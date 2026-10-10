// Turn a Nexra product into the seller's store format, and a seller's order
// into a Nexra draft order.
import { sellPrice, money, normalizeRule } from './pricing.js';

// Internal and supplier tags never travel to the seller's store.
const HIDDEN_TAG = /^(nexra-plan|membership|subscription|usadrop.*|saleyee.*|sku-.*)$/i;

export function cleanTags(tags = []) {
  return tags.filter((t) => !HIDDEN_TAG.test(String(t).trim()));
}

export function isDefaultOnly(product) {
  const opts = product.options || [];
  return opts.length === 0 || (opts.length === 1 && opts[0].name === 'Title' && (opts[0].values || []).every((v) => /^default/i.test(v)));
}

export function images(product) {
  return ((product.media && product.media.nodes) || [])
    .map((m) => m && m.image)
    .filter((i) => i && i.url)
    .slice(0, 10);
}

export function variantsOf(product) {
  return (product.variants && product.variants.nodes) || [];
}

// ---------- Shopify ----------

export function toShopifyProductSet(product, { discount, rule, customMarkup }) {
  const r = normalizeRule(rule);
  const variants = variantsOf(product);
  const def = isDefaultOnly(product);
  const productOptions = def
    ? [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }]
    : product.options.map((o, i) => ({ name: o.name, position: i + 1, values: o.values.map((v) => ({ name: v })) }));

  return {
    title: product.title,
    descriptionHtml: product.descriptionHtml || '',
    vendor: r.brand || undefined,
    productType: product.productType || undefined,
    tags: cleanTags(product.tags || []),
    status: 'ACTIVE',
    productOptions,
    files: images(product).map((img) => ({ originalSource: img.url, contentType: 'IMAGE', alt: img.altText || product.title })),
    variants: variants.map((v) => ({
      optionValues: def
        ? [{ optionName: 'Title', name: 'Default Title' }]
        : (v.selectedOptions || []).map((o) => ({ optionName: o.name, name: o.value })),
      price: money(sellPrice(v.price, discount, r, customMarkup)),
      sku: v.sku || undefined,
      inventoryPolicy: 'CONTINUE',
    })),
  };
}

// ---------- WooCommerce ----------

export function toWooProduct(product, { discount, rule, customMarkup }) {
  const r = normalizeRule(rule);
  const variants = variantsOf(product);
  const imgs = images(product).map((i) => ({ src: i.url, alt: i.altText || product.title }));
  const tags = cleanTags(product.tags || []).map((name) => ({ name }));
  const categories = product.productType ? [{ name: product.productType }] : [];
  const meta = r.brand ? [{ key: '_nexra_brand', value: r.brand }] : [];

  if (isDefaultOnly(product)) {
    const v = variants[0] || {};
    return {
      product: {
        name: product.title, type: 'simple', status: 'publish', description: product.descriptionHtml || '',
        regular_price: money(sellPrice(v.price, discount, r, customMarkup)), sku: v.sku || '',
        images: imgs, tags, categories, meta_data: meta,
      },
      variations: [],
    };
  }
  return {
    product: {
      name: product.title, type: 'variable', status: 'publish', description: product.descriptionHtml || '',
      images: imgs, tags, categories, meta_data: meta,
      attributes: product.options.map((o, i) => ({ name: o.name, position: i, visible: true, variation: true, options: o.values })),
    },
    variations: variants.map((v) => ({
      regular_price: money(sellPrice(v.price, discount, r, customMarkup)),
      sku: v.sku || '',
      attributes: (v.selectedOptions || []).map((o) => ({ name: o.name, option: o.value })),
    })),
  };
}

// ---------- Orders ----------

// Normalize an incoming order (Shopify or WooCommerce webhook) to one shape.
export function normalizeOrder(platform, body) {
  if (platform === 'shopify') {
    const a = body.shipping_address || {};
    return {
      externalId: String(body.id),
      name: body.name || `#${body.order_number || body.id}`,
      createdAt: body.created_at || new Date().toISOString(),
      shipping: {
        firstName: a.first_name || '', lastName: a.last_name || '', company: a.company || '',
        address1: a.address1 || '', address2: a.address2 || '', city: a.city || '',
        provinceCode: a.province_code || '', zip: a.zip || '', countryCode: a.country_code || '', phone: a.phone || '',
      },
      lines: (body.line_items || []).map((l) => ({
        sku: l.sku || '', title: l.title || l.name || '', variantTitle: l.variant_title || '',
        quantity: Number(l.quantity) || 1, targetVariantId: l.variant_id ? String(l.variant_id) : '',
      })),
    };
  }
  const s = body.shipping && body.shipping.address_1 ? body.shipping : body.billing || {};
  return {
    externalId: String(body.id),
    name: `#${body.number || body.id}`,
    createdAt: body.date_created_gmt ? `${body.date_created_gmt}Z` : new Date().toISOString(),
    shipping: {
      firstName: s.first_name || '', lastName: s.last_name || '', company: s.company || '',
      address1: s.address_1 || '', address2: s.address_2 || '', city: s.city || '',
      provinceCode: s.state || '', zip: s.postcode || '', countryCode: s.country || '', phone: s.phone || (body.billing && body.billing.phone) || '',
    },
    lines: (body.line_items || []).map((l) => ({
      sku: l.sku || '', title: l.name || '', variantTitle: '',
      quantity: Number(l.quantity) || 1, targetVariantId: l.variation_id ? String(l.variation_id) : String(l.product_id || ''),
    })),
  };
}

// Keep only lines that are Nexra products, resolved to Nexra variant ids.
// variantLinks: [{ source_variant_id, target_variant_id, sku }]
export function matchOrderLines(order, variantLinks) {
  const byTarget = new Map();
  const bySku = new Map();
  for (const l of variantLinks) {
    if (l.target_variant_id) byTarget.set(String(l.target_variant_id), l);
    if (l.sku) bySku.set(String(l.sku), l);
  }
  const out = [];
  for (const line of order.lines) {
    const link = byTarget.get(line.targetVariantId) || (line.sku && bySku.get(line.sku));
    if (link) out.push({ ...line, sourceVariantId: String(link.source_variant_id) });
  }
  return out;
}

export function toDraftOrderInput({ order, lines, customerGid, discount, storeName }) {
  const s = order.shipping;
  const address = {
    firstName: s.firstName, lastName: s.lastName, company: s.company || undefined,
    address1: s.address1, address2: s.address2 || undefined, city: s.city,
    provinceCode: s.provinceCode || undefined, zip: s.zip, countryCode: s.countryCode || undefined, phone: s.phone || undefined,
  };
  const input = {
    lineItems: lines.map((l) => ({ variantId: `gid://shopify/ProductVariant/${l.sourceVariantId}`, quantity: l.quantity })),
    shippingAddress: address,
    purchasingEntity: { customerId: customerGid },
    note: `Reseller order ${order.name} from ${storeName}. Ship in plain packaging, no Nexra invoice.`,
    tags: ['nexra-reseller-order'],
    customAttributes: [
      { key: 'Reseller store', value: storeName },
      { key: 'Reseller order', value: order.name },
    ],
  };
  if (discount > 0) input.appliedDiscount = { title: 'Reseller discount', value: discount, valueType: 'PERCENTAGE' };
  return input;
}
