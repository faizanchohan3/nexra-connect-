import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, encryptJson, decryptJson, hmacBase64 } from '../src/crypto.js';
import { verifyProxy, verifyOAuthQuery, verifyWebhook, normalizeShop } from '../src/shopify.js';
import { normalizeSiteUrl } from '../src/woo.js';
import { sellPrice, roundPrice, planFromTags } from '../src/pricing.js';
import { toShopifyProductSet, toWooProduct, normalizeOrder, matchOrderLines, toDraftOrderInput, cleanTags } from '../src/mapping.js';
import { SECRET, ENV, proxyUrl, oauthUrl, sourceProduct } from './helpers.js';

test('signed state tokens verify, and reject tampering and expiry', async () => {
  const t = await signToken('s', { c: '1', exp: Date.now() + 1000 });
  assert.equal((await verifyToken('s', t)).c, '1');
  assert.equal(await verifyToken('other', t), null);
  assert.equal(await verifyToken('s', t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);
  const old = await signToken('s', { c: '1', exp: Date.now() - 1 });
  assert.equal(await verifyToken('s', old), null);
});

test('credentials are encrypted at rest and decrypt back', async () => {
  const blob = await encryptJson(ENV.ENCRYPTION_KEY, { token: 'shpat_secret' });
  assert.ok(!blob.includes('shpat_secret'));
  assert.deepEqual(await decryptJson(ENV.ENCRYPTION_KEY, blob), { token: 'shpat_secret' });
});

test('app proxy signatures are checked', async () => {
  const good = await proxyUrl('/api/status');
  assert.equal(await verifyProxy(good, SECRET), true);
  assert.equal(await verifyProxy(good.replace('logged_in_customer_id=42', 'logged_in_customer_id=43'), SECRET), false);
  assert.equal(await verifyProxy(good, 'wrong'), false);
  const stale = await proxyUrl('/api/status', { ts: Math.floor(Date.now() / 1000) - 7200 });
  assert.equal(await verifyProxy(stale, SECRET), false);
});

test('OAuth query and webhook HMACs are checked', async () => {
  const u = await oauthUrl('/auth/callback', { shop: 'a.myshopify.com', code: 'c', state: 's', timestamp: '1' });
  assert.equal(await verifyOAuthQuery(u, SECRET), true);
  assert.equal(await verifyOAuthQuery(u.replace('code=c', 'code=d'), SECRET), false);
  const raw = '{"id":1}';
  assert.equal(await verifyWebhook(raw, await hmacBase64(SECRET, raw), SECRET), true);
  assert.equal(await verifyWebhook('{"id":2}', await hmacBase64(SECRET, raw), SECRET), false);
});

test('store addresses are normalized and unsafe ones rejected', () => {
  assert.equal(normalizeShop('https://My-Store.myshopify.com/admin'), 'my-store.myshopify.com');
  assert.equal(normalizeShop('mystore'), 'mystore.myshopify.com');
  assert.equal(normalizeShop('evil.com'), null);
  assert.equal(normalizeSiteUrl('shop.example.com/'), 'https://shop.example.com');
  assert.equal(normalizeSiteUrl('http://shop.example.com'), null);
  assert.equal(normalizeSiteUrl('https://localhost'), null);
});

test('pricing matches the dashboard rules', () => {
  assert.equal(sellPrice(20, 0, { mtype: 'pct', markup: 40, round: '99' }), 28.99); // 28.00 rounds up to .99, like the dashboard
  assert.equal(sellPrice(20, 0, { mtype: 'pct', markup: 35, round: '99' }), 27.99);
  assert.equal(sellPrice(20, 0, { mtype: 'pct', markup: 50, round: '00' }), 30);
  assert.equal(sellPrice(20, 10, { mtype: 'fixed', markup: 5, round: 'none' }), 23);
  assert.equal(sellPrice(20, 0, { mtype: 'pct', markup: 40, round: '99' }, 100), 40.99); // per-product +100% wins over the rule
  assert.equal(roundPrice(28.0, '95'), 28.95);
  assert.equal(planFromTags(['nexra-growth']), 'growth');
  assert.equal(planFromTags(['vip']), 'free');
});

test('Nexra product becomes a Shopify productSet input', () => {
  const input = toShopifyProductSet(sourceProduct(5, { variants: 2 }), { discount: 5, rule: { markup: 40, round: '99', brand: 'MyShop' } });
  assert.equal(input.vendor, 'MyShop');
  assert.deepEqual(input.tags, ['home-decor']);
  assert.equal(input.productOptions[0].name, 'Color');
  assert.equal(input.variants.length, 2);
  assert.deepEqual(input.variants[0].optionValues, [{ optionName: 'Color', name: 'C0' }]);
  assert.equal(input.variants[0].price, '26.99'); // 20 * 0.95 * 1.4 = 26.6 -> 26.99
  assert.equal(input.files[0].originalSource, 'https://cdn.shopify.com/p5.jpg');
  const single = toShopifyProductSet(sourceProduct(6, { variants: 1 }), { discount: 0, rule: {} });
  assert.deepEqual(single.variants[0].optionValues, [{ optionName: 'Title', name: 'Default Title' }]);
});

test('Nexra product becomes WooCommerce payloads', () => {
  const v = toWooProduct(sourceProduct(7, { variants: 3 }), { discount: 0, rule: { markup: 50, round: '00' } });
  assert.equal(v.product.type, 'variable');
  assert.equal(v.product.attributes[0].options.length, 3);
  assert.equal(v.variations[0].regular_price, '30.00');
  const s = toWooProduct(sourceProduct(8, { variants: 1 }), { discount: 0, rule: { markup: 50, round: '00' } });
  assert.equal(s.product.type, 'simple');
  assert.equal(s.product.sku, 'SKU8-0');
  assert.equal(cleanTags(['saleyee', 'SKU-9', 'gift']).join(), 'gift');
});

test('orders are normalized, matched to Nexra variants, and turned into draft orders', () => {
  const order = normalizeOrder('shopify', {
    id: 1, name: '#1001', shipping_address: { first_name: 'Sara', last_name: 'K', address1: '1 Main', city: 'Austin', province_code: 'TX', zip: '78701', country_code: 'US' },
    line_items: [{ sku: 'SKU5-0', variant_id: 111, quantity: 2, title: 'P5' }, { sku: 'OTHER', variant_id: 222, quantity: 1, title: 'Not ours' }],
  });
  const lines = matchOrderLines(order, [{ source_variant_id: '50', target_variant_id: '111', sku: 'SKU5-0' }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sourceVariantId, '50');
  const input = toDraftOrderInput({ order, lines, customerGid: 'gid://shopify/Customer/42', discount: 10, storeName: 'myshop' });
  assert.equal(input.lineItems[0].variantId, 'gid://shopify/ProductVariant/50');
  assert.equal(input.lineItems[0].quantity, 2);
  assert.equal(input.shippingAddress.countryCode, 'US');
  assert.equal(input.appliedDiscount.value, 10);
  const woo = normalizeOrder('woo', { id: 9, number: '9', shipping: { first_name: 'A', address_1: 'x', country: 'US' }, line_items: [{ sku: 'S', variation_id: 5, quantity: 1, name: 'n' }] });
  assert.equal(woo.lines[0].targetVariantId, '5');
});
