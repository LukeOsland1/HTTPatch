const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** Shared with the compiler: an exclude filter is only honoured if it is a plain domain. */
export function isBareDomain(pattern: string): boolean {
  return BARE_DOMAIN.test(pattern);
}
