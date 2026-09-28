CREATE TABLE IF NOT EXISTS users (
  google_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  items TEXT NOT NULL,
  status TEXT NOT NULL,
  cashfree_session TEXT,
  shopify_order_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_google_sub ON orders(google_sub);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);