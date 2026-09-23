import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySchema } from '../src/core/apply';
import { header, profile, schema } from './helpers';

interface DnrMock {
  isRegexSupported: ReturnType<typeof vi.fn>;
  getDynamicRules: ReturnType<typeof vi.fn>;
  updateDynamicRules: ReturnType<typeof vi.fn>;
  getSessionRules: ReturnType<typeof vi.fn>;
  updateSessionRules: ReturnType<typeof vi.fn>;
}

function installChrome(overrides: Partial<DnrMock> = {}): DnrMock {
  const dnr: DnrMock = {
    isRegexSupported: vi.fn(async () => ({ isSupported: true })),
    getDynamicRules: vi.fn(async () => []),
    updateDynamicRules: vi.fn(async () => undefined),
    getSessionRules: vi.fn(async () => []),
    updateSessionRules: vi.fn(async () => undefined),
    ...overrides,
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { declarativeNetRequest: dnr };
  return dnr;
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

describe('applySchema', () => {
  it('applies compiled rules and reports success', async () => {
    const dnr = installChrome();
    const s = schema([profile({ headers: [header({ name: 'X-A', value: '1' })] })]);

    const result = await applySchema(s);

    expect(result.applied).toBe(true);
    expect(result.ruleCount).toBe(1);
    expect(dnr.updateDynamicRules).toHaveBeenCalledOnce();
    expect(dnr.updateSessionRules).toHaveBeenCalledOnce();
  });

  it('puts tab-only profiles into session rules bound to their assigned tab', async () => {
    const dnr = installChrome();
    const scoped = profile({ tabOnly: true, headers: [header({ name: 'X-A', value: '1' })] });
    const result = await applySchema(schema([scoped]), { [scoped.id]: 42 });

    expect(result.applied).toBe(true);
    expect(dnr.updateDynamicRules).toHaveBeenCalledWith(expect.objectContaining({ addRules: [] }));
    expect(dnr.updateSessionRules).toHaveBeenCalledWith(
      expect.objectContaining({
        addRules: [
          expect.objectContaining({ condition: expect.objectContaining({ tabIds: [42] }) }),
        ],
      }),
    );
  });

  it('leaves an unassigned tab-only profile inactive', async () => {
    const dnr = installChrome();
    const result = await applySchema(
      schema([profile({ tabOnly: true, headers: [header({ name: 'X-A', value: '1' })] })]),
    );

    expect(result.applied).toBe(true);
    expect(result.ruleCount).toBe(0);
    expect(dnr.updateDynamicRules).toHaveBeenCalledWith(expect.objectContaining({ addRules: [] }));
    expect(dnr.updateSessionRules).toHaveBeenCalledWith(expect.objectContaining({ addRules: [] }));
  });

  it('returns applied:false with an error when updateDynamicRules rejects', async () => {
    installChrome({
      updateDynamicRules: vi.fn(async () => {
        throw new Error('rule 1 has an invalid header name');
      }),
    });
    const s = schema([profile({ headers: [header({ name: 'Bad Name', value: '1' })] })]);

    const result = await applySchema(s);

    expect(result.applied).toBe(false);
    expect(result.error).toContain('invalid header name');
  });

  it('skips unsupported regex rules with a warning instead of failing the whole apply', async () => {
    const dnr = installChrome({
      isRegexSupported: vi.fn(async () => ({ isSupported: false, reason: 'syntaxError' })),
    });
    const s = schema([
      profile({
        headers: [header({ name: 'X-A', value: '1' })],
        filters: {
          urlFilters: [{ kind: 'regex', mode: 'include', pattern: '(' }],
          resourceTypes: [],
        },
      }),
    ]);

    const result = await applySchema(s);

    expect(result.applied).toBe(true);
    expect(result.ruleCount).toBe(0);
    expect(result.compile.warnings.some((w) => w.message.includes('not supported'))).toBe(true);
    // The bad regex rule is never sent to Chrome.
    expect(dnr.updateDynamicRules).toHaveBeenCalledWith(expect.objectContaining({ addRules: [] }));
  });

  it('does not touch DNR when rule limits are exceeded', async () => {
    const dnr = installChrome();
    // 5001 include filters => 5001 rules, over MAX_UNSAFE_DYNAMIC_RULES (5000).
    const urlFilters = Array.from({ length: 5001 }, (_, i) => ({
      kind: 'wildcard' as const,
      mode: 'include' as const,
      pattern: `||h${i}.example.com^`,
    }));
    const s = schema([
      profile({
        headers: [header({ name: 'X-A', value: '1' })],
        filters: { urlFilters, resourceTypes: [] },
      }),
    ]);

    const result = await applySchema(s);

    expect(result.applied).toBe(false);
    expect(result.error).toContain('exceed');
    expect(dnr.updateDynamicRules).not.toHaveBeenCalled();
  });
});
