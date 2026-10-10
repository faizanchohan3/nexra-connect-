// Nexra Connect: Cloudflare Worker entry point.
//
//   /proxy/api/*         Seller dashboard API, reached as nexrallc.com/apps/nexra/api/* through a
//                        Shopify app proxy (Shopify signs every request and adds the logged-in customer).
//   /install             Install / open the app (Nexra store install, or sellers opening it from their admin).
//   /auth/callback       Shopify OAuth callback.
//   /webhooks/shopify    Shopify webhooks (Nexra store product changes, seller orders, uninstall, GDPR).
//   /webhooks/woo/:id    WooCommerce order webhooks.
import { verifyProxy, verifyOAuthQuery, verifyWebhook, normalizeShop, authorizeUrl, exchangeCode, adminClient, registerWebhooks, SELLER_SCOPES, SUPPLIER_SCOPES } from './shopify.js';
import { normalizeSiteUrl, wooClient, verifyWooWebhook } from './woo.js';
import { signToken, verifyToken, randomId } from './crypto.js';
import { makeDb } from './db.js';
import {
  UserError, MAX_PER_REQUEST, supplierGql, customerPlan, pushProducts,
  onSupplierProductUpdate, onSupplierProductDelete, onSellerOrder, sendOrderToNexra,
} from './services.js';

const DEFAULT_API_VERSION = '2025-07';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const html = (body, status = 200) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexra Connect</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f9;color:#1b2440;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.c{background:#fff;border:1px solid #e3e6ee;border-radius:16px;padding:32px;max-width:480px;text-align:center}a.b{display:inline-block;margin-top:16px;background:#1b2440;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700}</style>
</head><body><div class="c">${body}</div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

const redirect = (url) => Response.redirect(url, 302);

function config(env) {
  for (const k of ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'ENCRYPTION_KEY', 'APP_URL', 'SUPPLIER_SHOP', 'STOREFRONT_URL']) {
    if (!env[k]) throw new Error(`Missing setting ${k}`);
  }
  return { ...env, API_VERSION: env.API_VERSION || DEFAULT_API_VERSION, APP_URL: env.APP_URL.replace(/\/+$/, ''), STOREFRONT_URL: env.STOREFRONT_URL.replace(/\/+$/, '') };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request, rawEnv, ctx) {
    let env;
    try {
      env = config(rawEnv);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const db = makeDb(env);
    try {
      if (path.startsWith('/proxy/')) return await handleProxy(request, env, db, url, path.slice('/proxy'.length));
      if (path === '/install' || path === '/') return await handleInstall(request, env, db, url);
      if (path === '/auth/callback') return await handleCallback(request, env, db, url);
      if (path === '/webhooks/shopify' && request.method === 'POST') return await handleShopifyWebhook(request, env, db, ctx);
      const woo = path.match(/^\/webhooks\/woo\/([A-Za-z0-9_-]+)$/);
      if (woo && request.method === 'POST') return await handleWooWebhook(request, env, db, woo[1], ctx);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      if (err instanceof UserError || err.name === 'ShopifyError' || err.name === 'WooError') return json({ error: err.message }, 400);
      console.log(`error on ${path}: ${err.stack || err.message}`);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};

// ---------- seller dashboard API (via app proxy) ----------

async function handleProxy(request, env, db, url, path) {
  if (!(await verifyProxy(request.url, env.SHOPIFY_API_SECRET))) return json({ error: 'Invalid signature' }, 401);
  if (url.searchParams.get('shop') !== env.SUPPLIER_SHOP) return json({ error: 'Unknown store' }, 403);
  const customerId = url.searchParams.get('logged_in_customer_id');
  if (!customerId) return json({ error: 'Please log in to your Nexra seller account.' }, 401);
  const m = request.method;

  if (path === '/api/status' && m === 'GET') {
    const gql = await supplierGql(env, db);
    const plan = await customerPlan(gql, customerId);
    return json({
      plan: { key: plan.key, name: plan.name, discount: plan.discount, perPush: plan.perPush, totalProducts: plan.totalProducts },
      productsUsed: await db.countDistinctProducts(customerId),
      connections: await db.listConnections(customerId),
      maxPerRequest: MAX_PER_REQUEST,
    });
  }

  if (path === '/api/connect/shopify' && m === 'POST') {
    const body = await readJson(request);
    const shop = normalizeShop(body.shop);
    if (!shop) throw new UserError('Enter your Shopify store address, for example mystore.myshopify.com');
    if (shop === env.SUPPLIER_SHOP) throw new UserError('That is the Nexra store. Enter your own store address.');
    const state = await signToken(env.SHOPIFY_API_SECRET, { k: 'seller', c: String(customerId), s: shop, n: randomId(8), exp: Date.now() + 15 * 60 * 1000 });
    return json({ redirect: authorizeUrl({ shop, apiKey: env.SHOPIFY_API_KEY, scopes: SELLER_SCOPES, redirectUri: `${env.APP_URL}/auth/callback`, state }) });
  }

  if (path === '/api/connect/woo' && m === 'POST') {
    const body = await readJson(request);
    const site = normalizeSiteUrl(body.url);
    const key = String(body.key || '').trim();
    const secret = String(body.secret || '').trim();
    if (!site) throw new UserError('Enter your store address starting with https://');
    if (!/^ck_[A-Za-z0-9]+$/.test(key) || !/^cs_[A-Za-z0-9]+$/.test(secret)) throw new UserError('Paste the Consumer key (ck_…) and Consumer secret (cs_…) from WooCommerce.');
    const call = wooClient({ site, key, secret });
    await call('GET', '/products?per_page=1'); // proves the keys work
    const webhookSecret = randomId(24);
    const id = await db.upsertConnection({ customerId, platform: 'woo', storeUrl: site, name: new URL(site).host, credentials: { key, secret }, webhookSecret });
    try {
      await call('POST', '/webhooks', { name: 'Nexra order import', topic: 'order.created', delivery_url: `${env.APP_URL}/webhooks/woo/${id}`, secret: webhookSecret });
    } catch (err) {
      await db.setConnectionStatus(id, 'disconnected');
      throw new UserError(`Connected, but WooCommerce refused to create the order webhook. Make sure the keys have Read/Write permission. (${err.message})`);
    }
    return json({ ok: true, id, connections: await db.listConnections(customerId) });
  }

  if (path === '/api/disconnect' && m === 'POST') {
    const { id } = await readJson(request);
    const c = id && (await db.getConnection(String(id)));
    if (!c || c.customer_id !== String(customerId)) throw new UserError('Store not found.');
    await db.setConnectionStatus(c.id, 'disconnected');
    return json({ ok: true, connections: await db.listConnections(customerId) });
  }

  if (path === '/api/products' && m === 'GET') return json({ products: await db.listProductLinks(customerId) });

  if (path === '/api/push' && m === 'POST') {
    const body = await readJson(request);
    return json(await pushProducts({ env, db, customerId, connectionId: String(body.connectionId || ''), items: body.items, rule: body.rule }));
  }

  if (path === '/api/orders' && m === 'GET') return json({ orders: await db.listImportedOrders(customerId) });

  if (path === '/api/orders/send' && m === 'POST') {
    const { id } = await readJson(request);
    return json(await sendOrderToNexra({ env, db, customerId, orderId: String(id || '') }));
  }

  return json({ error: 'Not found' }, 404);
}

// ---------- install / OAuth ----------

async function handleInstall(request, env, db, url) {
  const shop = normalizeShop(url.searchParams.get('shop'));
  if (!shop) return html('<h2>Nexra Connect</h2><p>Connect your store from your Nexra Seller Dashboard.</p>' + `<a class="b" href="${env.STOREFRONT_URL}/pages/reseller-dashboard#stores">Open Seller Dashboard</a>`);
  if (url.searchParams.has('hmac') && !(await verifyOAuthQuery(request.url, env.SHOPIFY_API_SECRET))) return html('<h2>Invalid request</h2>', 401);

  if (shop === env.SUPPLIER_SHOP) {
    const state = await signToken(env.SHOPIFY_API_SECRET, { k: 'supplier', s: shop, n: randomId(8), exp: Date.now() + 15 * 60 * 1000 });
    return redirect(authorizeUrl({ shop, apiKey: env.SHOPIFY_API_KEY, scopes: SUPPLIER_SCOPES, redirectUri: `${env.APP_URL}/auth/callback`, state }));
  }
  const existing = await db.getConnectionByStore('shopify', shop);
  if (existing && existing.status === 'active') return redirect(`${env.STOREFRONT_URL}/pages/reseller-dashboard#stores`);
  return html(`<h2>Almost there</h2><p>To connect <b>${shop}</b>, log in to your Nexra Seller Dashboard and click <b>Connect Shopify store</b>.</p><a class="b" href="${env.STOREFRONT_URL}/pages/reseller-dashboard#stores">Open Seller Dashboard</a>`);
}

async function handleCallback(request, env, db, url) {
  if (!(await verifyOAuthQuery(request.url, env.SHOPIFY_API_SECRET))) return html('<h2>Invalid request</h2><p>Please try connecting again.</p>', 401);
  const shop = normalizeShop(url.searchParams.get('shop'));
  const state = await verifyToken(env.SHOPIFY_API_SECRET, url.searchParams.get('state'));
  if (!shop || !state || state.s !== shop) {
    return html(`<h2>Link expired</h2><p>Please start again from your Nexra Seller Dashboard.</p><a class="b" href="${env.STOREFRONT_URL}/pages/reseller-dashboard#stores">Open Seller Dashboard</a>`, 400);
  }
  const { token, scope } = await exchangeCode({ shop, apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET, code: url.searchParams.get('code') });
  const gql = adminClient({ shop, token, apiVersion: env.API_VERSION });
  const hookUri = `${env.APP_URL}/webhooks/shopify`;

  if (state.k === 'supplier' && shop === env.SUPPLIER_SHOP) {
    await db.saveSupplier(shop, token, scope);
    const failed = await registerWebhooks(gql, hookUri, ['PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED']);
    return html(`<h2>Nexra Connect is installed</h2><p>Your Nexra store is connected. Sellers can now push products to their stores.</p>${failed.length ? `<p style="color:#c8101a">Webhook setup issues: ${failed.join(', ')}</p>` : ''}<a class="b" href="https://${shop}/admin">Back to Shopify admin</a>`);
  }

  if (state.k === 'seller' && state.c) {
    await db.upsertConnection({ customerId: state.c, platform: 'shopify', storeUrl: shop, name: shop.replace('.myshopify.com', ''), credentials: { token } });
    await registerWebhooks(gql, hookUri, ['ORDERS_CREATE', 'APP_UNINSTALLED']);
    return redirect(`${env.STOREFRONT_URL}/pages/reseller-dashboard#stores`);
  }
  return html('<h2>Invalid request</h2>', 400);
}

// ---------- webhooks ----------

async function handleShopifyWebhook(request, env, db, ctx) {
  const raw = await request.text();
  if (!(await verifyWebhook(raw, request.headers.get('x-shopify-hmac-sha256'), env.SHOPIFY_API_SECRET))) return new Response('Unauthorized', { status: 401 });
  const topic = request.headers.get('x-shopify-topic') || '';
  const shop = normalizeShop(request.headers.get('x-shopify-shop-domain'));
  let body = {};
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    /* empty */
  }
  const isSupplier = shop === env.SUPPLIER_SHOP;
  const work = (async () => {
    if (isSupplier && topic === 'products/update') return onSupplierProductUpdate(env, db, body);
    if (isSupplier && topic === 'products/delete') return onSupplierProductDelete(env, db, body);
    if (!isSupplier && topic === 'orders/create') {
      const c = await db.getConnectionByStore('shopify', shop);
      if (c && c.status === 'active') return onSellerOrder(db, c, 'shopify', body);
      return null;
    }
    if (topic === 'app/uninstalled') {
      if (isSupplier) return null; // keep data; reinstalling restores service
      const c = await db.getConnectionByStore('shopify', shop);
      if (c) await db.setConnectionStatus(c.id, 'disconnected');
      return null;
    }
    // Mandatory privacy webhooks. Nexra Connect stores no seller-customer data beyond
    // order shipping details, which are removed with the store.
    if (topic === 'shop/redact') return db.deleteConnectionsForStore('shopify', shop);
    if (topic === 'customers/redact' && !isSupplier) {
      const c = await db.getConnectionByStore('shopify', shop);
      if (c) await db.deleteOrdersByExternalIds(c.id, body.orders_to_redact || []);
      return null;
    }
    return null; // customers/data_request: the store owner answers it; we only hold the order lines shown in their dashboard
  })().catch((err) => console.log(`webhook ${topic} failed: ${err.message}`));
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  else await work;
  return new Response('ok');
}

async function handleWooWebhook(request, env, db, connectionId, ctx) {
  const raw = await request.text();
  const connection = await db.getConnection(connectionId);
  if (!connection || connection.platform !== 'woo') return new Response('Unknown', { status: 404 });
  // WooCommerce pings a new webhook with a form-encoded body and no signature.
  if (!request.headers.get('x-wc-webhook-signature')) return new Response('ok');
  if (!(await verifyWooWebhook(raw, request.headers.get('x-wc-webhook-signature'), connection.webhook_secret))) return new Response('Unauthorized', { status: 401 });
  const topic = request.headers.get('x-wc-webhook-topic') || '';
  if (topic === 'order.created' && connection.status === 'active') {
    const work = onSellerOrder(db, connection, 'woo', JSON.parse(raw)).catch((err) => console.log(`woo order failed: ${err.message}`));
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    else await work;
  }
  return new Response('ok');
}
