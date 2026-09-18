// token.js — the one thing guarding a page that shows where people are.
//
// Shared by the origin and the Cloudflare Worker, for the same reason as
// tile-path.js: a second implementation of a check like this is a second
// chance to get it subtly wrong, and the failure is silent.
//
// It takes a cookie header rather than a request object, because Node and
// Workers disagree about how to reach one and this file should not have to
// know which it is talking to.

export const COOKIE = 'tll_token';

// Compare without letting response time reveal how much of the token matched.
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The token from the query string, or failing that the cookie the page sets on
// first load so it stops being visible in the address bar.
export function tokenOf(cookieHeader, url) {
  const q = url?.searchParams?.get('token');
  if (q) return q;
  const hit = String(cookieHeader || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  if (!hit) return '';
  try {
    return decodeURIComponent(hit.slice(COOKIE.length + 1));
  } catch {
    return '';
  }
}
