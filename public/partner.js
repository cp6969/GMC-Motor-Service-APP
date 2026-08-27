// Specialized partner view -- read-only, desktop-oriented (Specialized only
// ever accesses this from a computer, per the owner). Own localStorage key
// (not the internal app's `gmc_token`) since both could plausibly be logged
// into in the same browser at once, on the same origin.
const STAGE_META = {
  received:    { label: 'Received',    color: '#5B8DEF' },
  inspection:  { label: 'Inspection',  color: '#F2A93B' },
  quoted:      { label: 'Quoted',      color: '#B98CE0' },
  in_repair:   { label: 'In Repair',   color: '#E0637A' },
  completed:   { label: 'Completed',   color: '#3FBF7F' },
  returned:    { label: 'Returned',    color: '#8A8F98' },
};
const REFURB_COLOR = '#4FC3E8';

const app = document.getElementById('app');
let TOKEN = localStorage.getItem('gmc_partner_token') || null;
let allRecords = [];

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function logout() {
  TOKEN = null;
  localStorage.removeItem('gmc_partner_token');
  renderLogin();
}

function renderLogin(errorMsg) {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <img class="login-logo" src="/gmc-logo.png" alt="Greg Minnaar Cycles" />
        <h1 class="login-title">Motor Service Records</h1>
        <p class="login-sub">Specialized partner access</p>
        <form id="login-form">
          <div class="field">
            <label for="passcode">Passcode</label>
            <input type="password" id="passcode" autocomplete="current-password" autofocus />
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
      const res = await fetch('/api/partner/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      TOKEN = data.token;
      localStorage.setItem('gmc_partner_token', TOKEN);
      loadRecords();
    } catch (err) {
      renderLogin('Incorrect passcode. Try again.');
    }
  });
}

async function loadRecords() {
  app.innerHTML = `
    <div class="topbar" style="position:static">
      <div class="topbar-row">
        <img class="topbar-logo" src="/gmc-logo.png" alt="Greg Minnaar Cycles" />
        <button class="icon-btn" id="logout-btn">Log out</button>
      </div>
    </div>
    <div class="screen-body">
      <div class="section-label" style="margin-top:0">Motor service records</div>
      <p class="hint-text" style="margin-top:0">Search by serial number to check whether a motor was serviced here, and what was found/done.</p>
      <input type="text" class="search-input" id="partner-search" placeholder="Search by serial number, brand, or dealer&hellip;" autocomplete="off" />
      <div id="partner-list"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>
  `;
  document.getElementById('logout-btn').addEventListener('click', logout);

  try {
    const res = await fetch('/api/partner/records', { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error('Failed to load records');
    allRecords = await res.json();
    renderList(allRecords);
  } catch (err) {
    document.getElementById('partner-list').innerHTML =
      `<div class="empty-state">Couldn't load records.<br/>${esc(err.message)}</div>`;
    return;
  }

  document.getElementById('partner-search').addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    if (!term) return renderList(allRecords);
    renderList(allRecords.filter(r =>
      (r.serial_number || '').toLowerCase().includes(term) ||
      (r.brand || '').toLowerCase().includes(term) ||
      (r.dealer_name || '').toLowerCase().includes(term)
    ));
  });
}

function renderList(records) {
  const listEl = document.getElementById('partner-list');
  if (!records.length) {
    listEl.innerHTML = '<div class="empty-state">No matching records.</div>';
    return;
  }
  listEl.innerHTML = records.map(r => {
    const meta = STAGE_META[r.status] || STAGE_META.received;
    // A refurb swap always wins over the plain returned-to-X label -- the
    // motor that actually went back isn't the one that came in, so that's
    // the thing Specialized needs to see at a glance, not just "Returned".
    const isRefurb = r.quote_status === 'refurb';
    // "Returned" alone doesn't say who it went back to -- spell it out using
    // the same dealer-vs-direct-customer distinction the internal app
    // already tracks per record (source_type), rather than leaving it
    // ambiguous for someone at Specialized who wasn't there for the intake.
    const badgeLabel = isRefurb
      ? 'Refurb Motor Issued'
      : r.status === 'returned'
        ? (r.source_type === 'customer' ? 'Returned to Customer' : 'Returned to Dealer')
        : meta.label;
    const badgeColor = isRefurb ? REFURB_COLOR : meta.color;
    return `
      <div class="record-card" style="border-left-color:${meta.color}">
        <div class="record-card-top">
          <span class="record-card-title">${esc(r.dealer_name) || 'Direct customer'}</span>
          <span class="status-badge" style="background:${badgeColor};color:#15171B">${badgeLabel}</span>
        </div>
        <div class="record-card-meta">
          <span class="record-card-serial">${esc(r.serial_number)}</span>
          <span>&middot; ${esc(r.brand)}${r.model ? ' ' + esc(r.model) : ''}</span>
          ${r.date_received ? `<span>&middot; in ${esc(r.date_received)}</span>` : ''}
          ${r.date_completed ? `<span>&middot; completed ${esc(r.date_completed)}</span>` : ''}
          ${r.date_returned ? `<span>&middot; returned ${esc(r.date_returned)}</span>` : ''}
        </div>
        ${isRefurb ? `<div class="field" style="margin-top:10px"><label>Refurb motor issued</label><div class="hint-text">Reconditioned replacement motor sent back in place of the original &mdash; serial <strong>${esc(r.refurb_serial)}</strong></div></div>` : ''}
        ${r.issue_reported ? `<div class="field" style="margin-top:10px"><label>Issue reported</label><div class="hint-text">${esc(r.issue_reported)}</div></div>` : ''}
        ${r.work_performed ? `<div class="field" style="margin-top:10px"><label>Work performed</label><div class="hint-text">${esc(r.work_performed)}</div></div>` : ''}
        ${r.parts_replaced ? `<div class="field" style="margin-top:10px"><label>Parts replaced</label><div class="hint-text">${esc(r.parts_replaced)}</div></div>` : ''}
        ${r.images && r.images.length ? `
          <div class="field" style="margin-top:10px">
            <label>Photos</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${r.images.map(f => `<a href="/uploads/${esc(f)}" target="_blank" rel="noopener"><img src="/uploads/${esc(f)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:6px" /></a>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

TOKEN ? loadRecords() : renderLogin();
