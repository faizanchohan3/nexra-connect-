// WooCommerce REST API (v3). Keys are sent as query parameters over HTTPS, which
// works on hosts that strip the Authorization header.
import { hmacBase64, safeEqual } from './crypto.js';

export class WooError extends Error {
  name = 'WooError';
}

export function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null; // keys must never travel over plain HTTP
  if (!u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) return null;
  return `https://${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export function wooClient({ site, key, secret, fetchImpl = fetch }) {
  return async function call(method, path, body) {
    const url = new URL(`${site}/wp-json/wc/v3${path}`);
    url.searchParams.set('consumer_key', key);
    url.searchParams.set('consumer_secret', secret);
    const res = await fetchImpl(url.toString(), {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (res.status === 401 || res.status === 403) throw new WooError('WooCommerce rejected the API keys. Check they have Read/Write permission.');
    if (!res.ok) throw new WooError((data && data.message) || `WooCommerce returned ${res.status}`);
    return data;
  };
}

export async function verifyWooWebhook(rawBody, header, secret) {
  if (!header) return false;
  return safeEqual(await hmacBase64(secret, rawBody), header);
}
