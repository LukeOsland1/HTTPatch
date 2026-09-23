// Property test for the one invariant the whole replication design rests on:
//
//   from ANY starting state, a set of devices syncing repeatedly must reach a
//   fixed point — the sync area stops changing, and every device agrees.
//
// Three separate bugs in review were the same class: a field published from
// device-local state that peers cannot reproduce, so each side rewrote it at the
// other forever. Each was found by hand, one trigger at a time. This finds that
// class mechanically instead, by driving randomised operation sequences across
// several devices and asserting quiescence and agreement.
//
// Deterministic by construction: a seeded LCG, and time supplied as a counter, so
// a failure reproduces exactly from its seed.

import { beforeEach, describe, expect, it } from 'vitest';
import { load, save } from '../src/core/storage';
import { clearSync, runSync } from '../src/core/sync-runner';
import { QUOTA_BYTES, QUOTA_BYTES_PER_ITEM, SYNC_META_KEY, profileKey } from '../src/core/sync';
import { DEFAULT_SETTINGS } from '../src/core/constants';
import { SCHEMA_VERSION, type Profile, type StorageSchema } from '../src/core/types';

/** Same minimal StorageArea as sync-integration, with the real quota rules. */
class FakeArea {
  private data = new Map<string, string>();

  constructor(private quota: { total?: number; perItem?: number } = {}) {}

  private bytes(key: string, serialized: string): number {
    return key.length + serialized.length;
  }

  private totalBytes(exclude = new Set<string>()): number {
    let sum = 0;
    for (const [key, value] of this.data) {
      if (!exclude.has(key)) sum += this.bytes(key, value);
    }
    return sum;
  }

  get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const wanted = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const key of wanted) {
      const raw = this.data.get(key);
      if (raw !== undefined) out[key] = JSON.parse(raw);
    }
    return Promise.resolve(out);
  }

  set(items: Record<string, unknown>): Promise<void> {
    const incoming = new Map<string, string>();
    for (const [key, value] of Object.entries(items)) {
      const serialized = JSON.stringify(value);
      if (this.quota.perItem && this.bytes(key, serialized) > this.quota.perItem) {
        return Promise.reject(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
      }
      incoming.set(key, serialized);
    }
    if (this.quota.total) {
      const replaced = new Set(incoming.keys());
      let projected = this.totalBytes(replaced);
      for (const [key, serialized] of incoming) projected += this.bytes(key, serialized);
      if (projected > this.quota.total) return Promise.reject(new Error('QUOTA_BYTES exceeded'));
    }
    for (const [key, serialized] of incoming) this.data.set(key, serialized);
    return Promise.resolve();
  }

  remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
    return Promise.resolve();
  }

  getBytesInUse(keys: string | string[] | null): Promise<number> {
    if (keys === null) return Promise.resolve(this.totalBytes());
    let sum = 0;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const raw = this.data.get(key);
      if (raw !== undefined) sum += this.bytes(key, raw);
    }
    return Promise.resolve(sum);
  }

  snapshot(): string {
    return JSON.stringify([...this.data.entries()].sort());
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }
}

/** Deterministic PRNG so any failure is reproducible from its seed. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

let syncArea: FakeArea;
let devices: FakeArea[];
let activeLocal: FakeArea;

beforeEach(() => {
  syncArea = new FakeArea({ total: QUOTA_BYTES, perItem: QUOTA_BYTES_PER_ITEM });
  devices = [];
  activeLocal = new FakeArea();

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    writable: true,
    value: {
      storage: {
        get local() {
          return activeLocal;
        },
        sync: syncArea,
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    },
  });
});

async function on<T>(device: FakeArea, fn: () => Promise<T>): Promise<T> {
  const previous = activeLocal;
  activeLocal = device;
  try {
    return await fn();
  } finally {
    activeLocal = previous;
  }
}

function makeProfile(id: string, name: string, valueSize = 8): Profile {
  return {
    id,
    name,
    enabled: true,
    headers: [
      {
        id: `h-${id}`,
        enabled: true,
        target: 'request',
        operation: 'set',
        name: 'X-Test',
        value: 'v'.repeat(valueSize),
      },
    ],
    filters: { urlFilters: [], resourceTypes: [] },
  };
}

const emptySchema = (): StorageSchema => ({
  version: SCHEMA_VERSION,
  profiles: [],
  settings: { ...DEFAULT_SETTINGS, syncEnabled: true },
});

interface Outcome {
  quiesced: boolean;
  rounds: number;
  states: Array<{ ids: string[]; theme: string }>;
  log: string[];
}

/**
 * Apply a random operation sequence across `deviceCount` devices, then sync
 * round-robin until the area stops changing.
 */
async function fuzz(
  seed: number,
  deviceCount: number,
  operations: number,
  opts: { allowOversized?: boolean } = {},
): Promise<Outcome> {
  const random = rng(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

  devices = Array.from({ length: deviceCount }, () => new FakeArea());
  for (const device of devices) await on(device, () => save(emptySchema()));

  let clock = 1000;
  let nextId = 0;
  const log: string[] = [];

  for (let i = 0; i < operations; i++) {
    const index = Math.floor(random() * devices.length);
    const device = devices[index];
    const roll = random();

    await on(device, async () => {
      const schema = await load();
      if (roll < 0.34) {
        // add
        const oversized = opts.allowOversized === true && random() < 0.2;
        const id = `p${nextId++}`;
        const p = makeProfile(id, `P${id}`, oversized ? QUOTA_BYTES_PER_ITEM : 8);
        await save({ ...schema, profiles: [...schema.profiles, p] });
        log.push(`d${index} add ${id}${oversized ? ' (oversized)' : ''}`);
      } else if (roll < 0.56 && schema.profiles.length > 0) {
        // edit
        const target = pick(schema.profiles);
        await save({
          ...schema,
          profiles: schema.profiles.map((p) =>
            p.id === target.id ? { ...p, name: `${p.name}'` } : p,
          ),
        });
        log.push(`d${index} edit ${target.id}`);
      } else if (roll < 0.68 && schema.profiles.length > 0) {
        // delete
        const target = pick(schema.profiles);
        await save({ ...schema, profiles: schema.profiles.filter((p) => p.id !== target.id) });
        log.push(`d${index} delete ${target.id}`);
      } else if (roll < 0.76) {
        // theme
        const theme = pick(['system', 'light', 'dark'] as const);
        await save({ ...schema, settings: { ...schema.settings, theme } });
        log.push(`d${index} theme ${theme}`);
      } else if (roll < 0.8) {
        // Opt out and back in: resets this device's sync point, so first-run
        // adoption paths get exercised repeatedly rather than only at the start.
        await clearSync();
        log.push(`d${index} clearSync`);
      } else if (roll < 0.84) {
        await save({ ...schema, settings: { ...schema.settings, syncEnabled: false } });
        log.push(`d${index} sync off`);
      } else if (roll < 0.88) {
        await save({ ...schema, settings: { ...schema.settings, syncEnabled: true } });
        log.push(`d${index} sync on`);
      } else {
        // an interleaved sync, so cycles happen mid-sequence too
        await runSync({ now: (clock += 1000) });
        log.push(`d${index} sync`);
      }
    });
  }

  // A device left opted out cannot converge with the others, so re-enable
  // everywhere before asserting. This mirrors the real invariant: devices that
  // are syncing must agree.
  for (const device of devices) {
    await on(device, async () => {
      const schema = await load();
      if (!schema.settings.syncEnabled) {
        await save({ ...schema, settings: { ...schema.settings, syncEnabled: true } });
      }
    });
  }

  // Now let them talk until the area stops changing.
  let quiesced = false;
  let rounds = 0;
  for (; rounds < 40; rounds++) {
    const before = syncArea.snapshot();
    for (let d = 0; d < devices.length; d++) {
      const b = (await syncArea.get(null)) as Record<string, unknown>;
      await on(devices[d], () => runSync({ now: (clock += 1000) }));
      const a = (await syncArea.get(null)) as Record<string, unknown>;
      // Only record the tail, so a failure message shows the steady-state churn
      // rather than the legitimate catch-up writes at the start.
      if (rounds < 36) continue;
      const changed = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
        (k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]),
      );
      if (changed.length === 0) continue;
      log.push(`CHURN r${rounds} d${d}: ${changed.join(',')}`);
      if (changed.includes(SYNC_META_KEY)) {
        const bm = b[SYNC_META_KEY] as { order?: string[]; tombstones?: unknown } | undefined;
        const am = a[SYNC_META_KEY] as { order?: string[]; tombstones?: unknown } | undefined;
        log.push(`  order ${JSON.stringify(bm?.order)} -> ${JSON.stringify(am?.order)}`);
        log.push(`  tombs ${JSON.stringify(bm?.tombstones)} -> ${JSON.stringify(am?.tombstones)}`);
      }
    }
    if (syncArea.snapshot() === before) {
      quiesced = true;
      break;
    }
  }

  const states = [];
  for (const device of devices) {
    const schema = await on(device, () => load());
    states.push({ ids: schema.profiles.map((p) => p.id), theme: schema.settings.theme });
  }
  return { quiesced, rounds, states, log };
}

describe('replication reaches a fixed point', () => {
  // A wider sweep (120 seeds x 80 ops) was run while writing this; this size
  // keeps CI quick while still covering the interesting interleavings.
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);

  it.each(seeds)('converges and agrees (seed %i, 3 devices)', async (seed) => {
    const { quiesced, states, log } = await fuzz(seed, 3, 80);

    expect(quiesced, `never quiesced. ops:\n${log.join('\n')}`).toBe(true);

    // Every device must end up with the same profiles in the same order —
    // order decides header precedence, so disagreement is a real defect.
    const [first, ...rest] = states;
    for (const state of rest) {
      expect(state.ids, `order disagreement. ops:\n${log.join('\n')}`).toEqual(first.ids);
      expect(state.theme, `theme disagreement. ops:\n${log.join('\n')}`).toEqual(first.theme);
    }
  });

  it.each(seeds.slice(0, 15))('converges with oversized profiles (seed %i)', async (seed) => {
    // Devices legitimately differ here (an unpublishable profile stays local), so
    // only quiescence is asserted — plus that the published order never names an
    // id the area does not actually hold.
    const { quiesced, log } = await fuzz(seed, 3, 80, { allowOversized: true });

    expect(quiesced, `never quiesced. ops:\n${log.join('\n')}`).toBe(true);

    const raw = await syncArea.get(null);
    const meta = raw[SYNC_META_KEY] as { order: string[] } | undefined;
    for (const id of meta?.order ?? []) {
      expect(raw[profileKey(id)], `published order names missing ${id}`).toBeDefined();
    }
  });

  it.each([2, 4, 5])('converges with %i devices', async (count) => {
    const { quiesced, states, log } = await fuzz(5, count, 100);
    expect(quiesced, `never quiesced. ops:\n${log.join('\n')}`).toBe(true);
    const [first, ...rest] = states;
    for (const state of rest) {
      expect(state.ids, `order disagreement. ops:\n${log.join('\n')}`).toEqual(first.ids);
    }
  });
});
