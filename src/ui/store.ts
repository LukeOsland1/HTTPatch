// Shared UI state hook used by both the popup and the options page.
// Storage is the source of truth: every mutation writes the whole schema to
// chrome.storage.local, then (debounced) asks the service worker to recompile +
// apply and returns the resulting status (rule count, warnings, limit errors).

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Settings, StorageSchema } from '@/core/types';
import { load, onChange, save } from '@/core/storage';
import { requestApply, requestStatus, type ApplyStatus } from '@/messaging/messages';

/**
 * Debounce window for the recompile+apply. The storage write is immediate, but
 * we hold off on rebuilding DNR rules so that typing a header name doesn't push
 * every half-finished value ("Auth", "Autho", …) onto live traffic.
 */
const APPLY_DEBOUNCE_MS = 300;

export interface StoreState {
  schema: StorageSchema | null;
  status: ApplyStatus | null;
  loading: boolean;
  loadError: string | null;
  /**
   * Replace the whole schema (persist + apply). Resolves once the storage write
   * has landed, so callers that then message the worker — which re-reads storage
   * — cannot race their own write.
   */
  setSchema: (next: StorageSchema) => Promise<boolean>;
  /** Convenience: patch settings only. */
  patchSettings: (patch: Partial<Settings>) => Promise<boolean>;
}

/** Key-order-independent serialization so self-echoes match regardless of key order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

function errorStatus(paused: boolean, err: unknown): ApplyStatus {
  return {
    applied: false,
    paused,
    ruleCount: 0,
    warnings: [],
    limits: null,
    error: err instanceof Error ? err.message : String(err),
  };
}

export function useStore(): StoreState {
  const [schema, setSchemaState] = useState<StorageSchema | null>(null);
  const [status, setStatus] = useState<ApplyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Serialized payloads we wrote ourselves; used to ignore our own storage
  // echoes without dropping genuine concurrent writes from the other view.
  const pending = useRef<Set<string>>(new Set());
  // Always-current schema so mutations never build on a stale render closure.
  const schemaRef = useRef<StorageSchema | null>(null);
  const committedRef = useRef<StorageSchema | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const editId = useRef(0);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyState = (next: StorageSchema) => {
    schemaRef.current = next;
    setSchemaState(next);
  };

  const runApply = useCallback(async () => {
    try {
      setStatus(await requestApply());
    } catch (err) {
      setStatus(errorStatus(schemaRef.current?.settings.paused ?? false, err));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const initial = await load();
        if (!mounted) return;
        committedRef.current = initial;
        applyState(initial);
        setLoading(false);
        // Read-only: opening a view should not rewrite DNR rules.
        setStatus(await requestStatus());
      } catch (err) {
        if (!mounted) return;
        if (!schemaRef.current) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
        // The worker may be starting. A status failure does not hide loaded data.
      }
    })();

    const unsub = onChange((next) => {
      const key = stableStringify(next);
      if (pending.current.has(key)) {
        pending.current.delete(key); // our own echo — already reflected
        return;
      }
      // A genuine change from the other open view.
      committedRef.current = next;
      applyState(next);
    });

    return () => {
      mounted = false;
      unsub();
      // Flush a pending apply so a closing view never leaves DNR stale.
      if (applyTimer.current) {
        clearTimeout(applyTimer.current);
        applyTimer.current = null;
        void runApply();
      }
    };
  }, [runApply]);

  const persist = useCallback(
    (next: StorageSchema): Promise<boolean> => {
      const revision = ++editId.current;
      const key = stableStringify(next);
      applyState(next);
      // Browser storage writes are asynchronous. Serialize them so an older edit
      // cannot finish after a newer one and silently overwrite it.
      const write = writeQueue.current.then(async () => {
        pending.current.add(key);
        try {
          await save(next);
          committedRef.current = next;
          if (applyTimer.current) clearTimeout(applyTimer.current);
          applyTimer.current = setTimeout(() => {
            applyTimer.current = null;
            void runApply();
          }, APPLY_DEBOUNCE_MS);
          return true;
        } catch (err) {
          pending.current.delete(key);
          if (revision === editId.current) {
            if (committedRef.current) applyState(committedRef.current);
            setStatus(
              errorStatus(
                committedRef.current?.settings.paused ?? false,
                new Error(
                  `Could not save changes: ${err instanceof Error ? err.message : String(err)}`,
                ),
              ),
            );
          }
          return false;
        }
      });
      writeQueue.current = write.then(() => undefined);
      return write;
    },
    [runApply],
  );

  const setSchema = useCallback((next: StorageSchema) => persist(next), [persist]);

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => {
      const prev = schemaRef.current;
      if (!prev) return Promise.resolve(false);
      return persist({ ...prev, settings: { ...prev.settings, ...patch } });
    },
    [persist],
  );

  return { schema, status, loading, loadError, setSchema, patchSettings };
}
