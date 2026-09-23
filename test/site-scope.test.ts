import { describe, expect, it } from 'vitest';
import { siteScopeFromUrl } from '../src/core/site-scope';

describe('siteScopeFromUrl', () => {
  it('anchors a web hostname for DNR and ignores its path', () => {
    expect(siteScopeFromUrl('https://api.example.com:8443/path?x=1')).toEqual({
      hostname: 'api.example.com',
      filter: { kind: 'wildcard', mode: 'include', pattern: '||api.example.com^' },
    });
  });

  it('does not offer scope on browser-internal or malformed URLs', () => {
    expect(siteScopeFromUrl('chrome://extensions')).toBeNull();
    expect(siteScopeFromUrl('not a url')).toBeNull();
  });
});
