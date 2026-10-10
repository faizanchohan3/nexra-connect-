// Manual end-to-end check: theme dashboard (jsdom) -> Nexra Connect worker -> fake Shopify/Woo.
// Usage: node test/e2e-dashboard.mjs <dashboard.liquid> <dashboard-script.js> <products.json>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import worker from '../src/index.js';
import { d1, ENV, proxyUrl, oauthUrl, fakeUpstream } from './helpers.js';
const require = createRequire(process.argv[2]);
const { JSDOM } = require(process.env.JSDOM_PATH);

const [tplPath, jsPath, productsPath] = process.argv.slice(2);
const sample = JSON.parse(fs.readFileSync(productsPath, 'utf8')).products.slice(0, 5);
// Turn the storefront JSON into the Admin "source product" shape the worker reads.
const products = {};
for (const p of sample) {
  products[p.id] = {
    id: `gid://shopify/Product/${p.id}`, title: p.title, handle: p.handle, descriptionHtml: p.body_html, vendor: p.vendor, productType: p.product_type,
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags).split(', '), status: 'ACTIVE',
    options: p.options.map((o) => ({ name: o.name, values: o.values })),
    media: { nodes: p.images.map((i) => ({ image: { url: i.src, altText: null } })) },
    variants: { nodes: p.variants.map((v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, sku: v.sku, price: v.price, availableForSale: true,
      selectedOptions: p.options.map((o, i) => ({ name: o.name, value: v['option' + (i + 1)] })) })) },
  };
}
const up = fakeUpstream({ customerTags: ['nexra-growth'], products });
const env = { ...ENV, DB: d1() };
const pending = [];
const callWorker = async (req) => { const r = await worker.fetch(req, env, { waitUntil: (p) => pending.push(p) }); await Promise.all(pending.splice(0)); return r; };
globalThis.fetch = up.handler;

// Install on the Nexra store, connect a WooCommerce store for customer 42.
let r = await callWorker(new Request(await oauthUrl('/install', { shop: ENV.SUPPLIER_SHOP, timestamp: '1' })));
const state = new URL(r.headers.get('location')).searchParams.get('state');
await callWorker(new Request(await oauthUrl('/auth/callback', { shop: ENV.SUPPLIER_SHOP, code: 'a', state, timestamp: '2' })));

const tpl = fs.readFileSync(tplPath, 'utf8');
let body = tpl.slice(tpl.indexOf('<div class="nxd" id="nxd">'), tpl.indexOf('<script type="application/json" id="nx-config">'));
body = body.replace(/\{%-?[\s\S]*?-?%\}/g, '').replace(/\{\{[\s\S]*?\}\}/g, '');
const dom = new JSDOM('<!doctype html><body>' + body + '<script type="application/json" id="nx-config">{"discount":5,"limit":500,"tier":"Growth","customer":42}</script></body>',
  { url: 'https://nexrallc.com/pages/reseller-dashboard#stores', runScripts: 'outside-only' });
const w = dom.window;
w.confirm = () => true; w.scrollTo = () => {}; w.open = (u) => { w.__opened = u; };
w.fetch = async (u, init = {}) => {
  const url = new URL(u, 'https://nexrallc.com');
  if (url.pathname === '/products.json') return new Response(JSON.stringify(url.searchParams.get('page') === '1' ? { products: sample } : { products: [] }));
  if (url.pathname.startsWith('/apps/nexra/')) {
    const req = new Request(await proxyUrl(url.pathname.replace('/apps/nexra', '')), { method: init.method || 'GET', body: init.body, headers: init.headers });
    return callWorker(req);
  }
  return new Response('nope', { status: 404 });
};
w.eval(fs.readFileSync(jsPath, 'utf8'));
const tick = () => new Promise((res) => setTimeout(res, 300));
const $ = (id) => w.document.getElementById(id);
await tick();
console.log('stores view:', $('nxd-title').textContent, '|', $('nxd-store-rows').textContent.replace(/\s+/g, ' ').trim());

$('nxd-woo-url').value = 'shop.example.com'; $('nxd-woo-key').value = 'ck_abc'; $('nxd-woo-secret').value = 'cs_good';
$('nxd-connect-woo').click(); await tick();
console.log('after connect:', $('nxd-store-rows').textContent.replace(/\s+/g, ' ').trim().slice(0, 80), '| toast:', $('nxd-toast').textContent);

w.document.querySelector('.nxd-nav button[data-view="catalog"]').click();
for (let i = 0; i < 3; i++) w.document.querySelectorAll('[data-add]:not(.added)')[0].click(); // list re-renders after each click
w.document.querySelector('.nxd-nav button[data-view="imports"]').click();
console.log('push panel visible:', $('nxd-push-ready').style.display !== 'none', '| store option:', $('nxd-push-store').textContent);
$('nxd-push-btn').click(); await tick(); await tick();
console.log('push results:', $('nxd-push-results').textContent.replace(/\s+/g, ' '), '| toast:', $('nxd-toast').textContent);
const created = up.calls.filter((c) => c.host === 'shop.example.com' && c.method === 'POST' && c.path === '/wp-json/wc/v3/products');
console.log('woo products created:', created.length, '| first price/regular:', created[0] && (created[0].body.regular_price || created[0].body.type));
w.document.querySelector('.nxd-nav button[data-view="mine"]').click(); await tick();
console.log('in your stores rows:', $('nxd-pushed-rows').querySelectorAll('tr').length, '| list now:', $('nxd-k-list').textContent);
