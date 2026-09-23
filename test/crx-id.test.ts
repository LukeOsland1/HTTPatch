import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
// The CRX packer/publisher are dependency-free .mjs scripts with no type
// declarations; import their pure helpers directly to round-trip a signed CRX's id.
// @ts-expect-error -- pack-crx.mjs is plain JS with no .d.ts
import { buildCrx, extensionId, publicKeyDer } from '../scripts/pack-crx.mjs';
// @ts-expect-error -- publish-cws.mjs is plain JS with no .d.ts
import { crxExtensionId } from '../scripts/publish-cws.mjs';

function pemKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}

describe('crxExtensionId', () => {
  it('recovers the same id pack-crx derived when building the CRX (round-trip)', () => {
    const key = pemKey();
    // The id comes only from the signing key, so the zip payload can be anything.
    const { crx, id } = buildCrx(Buffer.from('dummy zip payload'), key);
    expect(crxExtensionId(crx)).toBe(id);
    expect(crxExtensionId(crx)).toBe(extensionId(publicKeyDer(key)));
  });

  it('is stable for a given key regardless of the packed payload', () => {
    const key = pemKey();
    const a = buildCrx(Buffer.from('payload A'), key).crx;
    const b = buildCrx(Buffer.from('a different, longer payload B'), key).crx;
    expect(crxExtensionId(a)).toBe(crxExtensionId(b));
  });

  it('differs between two independently generated keys', () => {
    const a = buildCrx(Buffer.from('x'), pemKey()).crx;
    const b = buildCrx(Buffer.from('x'), pemKey()).crx;
    expect(crxExtensionId(a)).not.toBe(crxExtensionId(b));
  });

  it('rejects a buffer that is not a CRX3', () => {
    expect(() => crxExtensionId(Buffer.from('PK\x03\x04 not a crx'))).toThrow(/Not a CRX3/);
  });
});
