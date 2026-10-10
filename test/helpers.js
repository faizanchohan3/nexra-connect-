// Test helpers: a D1-compatible database on node:sqlite, request signing, and
// fake Shopify / WooCommerce servers behind a stubbed global fetch.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hmacHex, hmacBase64 } from '../src/crypto.js';

export function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const norm = (v) => (v === undefined ? null : v);
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a.map(norm); return stmt; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
      };
      return stmt;
    },
  };
}

export const SECRET = 'test-app-secret';
export const ENV = {
  SHOPIFY_API_KEY: 'test-key',
  SHOPIFY_API_SECRET: SECRET,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_URL: 'https://connect.example.workers.dev',
  SUPPLIER_SHOP: 'nexra.myshopify.com',
  STOREFRONT_URL: 'https://nexrallc.com',
  API_VERSION: '2025-07',
};

export async function proxyUrl(path, { customerId = '42', shop = ENV.SUPPLIER_SHOP, ts = Math.floor(Date.now() / 1000) } = {}) {
  const params = { shop, logged_in_customer_id: customerId, path_prefix: '/apps/nexra', timestamp: String(ts) };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const q = new URLSearchParams({ ...params, signature: await hmacHex(SECRET, message) });
  return `${ENV.APP_URL}/proxy${path}?${q}`;
}

export async function oauthUrl(path, params) {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const q = new URLSearchParams({ ...params, hmac: await hmacHex(SECRET, message) });
  return `${ENV.APP_URL}${path}?${q}`;
}

export async function webhookRequest(url, body, headers, secret = SECRET, sigHeader = 'x-shopify-hmac-sha256') {
  const raw = JSON.stringify(body);
  return new Request(url, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', [sigHeader]: await hmacBase64(secret, raw), ...headers } });
}

// A Nexra product as returned by the source-products query.
export function sourceProduct(id, { variants = 2, price = '20.00', status = 'ACTIVE' } = {}) {
  const multi = variants > 1;
  return {
    id: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `product-${id}`, descriptionHtml: '<p>Nice</p>',
    vendor: 'Saleyee', productType: 'Wall Decoration', tags: ['home-decor', 'usadrop', 'saleyee', 'SKU-1'], status,
    options: multi ? [{ name: 'Color', values: Array.from({ length: variants }, (_, i) => `C${i}`) }] : [{ name: 'Title', values: ['Default Title'] }],
    media: { nodes: [{ image: { url: `https://cdn.shopify.com/p${id}.jpg`, altText: null } }] },
    variants: { nodes: Array.from({ length: variants }, (_, i) => ({
      id: `gid://shopify/ProductVariant/${id}${i}`, title: multi ? `C${i}` : 'Default Title', sku: `SKU${id}-${i}`, price, availableForSale: true,
      selectedOptions: multi ? [{ name: 'Color', value: `C${i}` }] : [{ name: 'Title', value: 'Default Title' }],
    })) },
  };
}

// Fake upstream servers. Records every call for assertions.
export function fakeUpstream({ customerTags = [], products = {} } = {}) {
  const calls = [];
  let nextId = 9000;
  const wooWebhooks = [];
  const handler = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: url.host, path: url.pathname, method: init.method || 'GET', body, search: url.search });
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/admin/oauth/access_token') return ok({ access_token: `tok-${url.host}`, scope: 'x' });

    if (url.pathname.endsWith('/graphql.json')) {
      const q = body.query;
      if (q.includes('NexraCustomer')) return ok({ data: { customer: { id: body.variables.id, firstName: 'Ali', tags: customerTags } } });
      if (q.includes('NexraSource')) return ok({ data: { nodes: body.variables.ids.map((g) => products[g.split('/').pop()] || null) } });
      if (q.includes('NexraProductSet')) {
        const pid = nextId++;
        const vs = body.variables.input.variants.map((v, i) => ({ id: `gid://shopify/ProductVariant/${pid}${i}`, sku: v.sku }));
        return ok({ data: { productSet: { product: { id: `gid://shopify/Product/${pid}`, handle: 'h', variants: { nodes: vs } }, userErrors: [] } } });
      }
      if (q.includes('NexraPrices')) return ok({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } });
      if (q.includes('NexraStatus')) return ok({ data: { productUpdate: { product: { id: 'x', status: 'DRAFT' }, userErrors: [] } } });
      if (q.includes('NexraHook')) return ok({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'w' }, userErrors: [] } } });
      if (q.includes('NexraDraft')) return ok({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/77', name: '#D77', invoiceUrl: 'https://nexrallc.com/invoices/abc', totalPriceSet: { shopMoney: { amount: '19.00', currencyCode: 'USD' } } }, userErrors: [] } } });
      return new Response('unknown query', { status: 500 });
    }

    if (url.pathname.startsWith('/wp-json/wc/v3')) {
      if (url.searchParams.get('consumer_secret') === 'cs_bad') return new Response(JSON.stringify({ message: 'Invalid' }), { status: 401 });
      const p = url.pathname.replace('/wp-json/wc/v3', '');
      if (p === '/products' && (init.method || 'GET') === 'GET') return ok([]);
      if (p === '/webhooks') { wooWebhooks.push(body); return ok({ id: 1 }); }
      if (p === '/products' && init.method === 'POST') return ok({ id: nextId++, sku: body.sku });
      const vb = p.match(/^\/products\/(\d+)\/variations\/batch$/);
      if (vb) return ok({ create: (body.create || []).map((v) => ({ id: nextId++, sku: v.sku })), update: body.update || [] });
      if (/^\/products\/\d+$/.test(p)) return ok({ id: 1 });
    }
    return new Response('not found', { status: 404 });
  };
  return { handler, calls, wooWebhooks };
}
