// Uploads a signed CRX to the Chrome Web Store and publishes it, via the CWS
// API v2. The item has "Verified CRX uploads" enabled, so every package must be
// a .crx signed with the personal project's registered key. Plain-zip
// uploads are rejected once verified uploads is on.
//
// Flow (https://developer.chrome.com/docs/webstore/using-api):
//   1. refresh_token -> access_token
//   2. POST .../upload/v2/publishers/{pub}/items/{id}:upload   (raw .crx bytes)
//   3. poll  .../v2/publishers/{pub}/items/{id}:fetchStatus     (until not IN_PROGRESS)
//   4. POST  .../v2/publishers/{pub}/items/{id}:publish
//
// Required env (set as `release`-environment secrets/vars in CI):
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN  — OAuth (scope
//     https://www.googleapis.com/auth/chromewebstore)
//   CWS_PUBLISHER_ID  — the personal Chrome Web Store publisher id
//   CWS_ITEM_ID       — the store-assigned item id (the published extension id,
//     assigned to the new listing). NOTE: this is NOT the id derived
//     from our signing key — CWS re-packages verified uploads with the item's
//     own key, so the two differ by design.
//   CWS_VERIFIED_UPLOAD_KEY_ID — expected signing-key id for the pre-upload
//     sanity check. Configure it for the personal listing; there is no default.
// Optional env:
//   CWS_PUBLISH_TARGET — "default" (live) or "trustedTesters". Default "default".
//
// Usage: node scripts/publish-cws.mjs [--file release/httpatch-<v>.crx]

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { extensionId } from './pack-crx.mjs';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://chromewebstore.googleapis.com';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/**
 * A minimal protobuf reader over `buf` that tracks its own cursor. We only need
 * length-delimited fields (wire type 2); for anything else we skip the value
 * rather than misread it as a length (a robustness guard should the CRX/proto
 * format ever grow a non-length-delimited field — today every CrxFileHeader and
 * AsymmetricKeyProof field is wire type 2).
 */
function protoReader(buf) {
  let i = 0;
  const varint = () => {
    let result = 0,
      shift = 0,
      byte;
    do {
      byte = buf[i++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  };
  return {
    done: () => i >= buf.length,
    // Returns { field, value } where value is the field's raw bytes for wire
    // type 2, or null for a (skipped) field of any other wire type.
    next: () => {
      const tag = varint();
      const field = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType !== 2) {
        if (wireType === 0)
          varint(); // varint
        else if (wireType === 1)
          i += 8; // 64-bit
        else if (wireType === 5)
          i += 4; // 32-bit
        else throw new Error(`Unexpected protobuf wire type ${wireType}`);
        return { field, value: null };
      }
      const len = varint();
      const value = buf.subarray(i, i + len);
      i += len;
      return { field, value };
    },
  };
}

/**
 * Recover the extension id from a signed CRX3 by reading its header's first
 * public key. CRX3 = "Cr24" | u32 version | u32 headerLen | CrxFileHeader | zip;
 * CrxFileHeader field 2 (sha256_with_rsa) is an AsymmetricKeyProof whose inner
 * field 1 is the public key (DER), from which the id is derived.
 */
export function crxExtensionId(crxBuffer) {
  if (crxBuffer.subarray(0, 4).toString('latin1') !== 'Cr24') {
    throw new Error('Not a CRX3 file');
  }
  const headerLen = crxBuffer.readUInt32LE(8);
  const header = protoReader(crxBuffer.subarray(12, 12 + headerLen));
  while (!header.done()) {
    const { field, value } = header.next();
    if (field !== 2 || !value) continue; // sha256_with_rsa AsymmetricKeyProof
    const proof = protoReader(value);
    while (!proof.done()) {
      const inner = proof.next();
      if (inner.field === 1 && inner.value) return extensionId(inner.value); // public_key (DER)
    }
  }
  throw new Error('Could not find public key in CRX header');
}

async function uploadCrx({ token, publisherId, itemId, fileName, crx }) {
  const url = `${API}/upload/v2/publishers/${publisherId}/items/${itemId}:upload`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': fileName,
      'Content-Type': 'application/octet-stream',
    },
    body: crx,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Upload HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body; // { kind, id, publicKey, uploadState, itemError }
}

async function fetchStatus({ token, publisherId, itemId }) {
  const url = `${API}/v2/publishers/${publisherId}/items/${itemId}:fetchStatus`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`fetchStatus HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function publish({ token, publisherId, itemId, target }) {
  const qs = target ? `?publishTarget=${encodeURIComponent(target)}` : '';
  const url = `${API}/v2/publishers/${publisherId}/items/${itemId}:publish${qs}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Publish HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body; // { status: [...], statusDetail: [...] }
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  const clientId = requireEnv('CWS_CLIENT_ID');
  const clientSecret = requireEnv('CWS_CLIENT_SECRET');
  const refreshToken = requireEnv('CWS_REFRESH_TOKEN');
  const publisherId = requireEnv('CWS_PUBLISHER_ID');
  const itemId = requireEnv('CWS_ITEM_ID');
  const expectedKeyId = requireEnv('CWS_VERIFIED_UPLOAD_KEY_ID');
  const target = process.env.CWS_PUBLISH_TARGET || 'default';

  // Locate the signed CRX produced by `npm run pack:crx`.
  let file = arg('--file');
  if (!file) {
    const releaseDir = join(root, 'release');
    const crxs = readdirSync(releaseDir).filter((f) => f.endsWith('.crx'));
    if (crxs.length !== 1) {
      console.error(
        `Expected exactly one .crx in release/, found ${crxs.length}: ${crxs.join(', ')}. ` +
          `Run \`npm run pack:crx\` first, or pass --file.`,
      );
      process.exit(1);
    }
    file = join(releaseDir, crxs[0]);
  }
  const crx = readFileSync(file);
  const fileName = basename(file);

  // Sanity-check that we signed with the registered verified-upload key BEFORE
  // uploading. CWS only accepts uploads signed with the public key registered on
  // the item, whose derived id is a fixed constant — the signing key must never
  // be rotated casually (doing so locks us out of updating the store item). A
  // mismatch here almost always means the wrong CRX_PRIVATE_KEY was used to pack;
  // fail fast with a clear message rather than get an opaque CWS rejection.
  //
  // NB: this is the *signing* key id, deliberately NOT the published extension id
  // — CWS re-packages verified uploads with the item's own key (CWS_ITEM_ID), so
  // the two differ by design. Override the expected id via CWS_VERIFIED_UPLOAD_KEY_ID
  // only in the rare, support-assisted event that the signing key is rotated.
  const signingKeyId = crxExtensionId(crx);
  if (signingKeyId !== expectedKeyId) {
    console.error(
      `Signing key mismatch: ${fileName} is signed with key id ${signingKeyId}, but the ` +
        `verified-upload key registered on the store item is ${expectedKeyId}. CWS will ` +
        `reject this upload — did you pack with the wrong CRX_PRIVATE_KEY? (If the key was ` +
        `intentionally rotated, set CWS_VERIFIED_UPLOAD_KEY_ID to the new id.)`,
    );
    process.exit(1);
  }
  console.log(`Signing (verified-upload) key id: ${signingKeyId} ✓`);
  console.log(`Publishing ${fileName} (${crx.length} bytes) to CWS item ${itemId}`);

  const token = await getAccessToken({ clientId, clientSecret, refreshToken });

  console.log('Uploading…');
  let up = await uploadCrx({ token, publisherId, itemId, fileName, crx });
  console.log(`  uploadState: ${up.uploadState}`);

  // Large uploads can process asynchronously; poll until it settles.
  for (let n = 0; up.uploadState === 'IN_PROGRESS' && n < 30; n++) {
    await sleep(5000);
    up = await fetchStatus({ token, publisherId, itemId });
    console.log(`  …${up.uploadState}`);
  }
  // The v2 API reports success as "SUCCEEDED" (some docs/tools say "SUCCESS");
  // accept both so a good upload isn't mistaken for a failure.
  if (up.uploadState !== 'SUCCEEDED' && up.uploadState !== 'SUCCESS') {
    throw new Error(`Upload did not succeed: ${JSON.stringify(up)}`);
  }

  console.log(`Publishing (target: ${target})…`);
  const pub = await publish({ token, publisherId, itemId, target });
  console.log(`  status: ${JSON.stringify(pub.status ?? pub)}`);
  if (pub.statusDetail?.length) console.log(`  detail: ${JSON.stringify(pub.statusDetail)}`);

  // CWS returns 200 with a status array; anything other than OK is a soft
  // failure worth surfacing (e.g. the listing still needs manual review fields).
  const statuses = Array.isArray(pub.status) ? pub.status : [];
  const bad = statuses.filter((s) => s !== 'OK');
  if (bad.length) {
    console.error(`Publish returned non-OK status: ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log('Done — new version submitted for review and will publish once approved.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
