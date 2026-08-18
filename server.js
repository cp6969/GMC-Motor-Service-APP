const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gmc-motor-tracker-secret-change-me';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = 'claude-sonnet-5';

// ---------- Lightspeed Retail (R-Series) OAuth ----------
// Same API/OAuth host PO Bridge already uses for this exact Lightspeed account
// (api.lightspeedapp.com/API/V3) -- but Motor Tracker is its own, independent
// Lightspeed app registration with its own client ID/secret/redirect URI, so it
// has no dependency on PO Bridge staying up. client_id/secret/redirect_uri are
// plain env vars (set once at deploy, essentially never change) -- same
// convention this app already uses for ANTHROPIC_API_KEY/JWT_SECRET, and the
// same pattern PO Bridge itself uses for its own Lightspeed credentials. The
// resulting per-connection access/refresh tokens (which DO change, on every
// OAuth handshake and every refresh) live in the DB instead.
const LIGHTSPEED_CLIENT_ID = process.env.LIGHTSPEED_CLIENT_ID || '';
const LIGHTSPEED_CLIENT_SECRET = process.env.LIGHTSPEED_CLIENT_SECRET || '';
const LIGHTSPEED_REDIRECT_URI = process.env.LIGHTSPEED_REDIRECT_URI || '';
const LIGHTSPEED_AUTHORIZE_URL = 'https://cloud.lightspeedapp.com/oauth/authorize.php';
const LIGHTSPEED_TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LIGHTSPEED_API_BASE = 'https://api.lightspeedapp.com/API/V3';

// In-memory OAuth state (CSRF protection for the redirect round-trip) -- fine
// for this single-instance deployment, same tradeoff PO Bridge itself accepts
// for the identical purpose (see app/routers/lightspeed_oauth.py there).
const pendingLightspeedState = new Set();

// Retries a Lightspeed API call on 429 (rate limited) or a transient 5xx,
// same idea PO Bridge's own lightspeed_client.py already relies on for this
// exact API. Lightspeed's rate limit is a leaky bucket scoped to the whole
// account, not per API key/app -- so Motor Tracker's own searches can get
// throttled by traffic that has nothing to do with it (PO Bridge polling the
// same account, or just several keystrokes firing search requests close
// together) and the right fix is to back off and retry, not fail outright.
// Honors a real Retry-After header when Lightspeed sends one.
async function fetchLightspeed(url, options = {}, maxRetries = 4) {
  let lastRes;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastRes = await fetch(url, options);
    if (lastRes.status !== 429 && lastRes.status < 500) return lastRes;
    if (attempt === maxRetries) return lastRes;
    const retryAfter = lastRes.headers.get('Retry-After');
    const waitMs = retryAfter ? Number(retryAfter) * 1000 : Math.min(1000 * (attempt + 1), 5000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return lastRes;
}

// Returns a currently-valid access token, refreshing it first if it's within
// 2 minutes of expiring (same safety margin PO Bridge itself uses for this
// exact class of problem). A refresh response may omit refresh_token
// entirely -- Lightspeed's refresh tokens don't rotate -- so the existing one
// is kept in that case, same behavior already confirmed for PO Bridge's own
// connection to this account.
async function getValidLightspeedToken() {
  const creds = db.prepare('SELECT * FROM lightspeed_credentials WHERE id = 1').get();
  if (!creds) {
    const err = new Error('Lightspeed is not connected -- connect it from Settings first');
    err.statusCode = 400;
    throw err;
  }
  const safetyMarginMs = 2 * 60 * 1000;
  if (new Date(creds.expires_at).getTime() > Date.now() + safetyMarginMs) {
    return { accessToken: creds.access_token, accountId: creds.account_id };
  }
  const tokenRes = await fetchLightspeed(LIGHTSPEED_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: LIGHTSPEED_CLIENT_ID,
      client_secret: LIGHTSPEED_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokenRes.ok) {
    const err = new Error('Failed to refresh the Lightspeed connection -- try reconnecting from Settings');
    err.statusCode = 502;
    throw err;
  }
  const tokenData = await tokenRes.json();
  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 1800) * 1000).toISOString();
  const newRefreshToken = tokenData.refresh_token || creds.refresh_token;
  db.prepare('UPDATE lightspeed_credentials SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1')
    .run(tokenData.access_token, newRefreshToken, newExpiresAt);
  return { accessToken: tokenData.access_token, accountId: creds.account_id };
}

// A dealer's own Lightspeed customer link (set once in Settings, section
// below) is what a dealer-sent record actually uses -- resolved fresh at
// write time from the dealers table, not trusted from client input, so a
// record can never claim a link to a customer the dealer database doesn't
// actually have on file.
function resolveDealerLightspeedLink(dealerName) {
  if (!dealerName) return { id: null, name: null };
  const dealer = db.prepare(
    'SELECT lightspeed_customer_id, lightspeed_customer_name FROM dealers WHERE name = ? COLLATE NOCASE'
  ).get(dealerName);
  return dealer ? { id: dealer.lightspeed_customer_id, name: dealer.lightspeed_customer_name } : { id: null, name: null };
}

// Normalizes a raw Lightspeed Item into the shape the parts catalog stores --
// same field names/derivation PO Bridge itself relies on (manufacturerSku,
// defaultCost, and the nested Prices.ItemPrice "Default" entry for retail
// price -- see app/invoice_processor.py's own Item price handling there).
function normalizeLightspeedItem(item) {
  const prices = item.Prices && item.Prices.ItemPrice
    ? (Array.isArray(item.Prices.ItemPrice) ? item.Prices.ItemPrice : [item.Prices.ItemPrice])
    : [];
  const defaultPrice = prices.find(p => p.useType === 'Default');
  return {
    id: item.itemID,
    sku: item.manufacturerSku || '',
    description: item.description || '',
    cost: item.defaultCost !== undefined && item.defaultCost !== null && item.defaultCost !== '' ? Number(item.defaultCost) : null,
    retail_price: defaultPrice ? Number(defaultPrice.amount) : null,
  };
}

const BRANDS = ['Brose', 'Mahle'];
const PART_CATEGORIES = ['part', 'labour', 'postage'];
// The dealer parts discount (20% off spares, never labour/postage) is
// computed entirely client-side, once, the moment a dealer's quote pulls a
// "part"-category item from the catalog (see the DEALER_PARTS_DISCOUNT
// constant and wf-parts-search in app.js) -- unit_price arriving here is
// already whatever the mechanic actually intends to charge, discounted or
// not, same trust model this route already used before discounts existed.
// The server's only job is to store category/original_unit_price alongside
// it for the read-only "was Rx" display, never to recompute the discount.
const STAGES = ['received', 'inspection', 'quoted', 'in_repair', 'completed', 'returned'];
const QUOTE_STATUSES = ['not_sent', 'pending', 'approved', 'declined', 'skipped', 'refurb'];
const IMAGE_CATEGORIES = ['intake', 'damage', 'repair', 'other'];

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
// no-store: this app is actively being iterated on, and Cloudflare's edge (once the
// tunnel is in front of it) caches static extensions like .js/.css by default even
// when the origin sends max-age=0 -- explicit no-store is what actually stops that,
// both at Cloudflare's edge and in the browser.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));

// ---------- Auth ----------
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

app.post('/api/login', (req, res) => {
  const { passcode } = req.body;
  if (passcode !== db.getSetting('passcode')) {
    return res.status(401).json({ error: 'Incorrect passcode' });
  }
  const token = jwt.sign({ workshop: 'gmc' }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ token });
});

app.post('/api/settings/passcode', authMiddleware, (req, res) => {
  const { current_passcode, new_passcode } = req.body;
  if (current_passcode !== db.getSetting('passcode')) {
    return res.status(401).json({ error: 'Current passcode is incorrect' });
  }
  if (!new_passcode || new_passcode.length < 4) {
    return res.status(400).json({ error: 'New passcode must be at least 4 characters' });
  }
  db.setSetting('passcode', new_passcode);
  res.json({ success: true });
});

// ---------- Image upload config ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ---------- Service records ----------
// dealer_alias is resolved fresh on every read (a LEFT JOIN by name, never
// stored on the record itself) so editing a dealer's alias in Settings takes
// effect everywhere immediately, including on already-existing records --
// unlike the Lightspeed customer link (section above), there's no
// correctness reason to freeze this at write time, it's purely cosmetic.
app.get('/api/records', authMiddleware, (req, res) => {
  const { search, status } = req.query;
  let query = `
    SELECT sr.*, d.alias AS dealer_alias
    FROM service_records sr
    LEFT JOIN dealers d ON d.name = sr.dealer_name COLLATE NOCASE
    WHERE 1=1
  `;
  const params = [];
  if (search) {
    query += ' AND (sr.serial_number LIKE ? OR sr.dealer_name LIKE ? OR sr.brand LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  if (status) {
    query += ' AND sr.status = ?';
    params.push(status);
  }
  query += ' ORDER BY sr.created_at DESC';
  const records = db.prepare(query).all(...params);

  const imageCountStmt = db.prepare('SELECT COUNT(*) as count FROM service_images WHERE record_id = ?');
  const withCounts = records.map(r => ({
    ...r,
    image_count: imageCountStmt.get(r.id).count
  }));
  res.json(withCounts);
});

app.get('/api/records/:id', authMiddleware, (req, res) => {
  const record = db.prepare(`
    SELECT sr.*, d.alias AS dealer_alias
    FROM service_records sr
    LEFT JOIN dealers d ON d.name = sr.dealer_name COLLATE NOCASE
    WHERE sr.id = ?
  `).get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  const images = db.prepare('SELECT * FROM service_images WHERE record_id = ? ORDER BY created_at ASC').all(req.params.id);
  const line_items = db.prepare('SELECT * FROM quote_line_items WHERE record_id = ? ORDER BY id ASC').all(req.params.id);
  res.json({ ...record, images, line_items });
});

app.post('/api/records', authMiddleware, (req, res) => {
  const {
    serial_number, brand, model, dealer_name, dealer_contact, source_type,
    date_received, date_completed, status, issue_reported,
    work_performed, parts_replaced, technician, notes,
    lightspeed_customer_id, lightspeed_customer_name
  } = req.body;

  if (!serial_number || !serial_number.trim()) {
    return res.status(400).json({ error: 'Serial number is required' });
  }
  if (!brand || !BRANDS.includes(brand)) {
    return res.status(400).json({ error: `Brand must be one of: ${BRANDS.join(', ')}` });
  }
  if (source_type && !['dealer', 'customer'].includes(source_type)) {
    return res.status(400).json({ error: 'source_type must be dealer or customer' });
  }
  if (status && !STAGES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STAGES.join(', ')}` });
  }

  const resolvedSourceType = source_type || 'dealer';
  // A dealer-sent record always uses that dealer's own saved Lightspeed link
  // (server-resolved, see resolveDealerLightspeedLink above) -- a direct
  // customer's record uses whatever the front-end's own live search actually
  // resolved, since there's no local entity to look it up from instead.
  let lsCustomerId = lightspeed_customer_id || null;
  let lsCustomerName = lightspeed_customer_name || null;
  if (resolvedSourceType === 'dealer') {
    const link = resolveDealerLightspeedLink(dealer_name);
    lsCustomerId = link.id;
    lsCustomerName = link.name;
  }

  const stmt = db.prepare(`
    INSERT INTO service_records
    (serial_number, brand, model, dealer_name, dealer_contact, source_type, date_received,
     date_completed, status, issue_reported, work_performed, parts_replaced, technician, notes, share_token,
     lightspeed_customer_id, lightspeed_customer_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    serial_number.trim(), brand, model || null, dealer_name || null,
    dealer_contact || null, resolvedSourceType, date_received || null, date_completed || null,
    status || 'received', issue_reported || null, work_performed || null,
    parts_replaced || null, technician || null, notes || null,
    crypto.randomBytes(12).toString('hex'),
    lsCustomerId, lsCustomerName
  );
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(record);
});

app.put('/api/records/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Record not found' });

  if (req.body.brand !== undefined && !BRANDS.includes(req.body.brand)) {
    return res.status(400).json({ error: `Brand must be one of: ${BRANDS.join(', ')}` });
  }
  if (req.body.source_type !== undefined && !['dealer', 'customer'].includes(req.body.source_type)) {
    return res.status(400).json({ error: 'source_type must be dealer or customer' });
  }
  if (req.body.status !== undefined && !STAGES.includes(req.body.status)) {
    return res.status(400).json({ error: `status must be one of: ${STAGES.join(', ')}` });
  }

  const fields = [
    'serial_number', 'brand', 'model', 'dealer_name', 'dealer_contact', 'source_type',
    'date_received', 'date_completed', 'date_returned', 'status', 'issue_reported', 'damage_found',
    'work_performed', 'parts_replaced', 'technician', 'notes',
    'quote_amount', 'quote_notes', 'refurb_serial',
    'lightspeed_customer_id', 'lightspeed_customer_name'
  ];
  const updates = {};
  fields.forEach(f => {
    updates[f] = req.body[f] !== undefined ? req.body[f] : existing[f];
  });

  // Same rule as record creation: a dealer-sent record always uses that
  // dealer's own current Lightspeed link, never whatever the client sent.
  if (updates.source_type === 'dealer') {
    const link = resolveDealerLightspeedLink(updates.dealer_name);
    updates.lightspeed_customer_id = link.id;
    updates.lightspeed_customer_name = link.name;
  }

  db.prepare(`
    UPDATE service_records SET
      serial_number = ?, brand = ?, model = ?, dealer_name = ?, dealer_contact = ?, source_type = ?,
      date_received = ?, date_completed = ?, date_returned = ?, status = ?, issue_reported = ?, damage_found = ?,
      work_performed = ?, parts_replaced = ?, technician = ?, notes = ?,
      quote_amount = ?, quote_notes = ?, refurb_serial = ?,
      lightspeed_customer_id = ?, lightspeed_customer_name = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    updates.serial_number, updates.brand, updates.model, updates.dealer_name,
    updates.dealer_contact, updates.source_type, updates.date_received, updates.date_completed,
    updates.date_returned, updates.status, updates.issue_reported, updates.damage_found, updates.work_performed,
    updates.parts_replaced, updates.technician, updates.notes,
    updates.quote_amount, updates.quote_notes, updates.refurb_serial,
    updates.lightspeed_customer_id, updates.lightspeed_customer_name, req.params.id
  );

  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  res.json(record);
});

app.delete('/api/records/:id', authMiddleware, (req, res) => {
  const images = db.prepare('SELECT * FROM service_images WHERE record_id = ?').all(req.params.id);
  images.forEach(img => {
    const p = path.join(UPLOAD_DIR, img.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  db.prepare('DELETE FROM service_records WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------- Images ----------
app.post('/api/records/:id/images', authMiddleware, upload.array('photos', 10), (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const category = IMAGE_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
  const insert = db.prepare('INSERT INTO service_images (record_id, filename, caption, category) VALUES (?, ?, ?, ?)');
  const inserted = [];
  (req.files || []).forEach(file => {
    const result = insert.run(req.params.id, file.filename, req.body.caption || null, category);
    inserted.push(db.prepare('SELECT * FROM service_images WHERE id = ?').get(result.lastInsertRowid));
  });
  res.status(201).json(inserted);
});

app.delete('/api/images/:id', authMiddleware, (req, res) => {
  const image = db.prepare('SELECT * FROM service_images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  const p = path.join(UPLOAD_DIR, image.filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  db.prepare('DELETE FROM service_images WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------- Stage / quote workflow ----------
app.put('/api/records/:id/stage', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const { stage } = req.body;
  if (!STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
  }

  const extra = {};
  if (stage === 'completed' && !record.date_completed) {
    extra.date_completed = new Date().toISOString().slice(0, 10);
  }
  if (stage === 'returned' && !record.date_returned) {
    extra.date_returned = new Date().toISOString().slice(0, 10);
  }

  db.prepare(`
    UPDATE service_records SET status = ?, date_completed = ?, date_returned = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    stage,
    extra.date_completed || record.date_completed,
    extra.date_returned || record.date_returned,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id));
});

app.post('/api/records/:id/quote', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const { quote_amount, quote_notes, line_items } = req.body;

  let finalAmount;
  let items = null;
  if (Array.isArray(line_items) && line_items.length) {
    items = line_items.map(li => ({
      sku: (li.sku || '').toString().slice(0, 100),
      description: (li.description || '').toString().slice(0, 300),
      unit_price: Number(li.unit_price),
      quantity: Number(li.quantity) || 1,
      category: PART_CATEGORIES.includes(li.category) ? li.category : 'part',
      original_unit_price: li.original_unit_price === undefined || li.original_unit_price === null || li.original_unit_price === ''
        ? null : Number(li.original_unit_price),
    }));
    if (items.some(li => !li.description || isNaN(li.unit_price) || li.unit_price < 0 || li.quantity <= 0)) {
      return res.status(400).json({ error: 'Each line item needs a description, a valid unit price, and a positive quantity' });
    }
    // Quote total is always computed from the line items server-side -- never trust a client-computed total.
    finalAmount = Math.round(items.reduce((sum, li) => sum + li.unit_price * li.quantity, 0) * 100) / 100;
  } else {
    if (quote_amount === undefined || quote_amount === null || quote_amount === '' || isNaN(Number(quote_amount))) {
      return res.status(400).json({ error: 'A valid quote_amount is required' });
    }
    finalAmount = Number(quote_amount);
  }

  db.prepare(`
    UPDATE service_records SET
      quote_amount = ?, quote_notes = ?, quote_status = 'pending', quote_sent_at = CURRENT_TIMESTAMP,
      status = CASE WHEN status = 'received' OR status = 'inspection' THEN 'quoted' ELSE status END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalAmount, quote_notes || null, req.params.id);

  if (items) {
    db.prepare('DELETE FROM quote_line_items WHERE record_id = ?').run(req.params.id);
    const insertLine = db.prepare(`
      INSERT INTO quote_line_items (record_id, sku, description, unit_price, quantity, category, original_unit_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    items.forEach(li => insertLine.run(
      req.params.id, li.sku || null, li.description, li.unit_price, li.quantity, li.category, li.original_unit_price
    ));
  }

  res.json(db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id));
});

// Edits an already-sent quote's line items in place -- unlike the POST
// version above (the original "send this quote for a decision" action, which
// resets quote_status to pending and can advance the record's stage), this
// never touches quote_status/quote_sent_at/status. It only exists for
// correcting an already-approved/declined/pending quote's contents. Marks
// quote_edited_at whenever a Lightspeed quote already exists, so the
// Lightspeed panel knows to offer "Update Lightspeed" instead of showing it
// as already in sync -- see POST .../update-lightspeed below.
app.put('/api/records/:id/quote', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  if (!record.quote_status || record.quote_status === 'not_sent' || record.quote_status === 'skipped') {
    return res.status(400).json({ error: 'This record has no quote to edit yet' });
  }

  const { line_items, quote_notes } = req.body;
  if (!Array.isArray(line_items) || !line_items.length) {
    return res.status(400).json({ error: 'At least one line item is required' });
  }
  const items = line_items.map(li => ({
    sku: (li.sku || '').toString().slice(0, 100),
    description: (li.description || '').toString().slice(0, 300),
    unit_price: Number(li.unit_price),
    quantity: Number(li.quantity) || 1,
    category: PART_CATEGORIES.includes(li.category) ? li.category : 'part',
    original_unit_price: li.original_unit_price === undefined || li.original_unit_price === null || li.original_unit_price === ''
      ? null : Number(li.original_unit_price),
    // Carried through from the client so an unchanged line keeps its real
    // Lightspeed SaleLine link -- only a genuinely new/edited line arrives
    // with this blank, which /update-lightspeed treats as "needs (re)creating".
    lightspeed_sale_line_id: li.lightspeed_sale_line_id || null,
  }));
  if (items.some(li => !li.description || isNaN(li.unit_price) || li.unit_price < 0 || li.quantity <= 0)) {
    return res.status(400).json({ error: 'Each line item needs a description, a valid unit price, and a positive quantity' });
  }
  const finalAmount = Math.round(items.reduce((sum, li) => sum + li.unit_price * li.quantity, 0) * 100) / 100;

  db.prepare('DELETE FROM quote_line_items WHERE record_id = ?').run(req.params.id);
  const insertLine = db.prepare(`
    INSERT INTO quote_line_items (record_id, sku, description, unit_price, quantity, category, original_unit_price, lightspeed_sale_line_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  items.forEach(li => insertLine.run(
    req.params.id, li.sku || null, li.description, li.unit_price, li.quantity, li.category, li.original_unit_price, li.lightspeed_sale_line_id
  ));

  db.prepare(`
    UPDATE service_records SET
      quote_amount = ?, quote_notes = ?,
      quote_edited_at = CASE WHEN lightspeed_quote_id IS NOT NULL THEN CURRENT_TIMESTAMP ELSE quote_edited_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalAmount, quote_notes || null, req.params.id);

  res.json(db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id));
});

app.post('/api/records/:id/quote/respond', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const { decision } = req.body;
  if (!['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or declined' });
  }

  const nextStage = decision === 'approved' ? 'in_repair' : 'returned';
  const extra = decision === 'declined' && !record.date_returned
    ? new Date().toISOString().slice(0, 10)
    : record.date_returned;

  db.prepare(`
    UPDATE service_records SET
      quote_status = ?, quote_responded_at = CURRENT_TIMESTAMP, status = ?, date_returned = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(decision, nextStage, extra, req.params.id);

  res.json(db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id));
});

app.post('/api/records/:id/quote/skip', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  db.prepare(`
    UPDATE service_records SET
      quote_status = 'skipped', quote_responded_at = CURRENT_TIMESTAMP, status = 'in_repair',
      refurb_suggested = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.body.refurb_suggested ? 1 : 0, req.params.id);

  res.json(db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id));
});

// The original motor's damage is too severe to repair -- a reconditioned replacement
// unit is handed over instead. Logged against the same service record (the refurb
// unit's own serial is what actually ships back to the dealer/customer), stage jumps
// straight to 'completed' the same way an approved quote jumps to 'in_repair' -- the
// decision and the "resolution" happen at the same moment here, there's no separate
// repair step to wait on.
app.post('/api/records/:id/refurb', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const { refurb_serial } = req.body;
  if (!refurb_serial || !refurb_serial.trim()) {
    return res.status(400).json({ error: 'The refurb motor serial number is required' });
  }

  db.prepare(`
    UPDATE service_records SET
      refurb_serial = ?, quote_status = 'refurb', quote_responded_at = CURRENT_TIMESTAMP,
      status = 'completed', date_completed = COALESCE(date_completed, ?),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(refurb_serial.trim(), new Date().toISOString().slice(0, 10), req.params.id);

  res.json(db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id));
});

// ---------- Parts catalog ----------
app.get('/api/dealers', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM dealers ORDER BY name ASC').all());
});

app.post('/api/dealers', authMiddleware, (req, res) => {
  const { name, contact, lightspeed_customer_id, lightspeed_customer_name, alias } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Dealer name is required' });
  }
  const existing = db.prepare('SELECT * FROM dealers WHERE name = ? COLLATE NOCASE').get(name.trim());
  if (existing) {
    return res.status(409).json({ error: 'A dealer with that name already exists' });
  }
  // Optional -- set when a dealer is created straight from a Lightspeed
  // customer search (Settings > Dealers > "Add from Lightspeed") instead of
  // typed manually, so it's already linked with no separate step needed.
  const result = db.prepare(`
    INSERT INTO dealers (name, contact, share_token, lightspeed_customer_id, lightspeed_customer_name, alias)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(), (contact || '').trim() || null, crypto.randomBytes(12).toString('hex'),
    lightspeed_customer_id ? String(lightspeed_customer_id) : null, lightspeed_customer_name || null,
    (alias || '').trim() || null
  );
  res.status(201).json(db.prepare('SELECT * FROM dealers WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/dealers/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM dealers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Dealer not found' });
  const { name, contact, alias } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Dealer name is required' });
  }
  const dup = db.prepare('SELECT * FROM dealers WHERE name = ? COLLATE NOCASE AND id != ?').get(name.trim(), req.params.id);
  if (dup) return res.status(409).json({ error: 'A dealer with that name already exists' });
  db.prepare('UPDATE dealers SET name = ?, contact = ?, alias = ? WHERE id = ?').run(
    name.trim(), (contact || '').trim() || null, (alias || '').trim() || null, req.params.id
  );
  res.json(db.prepare('SELECT * FROM dealers WHERE id = ?').get(req.params.id));
});

app.delete('/api/dealers/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM dealers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/dealers/:id/lightspeed-link', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM dealers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Dealer not found' });
  const { customer_id, customer_name } = req.body;
  if (!customer_id || !customer_name) {
    return res.status(400).json({ error: 'customer_id and customer_name are required' });
  }
  db.prepare('UPDATE dealers SET lightspeed_customer_id = ?, lightspeed_customer_name = ? WHERE id = ?')
    .run(String(customer_id), customer_name, req.params.id);
  res.json(db.prepare('SELECT * FROM dealers WHERE id = ?').get(req.params.id));
});

app.post('/api/dealers/:id/lightspeed-unlink', authMiddleware, (req, res) => {
  db.prepare('UPDATE dealers SET lightspeed_customer_id = NULL, lightspeed_customer_name = NULL WHERE id = ?').run(req.params.id);
  res.json(db.prepare('SELECT * FROM dealers WHERE id = ?').get(req.params.id));
});

// Live search against real Lightspeed customers -- used both by the dealer
// Lightspeed-link picker (Settings) and the "Direct customer" search on a new
// service record. Matches partial text against firstName/lastName/company
// via Lightspeed's own "~" (LIKE) operator, OR-combined across all three --
// see https://developers.lightspeedhq.com/retail/introduction/parameters/
// for the exact query syntax this is built from.
app.get('/api/lightspeed/customers', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const likeVal = encodeURIComponent(`%${q}%`);
    const orClause = `firstName%3D~,${likeVal}|lastName%3D~,${likeVal}|company%3D~,${likeVal}`;
    const rel = encodeURIComponent('["Contact"]');
    const url = `${LIGHTSPEED_API_BASE}/Account/${accountId}/Customer.json?or=${orClause}&load_relations=${rel}&limit=15`;
    const lsRes = await fetchLightspeed(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!lsRes.ok) throw new Error(`Lightspeed search failed: ${lsRes.status} ${await lsRes.text()}`);
    const data = await lsRes.json();
    const raw = data.Customer ? (Array.isArray(data.Customer) ? data.Customer : [data.Customer]) : [];
    const results = raw.map(c => {
      const contact = c.Contact || {};
      const emails = contact.Emails && contact.Emails.ContactEmail
        ? (Array.isArray(contact.Emails.ContactEmail) ? contact.Emails.ContactEmail : [contact.Emails.ContactEmail])
        : [];
      const phones = contact.Phones && contact.Phones.ContactPhone
        ? (Array.isArray(contact.Phones.ContactPhone) ? contact.Phones.ContactPhone : [contact.Phones.ContactPhone])
        : [];
      return {
        id: c.customerID,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || `Customer #${c.customerID}`,
        company: c.company || '',
        email: emails[0] ? emails[0].address : '',
        phone: phones[0] ? phones[0].number : '',
      };
    });
    res.json(results);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/parts', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM parts_catalog ORDER BY description ASC').all());
});

app.post('/api/parts', authMiddleware, (req, res) => {
  const { sku, description, cost, retail_price, category } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }
  if (category !== undefined && !PART_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${PART_CATEGORIES.join(', ')}` });
  }
  const result = db.prepare(
    'INSERT INTO parts_catalog (sku, description, cost, retail_price, category) VALUES (?, ?, ?, ?, ?)'
  ).run(
    (sku || '').trim() || null, description.trim(),
    cost === '' || cost === undefined ? null : Number(cost),
    retail_price === '' || retail_price === undefined ? null : Number(retail_price),
    category || 'part'
  );
  res.status(201).json(db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/parts/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Part not found' });
  const { sku, description, cost, retail_price, category } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }
  if (category !== undefined && !PART_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${PART_CATEGORIES.join(', ')}` });
  }
  const newSku = (sku || '').trim() || null;
  // Hand-editing the SKU invalidates any earlier Lightspeed verification --
  // the stored lightspeed_item_id would otherwise keep pointing at whatever
  // item the OLD sku resolved to, silently wrong. Editing cost/description
  // alone doesn't touch it.
  const skuChanged = newSku !== existing.sku;
  db.prepare(`
    UPDATE parts_catalog SET sku = ?, description = ?, cost = ?, retail_price = ?, category = ?
    ${skuChanged ? ', lightspeed_item_id = NULL, lightspeed_synced_at = NULL' : ''}
    WHERE id = ?
  `).run(
    newSku,
    description.trim(),
    cost === '' || cost === undefined ? null : Number(cost),
    retail_price === '' || retail_price === undefined ? null : Number(retail_price),
    category || existing.category || 'part',
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(req.params.id));
});

app.delete('/api/parts/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM parts_catalog WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Admin-only search against real Lightspeed items -- deliberately NOT exposed
// to the "Add part" search a mechanic uses while building a quote (that one
// only ever searches parts_catalog, see wf-parts-search below). This is only
// ever called from the Settings "Add from Lightspeed" picker, so the parts a
// mechanic can actually select stay a fixed, owner-curated list -- the whole
// point being to keep an incorrect SKU from ever reaching a real quote.
app.get('/api/lightspeed/items', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const likeVal = encodeURIComponent(`%${q}%`);
    const orClause = `description%3D~,${likeVal}|manufacturerSku%3D~,${likeVal}`;
    const url = `${LIGHTSPEED_API_BASE}/Account/${accountId}/Item.json?or=${orClause}&limit=15`;
    const lsRes = await fetchLightspeed(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!lsRes.ok) throw new Error(`Lightspeed item search failed: ${lsRes.status} ${await lsRes.text()}`);
    const data = await lsRes.json();
    const raw = data.Item ? (Array.isArray(data.Item) ? data.Item : [data.Item]) : [];
    res.json(raw.map(normalizeLightspeedItem));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/parts/from-lightspeed', authMiddleware, (req, res) => {
  const { lightspeed_item_id, sku, description, cost, retail_price, category } = req.body;
  if (!lightspeed_item_id || !description || !description.trim()) {
    return res.status(400).json({ error: 'lightspeed_item_id and description are required' });
  }
  if (category !== undefined && !PART_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${PART_CATEGORIES.join(', ')}` });
  }
  const result = db.prepare(`
    INSERT INTO parts_catalog (sku, description, cost, retail_price, lightspeed_item_id, lightspeed_synced_at, category)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `).run(
    (sku || '').trim() || null, description.trim(),
    cost === undefined || cost === null || cost === '' ? null : Number(cost),
    retail_price === undefined || retail_price === null || retail_price === '' ? null : Number(retail_price),
    String(lightspeed_item_id), category || 'part'
  );
  res.status(201).json(db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(result.lastInsertRowid));
});

// Re-resolves an existing catalog row against Lightspeed by its own SKU
// (exact manufacturerSku match, same field PO Bridge itself uses) -- backfills
// the real itemID and refreshes cost/retail price if found, or reports
// clearly that it wasn't, which is the actual point of this feature: catching
// a wrong/stale SKU in the mechanic-facing catalog before it ever reaches a
// real quote.
app.post('/api/parts/:id/verify', authMiddleware, async (req, res) => {
  const part = db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Part not found' });
  if (!part.sku) {
    return res.json({ verified: false, reason: 'This part has no SKU to look up in Lightspeed' });
  }
  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const url = `${LIGHTSPEED_API_BASE}/Account/${accountId}/Item.json?manufacturerSku=${encodeURIComponent(part.sku)}`;
    const lsRes = await fetchLightspeed(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!lsRes.ok) throw new Error(`Lightspeed lookup failed: ${lsRes.status} ${await lsRes.text()}`);
    const data = await lsRes.json();
    const raw = data.Item ? (Array.isArray(data.Item) ? data.Item : [data.Item]) : [];
    if (!raw.length) {
      return res.json({ verified: false, reason: `No Lightspeed item found with SKU "${part.sku}"` });
    }
    const item = normalizeLightspeedItem(raw[0]);
    db.prepare(`
      UPDATE parts_catalog SET lightspeed_item_id = ?, cost = ?, retail_price = ?, lightspeed_synced_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(item.id, item.cost, item.retail_price, req.params.id);
    res.json({ verified: true, part: db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(req.params.id) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---------- AI serial number extraction ----------
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

const LABEL_EXTRACTION_PROMPT = `This is a photo of the manufacturer's label on an ebike motor (Brose or Mahle). Identify three distinct fields on the label:

1. "brand" -- either "Brose" or "Mahle", based on the logo/branding printed on the label. Use null if you genuinely cannot tell which of these two it is.

2. "model" -- the motor's part/model number.
   On a Brose label, this appears directly below the "brose" logo and QR code, formatted as a capital letter followed by 5 digits, a dash, then 3 digits -- e.g. "E41221-100". A small circled number often sits right next to it (e.g. "28" in a circle) -- that circled number is a separate internal code, NOT part of the model number, so do not include it.

3. "serial_number" -- the unit's unique serial number.
   On a Brose label, this is the line directly below the model number, formatted as four space-separated groups: a single digit, an 8-digit date (YYYYMMDD), another single digit, and a 4-digit running number -- e.g. "1 20210324 1 0033". Extract it exactly as printed, including the spaces between groups.

If this is a Mahle motor, or the label doesn't match the Brose format described above, use your best judgment to identify the equivalent model and serial number fields from whatever labeling is actually visible.

Respond with ONLY a compact JSON object, no markdown fences, no commentary, in this exact shape:
{"brand": string or null, "model": string or null, "serial_number": string or null}
Use null for any field you cannot read clearly enough to be confident -- never guess.`;

app.post('/api/extract-serial', authMiddleware, memoryUpload.single('photo'), async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI serial extraction is not configured on this server' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No photo provided' });
  }

  try {
    const b64 = req.file.buffer.toString('base64');
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: b64 } },
            { type: 'text', text: LABEL_EXTRACTION_PROMPT }
          ]
        }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'AI extraction request failed' });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = (textBlock && textBlock.text || '').trim();
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('extract-serial: could not parse Claude response as JSON:', cleaned);
      return res.json({ serial_number: null, model: null, brand: null });
    }

    res.json({
      serial_number: parsed.serial_number || null,
      model: parsed.model || null,
      brand: BRANDS.includes(parsed.brand) ? parsed.brand : null
    });
  } catch (err) {
    console.error('extract-serial failed:', err);
    res.status(500).json({ error: 'AI extraction failed' });
  }
});

// ---------- AI spelling/grammar fix-up for workshop notes ----------
const FIX_TEXT_PROMPT = `This is a short note typed by a bicycle motor workshop technician, likely with spelling mistakes and typos. Fix the spelling and grammar only. Keep the exact same meaning and level of detail -- do not add, remove, or embellish anything. Keep mechanical/technical terms, brand names (Brose, Mahle, Specialized, etc.) and part numbers exactly as recognisable, correcting only obvious misspellings of them. Keep the tone as plain short workshop notes, not formal prose.

Respond with ONLY the corrected text, no commentary, no quotes around it.`;

app.post('/api/fix-text', authMiddleware, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI text fix-up is not configured on this server' });
  }
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `${FIX_TEXT_PROMPT}\n\nNote to fix:\n${text}` }]
        }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'AI fix-up request failed' });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const corrected = (textBlock && textBlock.text || '').trim();
    if (!corrected) return res.json({ corrected: text });
    res.json({ corrected });
  } catch (err) {
    console.error('fix-text failed:', err);
    res.status(500).json({ error: 'AI fix-up failed' });
  }
});

// ---------- Stats (for home screen summary) ----------
app.get('/api/stats', authMiddleware, (req, res) => {
  const counts = db.prepare(`
    SELECT status, COUNT(*) as count FROM service_records GROUP BY status
  `).all();
  res.json(counts);
});

// ---------- Lightspeed connection ----------
app.get('/api/lightspeed/status', authMiddleware, (req, res) => {
  const creds = db.prepare('SELECT account_id, connected_at, expires_at FROM lightspeed_credentials WHERE id = 1').get();
  res.json({
    configured: !!(LIGHTSPEED_CLIENT_ID && LIGHTSPEED_CLIENT_SECRET && LIGHTSPEED_REDIRECT_URI),
    connected: !!creds,
    account_id: creds ? creds.account_id : null,
    connected_at: creds ? creds.connected_at : null,
  });
});

// Called by the SPA (with its normal Bearer auth) to get a fresh, one-time
// authorize URL -- the actual navigation to Lightspeed then happens as a real
// browser redirect (window.location), which can't carry an Authorization
// header, hence this two-step "fetch the URL, then navigate" shape instead of
// a plain <a href> straight to /oauth/lightspeed/connect.
app.get('/api/lightspeed/connect-url', authMiddleware, (req, res) => {
  if (!LIGHTSPEED_CLIENT_ID || !LIGHTSPEED_REDIRECT_URI) {
    return res.status(400).json({ error: 'Lightspeed isn\'t configured on the server yet (missing client ID/redirect URI)' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingLightspeedState.add(state);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LIGHTSPEED_CLIENT_ID,
    scope: 'employee:all',
    state,
    redirect_uri: LIGHTSPEED_REDIRECT_URI,
  });
  res.json({ url: `${LIGHTSPEED_AUTHORIZE_URL}?${params.toString()}` });
});

// The redirect target Lightspeed itself sends the browser back to -- can't be
// behind authMiddleware (no Authorization header on a real navigation), so the
// state token is what proves this callback corresponds to a connect attempt
// this server actually initiated, not a forged/replayed request.
app.get('/oauth/lightspeed/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state || !pendingLightspeedState.has(state)) {
    return res.redirect('/?lightspeed_error=1');
  }
  pendingLightspeedState.delete(state);
  try {
    const tokenRes = await fetchLightspeed(LIGHTSPEED_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: LIGHTSPEED_CLIENT_ID,
        client_secret: LIGHTSPEED_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: LIGHTSPEED_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const tokenData = await tokenRes.json();

    const accountRes = await fetchLightspeed(`${LIGHTSPEED_API_BASE}/Account.json`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!accountRes.ok) throw new Error(`Account lookup failed: ${accountRes.status} ${await accountRes.text()}`);
    const accountData = await accountRes.json();
    const accountId = accountData.Account.accountID;
    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 1800) * 1000).toISOString();

    db.prepare(`
      INSERT INTO lightspeed_credentials (id, account_id, access_token, refresh_token, expires_at, connected_at)
      VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id, access_token = excluded.access_token,
        refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
        connected_at = CURRENT_TIMESTAMP
    `).run(accountId, tokenData.access_token, tokenData.refresh_token, expiresAt);

    res.redirect('/?lightspeed_connected=1');
  } catch (err) {
    console.error('Lightspeed OAuth callback failed:', err);
    res.redirect('/?lightspeed_error=1');
  }
});

app.post('/api/lightspeed/disconnect', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM lightspeed_credentials WHERE id = 1').run();
  res.json({ success: true });
});

// Real Lightspeed employees, for the "which employee do pushed quotes get
// attributed to" Settings picker -- this app has no per-mechanic login of
// its own (one shared workshop passcode), so a pushed Sale/Quote needs one
// fixed, explicitly-chosen real employeeID rather than trying to guess one.
app.get('/api/lightspeed/employees', authMiddleware, async (req, res) => {
  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const lsRes = await fetchLightspeed(`${LIGHTSPEED_API_BASE}/Account/${accountId}/Employee.json?limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!lsRes.ok) throw new Error(`Lightspeed employee lookup failed: ${lsRes.status}`);
    const data = await lsRes.json();
    const raw = data.Employee ? (Array.isArray(data.Employee) ? data.Employee : [data.Employee]) : [];
    res.json(raw.filter(e => e.archived !== 'true').map(e => ({
      id: e.employeeID, name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
    })));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/settings/lightspeed-employee', authMiddleware, (req, res) => {
  res.json({
    id: db.getSetting('lightspeed_employee_id'),
    name: db.getSetting('lightspeed_employee_name'),
  });
});

app.post('/api/settings/lightspeed-employee', authMiddleware, (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });
  db.setSetting('lightspeed_employee_id', String(id));
  db.setSetting('lightspeed_employee_name', name);
  res.json({ id, name });
});

// Resolves local quote_line_items rows against the owner-curated parts
// catalog into the shape Lightspeed's SaleLine wants -- shared by the initial
// push (below) and the update-existing-quote route further down. A bare
// custom line (no SKU) or a SKU that's missing/unverified in the catalog is
// collected as a problem rather than silently guessed at, so the whole
// push/update can be blocked with a clear, specific reason.
function resolveLinesForLightspeed(lineItems) {
  const problems = [];
  const resolved = lineItems.map(li => {
    if (!li.sku) {
      problems.push(`"${li.description}" has no SKU (added as a custom line)`);
      return null;
    }
    const part = db.prepare('SELECT * FROM parts_catalog WHERE sku = ?').get(li.sku);
    if (!part || !part.lightspeed_item_id) {
      problems.push(`"${li.description}" (${li.sku}) isn't a verified Lightspeed item -- verify it in Settings first`);
      return null;
    }
    return { itemID: part.lightspeed_item_id, unitQuantity: String(li.quantity), unitPrice: String(li.unit_price) };
  });
  return { resolved, problems };
}

// The actual push -- creates a real, incomplete Lightspeed Sale for the
// record's linked customer, attaches every quote line item as a real
// SaleLine (resolved to a verified parts_catalog entry, never a bare SKU
// string), then wraps it in a real Quote object. Confirmed live (2026-08-09,
// using throwaway data since archived afterward) that a plain POST SaleLine
// is rejected outright unless isSpecialOrder/isLayaway is set -- the actual
// working mechanism is a PUT on the Sale itself with a nested SaleLines
// array, which is NOT locked to special orders. All lines must go in ONE PUT
// call -- confirmed live this is additive, so two separate PUT calls would
// double up every line rather than replace them.
app.post('/api/records/:id/push-to-lightspeed', authMiddleware, async (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  if (record.lightspeed_quote_id) {
    return res.status(400).json({ error: `Already pushed to Lightspeed as Quote #${record.lightspeed_quote_id}` });
  }
  if (!record.lightspeed_customer_id) {
    return res.status(400).json({ error: 'This record has no linked Lightspeed customer yet' });
  }
  const lineItems = db.prepare('SELECT * FROM quote_line_items WHERE record_id = ? ORDER BY id ASC').all(req.params.id);
  if (!lineItems.length) {
    return res.status(400).json({ error: 'No quote line items to push' });
  }
  const employeeId = db.getSetting('lightspeed_employee_id');
  if (!employeeId) {
    return res.status(400).json({ error: 'Set a Lightspeed employee in Settings before pushing quotes' });
  }

  const { resolved: resolvedLines, problems } = resolveLinesForLightspeed(lineItems);
  if (problems.length) {
    return res.status(400).json({ error: 'Cannot push -- fix these lines first', problems });
  }

  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const acct = (path) => `${LIGHTSPEED_API_BASE}/Account/${accountId}/${path}`;

    const shopRes = await fetchLightspeed(acct('Shop.json'), { headers: authHeaders });
    if (!shopRes.ok) throw new Error(`Couldn't look up the Lightspeed shop: ${shopRes.status}`);
    const shopData = await shopRes.json();
    const shop = Array.isArray(shopData.Shop) ? shopData.Shop[0] : shopData.Shop;
    if (!shop) throw new Error('No Lightspeed shop found on this account');

    const registerRes = await fetchLightspeed(acct('Register.json'), { headers: authHeaders });
    if (!registerRes.ok) throw new Error(`Couldn't look up the Lightspeed register: ${registerRes.status}`);
    const registerData = await registerRes.json();
    const register = Array.isArray(registerData.Register) ? registerData.Register[0] : registerData.Register;
    if (!register) throw new Error('No Lightspeed register found on this account');

    const saleRes = await fetchLightspeed(acct('Sale.json'), {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        customerID: record.lightspeed_customer_id, employeeID: employeeId,
        shopID: shop.shopID, registerID: register.registerID, completed: 'false',
      }),
    });
    if (!saleRes.ok) throw new Error(`Couldn't create the Lightspeed sale: ${saleRes.status} ${await saleRes.text()}`);
    const saleData = await saleRes.json();
    const saleId = saleData.Sale.saleID;

    const linesRes = await fetchLightspeed(acct(`Sale/${saleId}.json`), {
      method: 'PUT', headers: authHeaders,
      body: JSON.stringify({ SaleLines: { SaleLine: resolvedLines } }),
    });
    if (!linesRes.ok) throw new Error(`Couldn't add line items: ${linesRes.status} ${await linesRes.text()}`);
    // Confirmed live (2026-08-11): this PUT's own response already includes
    // the newly-created SaleLine array, each with its real saleLineID, in the
    // same order as the request -- no follow-up GET needed. Recorded per
    // local line so a later edit (see /update-lightspeed) can reconcile
    // against Lightspeed's real line IDs instead of guessing.
    const linesData = await linesRes.json();
    const newLinesRaw = linesData.Sale && linesData.Sale.SaleLines && linesData.Sale.SaleLines.SaleLine
      ? (Array.isArray(linesData.Sale.SaleLines.SaleLine) ? linesData.Sale.SaleLines.SaleLine : [linesData.Sale.SaleLines.SaleLine])
      : [];
    const recordSaleLineId = db.prepare('UPDATE quote_line_items SET lightspeed_sale_line_id = ? WHERE id = ?');
    lineItems.forEach((li, i) => {
      if (newLinesRaw[i]) recordSaleLineId.run(newLinesRaw[i].saleLineID, li.id);
    });

    const quoteRes = await fetchLightspeed(acct('Quote.json'), {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ saleID: saleId, employeeID: employeeId, notes: record.quote_notes || '' }),
    });
    if (!quoteRes.ok) throw new Error(`Sale created, but the Quote wrapper failed: ${quoteRes.status} ${await quoteRes.text()}`);
    const quoteData = await quoteRes.json();
    const quoteId = quoteData.Quote.quoteID;

    db.prepare(`
      UPDATE service_records SET lightspeed_sale_id = ?, lightspeed_quote_id = ?, lightspeed_pushed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(saleId, quoteId, req.params.id);

    res.json({ success: true, lightspeed_sale_id: saleId, lightspeed_quote_id: quoteId });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Re-syncs an already-pushed quote's line items to Lightspeed after a local
// edit (see PUT /api/records/:id/quote above). Reconciles against the SAME
// existing Sale/Quote rather than creating a new one -- confirmed live
// (2026-08-11, using a throwaway Sale, archived afterward) that
// DELETE SaleLine/{id}.json genuinely removes a line (not a local no-op),
// and that PUT Sale/{id}.json {SaleLines:{SaleLine:[...]}} still works
// afterward to add a fresh batch, with the response's own SaleLine array
// coming back in the same order as the request. Deleting every existing line
// and re-adding the current full set is simpler and safer than trying to
// diff/patch individual lines in place, and this Sale's line count is always
// small (a handful of items on a motor service quote).
app.post('/api/records/:id/update-lightspeed', authMiddleware, async (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  if (!record.lightspeed_sale_id || !record.lightspeed_quote_id) {
    return res.status(400).json({ error: "This quote hasn't been pushed to Lightspeed yet" });
  }
  if (record.lightspeed_sale_completed_at) {
    return res.status(400).json({ error: "This quote's sale has already been completed in Lightspeed -- it can no longer be edited from here" });
  }
  const lineItems = db.prepare('SELECT * FROM quote_line_items WHERE record_id = ? ORDER BY id ASC').all(req.params.id);
  if (!lineItems.length) {
    return res.status(400).json({ error: 'No quote line items to push' });
  }

  const { resolved, problems } = resolveLinesForLightspeed(lineItems);
  if (problems.length) {
    return res.status(400).json({ error: 'Cannot update -- fix these lines first', problems });
  }

  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const acct = (path) => `${LIGHTSPEED_API_BASE}/Account/${accountId}/${path}`;
    const saleId = record.lightspeed_sale_id;

    const currentRes = await fetchLightspeed(acct(`Sale/${saleId}.json?load_relations=["SaleLines"]`), { headers: authHeaders });
    if (!currentRes.ok) throw new Error(`Couldn't read the existing Lightspeed sale: ${currentRes.status} ${await currentRes.text()}`);
    const currentData = await currentRes.json();
    const currentLinesRaw = currentData.Sale && currentData.Sale.SaleLines && currentData.Sale.SaleLines.SaleLine
      ? (Array.isArray(currentData.Sale.SaleLines.SaleLine) ? currentData.Sale.SaleLines.SaleLine : [currentData.Sale.SaleLines.SaleLine])
      : [];

    for (const line of currentLinesRaw) {
      const delRes = await fetchLightspeed(acct(`SaleLine/${line.saleLineID}.json`), { method: 'DELETE', headers: authHeaders });
      if (!delRes.ok) throw new Error(`Couldn't remove an old line item: ${delRes.status} ${await delRes.text()}`);
    }

    const addRes = await fetchLightspeed(acct(`Sale/${saleId}.json`), {
      method: 'PUT', headers: authHeaders,
      body: JSON.stringify({ SaleLines: { SaleLine: resolved } }),
    });
    if (!addRes.ok) throw new Error(`Couldn't add the updated line items: ${addRes.status} ${await addRes.text()}`);
    const addData = await addRes.json();
    const newLinesRaw = addData.Sale && addData.Sale.SaleLines && addData.Sale.SaleLines.SaleLine
      ? (Array.isArray(addData.Sale.SaleLines.SaleLine) ? addData.Sale.SaleLines.SaleLine : [addData.Sale.SaleLines.SaleLine])
      : [];

    const recordSaleLineId = db.prepare('UPDATE quote_line_items SET lightspeed_sale_line_id = ? WHERE id = ?');
    lineItems.forEach((li, i) => {
      if (newLinesRaw[i]) recordSaleLineId.run(newLinesRaw[i].saleLineID, li.id);
    });

    db.prepare(`
      UPDATE service_records SET lightspeed_pushed_at = CURRENT_TIMESTAMP, quote_edited_at = NULL WHERE id = ?
    `).run(req.params.id);

    res.json({ success: true, lightspeed_sale_id: saleId, lightspeed_quote_id: record.lightspeed_quote_id });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Checked in the background after the Board/History screens render (see
// app.js) -- for every pushed record whose Sale hasn't been confirmed
// complete yet, checks Lightspeed directly. Once a salesperson finishes
// checkout on the pushed Quote's Sale, it flips from "quote" (QN-prefixed)
// to "invoice" (IN-prefixed) in the UI -- same real Lightspeed object
// throughout, saleID unchanged, just relabeled once it's actually been paid.
// Cheap to call repeatedly: a no-op (one SQL query, zero Lightspeed calls)
// whenever nothing is still pending.
app.post('/api/records/check-lightspeed-invoices', authMiddleware, async (req, res) => {
  const pending = db.prepare(`
    SELECT id, lightspeed_sale_id FROM service_records
    WHERE lightspeed_sale_id IS NOT NULL AND lightspeed_sale_completed_at IS NULL
  `).all();
  if (!pending.length) return res.json({ checked: 0, becameInvoice: 0 });

  try {
    const { accessToken, accountId } = await getValidLightspeedToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    let becameInvoice = 0;
    await Promise.all(pending.map(async (record) => {
      try {
        const lsRes = await fetchLightspeed(`${LIGHTSPEED_API_BASE}/Account/${accountId}/Sale/${record.lightspeed_sale_id}.json`, {
          headers: authHeaders,
        });
        if (!lsRes.ok) return;
        const data = await lsRes.json();
        if (data.Sale && data.Sale.completed === 'true') {
          db.prepare('UPDATE service_records SET lightspeed_sale_completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(record.id);
          becameInvoice++;
        }
      } catch (err) { /* skip this one, try again next time */ }
    }));
    res.json({ checked: pending.length, becameInvoice });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---------- Public share page (no auth) ----------
const STAGE_MESSAGES = {
  received: 'Your motor has arrived at the workshop and is awaiting inspection.',
  inspection: 'Your motor is being opened up and inspected.',
  quoted: 'A quote has been prepared for this repair.',
  in_repair: 'Your motor is currently being repaired.',
  completed: 'Repair complete — your motor is ready to be sent back.',
  returned: 'This motor has been returned.'
};

app.get('/api/share/:token', (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE share_token = ?').get(req.params.token);
  if (!record) return res.status(404).json({ error: 'Not found' });

  const images = db.prepare(
    'SELECT id, filename, category FROM service_images WHERE record_id = ? ORDER BY created_at ASC'
  ).all(record.id);

  let stageMessage = STAGE_MESSAGES[record.status] || '';
  if (record.quote_status === 'refurb' && record.status === 'completed') {
    stageMessage = 'A reconditioned replacement motor has been prepared and is ready to be sent back.';
  } else if (record.quote_status === 'refurb' && record.status === 'returned') {
    stageMessage = 'A reconditioned replacement motor has been sent back.';
  }

  const payload = {
    serial_number: record.serial_number,
    brand: record.brand,
    model: record.model,
    stage: record.status,
    stage_message: stageMessage,
    date_received: record.date_received,
    date_completed: record.date_completed,
    date_returned: record.date_returned,
    issue_reported: record.issue_reported,
    damage_found: record.damage_found,
    work_performed: record.work_performed,
    images
  };
  if (record.quote_status === 'refurb') {
    payload.refurb_serial = record.refurb_serial;
  }
  if (record.quote_status !== 'not_sent' && record.quote_status !== 'skipped' && record.quote_status !== 'refurb') {
    payload.quote_amount = record.quote_amount;
    payload.quote_status = record.quote_status;
    payload.line_items = db.prepare(
      'SELECT sku, description, unit_price, quantity, category, original_unit_price FROM quote_line_items WHERE record_id = ? ORDER BY id ASC'
    ).all(record.id);
  }
  res.json(payload);
});

app.get('/share/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ---------- Public dealer history page (no auth) ----------
// One permanent link per dealer (the token never changes once a dealer exists) --
// unlike /api/share/:token above, which is per-record and meant to be re-shared for
// each new job, this one is meant to be bookmarked/saved once and always shows that
// dealer's current full motor history.
app.get('/api/share/dealer/:token', (req, res) => {
  const dealer = db.prepare('SELECT * FROM dealers WHERE share_token = ?').get(req.params.token);
  if (!dealer) return res.status(404).json({ error: 'Not found' });

  const records = db.prepare(`
    SELECT id, share_token, serial_number, brand, model, status, date_received, date_completed, date_returned
    FROM service_records
    WHERE dealer_name = ? COLLATE NOCASE
    ORDER BY date_received DESC, id DESC
  `).all(dealer.name);

  res.json({
    dealer_name: dealer.alias || dealer.name,
    records: records.map((r, i) => ({ ...r, is_latest: i === 0 }))
  });
});

app.get('/share/dealer/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'dealer-share.html'));
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Motor service tracker running on port ${PORT}`);
});
