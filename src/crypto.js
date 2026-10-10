// Signing, signature checks and token encryption. Uses Web Crypto, which both
// Cloudflare Workers and Node 22 provide as globalThis.crypto.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(buf) {
  return toBase64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return fromBase64(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(secret, message) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message)));
}

export async function hmacBase64(secret, message) {
  const data = typeof message === 'string' ? enc.encode(message) : message;
  return toBase64(await crypto.subtle.sign('HMAC', await hmacKey(secret), data));
}

// Constant-time comparison so signature checks do not leak timing information.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Signed, expiring tokens for the OAuth "state" parameter: base64url(json).base64url(hmac)
export async function signToken(secret, payload) {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = toBase64Url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}

export async function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = toBase64Url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(fromBase64Url(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

// AES-GCM encryption for store access tokens and WooCommerce keys at rest.
// The key is a base64 string of 32 random bytes (ENCRYPTION_KEY secret).
async function aesKey(b64) {
  const raw = fromBase64(b64);
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(keyB64, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(JSON.stringify(value)));
  return `${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptJson(keyB64, text) {
  const [iv, ct] = text.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await aesKey(keyB64), fromBase64(ct));
  return JSON.parse(dec.decode(pt));
}

export function randomId(bytes = 12) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
