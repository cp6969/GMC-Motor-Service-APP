const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'motors.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS service_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_number TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    dealer_name TEXT,
    dealer_contact TEXT,
    date_received TEXT,
    date_completed TEXT,
    status TEXT NOT NULL DEFAULT 'received',
    issue_reported TEXT,
    work_performed TEXT,
    parts_replaced TEXT,
    technician TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS service_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    caption TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (record_id) REFERENCES service_records(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS dealers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    contact TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lightspeed_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TEXT,
    connected_at TEXT
  );

  CREATE TABLE IF NOT EXISTS parts_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT,
    description TEXT NOT NULL,
    cost NUMERIC,
    retail_price NUMERIC,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS quote_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL,
    sku TEXT,
    description TEXT NOT NULL,
    unit_price NUMERIC NOT NULL,
    quantity NUMERIC NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (record_id) REFERENCES service_records(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_serial ON service_records(serial_number);
  CREATE INDEX IF NOT EXISTS idx_status ON service_records(status);
  CREATE INDEX IF NOT EXISTS idx_quote_line_items_record ON quote_line_items(record_id);
`);

// ---------- Additive migrations (safe to re-run on every startup) ----------
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumnIfMissing(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('service_records', 'source_type', "TEXT DEFAULT 'dealer'");
addColumnIfMissing('service_records', 'quote_amount', 'NUMERIC');
addColumnIfMissing('service_records', 'quote_notes', 'TEXT');
addColumnIfMissing('service_records', 'quote_status', "TEXT DEFAULT 'not_sent'");
addColumnIfMissing('service_records', 'quote_sent_at', 'TEXT');
addColumnIfMissing('service_records', 'quote_responded_at', 'TEXT');
addColumnIfMissing('service_records', 'date_returned', 'TEXT');
addColumnIfMissing('service_records', 'share_token', 'TEXT');
addColumnIfMissing('service_records', 'refurb_serial', 'TEXT');
addColumnIfMissing('service_records', 'refurb_suggested', 'INTEGER DEFAULT 0');
addColumnIfMissing('service_records', 'damage_found', 'TEXT');
addColumnIfMissing('service_records', 'dealer_reference', 'TEXT');
addColumnIfMissing('service_records', 'test_ridden_at', 'TEXT');
addColumnIfMissing('service_images', 'category', "TEXT DEFAULT 'other'");
addColumnIfMissing('dealers', 'share_token', 'TEXT');
addColumnIfMissing('dealers', 'lightspeed_customer_id', 'TEXT');
addColumnIfMissing('dealers', 'lightspeed_customer_name', 'TEXT');
addColumnIfMissing('dealers', 'alias', 'TEXT');
addColumnIfMissing('parts_catalog', 'lightspeed_item_id', 'TEXT');
addColumnIfMissing('parts_catalog', 'lightspeed_synced_at', 'TEXT');
addColumnIfMissing('service_records', 'lightspeed_customer_id', 'TEXT');
addColumnIfMissing('service_records', 'lightspeed_customer_name', 'TEXT');
addColumnIfMissing('service_records', 'lightspeed_sale_id', 'TEXT');
addColumnIfMissing('service_records', 'lightspeed_quote_id', 'TEXT');
addColumnIfMissing('service_records', 'lightspeed_pushed_at', 'TEXT');
addColumnIfMissing('service_records', 'lightspeed_sale_completed_at', 'TEXT');
addColumnIfMissing('parts_catalog', 'category', "TEXT NOT NULL DEFAULT 'part'");
addColumnIfMissing('quote_line_items', 'category', "TEXT DEFAULT 'part'");
addColumnIfMissing('quote_line_items', 'original_unit_price', 'NUMERIC');
addColumnIfMissing('quote_line_items', 'lightspeed_sale_line_id', 'TEXT');
// Set the moment an already-pushed quote's line items are edited (see the PUT
// /api/records/:id/quote route) -- cleared back to NULL the moment those
// changes are successfully re-synced to Lightspeed (POST .../update-lightspeed).
// Non-null is what flips the Lightspeed panel from a static "already pushed"
// chip to an actionable "Update Lightspeed" button.
addColumnIfMissing('service_records', 'quote_edited_at', 'TEXT');

// One-time backfill: the two known labour SKUs already in the catalog
// (added before "category" existed) are real service charges, not spares --
// mark them explicitly rather than leaving them defaulted to 'part', which
// would otherwise make them wrongly eligible for the dealer parts discount.
// Gated on a flag in app_settings (not just "category = 'part'") so this
// runs exactly once, ever -- otherwise it would silently re-flip either SKU
// back to 'labour' on every restart even after a deliberate manual
// correction to 'part' later.
if (!db.prepare(`SELECT value FROM app_settings WHERE key = 'backfilled_labour_skus_v1'`).get()) {
  db.prepare(`UPDATE parts_catalog SET category = 'labour' WHERE sku IN ('BROSEB', 'BROSEC')`).run();
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('backfilled_labour_skus_v1', '1')`).run();
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_share_token ON service_records(share_token)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dealer_share_token ON dealers(share_token)`);

// Backfill share_token for any pre-existing rows that don't have one yet
const missingTokens = db.prepare('SELECT id FROM service_records WHERE share_token IS NULL').all();
if (missingTokens.length) {
  const setToken = db.prepare('UPDATE service_records SET share_token = ? WHERE id = ?');
  missingTokens.forEach(r => setToken.run(crypto.randomBytes(12).toString('hex'), r.id));
}

// Same idea for dealers -- each dealer gets one permanent share link (their full
// motor history), generated once here for anyone that predates this feature, and
// at insert time (server.js) for every dealer added from now on.
const missingDealerTokens = db.prepare('SELECT id FROM dealers WHERE share_token IS NULL').all();
if (missingDealerTokens.length) {
  const setDealerToken = db.prepare('UPDATE dealers SET share_token = ? WHERE id = ?');
  missingDealerTokens.forEach(d => setDealerToken.run(crypto.randomBytes(12).toString('hex'), d.id));
}

// ---------- App settings (key/value) ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// The passcode used to live only in the APP_PASSCODE env var (fixed at container
// start, changeable only by editing .env and redeploying). It's now DB-backed so
// it can be changed from the Settings page -- seeded once from the env var (or the
// 'changeme' default) the first time this runs, then the DB value always wins.
if (getSetting('passcode') === null) {
  setSetting('passcode', process.env.APP_PASSCODE || 'changeme');
}

// Separate shared passcode for Specialized's own read-only partner view
// (see server.js's "Specialized partner view" section) -- randomly
// generated on first run rather than a guessable default, since the owner
// has to explicitly go look it up in Settings before it's ever handed to
// anyone anyway.
if (getSetting('specialized_passcode') === null) {
  setSetting('specialized_passcode', crypto.randomBytes(6).toString('hex'));
}

// One-time backfill: any dealer name already used on a real (source_type = 'dealer')
// service record, but not yet in the dealers table, is added so the new dealer
// picker isn't empty on first use. Idempotent (only inserts names not already present),
// safe to leave running on every startup. Direct-customer records are deliberately
// excluded -- those are personal names, not dealers to keep in this list.
const existingDealerNames = new Set(
  db.prepare('SELECT name FROM dealers').all().map(d => d.name.toLowerCase())
);
const historicalDealerNames = db.prepare(`
  SELECT DISTINCT dealer_name FROM service_records
  WHERE source_type = 'dealer' AND dealer_name IS NOT NULL AND trim(dealer_name) != ''
`).all().map(r => r.dealer_name.trim());
const insertDealer = db.prepare('INSERT INTO dealers (name) VALUES (?)');
historicalDealerNames.forEach(name => {
  if (!existingDealerNames.has(name.toLowerCase())) {
    insertDealer.run(name);
    existingDealerNames.add(name.toLowerCase());
  }
});

// ---------- Seed the Brose parts catalog (idempotent -- skips SKUs already present) ----------
// Pulled from Greg Minnaar Cycles' own Lightspeed inventory (PO Bridge's connection) on 2026-07-21,
// then hand-picked by the owner down to the real spare parts + labour charges worth quoting from.
const BROSE_PARTS_SEED = [
  ['S196800002', 'ELE MY19 EBIKE BROSE MOTOR HMI/E-BIKE CONTROL SOCKETS', 14.79, 65],
  ['S194200014', 'ELE MY19 EBIKE BROSE MOTOR LIGHT SOCKETS BLIND PLUGS', 8.25, 35],
  ['HK243016-2RS', 'Needle Bearing 24x30x16mm Brose Motor', 95, 220],
  ['b6807/34', '34x47x7mm bearing Brose Motor 6807/34 CW special seal', 90, 210],
  ['6811-2RS', '6811ZV CW Custom Bearing Brose motor', 120, 520],
  ['FE443', 'Brose Sprag Bearing FE443', 425, 899],
  ['FE448', 'Brose Sprag Bearing FE448', 425, 756],
  ['0983452', 'BROSE ORIGINAL CRANKSHAFT SMAG', 1296, 2500],
  ['PLB20126', 'BROSE S&T DRIVE GEAR SPRAG BEARING', 390.24, 695],
  ['PLB20127', 'BROSE S&T CRANKSHAFT SPRAG BEARING', 511.78, 915],
  ['PLB20126A', 'BROSE SPRAG HEAVY DUTY 443', 725.72, 1399],
  ['PLB20127A', 'BROSE SPRAG HEAVY DUTY 448', 766.55, 1399],
  ['PLB20144', 'BROSE DRIVESIDE CRANKSHAFT INNER WIPER SEAL', 65.9, 120],
  ['PLB20146', 'BROSE CRANKSHAFT EXTERNAL X-RING SEAL', 57.34, 99],
  ['CW6805LH', 'Brose CW6805-LH special seal (25x37x7mm) crankshaft bearing', 165, 320],
  ['BROSEB', 'BROSE BASIC MOTOR SERVICE', 0, 650],
  ['BROSEC', 'BROSE MOTOR COMPLETE OVERHAUL', 0, 950],
  ['RFM0142', 'Brose Refurbished motor', 500, 6800],
  ['PLB14023', 'ECU GASKET FOR BROSE S/T', 67.95, 125],
  ['PLB20142', 'MOTOR COVER GASKET FOR BROSE S & T', 100.5, 180],
  ['PLB20140', 'GENUINE BROSE S&T CARBON BELT KIT', 1018.43, 1815],
  ['PLB20141', 'GENUINE BROSE S-MAG BELT KIT', 1257.4, 2200],
  ['E16217-102', 'BROSE MAGNESIUM SCREWS M5 X 22', 5.9, 11],
  ['6807zzcw', '6805ZZ Brose crankshaft center bearing CW OEM', 116.25, 260]
];
const existingSkus = new Set(db.prepare('SELECT sku FROM parts_catalog').all().map(r => r.sku));
const insertPart = db.prepare('INSERT INTO parts_catalog (sku, description, cost, retail_price) VALUES (?, ?, ?, ?)');
BROSE_PARTS_SEED.forEach(([sku, description, cost, retail_price]) => {
  if (!existingSkus.has(sku)) insertPart.run(sku, description, cost, retail_price);
});

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
