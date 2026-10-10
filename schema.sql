-- Nexra Connect database (Cloudflare D1 / SQLite).
-- Apply with: npx wrangler d1 execute nexra-connect --remote --file=schema.sql

-- The Nexra store itself (installed once, used to read products/customers and create draft orders).
CREATE TABLE IF NOT EXISTS supplier (
  shop TEXT PRIMARY KEY,
  token_enc TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  installed_at TEXT NOT NULL
);

-- A seller's connected store (Shopify or WooCommerce).
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,            -- Nexra customer (numeric id) who owns the connection
  platform TEXT NOT NULL CHECK (platform IN ('shopify', 'woo')),
  store_url TEXT NOT NULL,              -- myshopify domain or https://site
  name TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,        -- encrypted {token} or {key, secret}
  webhook_secret TEXT,                  -- WooCommerce webhook secret
  status TEXT NOT NULL DEFAULT 'active',-- active | disconnected
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_platform_store ON connections (platform, store_url);
CREATE INDEX IF NOT EXISTS connections_customer ON connections (customer_id);

-- A Nexra product pushed to a seller store.
CREATE TABLE IF NOT EXISTS product_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  source_product_id TEXT NOT NULL,      -- numeric Nexra product id
  target_product_id TEXT NOT NULL,      -- id in the seller's store
  title TEXT NOT NULL,
  image TEXT,
  pricing_json TEXT NOT NULL,           -- {discount, rule, customMarkup} used for syncing prices
  status TEXT NOT NULL DEFAULT 'active',-- active | paused (source unavailable) | removed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, source_product_id)
);
CREATE INDEX IF NOT EXISTS product_links_source ON product_links (source_product_id);
CREATE INDEX IF NOT EXISTS product_links_customer ON product_links (customer_id);

CREATE TABLE IF NOT EXISTS variant_links (
  product_link_id INTEGER NOT NULL,
  source_variant_id TEXT NOT NULL,
  target_variant_id TEXT,
  sku TEXT,
  PRIMARY KEY (product_link_id, source_variant_id)
);
CREATE INDEX IF NOT EXISTS variant_links_target ON variant_links (target_variant_id);

-- Orders from seller stores that contain Nexra products.
CREATE TABLE IF NOT EXISTS imported_orders (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  order_json TEXT NOT NULL,             -- normalized order incl. matched lines
  status TEXT NOT NULL DEFAULT 'new',   -- new | sent | cancelled
  draft_order_id TEXT,
  invoice_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS imported_orders_customer ON imported_orders (customer_id, status);
