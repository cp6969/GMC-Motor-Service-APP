const STAGE_META = {
  received:    { label: 'Received',    color: '#5B8DEF' },
  inspection:  { label: 'Inspection',  color: '#F2A93B' },
  quoted:      { label: 'Quoted',      color: '#B98CE0' },
  in_repair:   { label: 'In Repair',   color: '#E0637A' },
  completed:   { label: 'Completed',   color: '#3FBF7F' },
  returned:    { label: 'Returned',    color: '#8A8F98' },
};
const QUOTE_META = {
  pending:  { label: 'Awaiting your response', color: '#F2A93B' },
  approved: { label: 'Approved',               color: '#3FBF7F' },
  declined: { label: 'Declined',               color: '#E0637A' },
};
const CATEGORY_META = {
  intake: 'Intake photos',
  damage: 'Damage found',
  repair: 'Repair',
  other:  'Other',
};
const CATEGORY_ORDER = ['intake', 'damage', 'repair', 'other'];

const app = document.getElementById('app');

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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
          <span>${li.quantity} &times; ${li.original_unit_price ? `<span class="discount-strike">${fmtMoney(li.original_unit_price)}</span>` : ''}${fmtMoney(li.unit_price)}${li.original_unit_price ? `<span class="discount-badge">dealer discount</span>` : ''}</span>
          <span>${fmtMoney(li.unit_price * li.quantity)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function tokenFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

async function load() {
  const token = tokenFromUrl();
  app.innerHTML = `<div class="empty-state" style="margin-top:100px"><div class="spinner"></div></div>`;
  try {
    const res = await fetch(`/api/share/${token}`);
    if (!res.ok) {
      app.innerHTML = `<div class="empty-state" style="margin-top:100px">This link isn't valid, or the record has been removed.</div>`;
      return;
    }
    const r = await res.json();
    render(r);
  } catch (err) {
    app.innerHTML = `<div class="empty-state" style="margin-top:100px">Couldn't load this page.<br/>${esc(err.message)}</div>`;
  }
}

function render(r) {
  const stageMeta = STAGE_META[r.stage] || STAGE_META.received;

  app.innerHTML = `
    <div class="screen">
      <div class="topbar" style="position:static">
        <div class="topbar-row" style="margin-bottom:0">
          <img class="topbar-logo" src="/gmc-logo.png" alt="Greg Minnaar Cycles" />
        </div>
      </div>
      <div class="screen-body">
        <span class="status-badge" style="background:${stageMeta.color};color:#15171B">${stageMeta.label}</span>
        <p class="text-block" style="margin-top:14px">${esc(r.stage_message)}</p>

        <div class="section-label">Motor</div>
        <div class="detail-row"><span class="k">Serial number</span><span class="v" style="font-family:var(--mono)">${esc(r.serial_number)}</span></div>
        <div class="detail-row"><span class="k">Brand / model</span><span class="v">${esc(r.brand) || '—'} ${esc(r.model) || ''}</span></div>

        <div class="section-label">Timeline</div>
        <div class="detail-row"><span class="k">Received</span><span class="v">${r.date_received || '—'}</span></div>
        ${r.date_completed ? `<div class="detail-row"><span class="k">Completed</span><span class="v">${r.date_completed}</span></div>` : ''}
        ${r.date_returned ? `<div class="detail-row"><span class="k">Returned</span><span class="v">${r.date_returned}</span></div>` : ''}

        ${r.issue_reported ? `<div class="section-label">Issue reported</div><div class="text-block">${esc(r.issue_reported)}</div>` : ''}
        ${r.damage_found ? `<div class="section-label">Damage found</div><div class="text-block">${esc(r.damage_found)}</div>` : ''}
        ${r.work_performed ? `<div class="section-label">Work performed</div><div class="text-block">${esc(r.work_performed)}</div>` : ''}

        ${r.quote_status ? `
        <div class="section-label">Quote</div>
        ${quoteLineItemsReadOnlyHtml(r.line_items)}
        <div class="detail-row"><span class="k">Total</span><span class="v" style="font-weight:700">${fmtMoney(r.quote_amount)}</span></div>
        <div class="detail-row"><span class="k">Status</span><span class="v">
          <span class="status-badge" style="background:${(QUOTE_META[r.quote_status] || {}).color || '#8A8F98'};color:#15171B">${(QUOTE_META[r.quote_status] || {}).label || r.quote_status}</span>
        </span></div>
        ` : ''}

        ${r.refurb_serial ? `
        <div class="section-label">Refurb motor issued</div>
        <div class="detail-row"><span class="k">Serial number</span><span class="v" style="font-family:var(--mono)">${esc(r.refurb_serial)}</span></div>
        ` : ''}

        <div id="photo-sections"></div>

        <p class="share-footer">Greg Minnaar Cycles &middot; Workshop motor service log</p>
      </div>
    </div>
  `;

  const el = document.getElementById('photo-sections');
  el.innerHTML = CATEGORY_ORDER.map(cat => {
    const imgs = (r.images || []).filter(img => (img.category || 'other') === cat);
    if (!imgs.length) return '';
    return `
      <div class="section-label">${CATEGORY_META[cat]}</div>
      <div class="photo-grid">
        ${imgs.map(img => `
          <div class="photo-tile">
            <img src="/uploads/${esc(img.filename)}" />
          </div>
        `).join('')}
      </div>
    `;
  }).join('');

  el.querySelectorAll('.photo-tile img').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src));
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

load();
