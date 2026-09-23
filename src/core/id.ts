/** Stable unique id for profiles and header rows. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return 'id-' + Math.abs(Date.now() ^ (Math.random() * 0xffffffff)).toString(36);
}
