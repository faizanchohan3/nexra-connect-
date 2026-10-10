// Push products, keep prices in sync, import orders and send them to Nexra.
import {
  adminClient, userErrors, gid, numericId,
  Q_SOURCE_PRODUCTS, M_PRODUCT_SET, M_VARIANT_PRICES, M_PRODUCT_STATUS, M_DRAFT_ORDER, Q_CUSTOMER,
} from './shopify.js';
import { wooClient } from './woo.js';
import { PLANS, planFromTags, normalizeRule, sellPrice, money } from './pricing.js';
import { toShopifyProductSet, toWooProduct, variantsOf, images, normalizeOrder, matchOrderLines, toDraftOrderInput } from './mapping.js';

export class UserError extends Error {
  name = 'UserError';
}

// Cloudflare limits outbound requests per invocation, so the dashboard sends
// products in small batches.
export const MAX_PER_REQUEST = 10;

export async function supplierGql(env, db, fetchImpl) {
  const supplier = await db.getSupplier(env.SUPPLIER_SHOP);
  if (!supplier) throw new UserError('Nexra Connect is not set up yet. Please contact Nexra support.');
  return adminClient({ shop: supplier.shop, token: supplier.token, apiVersion: env.API_VERSION, fetchImpl });
}

export function connectionClient(env, connection, fetchImpl) {
  if (connection.platform === 'shopify') {
    return adminClient({ shop: connection.store_url, token: connection.credentials.token, apiVersion: env.API_VERSION, fetchImpl });
  }
  return wooClient({ site: connection.store_url, key: connection.credentials.key, secret: connection.credentials.secret, fetchImpl });
}

export async function customerPlan(gql, customerId) {
  const data = await gql(Q_CUSTOMER, { id: gid('Customer', customerId) });
  const tags = (data.customer && data.customer.tags) || [];
  const key = planFromTags(tags);
  return { key, ...PLANS[key], firstName: (data.customer && data.customer.firstName) || '' };
}

export async function fetchSourceProducts(gql, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map((id) => gid('Product', id));
    const data = await gql(Q_SOURCE_PRODUCTS, { ids: chunk });
    for (const node of data.nodes || []) if (node && node.id) out.set(numericId(node.id), node);
  }
  return out;
}

// ---------- push ----------

export async function pushProducts({ env, db, customerId, connectionId, items, rule, fetchImpl = fetch }) {
  const connection = await db.getConnection(connectionId);
  if (!connection || connection.customer_id !== String(customerId) || connection.status !== 'active') {
    throw new UserError('That store is not connected to your account.');
  }
  const clean = [];
  const seen = new Set();
  for (const it of items || []) {
    const id = String((it && it.id) || '').replace(/\D/g, '');
    if (id && !seen.has(id)) { seen.add(id); clean.push({ id, markup: it.markup }); }
  }
  if (!clean.length) throw new UserError('Choose at least one product.');
  if (clean.length > MAX_PER_REQUEST) throw new UserError(`Send at most ${MAX_PER_REQUEST} products per request.`);

  const gql = await supplierGql(env, db, fetchImpl);
  const plan = await customerPlan(gql, customerId);
  if (plan.totalProducts != null) {
    const already = new Set(await db.distinctProductIds(customerId));
    clean.forEach((c) => already.add(c.id));
    if (already.size > plan.totalProducts) {
      throw new UserError(`Your ${plan.name} plan includes ${plan.totalProducts} products. Upgrade your plan to add more.`);
    }
  }

  const sources = await fetchSourceProducts(gql, clean.map((c) => c.id));
  const target = connectionClient(env, connection, fetchImpl);
  const baseRule = normalizeRule(rule);
  const results = [];

  for (const item of clean) {
    const product = sources.get(item.id);
    if (!product || product.status !== 'ACTIVE') {
      results.push({ id: item.id, ok: false, error: 'This product is no longer available.' });
      continue;
    }
    const pricing = { discount: plan.discount, rule: baseRule, customMarkup: item.markup ?? '' };
    try {
      const existing = await db.getProductLink(connection.id, item.id);
      if (existing && existing.status !== 'removed') {
        await syncLinkPrices(env, db, { ...existing, platform: connection.platform, credentials: connection.credentials, store_url: connection.store_url, pricing_json: JSON.stringify(pricing) }, product, fetchImpl);
        await db.saveProductLink({
          connectionId: connection.id, customerId, sourceProductId: item.id, targetProductId: existing.target_product_id,
          title: product.title, image: (images(product)[0] || {}).url, pricing,
          variants: (await db.variantLinks(existing.id)).map((v) => ({ sourceVariantId: v.source_variant_id, targetVariantId: v.target_variant_id, sku: v.sku })),
        });
        results.push({ id: item.id, ok: true, updated: true, title: product.title });
        continue;
      }
      const created = connection.platform === 'shopify'
        ? await createInShopify(target, product, pricing)
        : await createInWoo(target, product, pricing);
      await db.saveProductLink({
        connectionId: connection.id, customerId, sourceProductId: item.id, targetProductId: created.productId,
        title: product.title, image: (images(product)[0] || {}).url, pricing, variants: created.variants,
      });
      results.push({ id: item.id, ok: true, title: product.title, targetProductId: created.productId });
    } catch (err) {
      results.push({ id: item.id, ok: false, title: product.title, error: err.message });
    }
  }
  return { plan: plan.key, results };
}

function pairVariants(sourceVariants, targetVariants) {
  // Match by SKU first, then by position.
  const bySku = new Map(targetVariants.filter((t) => t.sku).map((t) => [t.sku, t]));
  return sourceVariants.map((sv, i) => {
    const tv = (sv.sku && bySku.get(sv.sku)) || targetVariants[i] || {};
    return { sourceVariantId: numericId(sv.id), targetVariantId: tv.id ? numericId(tv.id) : null, sku: sv.sku || null };
  });
}

async function createInShopify(gql, product, pricing) {
  const data = await gql(M_PRODUCT_SET, { input: toShopifyProductSet(product, pricing) });
  const err = userErrors(data.productSet);
  if (err) throw new UserError(err);
  const created = data.productSet.product;
  return { productId: numericId(created.id), variants: pairVariants(variantsOf(product), created.variants.nodes) };
}

async function createInWoo(call, product, pricing) {
  const payload = toWooProduct(product, pricing);
  const created = await call('POST', '/products', payload.product);
  if (!payload.variations.length) {
    const v = variantsOf(product)[0] || {};
    return { productId: String(created.id), variants: [{ sourceVariantId: numericId(v.id || ''), targetVariantId: String(created.id), sku: v.sku || null }] };
  }
  const batch = await call('POST', `/products/${created.id}/variations/batch`, { create: payload.variations });
  const made = (batch.create || []).map((v) => ({ id: v.id ? String(v.id) : null, sku: v.sku || '' }));
  return { productId: String(created.id), variants: pairVariants(variantsOf(product), made) };
}

// ---------- price / availability sync ----------

// Update one pushed product from the current Nexra product (GraphQL node or webhook payload).
export async function syncLinkPrices(env, db, link, source, fetchImpl = fetch) {
  const pricing = JSON.parse(link.pricing_json);
  const vlinks = await db.variantLinks(link.id);
  const priceBySource = new Map();
  const srcVariants = source.variants && source.variants.nodes ? source.variants.nodes : source.variants || [];
  for (const v of srcVariants) priceBySource.set(numericId(v.id), money(sellPrice(v.price, pricing.discount, pricing.rule, pricing.customMarkup)));
  const updates = vlinks
    .filter((v) => v.target_variant_id && priceBySource.has(String(v.source_variant_id)))
    .map((v) => ({ id: v.target_variant_id, price: priceBySource.get(String(v.source_variant_id)) }));
  const sourceActive = String(source.status || 'active').toLowerCase() === 'active';
  const client = connectionClient(env, { platform: link.platform, store_url: link.store_url, credentials: link.credentials }, fetchImpl);

  if (link.platform === 'shopify') {
    const productId = gid('Product', link.target_product_id);
    if (updates.length) {
      const data = await client(M_VARIANT_PRICES, { productId, variants: updates.map((u) => ({ id: gid('ProductVariant', u.id), price: u.price })) });
      const err = userErrors(data.productVariantsBulkUpdate);
      if (err) throw new UserError(err);
    }
    if (!sourceActive && link.status === 'active') {
      await client(M_PRODUCT_STATUS, { product: { id: productId, status: 'DRAFT' } });
      await db.setProductLinkStatus(link.id, 'paused');
    } else if (sourceActive && link.status === 'paused') {
      await client(M_PRODUCT_STATUS, { product: { id: productId, status: 'ACTIVE' } });
      await db.setProductLinkStatus(link.id, 'active');
    }
    return updates.length;
  }

  // WooCommerce
  const isSimple = updates.length === 1 && updates[0].id === String(link.target_product_id);
  if (isSimple) {
    await client('PUT', `/products/${link.target_product_id}`, { regular_price: updates[0].price, status: sourceActive ? 'publish' : 'draft' });
  } else {
    if (updates.length) {
      await client('POST', `/products/${link.target_product_id}/variations/batch`, { update: updates.map((u) => ({ id: Number(u.id), regular_price: u.price })) });
    }
    if (sourceActive !== (link.status === 'active')) {
      await client('PUT', `/products/${link.target_product_id}`, { status: sourceActive ? 'publish' : 'draft' });
    }
  }
  if (!sourceActive && link.status === 'active') await db.setProductLinkStatus(link.id, 'paused');
  if (sourceActive && link.status === 'paused') await db.setProductLinkStatus(link.id, 'active');
  return updates.length;
}

// Nexra store "products/update" webhook (REST payload).
export async function onSupplierProductUpdate(env, db, body, fetchImpl = fetch) {
  const links = await db.linksForSource(String(body.id));
  let ok = 0;
  for (const link of links) {
    try {
      await syncLinkPrices(env, db, link, body, fetchImpl);
      ok++;
    } catch (err) {
      console.log(`sync failed for link ${link.id}: ${err.message}`);
    }
  }
  return { links: links.length, updated: ok };
}

export async function onSupplierProductDelete(env, db, body, fetchImpl = fetch) {
  return onSupplierProductUpdate(env, db, { id: body.id, status: 'archived', variants: [] }, fetchImpl);
}

// ---------- orders ----------

export async function onSellerOrder(db, connection, platform, body) {
  const order = normalizeOrder(platform, body);
  const lines = matchOrderLines(order, await db.variantLinksForConnection(connection.id));
  if (!lines.length) return null; // no Nexra products in this order
  return db.saveImportedOrder({ connectionId: connection.id, customerId: connection.customer_id, order: { ...order, lines } });
}

export async function sendOrderToNexra({ env, db, customerId, orderId, fetchImpl = fetch }) {
  const row = await db.getImportedOrder(orderId);
  if (!row || row.customer_id !== String(customerId)) throw new UserError('Order not found.');
  if (row.status === 'sent' && row.invoice_url) return { invoiceUrl: row.invoice_url, alreadySent: true };
  const connection = await db.getConnection(row.connection_id);
  const gql = await supplierGql(env, db, fetchImpl);
  const plan = await customerPlan(gql, customerId);
  const input = toDraftOrderInput({
    order: row.order, lines: row.order.lines, customerGid: gid('Customer', customerId),
    discount: plan.discount, storeName: connection ? connection.name : 'seller store',
  });
  const data = await gql(M_DRAFT_ORDER, { input });
  const err = userErrors(data.draftOrderCreate);
  if (err) throw new UserError(err);
  const draft = data.draftOrderCreate.draftOrder;
  await db.markOrderSent(orderId, numericId(draft.id), draft.invoiceUrl);
  return { invoiceUrl: draft.invoiceUrl, draftOrder: draft.name, total: draft.totalPriceSet && draft.totalPriceSet.shopMoney };
}
