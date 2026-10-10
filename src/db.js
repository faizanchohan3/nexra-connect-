// Small data-access layer over Cloudflare D1.
import { encryptJson, decryptJson, randomId } from './crypto.js';

const now = () => new Date().toISOString();

export function makeDb(env) {
  const DB = env.DB;
  const key = env.ENCRYPTION_KEY;

  return {
    // ---------- supplier ----------
    async saveSupplier(shop, token, scopes) {
      await DB.prepare(
        `INSERT INTO supplier (shop, token_enc, scopes, installed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(shop) DO UPDATE SET token_enc = excluded.token_enc, scopes = excluded.scopes, installed_at = excluded.installed_at`,
      ).bind(shop, await encryptJson(key, { token }), scopes, now()).run();
    },
    async getSupplier(shop) {
      const row = await DB.prepare('SELECT * FROM supplier WHERE shop = ?').bind(shop).first();
      if (!row) return null;
      return { shop: row.shop, token: (await decryptJson(key, row.token_enc)).token };
    },

    // ---------- connections ----------
    async upsertConnection({ customerId, platform, storeUrl, name, credentials, webhookSecret = null }) {
      const existing = await DB.prepare('SELECT id, customer_id FROM connections WHERE platform = ? AND store_url = ?').bind(platform, storeUrl).first();
      const creds = await encryptJson(key, credentials);
      if (existing) {
        if (existing.customer_id !== String(customerId)) {
          // A store can belong to one seller account; reconnecting from another account moves it.
          await DB.prepare('UPDATE product_links SET customer_id = ? WHERE connection_id = ?').bind(String(customerId), existing.id).run();
        }
        await DB.prepare(
          `UPDATE connections SET customer_id = ?, name = ?, credentials_enc = ?, webhook_secret = COALESCE(?, webhook_secret),
           status = 'active', updated_at = ? WHERE id = ?`,
        ).bind(String(customerId), name, creds, webhookSecret, now(), existing.id).run();
        return existing.id;
      }
      const id = randomId();
      await DB.prepare(
        `INSERT INTO connections (id, customer_id, platform, store_url, name, credentials_enc, webhook_secret, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(id, String(customerId), platform, storeUrl, name, creds, webhookSecret, now(), now()).run();
      return id;
    },
    async listConnections(customerId) {
      const { results } = await DB.prepare(
        `SELECT c.id, c.platform, c.store_url, c.name, c.status, c.created_at,
                (SELECT COUNT(*) FROM product_links p WHERE p.connection_id = c.id AND p.status != 'removed') AS products
         FROM connections c WHERE c.customer_id = ? AND c.status = 'active' ORDER BY c.created_at`,
      ).bind(String(customerId)).all();
      return results;
    },
    async getConnection(id) {
      const row = await DB.prepare('SELECT * FROM connections WHERE id = ?').bind(id).first();
      if (!row) return null;
      return { ...row, credentials: await decryptJson(key, row.credentials_enc) };
    },
    async getConnectionByStore(platform, storeUrl) {
      const row = await DB.prepare('SELECT * FROM connections WHERE platform = ? AND store_url = ?').bind(platform, storeUrl).first();
      if (!row) return null;
      return { ...row, credentials: await decryptJson(key, row.credentials_enc) };
    },
    async setConnectionStatus(id, status) {
      await DB.prepare('UPDATE connections SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
    },
    async deleteConnectionsForStore(platform, storeUrl) {
      const rows = (await DB.prepare('SELECT id FROM connections WHERE platform = ? AND store_url = ?').bind(platform, storeUrl).all()).results;
      for (const r of rows) {
        await DB.prepare('DELETE FROM variant_links WHERE product_link_id IN (SELECT id FROM product_links WHERE connection_id = ?)').bind(r.id).run();
        await DB.prepare('DELETE FROM product_links WHERE connection_id = ?').bind(r.id).run();
        await DB.prepare('DELETE FROM imported_orders WHERE connection_id = ?').bind(r.id).run();
        await DB.prepare('DELETE FROM connections WHERE id = ?').bind(r.id).run();
      }
    },

    // ---------- product links ----------
    async countDistinctProducts(customerId) {
      const row = await DB.prepare(
        "SELECT COUNT(DISTINCT source_product_id) AS n FROM product_links WHERE customer_id = ? AND status != 'removed'",
      ).bind(String(customerId)).first();
      return row ? Number(row.n) : 0;
    },
    async distinctProductIds(customerId) {
      const { results } = await DB.prepare(
        "SELECT DISTINCT source_product_id AS id FROM product_links WHERE customer_id = ? AND status != 'removed'",
      ).bind(String(customerId)).all();
      return results.map((r) => String(r.id));
    },
    async getProductLink(connectionId, sourceProductId) {
      return DB.prepare('SELECT * FROM product_links WHERE connection_id = ? AND source_product_id = ?').bind(connectionId, String(sourceProductId)).first();
    },
    async saveProductLink({ connectionId, customerId, sourceProductId, targetProductId, title, image, pricing, variants }) {
      const t = now();
      await DB.prepare(
        `INSERT INTO product_links (connection_id, customer_id, source_product_id, target_product_id, title, image, pricing_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(connection_id, source_product_id) DO UPDATE SET target_product_id = excluded.target_product_id, title = excluded.title,
           image = excluded.image, pricing_json = excluded.pricing_json, status = 'active', updated_at = excluded.updated_at`,
      ).bind(connectionId, String(customerId), String(sourceProductId), String(targetProductId), title, image || null, JSON.stringify(pricing), t, t).run();
      const link = await this.getProductLink(connectionId, sourceProductId);
      await DB.prepare('DELETE FROM variant_links WHERE product_link_id = ?').bind(link.id).run();
      for (const v of variants) {
        await DB.prepare('INSERT INTO variant_links (product_link_id, source_variant_id, target_variant_id, sku) VALUES (?, ?, ?, ?)')
          .bind(link.id, String(v.sourceVariantId), v.targetVariantId ? String(v.targetVariantId) : null, v.sku || null).run();
      }
      return link.id;
    },
    async listProductLinks(customerId) {
      const { results } = await DB.prepare(
        `SELECT p.id, p.connection_id, p.source_product_id, p.target_product_id, p.title, p.image, p.status, p.created_at, p.updated_at,
                c.platform, c.name AS store_name, c.store_url
         FROM product_links p JOIN connections c ON c.id = p.connection_id
         WHERE p.customer_id = ? AND p.status != 'removed' ORDER BY p.updated_at DESC LIMIT 500`,
      ).bind(String(customerId)).all();
      return results;
    },
    async linksForSource(sourceProductId, limit = 40) {
      const { results } = await DB.prepare(
        `SELECT p.*, c.platform, c.store_url, c.credentials_enc, c.status AS connection_status
         FROM product_links p JOIN connections c ON c.id = p.connection_id
         WHERE p.source_product_id = ? AND p.status != 'removed' AND c.status = 'active' LIMIT ?`,
      ).bind(String(sourceProductId), limit).all();
      const out = [];
      for (const r of results) out.push({ ...r, credentials: await decryptJson(key, r.credentials_enc) });
      return out;
    },
    async variantLinks(productLinkId) {
      const { results } = await DB.prepare('SELECT * FROM variant_links WHERE product_link_id = ?').bind(productLinkId).all();
      return results;
    },
    async variantLinksForConnection(connectionId) {
      const { results } = await DB.prepare(
        'SELECT v.* FROM variant_links v JOIN product_links p ON p.id = v.product_link_id WHERE p.connection_id = ?',
      ).bind(connectionId).all();
      return results;
    },
    async setProductLinkStatus(id, status) {
      await DB.prepare('UPDATE product_links SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
    },

    // ---------- imported orders ----------
    async saveImportedOrder({ connectionId, customerId, order }) {
      const id = randomId();
      const t = now();
      const res = await DB.prepare(
        `INSERT INTO imported_orders (id, connection_id, customer_id, external_id, name, order_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?) ON CONFLICT(connection_id, external_id) DO NOTHING`,
      ).bind(id, connectionId, String(customerId), order.externalId, order.name, JSON.stringify(order), t, t).run();
      return res.meta && res.meta.changes ? id : null;
    },
    async listImportedOrders(customerId) {
      const { results } = await DB.prepare(
        `SELECT o.id, o.name, o.status, o.invoice_url, o.order_json, o.created_at, c.name AS store_name, c.platform
         FROM imported_orders o JOIN connections c ON c.id = o.connection_id
         WHERE o.customer_id = ? ORDER BY o.created_at DESC LIMIT 200`,
      ).bind(String(customerId)).all();
      return results.map((r) => ({ ...r, order: JSON.parse(r.order_json), order_json: undefined }));
    },
    async getImportedOrder(id) {
      const row = await DB.prepare('SELECT * FROM imported_orders WHERE id = ?').bind(id).first();
      return row ? { ...row, order: JSON.parse(row.order_json) } : null;
    },
    async deleteOrdersByExternalIds(connectionId, externalIds) {
      for (const ext of externalIds) {
        await DB.prepare('DELETE FROM imported_orders WHERE connection_id = ? AND external_id = ?').bind(connectionId, String(ext)).run();
      }
    },
    async markOrderSent(id, draftOrderId, invoiceUrl) {
      await DB.prepare("UPDATE imported_orders SET status = 'sent', draft_order_id = ?, invoice_url = ?, updated_at = ? WHERE id = ?")
        .bind(draftOrderId, invoiceUrl, now(), id).run();
    },
  };
}
