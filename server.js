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

const BRANDS = ['Brose', 'Mahle'];
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
app.get('/api/records', authMiddleware, (req, res) => {
  const { search, status } = req.query;
  let query = 'SELECT * FROM service_records WHERE 1=1';
  const params = [];
  if (search) {
    query += ' AND (serial_number LIKE ? OR dealer_name LIKE ? OR brand LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC';
  const records = db.prepare(query).all(...params);

  const imageCountStmt = db.prepare('SELECT COUNT(*) as count FROM service_images WHERE record_id = ?');
  const withCounts = records.map(r => ({
    ...r,
    image_count: imageCountStmt.get(r.id).count
  }));
  res.json(withCounts);
});

app.get('/api/records/:id', authMiddleware, (req, res) => {
  const record = db.prepare('SELECT * FROM service_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  const images = db.prepare('SELECT * FROM service_images WHERE record_id = ? ORDER BY created_at ASC').all(req.params.id);
  const line_items = db.prepare('SELECT * FROM quote_line_items WHERE record_id = ? ORDER BY id ASC').all(req.params.id);
  res.json({ ...record, images, line_items });
});

app.post('/api/records', authMiddleware, (req, res) => {
  const {
    serial_number, brand, model, dealer_name, dealer_contact, source_type,
    date_received, date_completed, status, issue_reported,
    work_performed, parts_replaced, technician, notes
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

  const stmt = db.prepare(`
    INSERT INTO service_records
    (serial_number, brand, model, dealer_name, dealer_contact, source_type, date_received,
     date_completed, status, issue_reported, work_performed, parts_replaced, technician, notes, share_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    serial_number.trim(), brand, model || null, dealer_name || null,
    dealer_contact || null, source_type || 'dealer', date_received || null, date_completed || null,
    status || 'received', issue_reported || null, work_performed || null,
    parts_replaced || null, technician || null, notes || null,
    crypto.randomBytes(12).toString('hex')
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
    'quote_amount', 'quote_notes', 'refurb_serial'
  ];
  const updates = {};
  fields.forEach(f => {
    updates[f] = req.body[f] !== undefined ? req.body[f] : existing[f];
  });

  db.prepare(`
    UPDATE service_records SET
      serial_number = ?, brand = ?, model = ?, dealer_name = ?, dealer_contact = ?, source_type = ?,
      date_received = ?, date_completed = ?, date_returned = ?, status = ?, issue_reported = ?, damage_found = ?,
      work_performed = ?, parts_replaced = ?, technician = ?, notes = ?,
      quote_amount = ?, quote_notes = ?, refurb_serial = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    updates.serial_number, updates.brand, updates.model, updates.dealer_name,
    updates.dealer_contact, updates.source_type, updates.date_received, updates.date_completed,
    updates.date_returned, updates.status, updates.issue_reported, updates.damage_found, updates.work_performed,
    updates.parts_replaced, updates.technician, updates.notes,
    updates.quote_amount, updates.quote_notes, updates.refurb_serial, req.params.id
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
      quantity: Number(li.quantity) || 1
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
    const insertLine = db.prepare(
      'INSERT INTO quote_line_items (record_id, sku, description, unit_price, quantity) VALUES (?, ?, ?, ?, ?)'
    );
    items.forEach(li => insertLine.run(req.params.id, li.sku || null, li.description, li.unit_price, li.quantity));
  }

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
app.get('/api/parts', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM parts_catalog ORDER BY description ASC').all());
});

app.post('/api/parts', authMiddleware, (req, res) => {
  const { sku, description, cost, retail_price } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }
  const result = db.prepare(
    'INSERT INTO parts_catalog (sku, description, cost, retail_price) VALUES (?, ?, ?, ?)'
  ).run((sku || '').trim() || null, description.trim(), cost === '' || cost === undefined ? null : Number(cost), retail_price === '' || retail_price === undefined ? null : Number(retail_price));
  res.status(201).json(db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/parts/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Part not found' });
  const { sku, description, cost, retail_price } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required' });
  }
  db.prepare('UPDATE parts_catalog SET sku = ?, description = ?, cost = ?, retail_price = ? WHERE id = ?').run(
    (sku || '').trim() || null,
    description.trim(),
    cost === '' || cost === undefined ? null : Number(cost),
    retail_price === '' || retail_price === undefined ? null : Number(retail_price),
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(req.params.id));
});

app.delete('/api/parts/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM parts_catalog WHERE id = ?').run(req.params.id);
  res.json({ success: true });
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
      'SELECT sku, description, unit_price, quantity FROM quote_line_items WHERE record_id = ? ORDER BY id ASC'
    ).all(record.id);
  }
  res.json(payload);
});

app.get('/share/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
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
