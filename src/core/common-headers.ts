export interface CookieParts {
  name: string;
  value: string;
  attributes: string;
}

export function parseCookieHeader(value: string, response: boolean): CookieParts {
  const separator = response ? value.indexOf(';') : -1;
  const pair = separator < 0 ? value : value.slice(0, separator);
  const equals = pair.indexOf('=');
  return {
    name: equals < 0 ? pair : pair.slice(0, equals),
    value: equals < 0 ? '' : pair.slice(equals + 1),
    attributes: separator < 0 ? '' : value.slice(separator + 1).trim(),
  };
}

export function formatCookieHeader(parts: CookieParts, response: boolean): string {
  if (!parts.name && !parts.value && !parts.attributes) return '';
  const pair = `${parts.name}=${parts.value}`;
  return response && parts.attributes.trim() ? `${pair}; ${parts.attributes.trim()}` : pair;
}

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function cookieRuleError(value: string, response: boolean): string | null {
  const parts = parseCookieHeader(value, response);
  if (!COOKIE_NAME.test(parts.name)) return 'Enter a valid cookie name.';
  if (/[;\r\n]/.test(parts.value)) return 'Cookie values cannot contain a semicolon or newline.';
  if (/[\r\n]/.test(parts.attributes)) return 'Cookie attributes cannot contain a newline.';
  return null;
}

/** Replace an existing directive of the same name or append a new one. */
export function setCspDirective(policy: string, name: string, value: string): string {
  const directives = policy
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const next = `${name}${value ? ` ${value}` : ''}`;
  const index = directives.findIndex((part) => part.split(/\s+/, 1)[0]?.toLowerCase() === name);
  if (index < 0) directives.push(next);
  else directives[index] = next;
  return directives.join('; ');
}
