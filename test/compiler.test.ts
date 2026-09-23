import { describe, it, expect } from 'vitest';
import { compile } from '../src/core/compiler';
import { ALL_RESOURCE_TYPES } from '../src/core/constants';
import { header, profile, schema } from './helpers';
import { migrate } from '../src/core/storage';
import { exportProfiles, importProfiles } from '../src/core/importexport';

describe('compile', () => {
  it.each(['', '   '])(
    'keeps a blank include scoped after storage and JSON round trips: %j',
    (pattern) => {
      const p = profile({
        headers: [header({ name: 'Authorization', value: 'Bearer test' })],
        filters: {
          resourceTypes: [],
          urlFilters: [{ kind: 'wildcard', mode: 'include', pattern }],
        },
      });
      expect(compile(migrate(schema([p]))).rules).toEqual([]);
      expect(compile(schema(importProfiles(exportProfiles([p])).profiles)).rules).toEqual([]);
    },
  );

  it('retains valid scope when a second include is still blank', () => {
    const p = profile({
      headers: [header()],
      filters: {
        resourceTypes: [],
        urlFilters: [
          { kind: 'wildcard', mode: 'include', pattern: '' },
          { kind: 'wildcard', mode: 'include', pattern: '||example.com^' },
        ],
      },
    });
    const { rules } = compile(migrate(schema([p])));
    expect(rules).toHaveLength(1);
    expect(rules[0].condition.urlFilter).toBe('||example.com^');
  });
  it('keeps note edits out of network rules', () => {
    const p = profile({ headers: [header({ name: 'X-Customer', value: 'synthetic-id' })] });
    const before = compile(schema([p]));
    expect(before.rules).toHaveLength(1);
    p.headers[0].comment = 'Northwind, production <script>example</script>';
    expect(compile(schema([p]))).toEqual(before);
    delete p.headers[0].comment;
    expect(compile(schema([p]))).toEqual(before);
  });

  it('emits a set request-header rule with a full resource-type list by default', () => {
    const { rules, warnings } = compile(
      schema([profile({ headers: [header({ name: 'Authorization', value: 'Bearer x' })] })]),
    );
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(1);
    const r = rules[0];
    expect(r.action.type).toBe('modifyHeaders');
    expect(r.action.requestHeaders).toEqual([
      { header: 'Authorization', operation: 'set', value: 'Bearer x' },
    ]);
    expect(r.condition.resourceTypes).toEqual(ALL_RESOURCE_TYPES);
    expect(r.condition.urlFilter).toBeUndefined();
    expect(r.condition.regexFilter).toBeUndefined();
  });

  it('supports response set/append/remove', () => {
    const { rules } = compile(
      schema([
        profile({
          headers: [
            header({ target: 'response', operation: 'set', name: 'X-A', value: '1' }),
            header({ target: 'response', operation: 'append', name: 'X-B', value: '2' }),
            header({ target: 'response', operation: 'remove', name: 'X-C' }),
          ],
        }),
      ]),
    );
    expect(rules).toHaveLength(3);
    expect(rules[0].action.responseHeaders).toEqual([
      { header: 'X-A', operation: 'set', value: '1' },
    ]);
    expect(rules[1].action.responseHeaders).toEqual([
      { header: 'X-B', operation: 'append', value: '2' },
    ]);
    expect(rules[2].action.responseHeaders).toEqual([{ header: 'X-C', operation: 'remove' }]);
  });

  it('skips disabled headers and disabled profiles', () => {
    const { rules } = compile(
      schema([
        profile({
          headers: [header({ enabled: false }), header({ name: 'X-On' })],
        }),
        profile({ enabled: false, headers: [header({ name: 'X-Never' })] }),
      ]),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].action.requestHeaders?.[0].header).toBe('X-On');
  });

  it('returns no rules when paused', () => {
    const { rules } = compile(schema([profile({ headers: [header()] })], true));
    expect(rules).toEqual([]);
  });

  it('skips append on non-allowlisted request headers with a warning', () => {
    const { rules, warnings } = compile(
      schema([
        profile({ headers: [header({ operation: 'append', name: 'X-Custom', value: 'v' })] }),
      ]),
    );
    expect(rules).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/Append is not allowed/);
  });

  it('allows append on allowlisted request headers', () => {
    const { rules, warnings } = compile(
      schema([profile({ headers: [header({ operation: 'append', name: 'Accept', value: 'x' })] })]),
    );
    expect(warnings).toEqual([]);
    expect(rules[0].action.requestHeaders).toEqual([
      { header: 'Accept', operation: 'append', value: 'x' },
    ]);
  });

  it('fans out N headers x M include filters into N*M rules', () => {
    const { rules } = compile(
      schema([
        profile({
          headers: [header({ name: 'X-1' }), header({ name: 'X-2' })],
          filters: {
            resourceTypes: [],
            urlFilters: [
              { kind: 'wildcard', mode: 'include', pattern: '||a.com^' },
              { kind: 'wildcard', mode: 'include', pattern: '||b.com^' },
            ],
          },
        }),
      ]),
    );
    expect(rules).toHaveLength(4);
    // ids are unique and monotonic
    expect(new Set(rules.map((r) => r.id)).size).toBe(4);
  });

  it('never sets both urlFilter and regexFilter on one rule', () => {
    const { rules } = compile(
      schema([
        profile({
          headers: [header()],
          filters: {
            resourceTypes: [],
            urlFilters: [{ kind: 'regex', mode: 'include', pattern: '^https://x/' }],
          },
        }),
      ]),
    );
    expect(rules[0].condition.regexFilter).toBe('^https://x/');
    expect(rules[0].condition.urlFilter).toBeUndefined();
  });

  it('maps bare-domain excludes to excludedRequestDomains and warns on others', () => {
    const { rules, warnings } = compile(
      schema([
        profile({
          headers: [header()],
          filters: {
            resourceTypes: [],
            urlFilters: [
              { kind: 'wildcard', mode: 'exclude', pattern: 'ads.example.com' },
              { kind: 'wildcard', mode: 'exclude', pattern: '*/tracker/*' },
            ],
          },
        }),
      ]),
    );
    expect(rules[0].condition.excludedRequestDomains).toEqual(['ads.example.com']);
    expect(warnings.some((w) => /not a bare domain/.test(w.message))).toBe(true);
  });

  it('gives later profiles higher priority', () => {
    const { rules } = compile(
      schema([
        profile({ headers: [header({ name: 'X-First' })] }),
        profile({ headers: [header({ name: 'X-Second' })] }),
      ]),
    );
    const first = rules.find((r) => r.action.requestHeaders?.[0].header === 'X-First')!;
    const second = rules.find((r) => r.action.requestHeaders?.[0].header === 'X-Second')!;
    expect(second.priority).toBeGreaterThan(first.priority);
  });

  it('does not apply rules globally when all include patterns are blank', () => {
    const { rules, warnings } = compile(
      schema([
        profile({
          headers: [header()],
          filters: {
            resourceTypes: [],
            urlFilters: [{ kind: 'wildcard', mode: 'include', pattern: '   ' }],
          },
        }),
      ]),
    );
    expect(rules).toHaveLength(0);
    expect(warnings.some((w) => /empty pattern/.test(w.message))).toBe(true);
  });

  it('trims valid include patterns', () => {
    const { rules } = compile(
      schema([
        profile({
          headers: [header()],
          filters: {
            resourceTypes: [],
            urlFilters: [{ kind: 'wildcard', mode: 'include', pattern: '  ||api.example.com^  ' }],
          },
        }),
      ]),
    );
    expect(rules[0].condition.urlFilter).toBe('||api.example.com^');
  });

  it('honors an explicit resource-type selection', () => {
    const { rules } = compile(
      schema([
        profile({
          headers: [header()],
          filters: { resourceTypes: ['xmlhttprequest'], urlFilters: [] },
        }),
      ]),
    );
    expect(rules[0].condition.resourceTypes).toEqual(['xmlhttprequest']);
  });
});
