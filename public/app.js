const API = '';
let TOKEN = localStorage.getItem('gmc_token') || null;
let currentFilter = { search: '', status: '' };
let currentRecord = null; // full record being viewed/edited
let pendingPhotos = []; // { file, url } staged before first save on new record
let activeTab = 'board';

const BRANDS = ['Brose', 'Mahle'];

const STAGE_META = {
  received:    { label: 'Received',    color: '#5B8DEF' },
  inspection:  { label: 'Inspection',  color: '#F2A93B' },
  quoted:      { label: 'Quoted',      color: '#B98CE0' },
  in_repair:   { label: 'In Repair',   color: '#E0637A' },
  completed:   { label: 'Completed',   color: '#3FBF7F' },
  returned:    { label: 'Returned',    color: '#8A8F98' },
};
const STAGE_ORDER = ['received', 'inspection', 'quoted', 'in_repair', 'completed', 'returned'];

const QUOTE_META = {
  not_sent: { label: 'Not sent',          color: '#8A8F98' },
  pending:  { label: 'Awaiting response', color: '#F2A93B' },
  approved: { label: 'Approved',          color: '#3FBF7F' },
  declined: { label: 'Declined',          color: '#E0637A' },
  skipped:  { label: 'Quote skipped',     color: '#8A8F98' },
  refurb:   { label: 'Refurb issued',     color: '#4FC3E8' },
};

const CATEGORY_META = {
  intake: 'Intake photos',
  damage: 'Damage found',
  repair: 'Repair',
  other:  'Other',
};
const CATEGORY_ORDER = ['damage', 'intake', 'repair', 'other'];

const app = document.getElementById('app');

// ---------- API helper ----------
async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (!(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) {
    TOKEN = null;
    localStorage.removeItem('gmc_token');
    renderLogin('Session expired. Please log in again.');
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function fmtDate(d) {
  if (!d) return '—';
  return d;
}

function fmtMoney(v) {
  if (v === null || v === undefined || v === '') return '—';
  return 'R' + Number(v).toFixed(2);
}

function lightspeedPushPanelHtml(r) {
  if (r.lightspeed_quote_id) {
    return `
      <div class="ls-linked-chip" style="margin-top:10px">
        <span>✓ Pushed to Lightspeed &mdash; Quote #${esc(r.lightspeed_quote_id)}</span>
      </div>
    `;
  }
  if (r.status !== 'completed' && r.status !== 'returned') {
    return `<p class="hint-text">Can be pushed to Lightspeed once the motor is marked Completed.</p>`;
  }
  if (!r.lightspeed_customer_id) {
    return `<p class="hint-text">Link a Lightspeed customer above before this can be pushed.</p>`;
  }
  if (!r.line_items || !r.line_items.length) return '';
  return `<button class="btn btn-primary btn-small" id="push-to-lightspeed-btn" style="margin-top:10px">Push to Lightspeed</button>`;
}

function quoteLineItemsReadOnlyHtml(items) {
  if (!items || !items.length) return '';
  return `
    <div class="quote-line-items-readonly">
      ${items.map(li => `
        <div class="quote-line-readonly-row">
          <span>${esc(li.description)}${li.sku ? ` <span class="quote-line-sku">${esc(li.sku)}</span>` : ''}</span>
          <span>${li.quantity} &times; ${fmtMoney(li.unit_price)}</span>
          <span>${fmtMoney(li.unit_price * li.quantity)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// Clipboard API requires a secure context (HTTPS or localhost) -- this app runs
// over plain HTTP on the LAN, so navigator.clipboard is undefined there and
// calling it throws synchronously. Fall back to the old execCommand trick.
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* fall through to legacy method */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (e) { /* fall through */ }
  return false;
}

// Shared, debounced Lightspeed customer search -- used both by the dealer
// Lightspeed-link picker (Settings) and the "Direct customer" search on a new
// service record. inputEl is the text box the tech types into, resultsEl is
// where matches render, onSelect(customer) fires when one is clicked.
function wireLightspeedSearch(inputEl, resultsEl, onSelect) {
  let debounceTimer;
  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = inputEl.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    debounceTimer = setTimeout(async () => {
      resultsEl.innerHTML = `<div class="hint-text">Searching Lightspeed…</div>`;
      try {
        const results = await api(`/api/lightspeed/customers?q=${encodeURIComponent(q)}`);
        if (!results.length) {
          resultsEl.innerHTML = `<div class="hint-text">No matches in Lightspeed.</div>`;
          return;
        }
        resultsEl.innerHTML = results.map(c => `
          <div class="ls-customer-result" data-id="${esc(c.id)}">
            <div style="font-weight:600">${esc(c.name)}${c.company ? ` <span class="hint-text">(${esc(c.company)})</span>` : ''}</div>
            ${(c.phone || c.email) ? `<div class="hint-text">${[esc(c.phone), esc(c.email)].filter(Boolean).join(' &middot; ')}</div>` : ''}
          </div>
        `).join('');
        resultsEl.querySelectorAll('.ls-customer-result').forEach(row => {
          row.addEventListener('click', () => {
            const chosen = results.find(c => String(c.id) === row.dataset.id);
            resultsEl.innerHTML = '';
            inputEl.value = '';
            onSelect(chosen);
          });
        });
      } catch (err) {
        resultsEl.innerHTML = `<div class="hint-text">Search failed: ${esc(err.message)}</div>`;
      }
    }, 300);
  });
}

// Same debounced-search shape as wireLightspeedSearch, but against real
// Lightspeed items -- used ONLY by the admin-only "Add from Lightspeed"
// picker on Settings' Parts catalog card, never surfaced to a mechanic.
function wireLightspeedItemSearch(inputEl, resultsEl, onSelect) {
  let debounceTimer;
  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = inputEl.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    debounceTimer = setTimeout(async () => {
      resultsEl.innerHTML = `<div class="hint-text">Searching Lightspeed…</div>`;
      try {
        const results = await api(`/api/lightspeed/items?q=${encodeURIComponent(q)}`);
        if (!results.length) {
          resultsEl.innerHTML = `<div class="hint-text">No matching Lightspeed items.</div>`;
          return;
        }
        resultsEl.innerHTML = results.map(item => `
          <div class="ls-item-result" data-id="${esc(item.id)}">
            <div style="font-weight:600">${esc(item.description)}</div>
            <div class="hint-text">${item.sku ? esc(item.sku) + ' &middot; ' : ''}Cost ${fmtMoney(item.cost)} &middot; Retail ${fmtMoney(item.retail_price)}</div>
          </div>
        `).join('');
        resultsEl.querySelectorAll('.ls-item-result').forEach(row => {
          row.addEventListener('click', () => {
            const chosen = results.find(item => String(item.id) === row.dataset.id);
            resultsEl.innerHTML = '';
            inputEl.value = '';
            onSelect(chosen);
          });
        });
      } catch (err) {
        resultsEl.innerHTML = `<div class="hint-text">Search failed: ${esc(err.message)}</div>`;
      }
    }, 300);
  });
}

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  const img = document.createElement('img');
  img.src = src;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'lightbox-close';
  closeBtn.textContent = '×';
  overlay.appendChild(img);
  overlay.appendChild(closeBtn);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// ---------- Login ----------
function renderLogin(errorMsg) {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-mark"></div>
        <h1 class="login-title">GMC Motor Service Log</h1>
        <p class="login-sub">Greg Minnaar Cycles &middot; Workshop access</p>
        <form id="login-form">
          <div class="field">
            <label for="passcode">Workshop passcode</label>
            <input type="password" id="passcode" inputmode="text" autocomplete="current-password" autofocus />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Log in</button>
          <div class="error-text">${esc(errorMsg || '')}</div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const passcode = document.getElementById('passcode').value;
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ passcode }) });
      TOKEN = data.token;
      localStorage.setItem('gmc_token', TOKEN);
      renderBoard();
    } catch (err) {
      renderLogin('Incorrect passcode. Try again.');
    }
  });
}

// ---------- Shared top bar / tabs ----------
function topBarHtml(tab) {
  return `
    <div class="topbar">
      <div class="topbar-row">
        <img class="topbar-logo" src="/gmc-logo.png" alt="Greg Minnaar Cycles" />
        <div style="display:flex;gap:10px">
          <button class="icon-btn" id="settings-btn">Settings</button>
          <button class="icon-btn" id="logout-btn">Log out</button>
        </div>
      </div>
      <div class="tab-row" id="tab-row">
        <button class="tab ${tab === 'board' ? 'active' : ''}" data-tab="board">Board</button>
        <button class="tab ${tab === 'history' ? 'active' : ''}" data-tab="history">History</button>
      </div>
    </div>
  `;
}

function wireTopBar() {
  document.getElementById('logout-btn').addEventListener('click', () => {
    TOKEN = null;
    localStorage.removeItem('gmc_token');
    renderLogin();
  });
  document.getElementById('settings-btn').addEventListener('click', () => renderSettings());
  document.getElementById('tab-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    if (btn.dataset.tab === 'board') renderBoard();
    else renderList();
  });
}

// ---------- Settings ----------
function renderSettings() {
  app.innerHTML = `
    <div class="screen">
      <div class="screen-header">
        <button class="icon-btn" id="settings-back-btn">&#8592;</button>
        <h2>Settings</h2>
        <span style="width:24px"></span>
      </div>
      <div class="screen-body">
        <div class="section-label">Workshop passcode</div>
        <form id="passcode-form">
          <div class="field">
            <label>Current passcode</label>
            <input type="password" id="s-current-passcode" autocomplete="current-password" required />
          </div>
          <div class="field">
            <label>New passcode</label>
            <input type="password" id="s-new-passcode" autocomplete="new-password" required minlength="4" />
          </div>
          <div class="field">
            <label>Confirm new passcode</label>
            <input type="password" id="s-confirm-passcode" autocomplete="new-password" required minlength="4" />
          </div>
          <button type="submit" class="btn btn-primary" id="passcode-save-btn">Update passcode</button>
        </form>
        <p class="hint-text">Everyone at the workshop shares this one passcode to log in — updating it here takes effect immediately for new logins. Devices already logged in stay logged in until they log out.</p>

        <div class="section-label">Lightspeed</div>
        <div id="lightspeed-status"><div class="empty-state"><div class="spinner"></div></div></div>
        <div class="field" style="margin-top:10px">
          <label>Employee for pushed quotes</label>
          <select id="lightspeed-employee-select" disabled>
            <option value="">Loading&hellip;</option>
          </select>
        </div>
        <p class="hint-text">A pushed quote is created in Lightspeed under this employee, since there's no per-mechanic login here.</p>

        <div class="section-label">Dealers</div>
        <p class="hint-text">Shown as a pick-list on the "Sent by" section of a new service record. Add, rename, or remove dealers here any time.</p>
        <div id="dealers-list"><div class="empty-state"><div class="spinner"></div></div></div>
        <div class="workflow-card" style="margin-top:12px">
          <div class="section-label" style="margin-top:0">Add a dealer</div>
          <div class="field">
            <label>Name</label>
            <input type="text" id="dealer-new-name" />
          </div>
          <div class="field">
            <label>Contact</label>
            <input type="text" id="dealer-new-contact" placeholder="Phone or email (optional)" />
          </div>
          <button class="btn btn-secondary" id="dealer-add-btn">Add dealer</button>
        </div>

        <div class="section-label">Parts catalog</div>
        <p class="hint-text">This is the exact list a mechanic can pick from when building a quote -- they never see a live Lightspeed search, only what's added here. Add real parts below, or verify existing ones still match a real Lightspeed item.</p>
        <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
          <button class="btn btn-ghost btn-small" id="parts-verify-all-btn">Verify all</button>
        </div>
        <div id="parts-catalog-list"><div class="empty-state"><div class="spinner"></div></div></div>

        <div class="workflow-card" style="margin-top:12px">
          <div class="section-label" style="margin-top:0">Add from Lightspeed</div>
          <p class="hint-text" style="margin-top:0">Search your real Lightspeed catalog and add the exact item -- captures its real SKU and current cost/retail price automatically.</p>
          <input type="text" id="part-ls-search-input" placeholder="Search Lightspeed items&hellip;" />
          <div class="ls-search-results" id="part-ls-search-results"></div>
        </div>

        <div class="workflow-card" style="margin-top:12px">
          <div class="section-label" style="margin-top:0">Add a part manually</div>
          <p class="hint-text" style="margin-top:0">For a one-off code with no real Lightspeed item (e.g. a labour charge) -- won't show as Lightspeed-verified until linked.</p>
          <div class="field">
            <label>SKU</label>
            <input type="text" id="part-new-sku" style="font-family:var(--mono);text-transform:uppercase" />
          </div>
          <div class="field">
            <label>Description</label>
            <input type="text" id="part-new-desc" />
          </div>
          <div class="form-row-2">
            <div class="field">
              <label>Cost (ZAR)</label>
              <input type="number" step="0.01" id="part-new-cost" />
            </div>
            <div class="field">
              <label>Retail price (ZAR)</label>
              <input type="number" step="0.01" id="part-new-retail" />
            </div>
          </div>
          <button class="btn btn-secondary" id="part-add-btn">Add part</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('settings-back-btn').addEventListener('click', () => activeTab === 'history' ? renderList() : renderBoard());
  loadLightspeedStatus();
  loadLightspeedEmployeeSetting();
  loadDealersSettings();
  document.getElementById('dealer-add-btn').addEventListener('click', async () => {
    const name = document.getElementById('dealer-new-name').value.trim();
    const contact = document.getElementById('dealer-new-contact').value.trim();
    if (!name) { showToast('Enter a dealer name'); return; }
    try {
      await api('/api/dealers', { method: 'POST', body: JSON.stringify({ name, contact }) });
      document.getElementById('dealer-new-name').value = '';
      document.getElementById('dealer-new-contact').value = '';
      showToast('Dealer added');
      loadDealersSettings();
    } catch (err) { showToast(err.message); }
  });

  loadPartsCatalogSettings();

  wireLightspeedItemSearch(
    document.getElementById('part-ls-search-input'),
    document.getElementById('part-ls-search-results'),
    async (item) => {
      try {
        await api('/api/parts/from-lightspeed', {
          method: 'POST',
          body: JSON.stringify({
            lightspeed_item_id: item.id, sku: item.sku, description: item.description,
            cost: item.cost, retail_price: item.retail_price,
          }),
        });
        showToast('Added from Lightspeed');
        loadPartsCatalogSettings();
      } catch (err) { showToast(err.message); }
    }
  );

  document.getElementById('parts-verify-all-btn').addEventListener('click', async () => {
    const btn = document.getElementById('parts-verify-all-btn');
    btn.disabled = true;
    try {
      const parts = await api('/api/parts');
      const unverified = parts.filter(p => !p.lightspeed_item_id && p.sku);
      if (!unverified.length) { showToast('Nothing to verify'); return; }
      let ok = 0, failed = 0;
      for (const p of unverified) {
        btn.textContent = `Verifying ${ok + failed + 1} of ${unverified.length}…`;
        try {
          const result = await api(`/api/parts/${p.id}/verify`, { method: 'POST' });
          if (result.verified) ok++; else failed++;
        } catch (err) { failed++; }
      }
      showToast(`Verified ${ok}, ${failed} not found in Lightspeed`);
      loadPartsCatalogSettings();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify all';
    }
  });

  document.getElementById('part-add-btn').addEventListener('click', async () => {
    const sku = document.getElementById('part-new-sku').value.trim();
    const description = document.getElementById('part-new-desc').value.trim();
    const cost = document.getElementById('part-new-cost').value;
    const retail_price = document.getElementById('part-new-retail').value;
    if (!description) { showToast('Enter a description'); return; }
    try {
      await api('/api/parts', { method: 'POST', body: JSON.stringify({ sku, description, cost, retail_price }) });
      document.getElementById('part-new-sku').value = '';
      document.getElementById('part-new-desc').value = '';
      document.getElementById('part-new-cost').value = '';
      document.getElementById('part-new-retail').value = '';
      showToast('Part added');
      loadPartsCatalogSettings();
    } catch (err) { showToast(err.message); }
  });

  document.getElementById('passcode-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current_passcode = document.getElementById('s-current-passcode').value;
    const new_passcode = document.getElementById('s-new-passcode').value;
    const confirm_passcode = document.getElementById('s-confirm-passcode').value;

    if (new_passcode !== confirm_passcode) {
      showToast("New passcode entries don't match");
      return;
    }
    try {
      await api('/api/settings/passcode', { method: 'POST', body: JSON.stringify({ current_passcode, new_passcode }) });
      showToast('Passcode updated');
      activeTab === 'history' ? renderList() : renderBoard();
    } catch (err) {
      showToast(err.message);
    }
  });
}

async function loadLightspeedEmployeeSetting() {
  const selectEl = document.getElementById('lightspeed-employee-select');
  if (!selectEl) return;
  try {
    const [employees, current] = await Promise.all([
      api('/api/lightspeed/employees'),
      api('/api/settings/lightspeed-employee'),
    ]);
    selectEl.innerHTML = `
      <option value="">Select employee&hellip;</option>
      ${employees.map(e => `<option value="${esc(e.id)}" ${current.id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
    `;
    selectEl.disabled = false;
    selectEl.addEventListener('change', async () => {
      const chosen = employees.find(e => e.id === selectEl.value);
      if (!chosen) return;
      try {
        await api('/api/settings/lightspeed-employee', { method: 'POST', body: JSON.stringify({ id: chosen.id, name: chosen.name }) });
        showToast('Saved');
      } catch (err) { showToast(err.message); }
    });
  } catch (err) {
    selectEl.innerHTML = `<option value="">Couldn't load -- connect Lightspeed first</option>`;
  }
}

async function loadLightspeedStatus() {
  const el = document.getElementById('lightspeed-status');
  if (!el) return;
  try {
    const status = await api('/api/lightspeed/status');
    renderLightspeedStatus(status);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load Lightspeed status.<br/>${esc(err.message)}</div>`;
  }
}

function renderLightspeedStatus(status) {
  const el = document.getElementById('lightspeed-status');
  if (!status.configured) {
    el.innerHTML = `<p class="hint-text">Not set up yet -- add LIGHTSPEED_CLIENT_ID, LIGHTSPEED_CLIENT_SECRET, and LIGHTSPEED_REDIRECT_URI to the server and redeploy before this can be connected.</p>`;
    return;
  }
  if (status.connected) {
    el.innerHTML = `
      <p class="hint-text">Connected to Lightspeed account #${esc(status.account_id)}, since ${esc(status.connected_at)}.</p>
      <button class="btn btn-secondary" id="lightspeed-disconnect-btn">Disconnect</button>
    `;
    document.getElementById('lightspeed-disconnect-btn').addEventListener('click', async () => {
      if (!confirm('Disconnect this Lightspeed connection?')) return;
      try {
        await api('/api/lightspeed/disconnect', { method: 'POST' });
        showToast('Lightspeed disconnected');
        loadLightspeedStatus();
      } catch (err) { showToast(err.message); }
    });
    return;
  }
  el.innerHTML = `
    <p class="hint-text">Not connected yet.</p>
    <button class="btn btn-primary" id="lightspeed-connect-btn">Connect to Lightspeed</button>
  `;
  document.getElementById('lightspeed-connect-btn').addEventListener('click', async () => {
    try {
      const { url } = await api('/api/lightspeed/connect-url');
      window.location.href = url;
    } catch (err) { showToast(err.message); }
  });
}

let dealersEditingId = null;

async function loadDealersSettings() {
  const el = document.getElementById('dealers-list');
  if (!el) return;
  try {
    const dealers = await api('/api/dealers');
    renderDealersSettings(dealers);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load dealers.<br/>${esc(err.message)}</div>`;
  }
}

function renderDealersSettings(dealers) {
  const el = document.getElementById('dealers-list');
  if (!dealers.length) {
    el.innerHTML = `<div class="empty-state">No dealers yet. Add one below.</div>`;
    return;
  }
  el.innerHTML = dealers.map(d => {
    if (d.id === dealersEditingId) {
      return `
        <div class="quote-line-row" data-id="${d.id}">
          <input type="text" class="quote-line-desc dealer-edit-name" value="${esc(d.name)}" placeholder="Name" style="margin-bottom:6px" />
          <div class="quote-line-controls">
            <input type="text" class="dealer-edit-contact" value="${esc(d.contact)}" placeholder="Phone or email" />
            <button type="button" class="btn btn-secondary btn-small dealer-save-btn" data-id="${d.id}">Save</button>
            <button type="button" class="btn btn-ghost btn-small dealer-cancel-btn">Cancel</button>
          </div>
          <div class="section-label" style="margin-top:10px">Lightspeed customer</div>
          ${d.lightspeed_customer_id ? `
            <div class="ls-linked-chip">
              <span>🔗 ${esc(d.lightspeed_customer_name)}</span>
              <button type="button" class="btn btn-ghost btn-small dealer-ls-unlink-btn" data-id="${d.id}">Unlink</button>
            </div>
          ` : `
            <input type="text" class="dealer-ls-search-input" placeholder="Search Lightspeed customers…" />
            <div class="ls-search-results dealer-ls-search-results"></div>
          `}
        </div>
      `;
    }
    return `
      <div class="quote-line-row" data-id="${d.id}">
        <div class="quote-line-desc" style="border:none;background:none;padding:0 0 4px;margin-bottom:0">${esc(d.name)}</div>
        ${d.lightspeed_customer_id ? `<div class="hint-text">🔗 Lightspeed: ${esc(d.lightspeed_customer_name)}</div>` : ''}
        <div class="quote-line-controls">
          <span>${d.contact ? esc(d.contact) : '&mdash;'}</span>
          <button type="button" class="btn btn-ghost btn-small dealer-link-btn" data-token="${esc(d.share_token)}" title="Copy this dealer's permanent history link">🔗 Link</button>
          <button type="button" class="btn btn-ghost btn-small dealer-edit-btn" data-id="${d.id}">Edit</button>
          <button type="button" class="quote-line-remove dealer-delete-btn" data-id="${d.id}" aria-label="Delete dealer">&times;</button>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.dealer-ls-search-input').forEach(input => {
    const row = input.closest('.quote-line-row');
    const resultsEl = row.querySelector('.dealer-ls-search-results');
    const dealerId = row.dataset.id;
    wireLightspeedSearch(input, resultsEl, async (customer) => {
      try {
        await api(`/api/dealers/${dealerId}/lightspeed-link`, {
          method: 'POST', body: JSON.stringify({ customer_id: customer.id, customer_name: customer.name })
        });
        showToast('Linked to Lightspeed');
        loadDealersSettings();
      } catch (err) { showToast(err.message); }
    });
  });
  el.querySelectorAll('.dealer-ls-unlink-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm("Unlink this dealer from their Lightspeed customer record?")) return;
    try {
      await api(`/api/dealers/${btn.dataset.id}/lightspeed-unlink`, { method: 'POST' });
      showToast('Unlinked');
      loadDealersSettings();
    } catch (err) { showToast(err.message); }
  }));

  el.querySelectorAll('.dealer-link-btn').forEach(btn => btn.addEventListener('click', async () => {
    const url = `${location.origin}/share/dealer/${btn.dataset.token}`;
    const ok = await copyToClipboard(url);
    showToast(ok ? 'Link copied — send it to the dealer' : url);
  }));
  el.querySelectorAll('.dealer-edit-btn').forEach(btn => btn.addEventListener('click', () => {
    dealersEditingId = Number(btn.dataset.id);
    renderDealersSettings(dealers);
  }));
  el.querySelectorAll('.dealer-cancel-btn').forEach(btn => btn.addEventListener('click', () => {
    dealersEditingId = null;
    renderDealersSettings(dealers);
  }));
  el.querySelectorAll('.dealer-save-btn').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.quote-line-row');
    const name = row.querySelector('.dealer-edit-name').value.trim();
    const contact = row.querySelector('.dealer-edit-contact').value.trim();
    if (!name) { showToast('Enter a name'); return; }
    try {
      await api(`/api/dealers/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify({ name, contact }) });
      dealersEditingId = null;
      showToast('Dealer updated');
      loadDealersSettings();
    } catch (err) { showToast(err.message); }
  }));
  el.querySelectorAll('.dealer-delete-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Remove this dealer from the list? Existing service records keep their dealer name either way.')) return;
    try {
      await api(`/api/dealers/${btn.dataset.id}`, { method: 'DELETE' });
      showToast('Dealer removed');
      loadDealersSettings();
    } catch (err) { showToast(err.message); }
  }));
}

let partsCatalogEditingId = null;

async function loadPartsCatalogSettings() {
  const el = document.getElementById('parts-catalog-list');
  if (!el) return;
  try {
    const parts = await api('/api/parts');
    renderPartsCatalogSettings(parts);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load parts.<br/>${esc(err.message)}</div>`;
  }
}

function renderPartsCatalogSettings(parts) {
  const el = document.getElementById('parts-catalog-list');
  if (!parts.length) {
    el.innerHTML = `<div class="empty-state">No parts yet. Add one below.</div>`;
    return;
  }
  el.innerHTML = parts.map(p => {
    if (p.id === partsCatalogEditingId) {
      return `
        <div class="quote-line-row" data-id="${p.id}">
          <input type="text" class="part-edit-sku" value="${esc(p.sku)}" placeholder="SKU" style="font-family:var(--mono);text-transform:uppercase;margin-bottom:6px" />
          <input type="text" class="quote-line-desc part-edit-desc" value="${esc(p.description)}" placeholder="Description" />
          <div class="quote-line-controls" style="margin-top:6px">
            <input type="number" class="quote-line-price part-edit-cost" value="${p.cost}" step="0.01" placeholder="Cost" />
            <input type="number" class="quote-line-price part-edit-retail" value="${p.retail_price}" step="0.01" placeholder="Retail" />
            <button type="button" class="btn btn-secondary btn-small part-save-btn" data-id="${p.id}">Save</button>
            <button type="button" class="btn btn-ghost btn-small part-cancel-btn">Cancel</button>
          </div>
        </div>
      `;
    }
    const verifyBadge = p.lightspeed_item_id
      ? `<span class="part-verify-badge verified" title="Linked to a real Lightspeed item, last synced ${esc(p.lightspeed_synced_at || '')}">✓ Lightspeed</span>`
      : `<span class="part-verify-badge unverified">Not verified</span>`;
    return `
      <div class="quote-line-row" data-id="${p.id}">
        <div class="quote-line-desc" style="border:none;background:none;padding:0 0 4px;margin-bottom:0">${esc(p.description)} ${p.sku ? `<span class="quote-line-sku">${esc(p.sku)}</span>` : ''}</div>
        <div style="margin-bottom:6px">${verifyBadge}</div>
        <div class="quote-line-controls">
          <span>Cost ${fmtMoney(p.cost)}</span>
          <span class="quote-line-total">Retail ${fmtMoney(p.retail_price)}</span>
          ${!p.lightspeed_item_id ? `<button type="button" class="btn btn-ghost btn-small part-verify-btn" data-id="${p.id}">Verify</button>` : ''}
          <button type="button" class="btn btn-ghost btn-small part-edit-btn" data-id="${p.id}">Edit</button>
          <button type="button" class="quote-line-remove part-delete-btn" data-id="${p.id}" aria-label="Delete part">&times;</button>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.part-verify-btn').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const result = await api(`/api/parts/${btn.dataset.id}/verify`, { method: 'POST' });
      if (result.verified) {
        showToast('Verified against Lightspeed');
      } else {
        showToast(result.reason || "Couldn't verify this part");
      }
      loadPartsCatalogSettings();
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  }));

  el.querySelectorAll('.part-edit-btn').forEach(btn => btn.addEventListener('click', () => {
    partsCatalogEditingId = Number(btn.dataset.id);
    renderPartsCatalogSettings(parts);
  }));
  el.querySelectorAll('.part-cancel-btn').forEach(btn => btn.addEventListener('click', () => {
    partsCatalogEditingId = null;
    renderPartsCatalogSettings(parts);
  }));
  el.querySelectorAll('.part-save-btn').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.quote-line-row');
    const sku = row.querySelector('.part-edit-sku').value.trim();
    const description = row.querySelector('.part-edit-desc').value.trim();
    const cost = row.querySelector('.part-edit-cost').value;
    const retail_price = row.querySelector('.part-edit-retail').value;
    if (!description) { showToast('Enter a description'); return; }
    try {
      await api(`/api/parts/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify({ sku, description, cost, retail_price }) });
      partsCatalogEditingId = null;
      showToast('Part updated');
      loadPartsCatalogSettings();
    } catch (err) { showToast(err.message); }
  }));
  el.querySelectorAll('.part-delete-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Remove this part from the catalog?')) return;
    try {
      await api(`/api/parts/${btn.dataset.id}`, { method: 'DELETE' });
      showToast('Part removed');
      loadPartsCatalogSettings();
    } catch (err) { showToast(err.message); }
  }));
}

function stageBadge(status) {
  const meta = STAGE_META[status] || STAGE_META.received;
  return `<span class="status-badge" style="background:${meta.color};color:#15171B">${meta.label}</span>`;
}

function quoteMiniBadge(r) {
  if (!r.quote_status || r.quote_status === 'not_sent') return '';
  if (r.quote_status === 'skipped' && r.refurb_suggested) {
    return `<span class="mini-badge" style="background:${QUOTE_META.refurb.color};color:#15171B">Refurb suggested</span>`;
  }
  const meta = QUOTE_META[r.quote_status];
  return `<span class="mini-badge" style="background:${meta.color};color:#15171B">${meta.label}</span>`;
}

// ---------- Board (kanban) ----------
async function renderBoard() {
  activeTab = 'board';
  app.innerHTML = `
    ${topBarHtml('board')}
    <div class="board" id="board">
      ${STAGE_ORDER.map((s, i) => `
        <div class="board-col">
          <div class="board-col-header" style="border-color:${STAGE_META[s].color}">
            <span>${STAGE_META[s].label}</span>
            <span class="board-col-count" id="count-${s}">&hellip;</span>
          </div>
          <div class="board-col-cards" id="col-${s}"></div>
          ${i === 0 ? '<button class="fab-inline" id="fab-new-inline">+ Log new motor</button>' : ''}
        </div>
      `).join('')}
    </div>
    <button class="fab" id="fab-new">+</button>
  `;
  wireTopBar();
  document.getElementById('fab-new').addEventListener('click', () => renderForm(null));
  document.getElementById('fab-new-inline').addEventListener('click', () => renderForm(null));

  try {
    const records = await api('/api/records');
    STAGE_ORDER.forEach(s => {
      const col = document.getElementById(`col-${s}`);
      const items = records.filter(r => r.status === s);
      document.getElementById(`count-${s}`).textContent = items.length;
      if (!items.length) {
        col.innerHTML = `<div class="board-empty">No motors</div>`;
        return;
      }
      col.innerHTML = items.map(r => `
        <div class="board-card" data-id="${r.id}">
          <div class="board-card-title">${esc(r.dealer_name) || '—'}</div>
          <div class="board-card-meta">${esc(r.brand)}${r.model ? ' ' + esc(r.model) : ''}</div>
          <div class="board-card-meta" style="font-family:var(--mono)">${esc(r.serial_number)}</div>
          ${quoteMiniBadge(r)}
        </div>
      `).join('');
      items.forEach(r => {
        const card = col.querySelector(`.board-card[data-id="${r.id}"]`);
        if (card) wireBoardCardSwipe(card, r);
      });
    });
  } catch (err) {
    document.getElementById('board').innerHTML = `<div class="empty-state">Couldn't load board.<br/>${esc(err.message)}</div>`;
  }
}

// Drag/swipe a board card left or right to move it to the adjacent stage --
// works with touch (phone) or mouse (desktop) via Pointer Events. Left = back
// a stage, right = forward a stage. A tap with no real movement still opens
// the record's detail view, same as before.
function wireBoardCardSwipe(card, record) {
  const SWIPE_THRESHOLD = 70;
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let dx = 0;

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    moved = false;
    dx = 0;
    startX = e.clientX;
    startY = e.clientY;
    card.style.transition = 'none';
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const curDx = e.clientX - startX;
    const curDy = e.clientY - startY;
    if (!moved && Math.abs(curDx) < 8 && Math.abs(curDy) < 8) return;
    if (!moved && Math.abs(curDy) > Math.abs(curDx)) return; // vertical intent -- let it scroll
    moved = true;
    dx = curDx;
    card.style.transform = `translateX(${dx}px)`;
    card.style.opacity = String(Math.max(1 - Math.abs(dx) / 300, 0.4));
  });

  const endDrag = async () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = 'transform 0.15s, opacity 0.15s';
    card.style.transform = '';
    card.style.opacity = '';

    if (!moved) {
      renderDetail(record.id);
      return;
    }
    if (Math.abs(dx) < SWIPE_THRESHOLD) return; // didn't clear the threshold, snaps back

    const idx = STAGE_ORDER.indexOf(record.status);
    const targetIdx = dx < 0 ? idx - 1 : idx + 1;
    if (targetIdx < 0) { showToast('Already at the first stage'); return; }
    if (targetIdx >= STAGE_ORDER.length) { showToast('Already at the last stage'); return; }

    try {
      const targetStage = STAGE_ORDER[targetIdx];
      await api(`/api/records/${record.id}/stage`, { method: 'PUT', body: JSON.stringify({ stage: targetStage }) });
      showToast(`Moved to ${STAGE_META[targetStage].label}`);
      renderBoard();
    } catch (err) {
      showToast(err.message);
    }
  };

  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);
}

// ---------- History (flat searchable list) ----------
async function renderList() {
  activeTab = 'history';
  app.innerHTML = `
    ${topBarHtml('history')}
    <div class="history-controls">
      <input type="text" class="search-input" id="search-input" placeholder="Search serial, dealer, brand..." value="${esc(currentFilter.search)}" />
      <div class="chip-row" id="chip-row">
        <button class="chip ${currentFilter.status === '' ? 'active' : ''}" data-status="">All</button>
        ${STAGE_ORDER.map(s => `<button class="chip ${currentFilter.status === s ? 'active' : ''}" data-status="${s}">${STAGE_META[s].label}</button>`).join('')}
      </div>
    </div>
    <div class="record-list" id="record-list">
      <div class="empty-state"><div class="spinner"></div></div>
    </div>
    <button class="fab" id="fab-new">+</button>
  `;
  wireTopBar();
  document.getElementById('fab-new').addEventListener('click', () => renderForm(null));

  const searchInput = document.getElementById('search-input');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      currentFilter.search = searchInput.value;
      loadRecords();
    }, 300);
  });

  document.getElementById('chip-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    currentFilter.status = btn.dataset.status;
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    loadRecords();
  });

  await loadRecords();
}

async function loadRecords() {
  const listEl = document.getElementById('record-list');
  if (!listEl) return;
  try {
    const params = new URLSearchParams();
    if (currentFilter.search) params.set('search', currentFilter.search);
    if (currentFilter.status) params.set('status', currentFilter.status);
    const records = await api('/api/records?' + params.toString());
    if (records.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="big">&#128295;</div>
          <div>No service records yet.<br/>Tap + to log a motor.</div>
        </div>
      `;
      return;
    }
    listEl.innerHTML = records.map(r => {
      const meta = STAGE_META[r.status] || STAGE_META.received;
      return `
        <div class="record-card" style="border-left-color:${meta.color}" data-id="${r.id}">
          <div class="record-card-top">
            <span class="record-card-title">${esc(r.dealer_name) || '—'}</span>
            <span class="status-badge" style="background:${meta.color};color:#15171B">${meta.label}</span>
          </div>
          <div class="record-card-meta">
            ${r.brand ? `<span class="record-card-brand">${esc(r.brand)}${r.model ? ' ' + esc(r.model) : ''}</span>` : ''}
            <span class="record-card-serial">&middot; ${esc(r.serial_number)}</span>
            ${r.date_received ? `<span>&middot; in ${esc(r.date_received)}</span>` : ''}
            ${r.image_count ? `<span>&middot; &#128247; ${r.image_count}</span>` : ''}
            ${quoteMiniBadge(r)}
          </div>
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.record-card').forEach(card => {
      card.addEventListener('click', () => renderDetail(card.dataset.id));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Couldn't load records.<br/>${esc(err.message)}</div>`;
  }
}

// ---------- Detail ----------
async function renderDetail(id) {
  app.innerHTML = `<div class="screen"><div class="empty-state" style="margin-top:100px"><div class="spinner"></div></div></div>`;
  try {
    const r = await api(`/api/records/${id}`);
    currentRecord = r;

    app.innerHTML = `
      <div class="screen">
        <div class="screen-header">
          <button class="icon-btn" id="back-btn">&#8592;</button>
          <h2>${esc(r.serial_number)}</h2>
          <button class="icon-btn" id="edit-btn">Edit</button>
        </div>
        <div class="screen-body">
          ${stageBadge(r.status)}
          <a class="btn btn-ghost btn-small" id="customer-link-anchor" href="${location.origin}/share/${r.share_token}" target="_blank" rel="noopener" style="margin-left:8px;text-decoration:none">🔗 Open customer link</a>
          <button class="btn btn-ghost btn-small" id="copy-link-btn" title="Copy link to clipboard">📋 Copy</button>

          <div class="section-label">Motor</div>
          <div class="detail-row"><span class="k">Serial number</span><span class="v" style="font-family:var(--mono)">${esc(r.serial_number)}</span></div>
          <div class="detail-row"><span class="k">Brand / model</span><span class="v">${esc(r.brand) || '—'} ${esc(r.model) || ''}</span></div>

          <div class="section-label">${r.source_type === 'customer' ? 'Customer' : 'Dealer'}</div>
          <div class="detail-row"><span class="k">Sent by</span><span class="v">${esc(r.dealer_name) || '—'}</span></div>
          <div class="detail-row"><span class="k">Contact</span><span class="v">${esc(r.dealer_contact) || '—'}</span></div>
          <div class="detail-row"><span class="k">Lightspeed</span><span class="v">${r.lightspeed_customer_id ? `🔗 ${esc(r.lightspeed_customer_name)}` : '<span class="hint-text" style="margin:0">Not linked</span>'}</span></div>

          <div class="section-label">Timeline</div>
          <div class="detail-row"><span class="k">Received</span><span class="v">${fmtDate(r.date_received)}</span></div>
          <div class="detail-row"><span class="k">Completed</span><span class="v">${fmtDate(r.date_completed)}</span></div>
          <div class="detail-row"><span class="k">Returned</span><span class="v">${fmtDate(r.date_returned)}</span></div>

          ${r.issue_reported ? `<div class="section-label">Issue reported</div><div class="text-block">${esc(r.issue_reported)}</div>` : ''}
          ${r.damage_found ? `<div class="section-label">Damage found</div><div class="text-block">${esc(r.damage_found)}</div>` : ''}

          ${r.refurb_serial ? `
          <div class="section-label">Refurb motor issued</div>
          <div class="detail-row"><span class="k">Serial number</span><span class="v" style="font-family:var(--mono)">${esc(r.refurb_serial)}</span></div>
          ` : ''}

          ${r.quote_status && r.quote_status !== 'not_sent' && r.quote_status !== 'skipped' ? `
          <div class="section-label">Quote</div>
          ${quoteLineItemsReadOnlyHtml(r.line_items)}
          <div class="detail-row"><span class="k">Total</span><span class="v" style="font-weight:700">${fmtMoney(r.quote_amount)}</span></div>
          ${r.quote_notes ? `<div class="text-block">${esc(r.quote_notes)}</div>` : ''}
          <div id="lightspeed-push-panel">${lightspeedPushPanelHtml(r)}</div>
          ` : ''}

          <div id="workflow-panel"></div>

          ${r.work_performed ? `<div class="section-label">Work performed</div><div class="text-block">${esc(r.work_performed)}</div>` : ''}
          ${r.technician ? `<div class="detail-row"><span class="k">Technician</span><span class="v">${esc(r.technician)}</span></div>` : ''}
          ${r.notes ? `<div class="section-label">Notes</div><div class="text-block">${esc(r.notes)}</div>` : ''}

          <div id="photo-sections"></div>
        </div>
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', () => activeTab === 'history' ? renderList() : renderBoard());
    document.getElementById('edit-btn').addEventListener('click', () => renderForm(r));
    document.getElementById('copy-link-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      const url = `${location.origin}/share/${r.share_token}`;
      const ok = await copyToClipboard(url);
      showToast(ok ? 'Customer link copied' : url);
    });

    const pushBtn = document.getElementById('push-to-lightspeed-btn');
    if (pushBtn) {
      pushBtn.addEventListener('click', async () => {
        if (!confirm(`Push this quote to Lightspeed for ${r.lightspeed_customer_name}? This creates a real Quote a salesperson can complete at checkout.`)) return;
        pushBtn.disabled = true;
        pushBtn.textContent = 'Pushing…';
        try {
          const res = await fetch(`${API}/api/records/${r.id}/push-to-lightspeed`, {
            method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
          });
          const data = await res.json();
          if (!res.ok) {
            const msg = data.problems && data.problems.length
              ? `${data.error}:\n${data.problems.map(p => '- ' + p).join('\n')}`
              : (data.error || 'Push failed');
            throw new Error(msg);
          }
          showToast(`Pushed -- Quote #${data.lightspeed_quote_id}`);
          renderDetail(r.id);
        } catch (err) {
          alert(err.message);
          pushBtn.disabled = false;
          pushBtn.textContent = 'Push to Lightspeed';
        }
      });
    }

    renderPhotoSections(r);
    renderWorkflowPanel(r);
  } catch (err) {
    app.innerHTML = `<div class="screen"><div class="empty-state">Couldn't load record.<br/>${esc(err.message)}</div></div>`;
  }
}

function renderPhotoSections(r) {
  const el = document.getElementById('photo-sections');
  el.innerHTML = CATEGORY_ORDER.map(cat => {
    const imgs = r.images.filter(img => (img.category || 'other') === cat);
    if (!imgs.length && cat === 'other') return ''; // don't show an empty "Other" section
    return `
      <div class="section-label">${CATEGORY_META[cat]}</div>
      <div class="photo-grid" data-category="${cat}">
        ${imgs.map(img => `
          <div class="photo-tile" data-image-id="${img.id}">
            <img src="/uploads/${esc(img.filename)}" />
            <button class="photo-remove" data-image-id="${img.id}">&times;</button>
          </div>
        `).join('')}
        <div class="add-photo-tile">
          <label class="add-photo-half" title="Take photo">
            📷
            <input type="file" accept="image/*" capture="environment" class="photo-input-camera" data-category="${cat}" style="display:none" />
          </label>
          <label class="add-photo-half" title="Choose from gallery">
            🖼️
            <input type="file" accept="image/*" multiple class="photo-input-gallery" data-category="${cat}" style="display:none" />
          </label>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.photo-tile img').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src));
  });
  el.querySelectorAll('.photo-input-camera, .photo-input-gallery').forEach(input => {
    input.addEventListener('change', (e) => uploadPhotos(currentRecord.id, e.target.files, input.dataset.category));
  });
  el.querySelectorAll('.photo-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Remove this photo?')) return;
      try {
        await api(`/api/images/${btn.dataset.imageId}`, { method: 'DELETE' });
        renderDetail(currentRecord.id);
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

async function uploadPhotos(recordId, fileList, category) {
  if (!fileList || fileList.length === 0) return;
  showToast('Uploading photo(s)...');
  const fd = new FormData();
  Array.from(fileList).forEach(f => fd.append('photos', f));
  fd.append('category', category || 'other');
  try {
    await api(`/api/records/${recordId}/images`, { method: 'POST', body: fd });
    showToast('Photo(s) added');
    renderDetail(recordId);
  } catch (err) {
    showToast('Upload failed: ' + err.message);
  }
}

// ---------- Stage-specific workflow panel ----------
function renderWorkflowPanel(r) {
  const el = document.getElementById('workflow-panel');

  if (r.status === 'received') {
    el.innerHTML = `
      <div class="workflow-card">
        <p>Motor received. Once it's been opened up, move it to inspection.</p>
        <button class="btn btn-primary" id="wf-begin-inspection">Begin inspection &rarr;</button>
      </div>
    `;
    document.getElementById('wf-begin-inspection').addEventListener('click', () => setStage(r.id, 'inspection'));

  } else if (r.status === 'inspection') {
    el.innerHTML = `
      <div class="workflow-card">
        <div class="field">
          <label class="field-label-row">Damage found <button type="button" class="fix-spelling-btn" data-target="wf-damage">&#10003; Fix spelling</button></label>
          <textarea id="wf-damage" spellcheck="true">${esc(r.damage_found)}</textarea>
        </div>
        <button class="btn btn-secondary" id="wf-save-damage">Save notes</button>
        <button class="btn btn-primary" id="wf-ready-quote" style="margin-top:8px">Ready to quote &rarr;</button>
      </div>
    `;
    document.getElementById('wf-save-damage').addEventListener('click', async () => {
      try {
        await api(`/api/records/${r.id}`, { method: 'PUT', body: JSON.stringify({ damage_found: document.getElementById('wf-damage').value }) });
        showToast('Saved');
      } catch (err) { showToast(err.message); }
    });
    document.getElementById('wf-ready-quote').addEventListener('click', () => setStage(r.id, 'quoted'));

  } else if (r.status === 'quoted') {
    const refurbCardHtml = `
      <div class="workflow-card">
        <p>If the damage is too severe to repair, log a reconditioned replacement motor instead:</p>
        <div class="field">
          <label>Refurb motor serial number</label>
          <input type="text" id="wf-refurb-serial" style="font-family:var(--mono);text-transform:uppercase" />
          <div style="display:flex;gap:8px;margin-top:8px">
            <button type="button" class="btn btn-secondary btn-small" id="wf-refurb-ai-camera-btn">📷 AI scan</button>
            <input type="file" accept="image/*" capture="environment" id="wf-refurb-ai-camera-input" style="display:none" />
            <button type="button" class="btn btn-secondary btn-small" id="wf-refurb-ai-gallery-btn">🖼️ AI scan</button>
            <input type="file" accept="image/*" id="wf-refurb-ai-gallery-input" style="display:none" />
          </div>
          <div class="hint-text" id="wf-refurb-ai-hint"></div>
        </div>
        <button class="btn btn-secondary" id="wf-issue-refurb">Issue refurb motor</button>
      </div>
    `;
    const wireRefurbCard = () => {
      const runRefurbScan = async (file) => {
        if (!file) return;
        const hint = document.getElementById('wf-refurb-ai-hint');
        hint.textContent = 'Reading serial number…';
        try {
          const fd = new FormData();
          fd.append('photo', file);
          const result = await api('/api/extract-serial', { method: 'POST', body: fd });
          if (result.serial_number) {
            document.getElementById('wf-refurb-serial').value = result.serial_number;
            hint.textContent = 'Suggested from photo — please double-check it.';
          } else {
            hint.textContent = "Couldn't read it clearly — please type it in manually.";
          }
        } catch (err) {
          hint.textContent = 'AI scan failed: ' + err.message;
        }
      };
      document.getElementById('wf-refurb-ai-camera-btn').addEventListener('click', () => {
        document.getElementById('wf-refurb-ai-camera-input').click();
      });
      document.getElementById('wf-refurb-ai-gallery-btn').addEventListener('click', () => {
        document.getElementById('wf-refurb-ai-gallery-input').click();
      });
      document.getElementById('wf-refurb-ai-camera-input').addEventListener('change', (e) => {
        const file = e.target.files[0]; e.target.value = ''; runRefurbScan(file);
      });
      document.getElementById('wf-refurb-ai-gallery-input').addEventListener('change', (e) => {
        const file = e.target.files[0]; e.target.value = ''; runRefurbScan(file);
      });
      document.getElementById('wf-issue-refurb').addEventListener('click', async () => {
        const refurb_serial = document.getElementById('wf-refurb-serial').value.trim();
        if (!refurb_serial) { showToast('Enter the refurb motor serial number'); return; }
        if (!confirm('Issue this refurb motor and mark the job complete?')) return;
        try {
          await api(`/api/records/${r.id}/refurb`, { method: 'POST', body: JSON.stringify({ refurb_serial }) });
          showToast('Refurb motor logged');
          renderDetail(r.id);
        } catch (err) { showToast(err.message); }
      });
    };

    if (r.quote_status === 'pending') {
      el.innerHTML = `
        <div class="workflow-card">
          <p>Quote sent — see the total above. Record the dealer/customer's decision once you hear back:</p>
          <button class="btn btn-primary" id="wf-approve">Mark approved</button>
          <button class="btn btn-danger" id="wf-decline">Mark declined</button>
        </div>
        ${refurbCardHtml}
      `;
      document.getElementById('wf-approve').addEventListener('click', () => respondQuote(r.id, 'approved'));
      document.getElementById('wf-decline').addEventListener('click', () => respondQuote(r.id, 'declined'));
      wireRefurbCard();
    } else {
      let quoteLineItems = [];
      let partsCache = [];

      el.innerHTML = `
        <div class="workflow-card">
          <div class="section-label">Quote items</div>
          <div class="field">
            <label>Search parts</label>
            <input type="text" id="wf-parts-search" placeholder="Search by SKU or description..." autocomplete="off" />
            <div id="wf-parts-results"></div>
          </div>
          <div id="wf-line-items"></div>
          <button type="button" class="btn btn-ghost btn-small" id="wf-add-custom-line">+ Add custom line</button>
          <div class="detail-row" style="margin-top:10px">
            <span class="k">Total</span><span class="v" id="wf-quote-total" style="font-weight:700">R0.00</span>
          </div>
          <div class="field" style="margin-top:12px">
            <label class="field-label-row">Notes (optional) <button type="button" class="fix-spelling-btn" data-target="wf-quote-notes">&#10003; Fix spelling</button></label>
            <textarea id="wf-quote-notes" spellcheck="true"></textarea>
          </div>
          <button class="btn btn-primary" id="wf-send-quote">Send quote</button>
          <button class="btn btn-ghost" id="wf-skip-quote">Skip quote &rarr;</button>
          <label class="radio-opt" style="padding-top:4px">
            <input type="checkbox" id="wf-refurb-suggested" /> Refurb motor suggested
          </label>
        </div>
        ${refurbCardHtml}
      `;

      function updateQuoteTotal() {
        const total = quoteLineItems.reduce((s, li) => s + (Number(li.unit_price) || 0) * (Number(li.quantity) || 0), 0);
        document.getElementById('wf-quote-total').textContent = fmtMoney(total);
      }

      function renderQuoteLineItems() {
        const container = document.getElementById('wf-line-items');
        container.innerHTML = quoteLineItems.map((li, i) => `
          <div class="quote-line-row">
            <input type="text" class="quote-line-desc" data-idx="${i}" value="${esc(li.description)}" placeholder="Description" />
            <div class="quote-line-controls">
              ${li.sku ? `<span class="quote-line-sku">${esc(li.sku)}</span>` : ''}
              <input type="number" class="quote-line-qty" data-idx="${i}" value="${li.quantity}" min="0.01" step="0.01" />
              <span>&times;</span>
              <input type="number" class="quote-line-price" data-idx="${i}" value="${li.unit_price}" min="0" step="0.01" />
              <span class="quote-line-total">${fmtMoney((Number(li.unit_price) || 0) * (Number(li.quantity) || 0))}</span>
              <button type="button" class="quote-line-remove" data-idx="${i}" aria-label="Remove line">&times;</button>
            </div>
          </div>
        `).join('');

        container.querySelectorAll('.quote-line-desc').forEach(inp => {
          inp.addEventListener('input', (e) => {
            quoteLineItems[Number(e.target.dataset.idx)].description = e.target.value;
          });
        });
        container.querySelectorAll('.quote-line-qty, .quote-line-price').forEach(inp => {
          inp.addEventListener('input', (e) => {
            const idx = Number(e.target.dataset.idx);
            const key = e.target.classList.contains('quote-line-qty') ? 'quantity' : 'unit_price';
            quoteLineItems[idx][key] = Number(e.target.value) || 0;
            const row = e.target.closest('.quote-line-row');
            row.querySelector('.quote-line-total').textContent = fmtMoney(
              (Number(quoteLineItems[idx].unit_price) || 0) * (Number(quoteLineItems[idx].quantity) || 0)
            );
            updateQuoteTotal();
          });
        });
        container.querySelectorAll('.quote-line-remove').forEach(btn => {
          btn.addEventListener('click', () => {
            quoteLineItems.splice(Number(btn.dataset.idx), 1);
            renderQuoteLineItems();
            updateQuoteTotal();
          });
        });
      }

      function renderPartsResults(query) {
        const resultsEl = document.getElementById('wf-parts-results');
        const q = query.trim().toLowerCase();
        if (!q) { resultsEl.innerHTML = ''; return; }
        const matches = partsCache.filter(p =>
          (p.sku || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
        ).slice(0, 8);
        if (!matches.length) {
          resultsEl.innerHTML = `<div class="parts-result-empty">No matching parts</div>`;
          return;
        }
        resultsEl.innerHTML = matches.map((p, i) => `
          <div class="parts-result-row" data-idx="${i}">
            <span class="quote-line-sku">${esc(p.sku || '')}</span>
            <span>${esc(p.description)}</span>
            <span>${fmtMoney(p.retail_price)}</span>
          </div>
        `).join('');
        resultsEl.querySelectorAll('.parts-result-row').forEach(row => {
          row.addEventListener('click', () => {
            const p = matches[Number(row.dataset.idx)];
            quoteLineItems.push({ sku: p.sku || '', description: p.description, unit_price: Number(p.retail_price) || 0, quantity: 1 });
            renderQuoteLineItems();
            updateQuoteTotal();
            document.getElementById('wf-parts-search').value = '';
            resultsEl.innerHTML = '';
          });
        });
      }

      api('/api/parts').then(parts => { partsCache = parts; }).catch(() => { partsCache = []; });

      document.getElementById('wf-parts-search').addEventListener('input', (e) => renderPartsResults(e.target.value));
      document.getElementById('wf-add-custom-line').addEventListener('click', () => {
        quoteLineItems.push({ sku: '', description: '', unit_price: 0, quantity: 1 });
        renderQuoteLineItems();
        updateQuoteTotal();
      });

      document.getElementById('wf-send-quote').addEventListener('click', async () => {
        const quote_notes = document.getElementById('wf-quote-notes').value.trim();
        const validItems = quoteLineItems.filter(li => li.description.trim());
        if (!validItems.length) { showToast('Add at least one part or line item'); return; }
        if (validItems.some(li => !li.unit_price && li.unit_price !== 0)) { showToast('Every line needs a price'); return; }
        try {
          await api(`/api/records/${r.id}/quote`, { method: 'POST', body: JSON.stringify({ line_items: validItems, quote_notes }) });
          showToast('Quote sent');
          renderDetail(r.id);
        } catch (err) { showToast(err.message); }
      });
      document.getElementById('wf-skip-quote').addEventListener('click', async () => {
        if (!confirm('Skip the quote and go straight to repair?')) return;
        const refurb_suggested = document.getElementById('wf-refurb-suggested').checked;
        try {
          await api(`/api/records/${r.id}/quote/skip`, { method: 'POST', body: JSON.stringify({ refurb_suggested }) });
          showToast('Quote skipped');
          renderDetail(r.id);
        } catch (err) { showToast(err.message); }
      });
      wireRefurbCard();
    }

  } else if (r.status === 'in_repair') {
    el.innerHTML = `
      <div class="workflow-card">
        ${r.quote_status === 'skipped'
          ? `<div class="detail-row"><span class="k">Quote</span><span class="v">Skipped${r.refurb_suggested ? ' — refurb motor suggested' : ''}</span></div>`
          : ''
        }
        <div class="field">
          <label class="field-label-row">Work performed <button type="button" class="fix-spelling-btn" data-target="wf-work">&#10003; Fix spelling</button></label>
          <textarea id="wf-work" spellcheck="true">${esc(r.work_performed)}</textarea>
        </div>
        <div class="field">
          <label>Technician</label>
          <input type="text" id="wf-technician" value="${esc(r.technician)}" />
        </div>
        <button class="btn btn-secondary" id="wf-save-repair">Save</button>
        <button class="btn btn-primary" id="wf-mark-complete" style="margin-top:8px">Mark repair complete &rarr;</button>
      </div>
    `;
    document.getElementById('wf-save-repair').addEventListener('click', async () => {
      try {
        await api(`/api/records/${r.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            work_performed: document.getElementById('wf-work').value,
            technician: document.getElementById('wf-technician').value,
          })
        });
        showToast('Saved');
      } catch (err) { showToast(err.message); }
    });
    document.getElementById('wf-mark-complete').addEventListener('click', () => setStage(r.id, 'completed'));

  } else if (r.status === 'completed') {
    const refurbed = r.quote_status === 'refurb';
    el.innerHTML = `
      <div class="workflow-card">
        <p>${refurbed
          ? `Reconditioned replacement motor issued (serial ${esc(r.refurb_serial)}). Once it's physically sent back, mark it returned.`
          : "Repair complete. Once it's physically sent back, mark it returned."
        }</p>
        <button class="btn btn-primary" id="wf-mark-returned">Mark returned &rarr;</button>
      </div>
    `;
    document.getElementById('wf-mark-returned').addEventListener('click', () => setStage(r.id, 'returned'));

  } else if (r.status === 'returned') {
    const declined = r.quote_status === 'declined';
    const refurbed = r.quote_status === 'refurb';
    el.innerHTML = `
      <div class="workflow-card">
        <p>${
          declined ? 'Returned — quote was declined, no repair performed.'
          : refurbed ? `Reconditioned replacement motor (serial ${esc(r.refurb_serial)}) issued and returned.`
          : 'Repaired and returned.'
        }</p>
      </div>
    `;
  }
}

async function setStage(id, stage) {
  try {
    await api(`/api/records/${id}/stage`, { method: 'PUT', body: JSON.stringify({ stage }) });
    renderDetail(id);
  } catch (err) {
    showToast(err.message);
  }
}

async function respondQuote(id, decision) {
  if (!confirm(`Mark this quote as ${decision}?`)) return;
  try {
    await api(`/api/records/${id}/quote/respond`, { method: 'POST', body: JSON.stringify({ decision }) });
    renderDetail(id);
  } catch (err) {
    showToast(err.message);
  }
}

// ---------- Form (new / edit) ----------
// ---------- Sent by (dealer picker) ----------
function updateSentByLayout() {
  const checked = document.querySelector('input[name="f-source-type"]:checked');
  const sourceType = checked ? checked.value : 'dealer';
  const selectWrap = document.getElementById('f-dealer-select-wrap');
  const nameWrap = document.getElementById('f-dealer-name-wrap');
  const nameLabel = document.getElementById('f-dealer-name-label');
  const selectEl = document.getElementById('f-dealer-select');
  if (sourceType === 'customer') {
    selectWrap.style.display = 'none';
    nameWrap.style.display = '';
    nameLabel.textContent = 'Name';
  } else {
    selectWrap.style.display = '';
    nameLabel.textContent = 'New dealer name';
    nameWrap.style.display = (selectEl.value === '__new__') ? '' : 'none';
    // Dealer records link to Lightspeed via that dealer's own saved link
    // (Settings -> Dealers), not a per-record search -- clear any stray
    // link/search state left over from a moment spent in customer mode.
    clearFormLightspeedLink();
  }
}

function renderFormLightspeedChip() {
  const chipEl = document.getElementById('f-lightspeed-linked-chip');
  const idEl = document.getElementById('f-lightspeed-customer-id');
  const nameEl = document.getElementById('f-lightspeed-customer-name');
  if (!chipEl) return;
  if (idEl.value) {
    chipEl.innerHTML = `
      <div class="ls-linked-chip">
        <span>🔗 Linked to ${esc(nameEl.value)}</span>
        <button type="button" class="btn btn-ghost btn-small" id="f-lightspeed-unlink-btn">Unlink</button>
      </div>
    `;
    document.getElementById('f-lightspeed-unlink-btn').addEventListener('click', () => {
      idEl.value = '';
      nameEl.value = '';
      renderFormLightspeedChip();
    });
  } else {
    chipEl.innerHTML = '';
  }
}

function clearFormLightspeedLink() {
  document.getElementById('f-lightspeed-customer-id').value = '';
  document.getElementById('f-lightspeed-customer-name').value = '';
  renderFormLightspeedChip();
  const resultsEl = document.getElementById('f-lightspeed-search-results');
  if (resultsEl) resultsEl.innerHTML = '';
}

async function wireSentBySection(r) {
  const selectEl = document.getElementById('f-dealer-select');
  const nameInput = document.getElementById('f-dealer');
  const contactInput = document.getElementById('f-contact');

  document.querySelectorAll('input[name="f-source-type"]').forEach(radio => {
    radio.addEventListener('change', updateSentByLayout);
  });

  try {
    const dealers = await api('/api/dealers');
    const currentName = (r.dealer_name || '').trim();
    const match = r.source_type !== 'customer' && currentName
      ? dealers.find(d => d.name.toLowerCase() === currentName.toLowerCase())
      : null;

    selectEl.innerHTML = `
      <option value="">Select dealer&hellip;</option>
      ${dealers.map(d => `<option value="${esc(d.name)}" ${match && match.id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      <option value="__new__" ${!match && r.source_type !== 'customer' && currentName ? 'selected' : ''}>+ Add new dealer&hellip;</option>
    `;
    selectEl.disabled = false;

    selectEl.addEventListener('change', () => {
      if (selectEl.value === '__new__') {
        nameInput.value = '';
      } else if (selectEl.value) {
        nameInput.value = '';
        const chosen = dealers.find(d => d.name === selectEl.value);
        if (chosen && chosen.contact) contactInput.value = chosen.contact;
      }
      updateSentByLayout();
    });
  } catch (err) {
    selectEl.innerHTML = `<option value="__new__" selected>Couldn't load dealer list &mdash; type name below</option>`;
    selectEl.disabled = true;
  }

  renderFormLightspeedChip();

  // Direct-customer mode: typing the Name field itself live-searches
  // Lightspeed (no separate search box) -- picking a result confirms the
  // name and links it; continuing to type after a pick clears the link,
  // since the name no longer necessarily matches who was selected.
  const lsResultsEl = document.getElementById('f-lightspeed-search-results');
  let lsSearchDebounce;
  nameInput.addEventListener('input', () => {
    const sourceType = document.querySelector('input[name="f-source-type"]:checked').value;
    if (sourceType !== 'customer') return; // "new dealer name" entry -- not a Lightspeed search
    document.getElementById('f-lightspeed-customer-id').value = '';
    document.getElementById('f-lightspeed-customer-name').value = '';
    renderFormLightspeedChip();
    clearTimeout(lsSearchDebounce);
    const q = nameInput.value.trim();
    if (q.length < 2) { lsResultsEl.innerHTML = ''; return; }
    lsSearchDebounce = setTimeout(async () => {
      lsResultsEl.innerHTML = `<div class="hint-text">Searching Lightspeed…</div>`;
      try {
        const results = await api(`/api/lightspeed/customers?q=${encodeURIComponent(q)}`);
        if (!results.length) {
          lsResultsEl.innerHTML = `<div class="hint-text">No match in Lightspeed -- will save as a new name.</div>`;
          return;
        }
        lsResultsEl.innerHTML = results.map(c => `
          <div class="ls-customer-result" data-id="${esc(c.id)}">
            <div style="font-weight:600">${esc(c.name)}${c.company ? ` <span class="hint-text">(${esc(c.company)})</span>` : ''}</div>
            ${(c.phone || c.email) ? `<div class="hint-text">${[esc(c.phone), esc(c.email)].filter(Boolean).join(' &middot; ')}</div>` : ''}
          </div>
        `).join('');
        lsResultsEl.querySelectorAll('.ls-customer-result').forEach(row => {
          row.addEventListener('click', () => {
            const chosen = results.find(c => String(c.id) === row.dataset.id);
            nameInput.value = chosen.name;
            document.getElementById('f-lightspeed-customer-id').value = chosen.id;
            document.getElementById('f-lightspeed-customer-name').value = chosen.name;
            if (!contactInput.value.trim() && (chosen.phone || chosen.email)) {
              contactInput.value = chosen.phone || chosen.email;
            }
            lsResultsEl.innerHTML = '';
            renderFormLightspeedChip();
          });
        });
      } catch (err) {
        lsResultsEl.innerHTML = `<div class="hint-text">Search failed: ${esc(err.message)}</div>`;
      }
    }, 300);
  });

  updateSentByLayout();
}

function renderForm(record) {
  const isEdit = !!record;
  pendingPhotos = [];
  const r = record || {
    serial_number: '', brand: '', model: '', dealer_name: '', dealer_contact: '', source_type: 'dealer',
    date_received: new Date().toISOString().slice(0, 10), date_completed: '', date_returned: '',
    status: 'received', issue_reported: '', work_performed: '',
    technician: '', notes: '', quote_amount: '', quote_notes: ''
  };

  app.innerHTML = `
    <div class="screen">
      <div class="screen-header">
        <button class="icon-btn" id="cancel-btn">&#8592;</button>
        <h2>${isEdit ? 'Edit record' : 'New service record'}</h2>
        <span style="width:24px"></span>
      </div>
      <div class="screen-body">
        <form id="record-form">
          <div class="section-label">Sent by</div>
          <div class="form-row-2">
            <label class="radio-opt"><input type="radio" name="f-source-type" value="dealer" ${r.source_type !== 'customer' ? 'checked' : ''}/> Dealer</label>
            <label class="radio-opt"><input type="radio" name="f-source-type" value="customer" ${r.source_type === 'customer' ? 'checked' : ''}/> Direct customer</label>
          </div>
          <div class="field" id="f-dealer-select-wrap">
            <label>Dealer</label>
            <select id="f-dealer-select" disabled>
              <option value="">Loading dealers&hellip;</option>
            </select>
          </div>
          <div class="field" id="f-dealer-name-wrap">
            <label id="f-dealer-name-label">Name</label>
            <input type="hidden" id="f-lightspeed-customer-id" value="${esc(r.lightspeed_customer_id || '')}" />
            <input type="hidden" id="f-lightspeed-customer-name" value="${esc(r.lightspeed_customer_name || '')}" />
            <input type="text" id="f-dealer" value="${esc(r.dealer_name)}" autocomplete="off" />
            <div id="f-lightspeed-linked-chip"></div>
            <div class="ls-search-results" id="f-lightspeed-search-results"></div>
          </div>
          <div class="field">
            <label>Contact</label>
            <input type="text" id="f-contact" value="${esc(r.dealer_contact)}" placeholder="Phone or email" />
          </div>

          <div class="section-label">Motor</div>
          <div class="field">
            <label>Serial number *</label>
            <input type="text" id="f-serial" required value="${esc(r.serial_number)}" style="font-family:var(--mono);text-transform:uppercase" />
            ${!isEdit ? `
            <div style="display:flex;gap:8px;margin-top:8px">
              <button type="button" class="btn btn-secondary btn-small" id="ai-extract-camera-btn">📷 AI scan</button>
              <input type="file" accept="image/*" capture="environment" id="ai-extract-camera-input" style="display:none" />
              <button type="button" class="btn btn-secondary btn-small" id="ai-extract-gallery-btn">🖼️ AI scan</button>
              <input type="file" accept="image/*" id="ai-extract-gallery-input" style="display:none" />
            </div>
            ` : ''}
            ${!isEdit ? '<div class="hint-text" id="ai-extract-hint">Take or pick a clear photo of the label to read the serial number, brand, and model.</div>' : ''}
          </div>
          <div class="form-row-2">
            <div class="field">
              <label>Brand *</label>
              <select id="f-brand">
                <option value="">Select brand&hellip;</option>
                ${BRANDS.map(b => `<option value="${b}" ${r.brand === b ? 'selected' : ''}>${b}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Model</label>
              <input type="text" id="f-model" value="${esc(r.model)}" />
            </div>
          </div>

          ${!isEdit ? `
          <div class="section-label">Photos (motor + serial plate)</div>
          <div class="photo-grid" id="pending-photo-grid">
            <div class="add-photo-tile">
              <label class="add-photo-half" title="Take photo">
                📷
                <input type="file" accept="image/*" capture="environment" id="pending-photo-input-camera" style="display:none" />
              </label>
              <label class="add-photo-half" title="Choose from gallery">
                🖼️
                <input type="file" accept="image/*" multiple id="pending-photo-input-gallery" style="display:none" />
              </label>
            </div>
          </div>
          ` : ''}

          ${isEdit ? `
          <div class="section-label">Stage</div>
          <div class="field">
            <select id="f-status">
              ${STAGE_ORDER.map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${STAGE_META[s].label}</option>`).join('')}
            </select>
          </div>
          ` : ''}

          <div class="section-label">Timeline</div>
          <div class="form-row-2">
            <div class="field">
              <label>Date received</label>
              <input type="date" id="f-date-received" value="${esc(r.date_received)}" lang="en-ZA" />
            </div>
            ${isEdit ? `
            <div class="field">
              <label>Date completed</label>
              <input type="date" id="f-date-completed" value="${esc(r.date_completed)}" lang="en-ZA" />
            </div>
            ` : ''}
          </div>
          ${isEdit ? `
          <div class="field">
            <label>Date returned</label>
            <input type="date" id="f-date-returned" value="${esc(r.date_returned)}" lang="en-ZA" />
          </div>
          ` : ''}

          <div class="section-label">Issue reported</div>
          <div class="field">
            <label class="field-label-row">What the ${r.source_type === 'customer' ? 'customer' : 'dealer'} says is wrong <button type="button" class="fix-spelling-btn" data-target="f-issue">&#10003; Fix spelling</button></label>
            <textarea id="f-issue" spellcheck="true">${esc(r.issue_reported)}</textarea>
          </div>
          ${isEdit ? `
          <div class="field">
            <label class="field-label-row">Damage found (once opened up) <button type="button" class="fix-spelling-btn" data-target="f-damage-found">&#10003; Fix spelling</button></label>
            <textarea id="f-damage-found" spellcheck="true">${esc(r.damage_found)}</textarea>
          </div>
          ` : ''}

          ${isEdit ? `
          <div class="section-label">Quote</div>
          <div class="form-row-2">
            <div class="field">
              <label>Quote amount (ZAR)</label>
              <input type="number" step="0.01" id="f-quote-amount" value="${esc(r.quote_amount)}" />
            </div>
          </div>
          <div class="field">
            <label class="field-label-row">Quote notes <button type="button" class="fix-spelling-btn" data-target="f-quote-notes">&#10003; Fix spelling</button></label>
            <textarea id="f-quote-notes" spellcheck="true">${esc(r.quote_notes)}</textarea>
          </div>
          <div class="field">
            <label>Refurb motor serial number (if one was issued)</label>
            <input type="text" id="f-refurb-serial" value="${esc(r.refurb_serial)}" style="font-family:var(--mono);text-transform:uppercase" />
          </div>

          <div class="section-label">Repair</div>
          <div class="field">
            <label class="field-label-row">Work performed <button type="button" class="fix-spelling-btn" data-target="f-work">&#10003; Fix spelling</button></label>
            <textarea id="f-work" spellcheck="true">${esc(r.work_performed)}</textarea>
          </div>
          <div class="field">
            <label>Technician</label>
            <input type="text" id="f-technician" value="${esc(r.technician)}" />
          </div>
          ` : ''}

          <div class="field">
            <label class="field-label-row">Notes <button type="button" class="fix-spelling-btn" data-target="f-notes">&#10003; Fix spelling</button></label>
            <textarea id="f-notes" spellcheck="true">${esc(r.notes)}</textarea>
          </div>
        </form>
      </div>
      <div class="bottom-actions">
        ${isEdit ? '<button class="btn btn-danger" id="delete-btn">Delete</button>' : ''}
        <button class="btn btn-primary btn-block" id="save-btn">Save record</button>
      </div>
    </div>
  `;

  document.getElementById('cancel-btn').addEventListener('click', () => {
    if (isEdit) renderDetail(r.id);
    else if (activeTab === 'history') renderList();
    else renderBoard();
  });

  wireSentBySection(r);

  if (!isEdit) {
    const onPendingPhotoChange = (e) => {
      Array.from(e.target.files).forEach(file => {
        pendingPhotos.push({ file, url: URL.createObjectURL(file) });
      });
      e.target.value = '';
      renderPendingPhotoGrid();
    };
    document.getElementById('pending-photo-input-camera').addEventListener('change', onPendingPhotoChange);
    document.getElementById('pending-photo-input-gallery').addEventListener('change', onPendingPhotoChange);
    renderPendingPhotoGrid();

    const runIntakeScan = async (file) => {
      if (!file) return;
      const hint = document.getElementById('ai-extract-hint');
      hint.textContent = 'Reading serial number and model…';
      try {
        const fd = new FormData();
        fd.append('photo', file);
        const result = await api('/api/extract-serial', { method: 'POST', body: fd });
        if (result.serial_number) document.getElementById('f-serial').value = result.serial_number;
        if (result.model) document.getElementById('f-model').value = result.model;
        if (result.brand) document.getElementById('f-brand').value = result.brand;

        const readCount = [result.serial_number, result.model, result.brand].filter(Boolean).length;
        if (readCount === 3) {
          hint.textContent = 'Brand, model and serial number suggested from photo — please double-check them.';
        } else if (readCount > 0) {
          hint.textContent = 'Partially read from photo — please fill in and double-check the rest.';
        } else {
          hint.textContent = "Couldn't read it clearly — please type it in manually.";
        }
        // Stage this same photo as an intake photo too, so it doesn't need to be added twice
        pendingPhotos.push({ file, url: URL.createObjectURL(file) });
        renderPendingPhotoGrid();
      } catch (err) {
        hint.textContent = 'AI scan failed: ' + err.message;
      }
    };
    document.getElementById('ai-extract-camera-btn').addEventListener('click', () => {
      document.getElementById('ai-extract-camera-input').click();
    });
    document.getElementById('ai-extract-gallery-btn').addEventListener('click', () => {
      document.getElementById('ai-extract-gallery-input').click();
    });
    document.getElementById('ai-extract-camera-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = ''; runIntakeScan(file);
    });
    document.getElementById('ai-extract-gallery-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = ''; runIntakeScan(file);
    });
  }

  if (isEdit) {
    document.getElementById('delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete the record for serial ${r.serial_number}? This also deletes its photos.`)) return;
      try {
        await api(`/api/records/${r.id}`, { method: 'DELETE' });
        showToast('Record deleted');
        renderBoard();
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  document.getElementById('save-btn').addEventListener('click', async () => {
    const sourceTypeEl = document.querySelector('input[name="f-source-type"]:checked');
    const sourceType = sourceTypeEl ? sourceTypeEl.value : 'dealer';
    const dealerSelectEl = document.getElementById('f-dealer-select');
    let dealerName;
    let newDealerName = null;
    if (sourceType === 'customer') {
      dealerName = document.getElementById('f-dealer').value.trim();
    } else if (dealerSelectEl && dealerSelectEl.value && dealerSelectEl.value !== '__new__') {
      dealerName = dealerSelectEl.value;
    } else {
      dealerName = document.getElementById('f-dealer').value.trim();
      if (dealerName) newDealerName = dealerName;
    }
    const payload = {
      serial_number: document.getElementById('f-serial').value.trim(),
      brand: document.getElementById('f-brand').value,
      model: document.getElementById('f-model').value.trim(),
      dealer_name: dealerName,
      dealer_contact: document.getElementById('f-contact').value.trim(),
      source_type: sourceType,
      date_received: document.getElementById('f-date-received').value,
      issue_reported: document.getElementById('f-issue').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      lightspeed_customer_id: document.getElementById('f-lightspeed-customer-id').value || null,
      lightspeed_customer_name: document.getElementById('f-lightspeed-customer-name').value || null,
    };
    if (isEdit) {
      payload.status = document.getElementById('f-status').value;
      payload.date_completed = document.getElementById('f-date-completed').value;
      payload.date_returned = document.getElementById('f-date-returned').value;
      payload.damage_found = document.getElementById('f-damage-found').value.trim();
      payload.quote_amount = document.getElementById('f-quote-amount').value || null;
      payload.quote_notes = document.getElementById('f-quote-notes').value.trim();
      payload.refurb_serial = document.getElementById('f-refurb-serial').value.trim() || null;
      payload.work_performed = document.getElementById('f-work').value.trim();
      payload.technician = document.getElementById('f-technician').value.trim();
    }
    if (!payload.serial_number) {
      showToast('Serial number is required');
      return;
    }
    if (!payload.brand) {
      showToast('Brand is required (Brose or Mahle)');
      return;
    }
    if (newDealerName) {
      // Best-effort -- also adds a freshly-typed dealer name to the dealer database so it's
      // pickable next time. A 409 (name already exists, e.g. differing only by case) is expected
      // and fine to ignore; this must never block saving the actual service record.
      try { await api('/api/dealers', { method: 'POST', body: JSON.stringify({ name: newDealerName }) }); } catch (err) { /* ignore */ }
    }
    try {
      if (isEdit) {
        await api(`/api/records/${r.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Record updated');
        renderDetail(r.id);
      } else {
        const created = await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
        if (pendingPhotos.length) {
          const fd = new FormData();
          pendingPhotos.forEach(p => fd.append('photos', p.file));
          fd.append('category', 'intake');
          await api(`/api/records/${created.id}/images`, { method: 'POST', body: fd });
        }
        pendingPhotos = [];
        showToast('Record created');
        renderDetail(created.id);
      }
    } catch (err) {
      showToast(err.message);
    }
  });
}

function renderPendingPhotoGrid() {
  const grid = document.getElementById('pending-photo-grid');
  if (!grid) return;
  const addTile = grid.querySelector('.add-photo-tile');
  grid.querySelectorAll('.photo-tile').forEach(t => t.remove());
  pendingPhotos.forEach((p, idx) => {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    tile.innerHTML = `
      <img src="${p.url}" />
      <button type="button" class="photo-remove" data-idx="${idx}">&times;</button>
    `;
    grid.insertBefore(tile, addTile);
  });
  grid.querySelectorAll('.photo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingPhotos.splice(Number(btn.dataset.idx), 1);
      renderPendingPhotoGrid();
    });
  });
}

// ---------- AI "Fix spelling" -- delegated once, works for every field on every screen ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.fix-spelling-btn');
  if (!btn) return;
  const textarea = document.getElementById(btn.dataset.target);
  if (!textarea || !textarea.value.trim()) { showToast('Nothing to fix yet'); return; }
  const original = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const result = await api('/api/fix-text', { method: 'POST', body: JSON.stringify({ text: textarea.value }) });
    textarea.value = result.corrected;
    showToast('Spelling fixed — please double-check it');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

// ---------- Boot ----------
const lightspeedRedirectParam = new URLSearchParams(location.search).get('lightspeed_connected')
  ? 'connected'
  : new URLSearchParams(location.search).get('lightspeed_error') ? 'error' : null;
if (lightspeedRedirectParam) {
  history.replaceState(null, '', location.pathname);
}

if (TOKEN) {
  if (lightspeedRedirectParam === 'connected') {
    renderSettings();
    showToast('Lightspeed connected');
  } else if (lightspeedRedirectParam === 'error') {
    renderSettings();
    showToast("Couldn't connect to Lightspeed -- please try again");
  } else {
    renderBoard();
  }
} else {
  renderLogin();
}

// Register service worker for installability (best-effort, no offline caching)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
