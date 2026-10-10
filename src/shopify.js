// Shopify: request verification, OAuth and Admin GraphQL.
import { hmacHex, hmacBase64, safeEqual } from './crypto.js';

export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// Scopes asked from each kind of store. Sellers only grant what pushing products
// and importing their orders needs; the Nexra store also lets the app read
// customer plans and create draft orders.
export const SELLER_SCOPES = 'read_products,write_products,read_orders';
export const SUPPLIER_SCOPES = 'read_products,read_customers,read_orders,write_draft_orders';

export function normalizeShop(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (s && !s.includes('.')) s += '.myshopify.com';
  return SHOP_DOMAIN.test(s) ? s : null;
}

// App proxy requests: params sorted, joined as key=value (arrays comma-joined),
// concatenated without separators, HMAC-SHA256 hex in "signature".
export async function verifyProxy(url, secret, now = Date.now()) {
  const params = new URL(url).searchParams;
  const signature = params.get('signature');
  if (!signature) return false;
  const grouped = {};
  for (const [k, v] of params) {
    if (k === 'signature') continue;
    (grouped[k] ||= []).push(v);
  }
  const message = Object.keys(grouped)
    .sort()
    .map((k) => `${k}=${grouped[k].join(',')}`)
    .join('');
  if (!safeEqual(await hmacHex(secret, message), signature)) return false;
  const ts = Number(params.get('timestamp'));
  return Number.isFinite(ts) && Math.abs(now / 1000 - ts) < 60 * 60;
}

// OAuth callback / install requests: params except hmac, sorted, joined with "&".
export async function verifyOAuthQuery(url, secret) {
  const params = new URL(url).searchParams;
  const hmac = params.get('hmac');
  if (!hmac) return false;
  const message = [...params]
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return safeEqual(await hmacHex(secret, message), hmac);
}

// Webhooks: base64 HMAC-SHA256 of the raw body in X-Shopify-Hmac-Sha256.
export async function verifyWebhook(rawBody, header, secret) {
  if (!header) return false;
  return safeEqual(await hmacBase64(secret, rawBody), header);
}

export function authorizeUrl({ shop, apiKey, scopes, redirectUri, state }) {
  const q = new URLSearchParams({ client_id: apiKey, scope: scopes, redirect_uri: redirectUri, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

export async function exchangeCode({ shop, apiKey, apiSecret, code, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });
  if (!res.ok) throw new Error(`Shopify token exchange failed (${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Shopify did not return an access token');
  return { token: data.access_token, scope: data.scope || '' };
}

export class ShopifyError extends Error {
  name = 'ShopifyError';
}

export function adminClient({ shop, token, apiVersion, fetchImpl = fetch }) {
  return async function gql(query, variables = {}) {
    const res = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 || res.status === 403) throw new ShopifyError('The store connection has expired. Please reconnect the store.');
    if (!res.ok) throw new ShopifyError(`Shopify returned ${res.status}`);
    const body = await res.json();
    if (body.errors && body.errors.length) throw new ShopifyError(body.errors.map((e) => e.message).join('; '));
    return body.data;
  };
}

export function userErrors(payload) {
  const errs = (payload && payload.userErrors) || [];
  return errs.length ? errs.map((e) => e.message).join('; ') : null;
}

export const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);
export const numericId = (id) => String(id).split('/').pop();

// ---------- GraphQL operations (validated against the Admin API schema) ----------

export const Q_SOURCE_PRODUCTS = `query NexraSource($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id title handle descriptionHtml vendor productType tags status
      options { name values }
      media(first: 10) { nodes { ... on MediaImage { image { url altText } } } }
      variants(first: 100) { nodes { id title sku price availableForSale selectedOptions { name value } } }
    }
  }
}`;

export const M_PRODUCT_SET = `mutation NexraProductSet($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id handle variants(first: 100) { nodes { id sku } } }
    userErrors { field message code }
  }
}`;

export const M_VARIANT_PRICES = `mutation NexraPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}`;

export const M_PRODUCT_STATUS = `mutation NexraStatus($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id status } userErrors { field message } }
}`;

export const M_DRAFT_ORDER = `mutation NexraDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
    userErrors { field message }
  }
}`;

export const M_WEBHOOK = `mutation NexraHook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

export const Q_CUSTOMER = `query NexraCustomer($id: ID!) { customer(id: $id) { id firstName tags } }`;

export async function registerWebhooks(gql, uri, topics) {
  const failed = [];
  for (const topic of topics) {
    const data = await gql(M_WEBHOOK, { topic, sub: { uri, format: 'JSON' } });
    const err = userErrors(data.webhookSubscriptionCreate);
    // "already taken" means the subscription exists from an earlier connect.
    if (err && !/taken|already/i.test(err)) failed.push(`${topic}: ${err}`);
  }
  return failed;
}
