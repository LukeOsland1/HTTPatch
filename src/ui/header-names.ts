import type { HeaderTarget } from '@/core/types';

// A short, practical list for discovery; the editor still accepts any valid name.
const REQUEST_HEADERS = [
  'Authorization',
  'Accept',
  'Accept-Language',
  'Content-Type',
  'Cache-Control',
  'Origin',
  'Referer',
  'User-Agent',
  'Accept-Encoding',
  'Cookie',
  'If-None-Match',
  'If-Modified-Since',
  'If-Match',
  'Pragma',
  'X-Requested-With',
  'X-API-Key',
];

const RESPONSE_HEADERS = [
  'Access-Control-Allow-Origin',
  'Content-Type',
  'Cache-Control',
  'Content-Security-Policy',
  'Access-Control-Allow-Headers',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Credentials',
  'Access-Control-Expose-Headers',
  'Set-Cookie',
  'Location',
  'ETag',
  'Expires',
  'Content-Disposition',
  'Content-Encoding',
  'Referrer-Policy',
  'Strict-Transport-Security',
  'Vary',
  'X-Content-Type-Options',
  'X-Frame-Options',
];

export function suggestHeaderNames(target: HeaderTarget, query: string): string[] {
  const names = target === 'request' ? REQUEST_HEADERS : RESPONSE_HEADERS;
  const search = query.trim().toLowerCase();
  if (!search) return names.slice(0, 8);
  const matches = names.filter((name) => name.toLowerCase().includes(search));
  return matches
    .sort(
      (a, b) =>
        Number(b.toLowerCase().startsWith(search)) - Number(a.toLowerCase().startsWith(search)),
    )
    .slice(0, 8);
}
