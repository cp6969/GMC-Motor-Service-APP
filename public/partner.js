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
        <div class="login-mark"></div>
        <h1 class="login-title">Motor Service Records</h1>
        <p class="login-sub">Greg Minnaar Cycles &middot; Specialized partner access</p>
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
      <input type="text" id="partner-search" placeholder="Search by serial number, brand, or dealer&hellip;" autocomplete="off" style="margin-bottom:16px" />
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
    return `
      <div class="record-card" style="border-left-color:${meta.color}">
        <div class="record-card-top">
          <span class="record-card-title">${esc(r.brand)}${r.model ? ' ' + esc(r.model) : ''}</span>
          <span class="status-badge" style="background:${meta.color};color:#15171B">${meta.label}</span>
        </div>
        <div class="record-card-meta">
          <span class="record-card-serial">${esc(r.serial_number)}</span>
          ${r.dealer_name ? `<span>&middot; sent by ${esc(r.dealer_name)}</span>` : ''}
          ${r.date_received ? `<span>&middot; in ${esc(r.date_received)}</span>` : ''}
          ${r.date_completed ? `<span>&middot; completed ${esc(r.date_completed)}</span>` : ''}
          ${r.date_returned ? `<span>&middot; returned ${esc(r.date_returned)}</span>` : ''}
        </div>
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
