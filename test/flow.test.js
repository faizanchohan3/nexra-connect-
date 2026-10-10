// End-to-end: the worker against fake Shopify and WooCommerce stores.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeDb } from '../src/db.js';
import { d1, ENV, SECRET, proxyUrl, oauthUrl, webhookRequest, sourceProduct, fakeUpstream } from './helpers.js';
import { hmacBase64 } from '../src/crypto.js';

let env, up, realFetch;
const pending = [];
// Like Cloudflare, background work (ctx.waitUntil) finishes before the next request in a test.
const call = async (req) => {
  const res = await worker.fetch(req, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending.splice(0));
  return res;
};
const getJson = async (path, opts) => (await call(new Request(await proxyUrl(path, opts)))).json();
const postJson = async (path, body, opts) =>
  call(new Request(await proxyUrl(path, opts), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

function setup(fake) {
  env = { ...ENV, DB: d1() };
  up = fakeUpstream(fake);
  globalThis.fetch = up.handler;
}

async function installSupplier() {
  const res = await call(new Request(await oauthUrl('/install', { shop: ENV.SUPPLIER_SHOP, timestamp: '1' })));
  assert.equal(res.status, 302);
  const state = new URL(res.headers.get('location')).searchParams.get('state');
  const cb = await call(new Request(await oauthUrl('/auth/callback', { shop: ENV.SUPPLIER_SHOP, code: 'abc', state, timestamp: '2' })));
  assert.equal(cb.status, 200);
}

async function connectShopifySeller(shop = 'seller-one.myshopify.com', customerId = '42') {
  const res = await postJson('/api/connect/shopify', { shop }, { customerId });
  const { redirect } = await res.json();
  assert.ok(redirect.startsWith(`https://${shop}/admin/oauth/authorize?`));
  assert.ok(redirect.includes('scope=read_products%2Cwrite_products%2Cread_orders'));
  const state = new URL(redirect).searchParams.get('state');
  const cb = await call(new Request(await oauthUrl('/auth/callback', { shop, code: 'xyz', state, timestamp: '3' })));
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), 'https://nexrallc.com/pages/reseller-dashboard#stores');
  const status = await getJson('/api/status', { customerId });
  return status.connections.find((c) => c.store_url === shop);
}

beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

test('requests without a valid proxy signature or login are refused', async () => {
  setup();
  const bad = (await proxyUrl('/api/status')).replace(/signature=[^&]+/, 'signature=00');
  assert.equal((await call(new Request(bad))).status, 401);
  const anon = await call(new Request(await proxyUrl('/api/status', { customerId: '' })));
  assert.equal(anon.status, 401);
});

test('before the Nexra store installs the app, the dashboard gets a clear message', async () => {
  setup();
  const res = await call(new Request(await proxyUrl('/api/status')));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not set up yet/);
});

test('Shopify seller: connect, push products with their prices, and stay within plan limits', async () => {
  setup({ customerTags: ['nexra-growth'], products: { 101: sourceProduct(101, { variants: 2 }), 102: sourceProduct(102, { variants: 1 }) } });
  await installSupplier();
  // The supplier install registers product webhooks on the Nexra store.
  assert.ok(up.calls.some((c) => c.host === ENV.SUPPLIER_SHOP && c.body && /NexraHook/.test(c.body.query) && c.body.variables.topic === 'PRODUCTS_UPDATE'));
  const conn = await connectShopifySeller();
  assert.ok(conn, 'connection listed');

  const res = await postJson('/api/push', { connectionId: conn.id, items: [{ id: 101 }, { id: 102, markup: 100 }], rule: { mtype: 'pct', markup: 40, round: '99', brand: 'Ali Shop' } });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual(out.results.map((r) => r.ok), [true, true]);

  const sets = up.calls.filter((c) => c.host === 'seller-one.myshopify.com' && c.body && /NexraProductSet/.test(c.body.query));
  assert.equal(sets.length, 2);
  const first = sets[0].body.variables.input;
  assert.equal(first.vendor, 'Ali Shop');
  assert.equal(first.variants[0].price, '26.99'); // Growth: 5% off $20, +40% = 26.60 -> 26.99
  assert.equal(sets[1].body.variables.input.variants[0].price, '38.99'); // custom +100%: 19 * 2 = 38.00 -> 38.99

  // Pushing the same product again updates prices instead of creating a duplicate.
  const again = await (await postJson('/api/push', { connectionId: conn.id, items: [{ id: 101 }], rule: { markup: 60, round: '00' } })).json();
  assert.equal(again.results[0].updated, true);
  assert.equal(up.calls.filter((c) => c.body && /NexraProductSet/.test(c.body.query)).length, 2);
  const priceCall = up.calls.filter((c) => c.body && /NexraPrices/.test(c.body.query)).pop();
  assert.equal(priceCall.body.variables.variants[0].price, '31.00'); // 19 * 1.6 = 30.4 -> 31.00

  const products = await getJson('/api/products');
  assert.equal(products.products.length, 2);
  assert.equal(products.products[0].platform, 'shopify');
});

test('Free plan: 3 products in total, checked on the server', async () => {
  const products = {};
  for (const id of [1, 2, 3, 4]) products[id] = sourceProduct(id, { variants: 1 });
  setup({ customerTags: [], products });
  await installSupplier();
  const conn = await connectShopifySeller();
  const ok = await postJson('/api/push', { connectionId: conn.id, items: [{ id: 1 }, { id: 2 }, { id: 3 }], rule: {} });
  assert.equal(ok.status, 200);
  const over = await postJson('/api/push', { connectionId: conn.id, items: [{ id: 4 }], rule: {} });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /Free plan includes 3 products/);
  const status = await getJson('/api/status');
  assert.equal(status.plan.key, 'free');
  assert.equal(status.productsUsed, 3);
});

test('a seller cannot push to a store owned by another seller', async () => {
  setup({ customerTags: ['nexra-pro'], products: { 1: sourceProduct(1) } });
  await installSupplier();
  const conn = await connectShopifySeller('seller-a.myshopify.com', '42');
  const res = await postJson('/api/push', { connectionId: conn.id, items: [{ id: 1 }] }, { customerId: '99' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not connected to your account/);
});

test('WooCommerce seller: connect with keys, push variable and simple products', async () => {
  setup({ customerTags: ['nexra-starter'], products: { 201: sourceProduct(201, { variants: 3 }), 202: sourceProduct(202, { variants: 1 }) } });
  await installSupplier();
  const bad = await postJson('/api/connect/woo', { url: 'shop.example.com', key: 'ck_abc', secret: 'cs_bad' });
  assert.equal(bad.status, 400);
  const res = await postJson('/api/connect/woo', { url: 'shop.example.com', key: 'ck_abc', secret: 'cs_good' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(up.wooWebhooks[0].topic, 'order.created');
  assert.ok(up.wooWebhooks[0].delivery_url.endsWith(`/webhooks/woo/${body.id}`));

  const push = await (await postJson('/api/push', { connectionId: body.id, items: [{ id: 201 }, { id: 202 }], rule: { markup: 50, round: '00' } })).json();
  assert.deepEqual(push.results.map((r) => r.ok), [true, true]);
  const created = up.calls.filter((c) => c.host === 'shop.example.com' && c.method === 'POST' && c.path === '/wp-json/wc/v3/products');
  assert.equal(created[0].body.type, 'variable');
  assert.equal(created[1].body.type, 'simple');
  assert.equal(created[1].body.regular_price, '30.00');
  const batch = up.calls.find((c) => /variations\/batch$/.test(c.path));
  assert.equal(batch.body.create.length, 3);
});

test('price change on the Nexra store updates every seller store', async () => {
  setup({ customerTags: ['nexra-pro'], products: { 301: sourceProduct(301, { variants: 2 }) } });
  await installSupplier();
  const conn = await connectShopifySeller();
  await postJson('/api/push', { connectionId: conn.id, items: [{ id: 301 }], rule: { markup: 100, round: 'none' } });
  const before = up.calls.length;
  const hook = await webhookRequest(`${ENV.APP_URL}/webhooks/shopify`, {
    id: 301, status: 'active', variants: [{ id: 3010, price: '30.00', sku: 'SKU301-0' }, { id: 3011, price: '40.00', sku: 'SKU301-1' }],
  }, { 'x-shopify-topic': 'products/update', 'x-shopify-shop-domain': ENV.SUPPLIER_SHOP });
  assert.equal((await call(hook)).status, 200);
  const priceCall = up.calls.slice(before).find((c) => c.body && /NexraPrices/.test(c.body.query));
  assert.ok(priceCall, 'prices pushed to seller store');
  assert.deepEqual(priceCall.body.variables.variants.map((v) => v.price), ['54.00', '72.00']); // Pro 10% off, then +100%

  // Product archived on Nexra -> hidden in seller store.
  const arch = await webhookRequest(`${ENV.APP_URL}/webhooks/shopify`, { id: 301, status: 'archived', variants: [] },
    { 'x-shopify-topic': 'products/update', 'x-shopify-shop-domain': ENV.SUPPLIER_SHOP });
  await call(arch);
  const statusCall = up.calls.filter((c) => c.body && /NexraStatus/.test(c.body.query)).pop();
  assert.equal(statusCall.body.variables.product.status, 'DRAFT');

  const forged = await webhookRequest(`${ENV.APP_URL}/webhooks/shopify`, { id: 301 }, { 'x-shopify-topic': 'products/update' }, 'wrong-secret');
  assert.equal((await call(forged)).status, 401);
});

test('seller orders are imported and sent to Nexra as a paid-on-invoice draft order', async () => {
  setup({ customerTags: ['nexra-growth'], products: { 401: sourceProduct(401, { variants: 2 }) } });
  await installSupplier();
  const conn = await connectShopifySeller();
  await postJson('/api/push', { connectionId: conn.id, items: [{ id: 401 }], rule: {} });
  const db = makeDb(env);
  const [link] = await db.listProductLinks('42');
  const vlinks = await db.variantLinks(link.id);
  const orderBody = {
    id: 555, name: '#1001', shipping_address: { first_name: 'Sara', last_name: 'K', address1: '1 Main', city: 'Austin', province_code: 'TX', zip: '78701', country_code: 'US' },
    line_items: [{ variant_id: Number(vlinks[1].target_variant_id), sku: vlinks[1].sku, quantity: 2, title: 'Product 401' }, { variant_id: 1, sku: 'NOT-OURS', quantity: 1 }],
  };
  const orderHeaders = { 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': 'seller-one.myshopify.com' };
  await call(await webhookRequest(`${ENV.APP_URL}/webhooks/shopify`, orderBody, orderHeaders));
  // Shopify may deliver the same webhook twice; it must be imported once.
  await call(await webhookRequest(`${ENV.APP_URL}/webhooks/shopify`, orderBody, orderHeaders));

  const list = await getJson('/api/orders');
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].order.lines.length, 1);
  assert.equal(list.orders[0].order.lines[0].sourceVariantId, '4011');

  const send = await (await postJson('/api/orders/send', { id: list.orders[0].id })).json();
  assert.equal(send.invoiceUrl, 'https://nexrallc.com/invoices/abc');
  const draft = up.calls.find((c) => c.body && /NexraDraft/.test(c.body.query)).body.variables.input;
  assert.equal(draft.lineItems[0].variantId, 'gid://shopify/ProductVariant/4011');
  assert.equal(draft.lineItems[0].quantity, 2);
  assert.equal(draft.purchasingEntity.customerId, 'gid://shopify/Customer/42');
  assert.equal(draft.appliedDiscount.value, 5);
  assert.equal(draft.shippingAddress.city, 'Austin');

  const again = await (await postJson('/api/orders/send', { id: list.orders[0].id })).json();
  assert.equal(again.alreadySent, true);
  assert.equal(up.calls.filter((c) => c.body && /NexraDraft/.test(c.body.query)).length, 1);

  // Another seller cannot send someone else's order.
  const other = await postJson('/api/orders/send', { id: list.orders[0].id }, { customerId: '7' });
  assert.equal(other.status, 400);
});

test('WooCommerce order webhooks are verified with the per-store secret', async () => {
  setup({ customerTags: ['nexra-starter'], products: { 501: sourceProduct(501, { variants: 1 }) } });
  await installSupplier();
  const res = await (await postJson('/api/connect/woo', { url: 'shop.example.com', key: 'ck_abc', secret: 'cs_good' })).json();
  await postJson('/api/push', { connectionId: res.id, items: [{ id: 501 }], rule: {} });
  const secret = up.wooWebhooks[0].secret;
  const body = { id: 77, number: '77', shipping: { first_name: 'A', last_name: 'B', address_1: 'x', city: 'y', postcode: '1', country: 'US' }, line_items: [{ sku: 'SKU501-0', product_id: 1, variation_id: 0, quantity: 1, name: 'P' }] };
  const url = `${ENV.APP_URL}/webhooks/woo/${res.id}`;
  const forged = await webhookRequest(url, body, { 'x-wc-webhook-topic': 'order.created' }, 'nope', 'x-wc-webhook-signature');
  assert.equal((await call(forged)).status, 401);
  const good = await webhookRequest(url, body, { 'x-wc-webhook-topic': 'order.created' }, secret, 'x-wc-webhook-signature');
  assert.equal((await call(good)).status, 200);
  const list = await getJson('/api/orders');
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].platform, 'woo');
});

test('uninstalling the app from a seller store disconnects it', async () => {
  setup({ customerTags: ['nexra-pro'] });
  await installSupplier();
  await connectShopifySeller();
  const hook = await webhookRequest(`${ENV.APP_URL}/webhooks/shopify`, {}, { 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': 'seller-one.myshopify.com' });
  await call(hook);
  const status = await getJson('/api/status');
  assert.equal(status.connections.length, 0);
});

test('OAuth callback rejects forged or expired requests', async () => {
  setup();
  const forged = `${ENV.APP_URL}/auth/callback?shop=x.myshopify.com&code=1&state=a&hmac=00`;
  assert.equal((await call(new Request(forged))).status, 401);
  const noState = await call(new Request(await oauthUrl('/auth/callback', { shop: 'x.myshopify.com', code: '1', state: 'bogus', timestamp: '1' })));
  assert.equal(noState.status, 400);
});
