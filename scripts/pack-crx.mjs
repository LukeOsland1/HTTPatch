// Packs the built dist/ into a signed CRX3 and writes a matching update.xml,
// for self-hosted enterprise deployment (ExtensionInstallForcelist + custom
// update URL) — no Chrome Web Store required.
//
// Usage:
//   node scripts/pack-crx.mjs --key path/to/key.pem --base-url https://host/httpatch
// or via env: CRX_PRIVATE_KEY (PEM contents), CRX_BASE_URL
//
// The extension ID is derived from the signing key, so reuse the same key on
// every build to keep the ID (and therefore the forcelist entry) stable.

import AdmZip from 'adm-zip';
import { createPrivateKey, createPublicKey, createHash, sign as signOneShot } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// --- CRX3 primitives -------------------------------------------------------
// CRX3 = "Cr24" + uint32LE(3) + uint32LE(headerLen) + CrxFileHeader + zip.
// See https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/

const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1'); // 16 bytes

function uint32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function varint(value) {
  const bytes = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

/** Serialize one length-delimited (wire type 2) protobuf field. */
function pbField(fieldNumber, buf) {
  return Buffer.concat([varint(fieldNumber * 8 + 2), varint(buf.length), buf]);
}

/** DER SubjectPublicKeyInfo for the key's public half. */
export function publicKeyDer(privateKeyPem) {
  const priv = createPrivateKey(privateKeyPem);
  return createPublicKey(priv).export({ type: 'spki', format: 'der' });
}

/** The 16-byte CRX id: first half of SHA-256 over the public key DER. */
export function crxIdBytes(publicDer) {
  return createHash('sha256').update(publicDer).digest().subarray(0, 16);
}

/** The 32-char extension ID string (each nibble mapped 0–15 → 'a'–'p'). */
export function extensionId(publicDer) {
  let out = '';
  for (const byte of crxIdBytes(publicDer)) {
    out += String.fromCharCode(97 + (byte >> 4));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}

/**
 * Build a signed CRX3 buffer from the extension's zip archive and a PEM key.
 * Pure and deterministic (RSA PKCS#1 v1.5 is deterministic), which is what lets
 * the smoke test byte-compare our signature against Chrome's.
 */
export function buildCrx(zip, privateKeyPem) {
  const priv = createPrivateKey(privateKeyPem);
  const publicDer = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const idBytes = crxIdBytes(publicDer);

  const signedHeaderData = pbField(1, idBytes); // SignedData { crx_id = 1 }
  const payload = Buffer.concat([
    SIGNATURE_CONTEXT,
    uint32LE(signedHeaderData.length),
    signedHeaderData,
    zip,
  ]);
  const signature = signOneShot('sha256', payload, priv); // RSA PKCS#1 v1.5

  const proof = Buffer.concat([pbField(1, publicDer), pbField(2, signature)]); // AsymmetricKeyProof
  const header = Buffer.concat([
    pbField(2, proof), // CrxFileHeader.sha256_with_rsa
    pbField(10000, signedHeaderData), // CrxFileHeader.signed_header_data
  ]);

  const crx = Buffer.concat([
    Buffer.from('Cr24', 'latin1'),
    uint32LE(3),
    uint32LE(header.length),
    header,
    zip,
  ]);
  return { crx, id: extensionId(publicDer) };
}

/** Zip a directory without depending on a system zip command. */
export function zipDir(dir) {
  const archive = new AdmZip();
  archive.addLocalFolder(dir);
  return archive.toBuffer();
}

export function updateXml({ id, version, crxUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${id}">
    <updatecheck codebase="${crxUrl}" version="${version}" />
  </app>
</gupdate>
`;
}

// --- CLI -------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  const keyPath = arg('--key');
  const keyPem = keyPath ? readFileSync(keyPath, 'utf8') : process.env.CRX_PRIVATE_KEY;
  if (!keyPem) {
    console.error('No signing key. Pass --key <path> or set CRX_PRIVATE_KEY.');
    process.exit(1);
  }

  // --print-id: derive the extension id from the key and exit (no build needed).
  if (process.argv.includes('--print-id')) {
    console.log(extensionId(publicKeyDer(keyPem)));
    return;
  }

  const dist = join(root, 'dist');
  if (!existsSync(dist)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  // --base-url / CRX_BASE_URL is only needed for the self-hosted update manifest.
  // When packing for a Chrome Web Store verified CRX upload we just need the .crx,
  // so the base URL (and update.xml) is optional.
  const baseUrl = (arg('--base-url') || process.env.CRX_BASE_URL || '').replace(/\/+$/, '');

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const crxName = `httpatch-${pkg.version}.crx`;

  const { crx, id } = buildCrx(zipDir(dist), keyPem);

  const outDir = join(root, 'release');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, crxName), crx);

  // NB: for a Chrome Web Store item using Verified CRX Uploads, this key-derived
  // id is the signing/verification identity, NOT the published extension id (the
  // store re-packages with the item's own key). It matches the published id only
  // for the legacy self-hosted route.
  console.log(`Signing key ID: ${id}`);
  console.log(`Packed:         release/${crxName} (${crx.length} bytes)`);

  if (baseUrl) {
    writeFileSync(
      join(outDir, 'update.xml'),
      updateXml({ id, version: pkg.version, crxUrl: `${baseUrl}/${crxName}` }),
    );
    console.log(`Update XML:   release/update.xml -> ${baseUrl}/${crxName}`);
    console.log(`Forcelist:    ${id};${baseUrl}/update.xml`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
