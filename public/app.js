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

        <div class="section-label">Parts catalog</div>
        <p class="hint-text">Used when building a quote in the Quoted stage — add more here any time (e.g. Mahle parts later).</p>
        <div id="parts-catalog-list"><div class="empty-state"><div class="spinner"></div></div></div>
        <div class="workflow-card" style="margin-top:12px">
          <div class="section-label" style="margin-top:0">Add a part</div>
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
  loadPartsCatalogSettings();
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
    return `
      <div class="quote-line-row" data-id="${p.id}">
        <div class="quote-line-desc" style="border:none;background:none;padding:0 0 4px;margin-bottom:0">${esc(p.description)} ${p.sku ? `<span class="quote-line-sku">${esc(p.sku)}</span>` : ''}</div>
        <div class="quote-line-controls">
          <span>Cost ${fmtMoney(p.cost)}</span>
          <span class="quote-line-total">Retail ${fmtMoney(p.retail_price)}</span>
          <button type="button" class="btn btn-ghost btn-small part-edit-btn" data-id="${p.id}">Edit</button>
          <button type="button" class="quote-line-remove part-delete-btn" data-id="${p.id}" aria-label="Delete part">&times;</button>
        </div>
      </div>
    `;
  }).join('');

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
      ${STAGE_ORDER.map(s => `
        <div class="board-col">
          <div class="board-col-header" style="border-color:${STAGE_META[s].color}">
            <span>${STAGE_META[s].label}</span>
            <span class="board-col-count" id="count-${s}">&hellip;</span>
          </div>
          <div class="board-col-cards" id="col-${s}"></div>
        </div>
      `).join('')}
    </div>
    <button class="fab" id="fab-new">+</button>
  `;
  wireTopBar();
  document.getElementById('fab-new').addEventListener('click', () => renderForm(null));

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
            <span class="serial-chip">${esc(r.serial_number)}</span>
            <span class="status-badge" style="background:${meta.color};color:#15171B">${meta.label}</span>
          </div>
          <div class="record-card-meta">
            ${r.brand ? `<span class="record-card-brand">${esc(r.brand)}${r.model ? ' ' + esc(r.model) : ''}</span>` : ''}
            ${r.dealer_name ? `<span>&middot; ${esc(r.dealer_name)}</span>` : ''}
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

          <div class="section-label">Sent by</div>
          <div class="form-row-2">
            <label class="radio-opt"><input type="radio" name="f-source-type" value="dealer" ${r.source_type !== 'customer' ? 'checked' : ''}/> Dealer</label>
            <label class="radio-opt"><input type="radio" name="f-source-type" value="customer" ${r.source_type === 'customer' ? 'checked' : ''}/> Direct customer</label>
          </div>
          <div class="field">
            <label>Name</label>
            <input type="text" id="f-dealer" value="${esc(r.dealer_name)}" />
          </div>
          <div class="field">
            <label>Contact</label>
            <input type="text" id="f-contact" value="${esc(r.dealer_contact)}" placeholder="Phone or email" />
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
    const payload = {
      serial_number: document.getElementById('f-serial').value.trim(),
      brand: document.getElementById('f-brand').value,
      model: document.getElementById('f-model').value.trim(),
      dealer_name: document.getElementById('f-dealer').value.trim(),
      dealer_contact: document.getElementById('f-contact').value.trim(),
      source_type: sourceTypeEl ? sourceTypeEl.value : 'dealer',
      date_received: document.getElementById('f-date-received').value,
      issue_reported: document.getElementById('f-issue').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
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
if (TOKEN) {
  renderBoard();
} else {
  renderLogin();
}

// Register service worker for installability (best-effort, no offline caching)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
