const STAGE_META = {
  received:    { label: 'Received',    color: '#5B8DEF' },
  inspection:  { label: 'Inspection',  color: '#F2A93B' },
  quoted:      { label: 'Quoted',      color: '#B98CE0' },
  in_repair:   { label: 'In Repair',   color: '#E0637A' },
  completed:   { label: 'Completed',   color: '#3FBF7F' },
  returned:    { label: 'Returned',    color: '#8A8F98' },
};

const app = document.getElementById('app');

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function tokenFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

async function load() {
  const token = tokenFromUrl();
  app.innerHTML = `<div class="empty-state" style="margin-top:100px"><div class="spinner"></div></div>`;
  try {
    const res = await fetch(`/api/share/dealer/${token}`);
    if (!res.ok) {
      app.innerHTML = `<div class="empty-state" style="margin-top:100px">This link isn't valid.</div>`;
      return;
    }
    const data = await res.json();
    render(data);
  } catch (err) {
    app.innerHTML = `<div class="empty-state" style="margin-top:100px">Couldn't load this page.<br/>${esc(err.message)}</div>`;
  }
}

function render(data) {
  const records = data.records || [];

  app.innerHTML = `
    <div class="screen">
      <div class="topbar" style="position:static">
        <div class="topbar-row" style="margin-bottom:0;justify-content:center">
          <img class="topbar-logo" src="/gmc-logo.png" alt="Greg Minnaar Cycles" />
        </div>
      </div>
      <div class="screen-body">
        <div class="section-label">Motor history &middot; ${esc(data.dealer_name)}</div>
        <div id="dealer-history-list">
          ${records.length ? '' : '<div class="empty-state">No service records yet for this dealer.</div>'}
        </div>
        <p class="share-footer">Greg Minnaar Cycles &middot; Workshop motor service log</p>
      </div>
    </div>
  `;

  if (!records.length) return;

  const listEl = document.getElementById('dealer-history-list');
  listEl.innerHTML = records.map(r => {
    const meta = STAGE_META[r.status] || STAGE_META.received;
    return `
      <a class="record-card${r.is_latest ? ' latest-record-card' : ''}" style="border-left-color:${meta.color}" href="/share/${r.share_token}">
        <div class="record-card-top">
          <span class="record-card-title">${esc(r.brand)}${r.model ? ' ' + esc(r.model) : ''}</span>
          <span style="display:flex;align-items:center;gap:6px">
            ${r.is_latest ? '<span class="latest-chip">Latest</span>' : ''}
            <span class="status-badge" style="background:${meta.color};color:#15171B">${meta.label}</span>
          </span>
        </div>
        <div class="record-card-meta">
          <span class="record-card-serial">${esc(r.serial_number)}</span>
          ${r.date_received ? `<span>&middot; in ${esc(r.date_received)}</span>` : ''}
          ${r.date_returned ? `<span>&middot; returned ${esc(r.date_returned)}</span>` : ''}
        </div>
      </a>
    `;
  }).join('');
}

load();
