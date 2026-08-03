// Lead Report dashboard — vanilla JS SPA talking to /api.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');
// Show 2 decimals for sub-1% values so small funnel rates aren't shown as 0.0%.
const fmtPct = (x) => {
  const v = Number(x || 0) * 100;
  return `${v > 0 && v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
};

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  const icons = { ok: '✓', err: '✕', info: 'ℹ', warn: '⚠' };
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span style="font-weight:700;flex-shrink:0">${icons[type] || '●'}</span><span>${String(msg).replace(/</g,'&lt;')}</span>`;
  container.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); el.addEventListener('transitionend', () => el.remove(), { once: true }); }, 3200);
}

// 'YYYY-MM' -> 'Jul 2026'. Leaves '(none)' / blank as-is.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return ym || '';
  return `${MONTH_NAMES[Number(m[2]) - 1] || '?'} ${m[1]}`;
}

$("#logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
});

// ---- Tab navigation -------------------------------------------------------
$$('.tab[data-view]').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab[data-view]').forEach((b) => b.classList.remove('is-active'));
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  btn.classList.add('is-active');
  $(`#view-${btn.dataset.view}`).classList.add('is-active');
  if (btn.dataset.view === 'data') loadDatasets();
  if (btn.dataset.view === 'settings') loadSettings();
  if (btn.dataset.view === 'mappings') loadMap();
  if (btn.dataset.view === 'duplicates') loadDup();
}));

// ---- Weekly Dump tab navigation -------------------------------------------
$$('.tab[data-wd-view]').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab[data-wd-view]').forEach((b) => b.classList.remove('is-active'));
  $$('.wd-view').forEach((v) => v.classList.remove('is-active'));
  btn.classList.add('is-active');
  $(`#wd-view-${btn.dataset.wdView}`).classList.add('is-active');
  if (btn.dataset.wdView === 'report') loadWdReport();
  if (btn.dataset.wdView === 'setup') loadWdSetup();
  if (btn.dataset.wdView === 'datasets') loadWdDatasets();
}));

// ---- Report ---------------------------------------------------------------
let annos = {};
let currentOriginMonth = [];
const CHART_COLORS = ['#4f8ef7', '#f59e42', '#22c55e', '#f87171', '#fbbf24', '#a78bfa'];
const annoOf = (scope, key) => (annos[scope] && annos[scope][key]) || { insights: '', challenges: '' };

async function loadReport() {
  annos = await (await fetch('/api/annotations')).json().catch(() => ({}));
  const topN = $('#topNSelect')?.value || '15';
  const data = await (await fetch(`/api/report?top_n=${topN}`)).json().catch(() => ({ empty: true }));
  const empty = data.empty || !!data.error || !data.summary;
  $('#reportEmpty').classList.toggle('hidden', !empty);
  $('#reportBody').classList.toggle('hidden', !!empty);
  if (empty) { $('#reportBody').innerHTML = ''; $('#reportSub').textContent = ''; $('#reportTitle').textContent = 'Weekly Report'; return; }
  const s = data.summary;
  $('#reportTitle').textContent = s.report_title || 'Weekly Report';
  $('#reportSub').textContent = `Deal type ${s.deal_type} · target ${fmtInt(s.target)} (${s.target_metric})`;
  renderReport(data);
}

// Collapsible drawer wrapper.
function drawer(title, bodyHtml, open = true) {
  return `<div class="card ${open ? '' : 'collapsed'}">
    <button type="button" class="drawer-toggle" aria-expanded="${open}"><span>${title}</span><span class="chev" aria-hidden="true">▾</span></button>
    <div class="drawer-body">${bodyHtml}</div></div>`;
}

// One merged Insights + one Challenges cell for the whole table (spans all rows).
const annoHead = '<th>Insights</th><th>Challenges</th>';
function annoMerged(scope, rowspan) {
  const a = annoOf(scope, '__table__');
  const cell = (field, val) => `<td class="anno" rowspan="${rowspan}"><div class="editable" contenteditable="true"
    data-scope="${esc(scope)}" data-key="__table__" data-field="${field}">${esc(val)}</div></td>`;
  return cell('insights', a.insights) + cell('challenges', a.challenges);
}

const RANK_COLS = [
  ['leads', 'Leads', fmtInt], ['fi', 'FI', fmtInt], ['apps', 'Apps', fmtInt], ['adm', 'Adms', fmtInt],
  ['lead_to_fi', 'Lead→FI', fmtPct], ['fi_to_app', 'FI→App', fmtPct], ['app_to_adm', 'App→Adm', fmtPct],
  ['dup_leads', 'Dup Leads', fmtInt, 1], ['dup_fi', 'Dup FI', fmtInt, 1], ['dup_apps', 'Dup Apps', fmtInt, 1], ['dup_adm', 'Dup Adms', fmtInt, 1],
];
const MONTH_COLS = [
  ['leads', 'Leads', fmtInt], ['fi', 'FI', fmtInt], ['apps', 'Apps', fmtInt], ['adm', 'Adms', fmtInt],
  ['lead_to_fi', 'Lead→FI', fmtPct], ['fi_to_app', 'FI→App', fmtPct], ['app_to_adm', 'App→Adm', fmtPct],
];

// Generic table: leading columns + metric columns + one merged notes block.
function tableHtml(leadHeaders, cols, allRows, scope) {
  const head = leadHeaders.map((h) => `<th>${h}</th>`).join('') + cols.map(([, h,, d]) => `<th class="${d ? 'dupcol' : ''}">${h}</th>`).join('') + annoHead;
  const n = allRows.length;
  const body = allRows.map((row, i) => {
    const lead = row.lead.map((v) => `<td>${v}</td>`).join('');
    const metrics = cols.map(([k,, f, d]) => `<td class="${d ? 'dupcol' : ''}">${f(row.r[k])}</td>`).join('');
    return `<tr class="${row.cls || ''}">${lead}${metrics}${i === 0 ? annoMerged(scope, n) : ''}</tr>`;
  }).join('');
  return `<div class="tblwrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function rankTableHtml(firstHeader, block, scope) {
  const rows = block.rows.map((r) => ({ lead: [esc(r.key)], r }));
  if (block.others) rows.push({ lead: [esc(block.others.key)], r: block.others, cls: 'agg' });
  if (block.total) rows.push({ lead: [esc(block.total.key)], r: block.total, cls: 'total' });
  return tableHtml([firstHeader], RANK_COLS, rows, scope);
}

function monthTableHtml(keyHeader, rows, scope) {
  if (!rows.length) return `<div class="tblwrap"><table class="grid"><tbody><tr><td style="color:var(--muted)">no dated rows</td></tr></tbody></table></div>`;
  return tableHtml(['Month', keyHeader], MONTH_COLS, rows.map((r) => ({ lead: [fmtMonth(r.month), esc(r.key)], r })), scope);
}

function originMonthTableHtml(rows, scope) {
  if (!rows.length) return `<div class="tblwrap"><table class="grid"><tbody><tr><td style="color:var(--muted)">no rows</td></tr></tbody></table></div>`;
  return tableHtml(['Lead Origin', 'Month'], MONTH_COLS, rows.map((r) => ({ lead: [esc(r.origin), fmtMonth(r.month)], r })), scope);
}

// Summary as a funnel.
function summaryHtml(s) {
  const c = s.conversions, d = s.conversions_dup, dup = s.duplicates;
  const totLeads = s.leads + dup.leads;
  const share = (x) => (totLeads ? fmtPct(x / totLeads) : '—');
  const rows = [
    ['Total Leads', fmtInt(totLeads), `${fmtInt(s.leads)} · ${share(s.leads)}`, `${fmtInt(dup.leads)} · ${share(dup.leads)}`, '', ''],
    ['Form Initiated', fmtInt(s.fi + dup.fi), fmtInt(s.fi), fmtInt(dup.fi), fmtPct(c.lead_to_fi), fmtPct(d.lead_to_fi)],
    ['Applications', fmtInt(s.apps + dup.apps), fmtInt(s.apps), fmtInt(dup.apps), fmtPct(c.fi_to_app), fmtPct(d.fi_to_app)],
    ['Admissions', '', fmtInt(s.adm), fmtInt(dup.adm), fmtPct(c.app_to_adm), fmtPct(d.app_to_adm)],
    ['Target', fmtInt(s.target), '', '', '', ''],
    ['Target Achieved %', '', '', '', fmtPct(c.target_achieved), ''],
    ['Deal Type', esc(s.deal_type), '', '', '', ''],
  ];
  const head = `<th>Metric</th><th>Total (P+D)</th><th>Primary</th><th class="dupcol">Duplicate</th><th>Primary Conv %</th><th class="dupcol">Duplicate Conv %</th>${annoHead}`;
  const n = rows.length;
  const body = rows.map(([m, tot, p, dp, pc, dc], i) =>
    `<tr><td>${m}</td><td>${tot}</td><td>${p}</td><td class="dupcol">${dp}</td><td>${pc}</td><td class="dupcol">${dc}</td>${i === 0 ? annoMerged('summary', n) : ''}</tr>`).join('');
  return `<div class="tblwrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function stagesHtml(block) {
  const body = block.rows.map((r) => `<tr><td>${esc(r.stage)}</td><td>${fmtInt(r.leads)}</td><td>${fmtPct(r.pct)}</td></tr>`).join('')
    + `<tr class="total"><td>TOTAL</td><td>${fmtInt(block.total)}</td><td></td></tr>`;
  return `<div class="tblwrap"><table class="grid"><thead><tr><th>Stage</th><th>Leads</th><th>%</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function originMonthChartHtml() {
  return `<div class="chart-block">
    <div class="seg chart-metric-seg">
      <button class="seg-btn is-active" data-chart-metric="leads">Leads</button>
      <button class="seg-btn" data-chart-metric="fi">FI</button>
      <button class="seg-btn" data-chart-metric="apps">Apps</button>
      <button class="seg-btn" data-chart-metric="adm">Adms</button>
    </div>
    <svg id="originMonthSvg" class="origin-chart" viewBox="0 0 820 340" width="820" height="340" preserveAspectRatio="xMidYMid meet"></svg>
  </div>`;
}

function drawOriginMonthChart(rows, metric = 'leads') {
  const svg = document.getElementById('originMonthSvg');
  if (!svg || !rows.length) return;
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const origins = [...new Set(rows.map((r) => r.origin))];
  const lookup = {};
  for (const r of rows) (lookup[r.origin] = lookup[r.origin] || {})[r.month] = r;
  const W = 820, H = 340;
  const PAD = { top: 48, right: 20, bottom: 72, left: 72 };
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;
  const maxVal = Math.max(...rows.map((r) => Number(r[metric] || 0)), 1);
  const niceMax = Math.ceil(maxVal / 5) * 5 || 5;
  const xOf = (i) => PAD.left + (months.length < 2 ? cW / 2 : (i / (months.length - 1)) * cW);
  const yOf = (v) => PAD.top + cH - (v / niceMax) * cH;
  const METRIC_LABEL = { leads: 'Leads', fi: 'Form Initiated', apps: 'Applications', adm: 'Admissions' };
  const label = METRIC_LABEL[metric] || metric;
  let out = '';
  out += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  out += `<rect x="${PAD.left}" y="${PAD.top}" width="${cW}" height="${cH}" fill="#fafafa" stroke="#e4e4e4" stroke-width="1"/>`;
  out += `<text x="${PAD.left + cW / 2}" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#222" font-family="sans-serif">${label} Trend by Lead Origin</text>`;
  const midY = PAD.top + cH / 2;
  out += `<text transform="rotate(-90,18,${midY})" x="18" y="${midY}" text-anchor="middle" font-size="12" fill="#555" font-family="sans-serif">${label}</text>`;
  out += `<text x="${PAD.left + cW / 2}" y="${H - 2}" text-anchor="middle" font-size="12" fill="#555" font-family="sans-serif">Month</text>`;
  for (let i = 0; i <= 5; i++) {
    const v = (niceMax / 5) * i, y = yOf(v);
    if (i > 0) out += `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${PAD.left + cW}" y2="${y.toFixed(1)}" stroke="#d8d8d8" stroke-width="1" stroke-dasharray="4,3"/>`;
    out += `<text x="${PAD.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#555" font-family="sans-serif">${fmtInt(Math.round(v))}</text>`;
  }
  months.forEach((m, i) => {
    const x = xOf(i), parts = fmtMonth(m).split(' ');
    out += `<text x="${x.toFixed(1)}" y="${(PAD.top + cH + 16).toFixed(1)}" text-anchor="middle" font-size="11" fill="#555" font-family="sans-serif">${parts[0] || ''}</text>`;
    out += `<text x="${x.toFixed(1)}" y="${(PAD.top + cH + 29).toFixed(1)}" text-anchor="middle" font-size="11" fill="#555" font-family="sans-serif">${parts[1] || ''}</text>`;
  });
  const placed = [];
  origins.forEach((origin, oi) => {
    const color = CHART_COLORS[oi % CHART_COLORS.length];
    const pts = months.map((m, i) => [xOf(i), yOf(Number(lookup[origin]?.[m]?.[metric] || 0))]);
    out += `<path d="${pts.map((p, pi) => `${pi ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(([x, y], pi) => {
      const v = Number(lookup[origin]?.[months[pi]]?.[metric] || 0);
      out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${color}" stroke="#fff" stroke-width="2"><title>${esc(origin)} · ${fmtMonth(months[pi])}: ${fmtInt(v)}</title></circle>`;
      let labelY = y - 9;
      if (y < PAD.top + 18) labelY = y + 16;
      const textW = fmtInt(v).length * 6;
      for (let tries = 0; tries < 6; tries++) {
        const hit = placed.some((p) => Math.abs(p.x - x) < (textW + p.w) / 2 && Math.abs(p.y - labelY) < 12);
        if (!hit) break;
        labelY += labelY < y ? -13 : 13;
      }
      placed.push({ x, y: labelY, w: textW });
      out += `<text x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="${color}" font-family="sans-serif">${fmtInt(v)}</text>`;
    });
  });
  out += `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + cH}" stroke="#666" stroke-width="1.5"/>`;
  out += `<line x1="${PAD.left}" y1="${PAD.top + cH}" x2="${PAD.left + cW}" y2="${PAD.top + cH}" stroke="#666" stroke-width="1.5"/>`;
  const LEG_W = 130, LEG_H = origins.length * 22 + 14;
  const LEG_X = PAD.left + cW - 10 - LEG_W, LEG_Y = PAD.top + 10;
  out += `<rect x="${LEG_X}" y="${LEG_Y}" width="${LEG_W}" height="${LEG_H}" fill="white" stroke="#ccc" stroke-width="1" rx="4"/>`;
  origins.forEach((origin, oi) => {
    const color = CHART_COLORS[oi % CHART_COLORS.length];
    const ly = LEG_Y + 10 + oi * 22;
    out += `<line x1="${LEG_X + 8}" y1="${ly + 5}" x2="${LEG_X + 22}" y2="${ly + 5}" stroke="${color}" stroke-width="2"/>`;
    out += `<circle cx="${LEG_X + 15}" cy="${ly + 5}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
    out += `<text x="${LEG_X + 28}" y="${ly + 9}" font-size="11" fill="#333" font-family="sans-serif">${esc(origin)}</text>`;
  });
  svg.innerHTML = out;
}

function renderKpiGrid(s) {
  const dup = s.duplicates || {};
  const c = s.conversions || {};
  const totLeads = (s.leads || 0) + (dup.leads || 0);
  const achievement = Number(c.target_achieved || 0);
  const cls = achievement >= 1 ? 'good' : achievement >= 0.5 ? 'warn' : 'accent';
  const kpis = [
    { label: 'Total Leads', value: fmtInt(totLeads), sub: `${fmtInt(s.leads||0)} primary · ${fmtInt(dup.leads||0)} dup`, cls: 'accent' },
    { label: 'Form Initiated', value: fmtInt(s.fi||0), sub: `Lead→FI: ${fmtPct(c.lead_to_fi)}`, cls: '' },
    { label: 'Applications', value: fmtInt(s.apps||0), sub: `FI→App: ${fmtPct(c.fi_to_app)}`, cls: '' },
    { label: 'Admissions', value: fmtInt(s.adm||0), sub: `App→Adm: ${fmtPct(c.app_to_adm)}`, cls: 'good' },
    { label: 'Target Achievement', value: fmtPct(c.target_achieved), sub: `Target: ${fmtInt(s.target||0)}`, cls },
  ];
  return `<div class="kpi-grid">${kpis.map((k) => `<div class="kpi ${k.cls}"><div class="label">${k.label}</div><div class="value">${k.value}</div><div class="sub">${k.sub}</div></div>`).join('')}</div>`;
}

function renderReport(d) {
  currentOriginMonth = d.origin_month || [];
  $('#reportBody').innerHTML = renderKpiGrid(d.summary) + [
    drawer('Summary', summaryHtml(d.summary)),
    drawer('Top Lead Codes', rankTableHtml('Lead Code', d.top_lead_codes, 'lead_codes')),
    drawer('Top Courses', rankTableHtml('Course', d.top_courses, 'courses')),
    drawer('Top Cities', rankTableHtml('City', d.top_cities, 'cities')),
    drawer('Lead Origin (overall)', rankTableHtml('Lead Origin', d.origin, 'origin')),
    drawer('Lead Origin × Month', originMonthChartHtml() + originMonthTableHtml(d.origin_month, 'origin_month')),
    drawer('Top Performing Medium by Month', monthTableHtml('Medium', d.top_medium_by_month, 'medium_month')),
    drawer('Top Performing Course by Month', monthTableHtml('Course', d.top_course_by_month, 'course_month')),
    drawer('Lead Stages', stagesHtml(d.lead_stages), false),
  ].join('');
  drawOriginMonthChart(currentOriginMonth, 'leads');
}

// Drawer open/close (delegated, covers report tables + SETUP preview).
document.addEventListener('click', (e) => {
  const t = e.target.closest('.drawer-toggle');
  if (!t) return;
  const card = t.closest('.card');
  const collapsed = card.classList.toggle('collapsed');
  t.setAttribute('aria-expanded', String(!collapsed));
});

// Chart metric toggle.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-chart-metric]');
  if (!btn) return;
  btn.closest('.seg').querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  drawOriginMonthChart(currentOriginMonth, btn.dataset.chartMetric);
});

// Save Insights / Challenges on blur.
document.addEventListener('blur', async (e) => {
  const el = e.target.closest && e.target.closest('.editable');
  if (!el) return;
  const { scope, key } = el.dataset;
  const row = el.closest('tr');
  const insights = (row.querySelector('[data-field="insights"]')?.innerText || '').trim();
  const challenges = (row.querySelector('[data-field="challenges"]')?.innerText || '').trim();
  annos[scope] = annos[scope] || {};
  annos[scope][key] = { insights, challenges };
  await fetch('/api/annotations', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, key, insights, challenges }) });
}, true);

$('#exportBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  $('#exportMenu')?.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#exportDropdown')) $('#exportMenu')?.classList.add('hidden');
});
$('#downloadPdf')?.addEventListener('click', () => { window.print(); $('#exportMenu')?.classList.add('hidden'); });
$('#downloadXlsx')?.addEventListener('click', () => { window.location.href = '/api/report.xlsx'; $('#exportMenu')?.classList.add('hidden'); });
$('#topNSelect')?.addEventListener('change', () => loadReport());
$('#expandAll')?.addEventListener('click', () => $$('#reportBody .card').forEach((c) => c.classList.remove('collapsed')));
$('#collapseAll')?.addEventListener('click', () => $$('#reportBody .card').forEach((c) => c.classList.add('collapsed')));

// ---- Datasets -------------------------------------------------------------
async function loadDatasets() {
  const raw = await (await fetch('/api/datasets')).json().catch(() => ({}));
  const datasets = raw.datasets || [];
  const tbody = $('#datasetsTable tbody');
  if (!datasets.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999">No datasets yet</td></tr>'; setPill(null); return; }
  tbody.innerHTML = datasets.map((d) => `<tr>
    <td>${d.is_active ? '● active' : `<button class="btn ghost sm" data-activate="${d.id}">use</button>`}</td>
    <td>${d.name || d.source_filename || '—'}</td>
    <td>${fmtInt(d.row_count)}</td>
    <td>${new Date(d.uploaded_at).toLocaleString()}</td>
    <td><button class="btn ghost sm" data-del="${d.id}">delete</button></td></tr>`).join('');
  const active = datasets.find((d) => d.is_active) || datasets[0];
  setPill(active);
  tbody.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', async () => {
    await fetch(`/api/datasets/${b.dataset.activate}/activate`, { method: 'POST' });
    loadDatasets(); loadReport();
  }));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this dataset and all its rows?')) return;
    await fetch(`/api/datasets/${b.dataset.del}`, { method: 'DELETE' });
    loadDatasets(); loadReport();
  }));
}

function setPill(active) {
  $('#datasetPill').textContent = active ? `${active.name || active.source_filename} · ${fmtInt(active.row_count)} rows` : 'No dataset';
}

// Minimal RFC-4180-ish CSV parser.
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function detectHeaderRow(matrix) {
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    const cells = matrix[i] || [];
    const nonEmpty = cells.filter((c) => String(c ?? '').trim() !== '').length;
    const shortText = cells.filter((c) => { const v = String(c ?? '').trim(); return v && v.length <= 40; }).length;
    const score = nonEmpty + shortText;
    if (nonEmpty >= 3 && score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

async function chunkedCsvUpload(file, name, headerRowOverride) {
  const status = $('#uploadStatus');
  status.textContent = 'Reading file…'; status.className = 'status';
  const matrix = parseCSV(await file.text());
  const hIdx = headerRowOverride !== '' && headerRowOverride != null ? Number(headerRowOverride) : detectHeaderRow(matrix);
  const headers = (matrix[hIdx] || []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  const rows = [];
  for (let r = hIdx + 1; r < matrix.length; r++) {
    const line = matrix[r] || [];
    if (line.every((c) => String(c ?? '').trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = line[c] ?? '';
    rows.push(obj);
  }
  if (!rows.length) throw new Error('No data rows found in file');

  const started = await (await fetch('/api/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || file.name, filename: file.name, headers }),
  })).json();
  const datasetId = started.datasetId;
  if (!datasetId) throw new Error(started.error || 'Could not start upload');

  const CHUNK = 5000;
  const PARALLEL = 5;
  let sent = 0;

  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    chunks.push(rows.slice(i, i + CHUNK));
  }

  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const batch = chunks.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async (chunk) => {
      const res = await fetch('/api/upload/rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, rows: chunk }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Batch upload failed');
      }
      sent += chunk.length;
      status.textContent = `Uploading ${fmtInt(Math.min(sent, rows.length))} / ${fmtInt(rows.length)} rows…`;
    }));
  }
  await fetch('/api/upload/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId }),
  });
  return sent;
}

$('#uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#uploadStatus');
  const btn = $('#uploadBtn');
  const file = $('#fileInput').files[0];
  const name = $('#uploadName').value;
  const headerRow = $('#headerRow').value;
  if (!file) { status.textContent = 'Choose a file'; status.className = 'status err'; return; }
  btn.disabled = true;
  try {
    const isCsv = /\.(csv|tsv|txt)$/i.test(file.name);
    if (isCsv) {
      const n = await chunkedCsvUpload(file, name, headerRow);
      status.textContent = `✓ Imported ${fmtInt(n)} rows`; status.className = 'status ok';
      showToast(`✓ Imported ${fmtInt(n)} rows`, 'ok');
    } else {
      status.textContent = 'Uploading & importing…'; status.className = 'status';
      const res = await fetch('/api/upload', { method: 'POST', body: new FormData(e.target) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      status.textContent = `✓ Imported ${fmtInt(data.rowCount)} rows (${data.columns} cols)`; status.className = 'status ok';
      showToast(`✓ Imported ${fmtInt(data.rowCount)} rows`, 'ok');
    }
    e.target.reset();
    loadDatasets(); loadReport();
  } catch (err) {
    status.textContent = err.message; status.className = 'status err';
    showToast(err.message, 'err');
  } finally { btn.disabled = false; }
});

(function initDropZones() {
  document.querySelectorAll('.drop-zone').forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    if (!input) return;
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        input.files = dt.files;
        const label = zone.querySelector('.drop-title');
        if (label) label.textContent = e.dataTransfer.files[0].name;
      }
    });
    input.addEventListener('change', () => {
      if (input.files[0]) {
        const label = zone.querySelector('.drop-title');
        if (label) label.textContent = input.files[0].name;
      }
    });
  });
})();

// ---- Campaign Analysis merge upload ---------------------------------------
// Parses all CSV files client-side, unions headers, uploads via chunked API.
async function chunkedCsvMerge(files, name, statusEl) {
  const fileArr = [...files];
  const allHeaders = new Set();
  const parsed = [];
  for (const f of fileArr) {
    statusEl.textContent = `Reading ${f.name}…`; statusEl.className = 'status';
    const matrix = parseCSV(await f.text());
    const hIdx = detectHeaderRow(matrix);
    const headers = (matrix[hIdx] || []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    headers.forEach((h) => allHeaders.add(h));
    const rows = [];
    for (let r = hIdx + 1; r < matrix.length; r++) {
      const line = matrix[r] || [];
      if (line.every((c) => String(c ?? '').trim() === '')) continue;
      const obj = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c]] = line[c] ?? '';
      rows.push(obj);
    }
    parsed.push(rows);
  }
  const mergedHeaders = [...allHeaders];
  const mergedRows = parsed.flatMap((rows) => rows.map((row) => {
    const out = {};
    for (const h of mergedHeaders) out[h] = row[h] ?? '';
    return out;
  }));
  if (!mergedRows.length) throw new Error('No data rows found in any file');

  const dsName = name || `Merged (${fileArr.length} files)`;
  const started = await (await fetch('/api/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: dsName, filename: dsName, headers: mergedHeaders }),
  })).json();
  if (!started.datasetId) throw new Error(started.error || 'Could not start upload');

  const CHUNK = 5000;
  let sent = 0;
  const chunks = [];
  for (let i = 0; i < mergedRows.length; i += CHUNK) chunks.push(mergedRows.slice(i, i + CHUNK));
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    await Promise.all(batch.map(async (chunk) => {
      const res = await fetch('/api/upload/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId: started.datasetId, rows: chunk }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Batch upload failed');
      sent += chunk.length;
      statusEl.textContent = `Uploading ${fmtInt(Math.min(sent, mergedRows.length))} / ${fmtInt(mergedRows.length)} rows…`;
    }));
  }
  const fin = await (await fetch('/api/upload/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId: started.datasetId }),
  })).json();
  return { rowCount: fin.rowCount, fileCount: fileArr.length, columns: mergedHeaders.length };
}

$('#mergeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#mergeStatus');
  const btn = $('#mergeBtn');
  const files = $('#mergeFiles').files;
  const name = $('#mergeName').value;
  if (!files.length) { status.textContent = 'Choose at least one file'; status.className = 'status err'; return; }
  const allCsv = [...files].every((f) => /\.(csv|tsv|txt)$/i.test(f.name));
  btn.disabled = true;
  status.textContent = 'Reading files…'; status.className = 'status';
  try {
    let data;
    if (allCsv) {
      data = await chunkedCsvMerge(files, name, status);
    } else {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      if (name) fd.append('name', name);
      const res = await fetch('/api/upload/merge', { method: 'POST', body: fd });
      const text = await res.text();
      try { data = JSON.parse(text); } catch {
        throw new Error(res.status === 413 || text.includes('Entity Too Large')
          ? 'Files too large — Vercel limits XLSX uploads to 4.5 MB total.'
          : `Server error (${res.status})`);
      }
      if (!res.ok) throw new Error(data.error || 'Merge failed');
    }
    status.textContent = `✓ Merged ${data.fileCount} files → ${fmtInt(data.rowCount)} rows (${data.columns} cols)`;
    status.className = 'status ok';
    e.target.reset();
    loadDatasets(); loadReport();
  } catch (err) {
    status.textContent = err.message; status.className = 'status err';
  } finally { btn.disabled = false; }
});

// ---- CRM Presets ----------------------------------------------------------
const CRM_PRESETS = {
  NPF: {
    crm_type: 'NPF',
    report_title: '',
    target: 50,
    deal_type: 'CPA',
    record_key_column: 'Name',
    lead_source_column: 'Campaign',
    lead_code_delimiter: '/',
    lead_code_token: 2,
    course_column: 'Mobile Verification Status',
    city_column: 'City',
    form_initiated_column: 'Registration Device',
    application_column: 'Course',
    admission_column: 'Lead Stage',
    lead_stage_column: 'Lead Stage',
    date_column: 'Instance Date',
    date_format: 'auto',
    instance_column: 'Instance',
    instance_filter: 'Primary',
    lead_origin_column: 'Lead Origin',
    application_values: ['1'],
    admission_values: ['Submitted'],
    form_initiated_values: ['1', '2'],
    duplicate_instance_values: [],
    top_n: 15,
  },
  LSQ: {
    crm_type: 'LSQ',
    report_title: '',
    target: 100,
    deal_type: 'CPS',
    record_key_column: 'Name',
    lead_source_column: 'Lead Stage',
    lead_code_delimiter: '',
    lead_code_token: 1,
    course_column: 'Instance',
    city_column: 'State',
    form_initiated_column: 'Lead Score',
    application_column: 'Lead Score',
    admission_column: 'Lead Status',
    lead_stage_column: 'Lead Status',
    date_column: 'Instance Date',
    date_format: 'auto',
    instance_column: 'Instance',
    instance_filter: 'Primary',
    lead_origin_column: 'Lead Origin',
    application_values: ['CUCET Payment Done'],
    admission_values: ['Enrolled', 'Refunded'],
    form_initiated_values: ['CUCET Payment Done'],
    duplicate_instance_values: [],
    top_n: 15,
  },
};

// ---- Settings -------------------------------------------------------------
const FIELDS = [
  ['crm_type', '', 'hidden'],
  ['report_title', 'Report title / client name (PDF heading)', 'text'],
  ['target', 'Target (CPA → applications · CPS → admissions)', 'number'],
  ['deal_type', 'Deal Type', 'select', ['CPA', 'CPS']],
  ['record_key_column', 'Record key column (total leads)', 'text'],
  ['lead_source_column', 'Lead-source column (Lead Code)', 'text'],
  ['lead_code_delimiter', 'Lead Code delimiter', 'text'],
  ['lead_code_token', 'Lead Code token number', 'number'],
  ['course_column', 'Course column', 'text'],
  ['city_column', 'City column', 'text'],
  ['form_initiated_column', 'Form-Initiated column', 'text'],
  ['application_column', 'Application column', 'text'],
  ['admission_column', 'Admission column', 'text'],
  ['lead_stage_column', 'Lead Stage column', 'text'],
  ['date_column', 'Date column', 'text'],
  ['date_format', 'Date format (auto-detects day/month)', 'select', ['auto', 'MDY', 'DMY', 'YMD']],
  ['instance_column', 'Instance column', 'text'],
  ['instance_filter', 'Count ONLY this instance (blank = all)', 'text'],
  ['lead_origin_column', 'Lead Origin column', 'text'],
  ['application_values', 'Application values (comma sep; blank = any non-empty)', 'list'],
  ['admission_values', 'Admission values (comma sep)', 'list'],
  ['form_initiated_values', 'Form-Initiated values (comma sep)', 'list'],
  ['duplicate_instance_values', 'Duplicate instance values (comma sep; blank = use uploaded dup files)', 'list'],
  ['top_n', 'Top N rows per table', 'number'],
];
let defaultsCache = null;
let previewColumns = [];

async function loadSettings() {
  const [settingsData, previewData] = await Promise.all([
    fetch('/api/settings').then((r) => r.json()).catch(() => ({ settings: {}, defaults: {} })),
    fetch('/api/preview?limit=8').then((r) => r.json()).catch(() => ({ empty: true })),
  ]);
  const { settings, defaults } = settingsData;
  defaultsCache = defaults;
  previewColumns = previewData.columns || [];
  renderSettings(settings);
  const crmSel = $('#crmPreset');
  if (crmSel) crmSel.value = settings.crm_type || '';
  const topNSel = $('#topNSelect');
  if (topNSel && settings.top_n) topNSel.value = String(settings.top_n);
  renderPreview(previewData);
}

function renderPreview(data) {
  const table = $('#previewTable');
  if (!table) return;
  if (data.empty || !data.columns) { table.innerHTML = ''; return; }
  const head = `<thead><tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${data.rows.map((r) =>
    `<tr>${data.columns.map((c) => `<td title="${String(r[c] ?? '').replace(/"/g, '&quot;')}">${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
  table.innerHTML = head + body;
}

function renderSettings(s) {
  const crmType = String(s.crm_type || '').toUpperCase();
  $('#settingsForm').innerHTML = FIELDS.map(([key, label, type, options]) => {
    if (type === 'hidden') {
      return `<input type="hidden" data-key="${key}" data-type="hidden" value="${String(s[key] ?? '').replace(/"/g, '&quot;')}" />`;
    }
    if (key === 'duplicate_instance_values') {
      const hasValues = Array.isArray(s[key]) && s[key].length > 0;
      if (crmType !== 'LSQ' && !hasValues) return '';
    }
    if (type === 'select') {
      const current = String(s[key] ?? (options && options[0]) ?? '');
      const opts = (options || []).map((o) =>
        `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('');
      return `<label class="field"><span>${label}</span>
        <select data-key="${key}" data-type="select">${opts}</select></label>`;
    }
    if (key.endsWith('_column') && previewColumns.length) {
      const current = String(s[key] ?? '');
      const allCols = current && !previewColumns.includes(current)
        ? ['', ...previewColumns, current]
        : ['', ...previewColumns];
      const opts = allCols.map((col) =>
        `<option value="${esc(col)}" ${col === current ? 'selected' : ''}>${esc(col) || '— none —'}</option>`
      ).join('');
      return `<label class="field"><span>${label}</span>
        <select data-key="${key}" data-type="text">${opts}</select></label>`;
    }
    const val = type === 'list' ? (s[key] || []).join(', ') : (s[key] ?? '');
    return `<label class="field"><span>${label}</span>
      <input data-key="${key}" data-type="${type}" type="${type === 'number' ? 'number' : 'text'}" value="${String(val).replace(/"/g, '&quot;')}" /></label>`;
  }).join('');
}

function collectSettings() {
  const out = {};
  $$('#settingsForm input, #settingsForm select').forEach((inp) => {
    const { key, type } = inp.dataset;
    if (type === 'number') out[key] = inp.value === '' ? null : Number(inp.value);
    else if (type === 'list') out[key] = inp.value.split(',').map((x) => x.trim()).filter(Boolean);
    else out[key] = inp.value;
  });
  return out;
}

$('#saveSettings').addEventListener('click', async () => {
  const status = $('#settingsStatus');
  status.textContent = 'Saving…'; status.className = 'status';
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectSettings()) });
  status.textContent = res.ok ? '✓ Saved — click Recompute to apply' : 'Save failed';
  status.className = res.ok ? 'status ok' : 'status err';
  if (res.ok) { loadReport(); loadClients(); }
});

$('#recomputeBtn').addEventListener('click', async () => {
  const status = $('#settingsStatus');
  status.textContent = 'Recomputing…'; status.className = 'status';
  const res = await fetch('/api/recompute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json();
  status.textContent = res.ok ? `✓ Recomputed ${fmtInt(data.recomputed)} rows` : (data.error || 'Failed');
  status.className = res.ok ? 'status ok' : 'status err';
  loadReport();
});

$('#resetSettings').addEventListener('click', () => { if (defaultsCache) renderSettings(defaultsCache); });

$('#applyCrmPreset')?.addEventListener('click', () => {
  const sel = $('#crmPreset').value;
  const preset = CRM_PRESETS[sel];
  if (!preset) return;
  renderSettings(preset);
  $('#settingsStatus').textContent = `${sel} preset loaded — review, then Save + Recompute`;
  $('#settingsStatus').className = 'status ok';
});

// ---- Mappings -------------------------------------------------------------
let mapType = 'course';
let mapSearchTimer = null;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$$('.seg-btn[data-map]').forEach((b) => b.addEventListener('click', () => {
  b.parentElement.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('is-active'));
  b.classList.add('is-active');
  mapType = b.dataset.map;
  updateMapPlaceholders();
  loadMap();
}));

$('#mapSearch')?.addEventListener('input', () => {
  clearTimeout(mapSearchTimer);
  mapSearchTimer = setTimeout(loadMap, 250);
});

function updateMapPlaceholders() {
  const course = mapType === 'course';
  $('#mapNewKey').placeholder = course ? 'From (raw course, e.g. PGDM)' : 'From (campaign token, e.g. bm79)';
  $('#mapNewValue').placeholder = course ? 'To (KAPP course, e.g. MBA/PGDM)' : 'To (new lead code, e.g. bm)';
}

async function loadMap() {
  const q = $('#mapSearch').value.trim();
  const url = `/api/mappings?type=${mapType}&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const data = await (await fetch(url)).json();
  $('#mapCount').textContent = `${fmtInt(data.total)} total${data.total > data.rows.length ? ` · showing ${data.rows.length}` : ''}`;
  renderMapTable(data.rows);
}

function renderMapTable(rows) {
  const kh = mapType === 'course' ? 'Raw course' : 'Campaign token';
  const vh = mapType === 'course' ? 'KAPP course' : 'New lead code';
  const head = `<thead><tr><th>${kh}</th><th>${vh}</th><th></th></tr></thead>`;
  const body = rows.length ? rows.map((r) => `<tr data-id="${r.id}">
    <td class="mk">${esc(r.key)}</td><td class="mv">${esc(r.value)}</td>
    <td><button class="link-btn" data-edit>edit</button><button class="link-btn danger" data-del>delete</button></td>
  </tr>`).join('') : `<tr><td colspan="3" style="text-align:center;color:var(--muted)">No mappings found</td></tr>`;
  const t = $('#mapTable');
  t.innerHTML = head + `<tbody>${body}</tbody>`;
  t.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delMap(b.closest('tr'))));
  t.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editMap(b.closest('tr'))));
}

function editMap(tr) {
  const id = tr.dataset.id;
  const key = tr.querySelector('.mk').textContent;
  const val = tr.querySelector('.mv').textContent;
  tr.querySelector('.mk').innerHTML = `<input class="inp ek" value="${esc(key)}">`;
  tr.querySelector('.mv').innerHTML = `<input class="inp ev" value="${esc(val)}">`;
  tr.querySelector('td:last-child').innerHTML =
    '<button class="link-btn" data-save>save</button><button class="link-btn" data-cancel>cancel</button>';
  tr.querySelector('[data-save]').addEventListener('click', async () => {
    const res = await fetch(`/api/mappings/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: mapType, key: tr.querySelector('.ek').value.trim(), value: tr.querySelector('.ev').value.trim() }),
    });
    if (!res.ok) { alert((await res.json()).error || 'Update failed'); return; }
    loadMap();
  });
  tr.querySelector('[data-cancel]').addEventListener('click', loadMap);
}

async function delMap(tr) {
  if (!confirm('Delete this mapping?')) return;
  await fetch(`/api/mappings/${tr.dataset.id}?type=${mapType}`, { method: 'DELETE' });
  loadMap();
}

$('#mapAdd')?.addEventListener('click', async () => {
  const key = $('#mapNewKey').value.trim();
  const value = $('#mapNewValue').value.trim();
  const status = $('#mapStatus');
  if (!key || !value) { status.textContent = 'Enter both values'; status.className = 'status err'; return; }
  const res = await fetch('/api/mappings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: mapType, key, value }),
  });
  if (!res.ok) { status.textContent = (await res.json()).error || 'Failed'; status.className = 'status err'; return; }
  status.textContent = '✓ Saved'; status.className = 'status ok';
  $('#mapNewKey').value = ''; $('#mapNewValue').value = '';
  loadMap();
});

$('#mapRecompute')?.addEventListener('click', async () => {
  const status = $('#mapStatus');
  status.textContent = 'Recomputing…'; status.className = 'status';
  const res = await fetch('/api/recompute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json();
  status.textContent = res.ok ? `✓ Recomputed ${fmtInt(data.recomputed)} rows` : (data.error || 'Failed');
  status.className = res.ok ? 'status ok' : 'status err';
  loadReport();
});

$('#mapSample')?.addEventListener('click', () => {
  window.location.href = `/api/mappings/${mapType}/sample`;
});

async function uploadMapFile(input, replace) {
  const file = input.files[0];
  const status = $('#mapBulkStatus');
  if (!file) return;
  status.textContent = `${replace ? 'Replacing' : 'Uploading'}…`; status.className = 'status';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('replace', String(replace));
  const res = await fetch(`/api/mappings/${mapType}/upload`, { method: 'POST', body: fd });
  const data = await res.json();
  input.value = '';
  if (!res.ok) { status.textContent = data.error || 'Upload failed'; status.className = 'status err'; return; }
  status.textContent = `✓ ${fmtInt(data.count)} mappings ${data.replaced ? 'replaced' : 'added/updated'} — click Recompute to apply`;
  status.className = 'status ok';
  loadMap();
}
$('#mapFile')?.addEventListener('change', (e) => uploadMapFile(e.target, false));
$('#mapFileReplace')?.addEventListener('change', (e) => uploadMapFile(e.target, true));

$('#mapClearAll')?.addEventListener('click', async () => {
  const label = mapType === 'course' ? 'course' : 'lead code';
  if (!confirm(`Delete ALL ${label} mappings? Unmatched values will then pass through unchanged until you upload new ones.`)) return;
  const status = $('#mapBulkStatus');
  const res = await fetch(`/api/mappings/${mapType}/all`, { method: 'DELETE' });
  status.textContent = res.ok ? '✓ All mappings cleared — click Recompute to apply' : 'Failed';
  status.className = res.ok ? 'status ok' : 'status err';
  loadMap();
});

// ---- Duplicates -----------------------------------------------------------
let dupCat = 'leads';

$$('.seg-btn[data-dup]').forEach((b) => b.addEventListener('click', () => {
  b.parentElement.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('is-active'));
  b.classList.add('is-active');
  dupCat = b.dataset.dup;
  loadDup();
}));

async function loadDup() {
  const data = await (await fetch(`/api/duplicates/${dupCat}`)).json();
  const m = data.meta;
  const t = data.totals || {};
  $('#dupMeta').textContent = m
    ? `${m.source_filename || 'uploaded'} · ${fmtInt(m.row_count)} rows · dup total ${fmtInt(t.dup)}`
    : 'Not uploaded yet';
  renderDupTable(data.rows || []);
}

function renderDupTable(rows) {
  const cols = [
    ['medium', 'Medium', esc], ['kapp_medium', 'Kapp Medium', esc], ['campaign', 'Campaign', esc],
    ['primary_leads', 'Primary', fmtInt], ['secondary_leads', 'Secondary', fmtInt],
    ['tertiary_leads', 'Tertiary', fmtInt], ['dup_count', 'Duplicate (S+T)', fmtInt],
    ['form_initiated', 'Form Init', fmtInt], ['payment_approved', 'Payment Appr', fmtInt],
  ];
  const head = `<thead><tr>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? rows.map((r) => `<tr>${cols.map(([k,, f]) => `<td>${f(r[k] ?? '')}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--muted)">No rows — upload a file above</td></tr>`;
  $('#dupTable').innerHTML = head + `<tbody>${body}</tbody>`;
}

$('#dupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#dupFile').files[0];
  const status = $('#dupStatus');
  if (!file) { status.textContent = 'Choose a file'; status.className = 'status err'; return; }
  status.textContent = 'Uploading…'; status.className = 'status';
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch(`/api/duplicates/${dupCat}`, { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) { status.textContent = data.error || 'Failed'; status.className = 'status err'; return; }
  status.textContent = `✓ ${fmtInt(data.rowCount)} rows · dup total ${fmtInt(data.dupTotal)}`;
  status.className = 'status ok';
  $('#dupFile').value = '';
  loadDup(); loadReport();
});

$('#dupClear')?.addEventListener('click', async () => {
  if (!confirm(`Clear the ${dupCat} duplicate upload?`)) return;
  await fetch(`/api/duplicates/${dupCat}`, { method: 'DELETE' });
  loadDup(); loadReport();
});

// ---- Campaign Analysis Clients -------------------------------------------
let clientSearchTimer = null;

async function loadClients(q = '') {
  const data = await (await fetch(`/api/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json().catch(() => ({ clients: [], active: null }));
  if (!data.clients) { data.clients = []; }
  $('#clientName').textContent = (data.active && data.active.name) || '—';
  const activeId = data.active?.id;
  const list = $('#clientList');
  list.innerHTML = data.clients.length ? data.clients.map((c) => `<div class="client-item ${c.id === activeId ? 'active' : ''}" data-id="${c.id}">
      <span>${esc(c.name)}</span>
      <span class="meta">${fmtInt(c.rows)} rows · ${c.dup_files}/4 dup</span>
      ${c.id === activeId ? '' : `<span class="del" data-del="${c.id}" title="delete client">✕</span>`}
    </div>`).join('') : '<div class="meta" style="padding:8px">No clients found</div>';
  list.querySelectorAll('.client-item').forEach((b) => b.addEventListener('click', async (e) => {
    if (e.target.closest('[data-del]')) return;
    await fetch(`/api/clients/${b.dataset.id}/activate`, { method: 'POST' });
    $('#clientMenu').classList.add('hidden');
    await switchClient();
  }));
  list.querySelectorAll('[data-del]').forEach((d) => d.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this client and ALL its data (datasets, duplicates, notes)? This cannot be undone.')) return;
    await fetch(`/api/clients/${d.dataset.del}`, { method: 'DELETE' });
    loadClients($('#clientSearch').value.trim());
  }));
}

async function switchClient() {
  await loadClients();
  await loadReport();
  await loadDatasets();
  if ($('#view-settings').classList.contains('is-active')) loadSettings();
  if ($('#view-duplicates').classList.contains('is-active')) loadDup();
  if ($('#view-mappings').classList.contains('is-active')) loadMap();
}

$('#clientBtn')?.addEventListener('click', () => {
  const menu = $('#clientMenu');
  menu.classList.toggle('hidden');
  if (!menu.classList.contains('hidden')) { $('#clientSearch').value = ''; loadClients(); $('#clientSearch').focus(); }
});
$('#clientSearch')?.addEventListener('input', () => {
  clearTimeout(clientSearchTimer);
  clientSearchTimer = setTimeout(() => loadClients($('#clientSearch').value.trim()), 200);
});
$('#newClientBtn')?.addEventListener('click', async () => {
  const name = $('#newClientName').value.trim();
  if (!name) return;
  const res = await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (res.ok) { $('#newClientName').value = ''; $('#clientMenu').classList.add('hidden'); await switchClient(); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#clientPicker')) $('#clientMenu')?.classList.add('hidden');
});

$('#wdClientBtn')?.addEventListener('click', () => {
  const menu = $('#wdClientMenu');
  menu.classList.toggle('hidden');
  if (!menu.classList.contains('hidden')) { $('#wdClientSearch').value = ''; loadWdClients(); $('#wdClientSearch').focus(); }
});
$('#wdClientSearch')?.addEventListener('input', () => {
  clearTimeout(wdClientSearchTimer);
  wdClientSearchTimer = setTimeout(() => loadWdClients($('#wdClientSearch').value.trim()), 200);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#wdClientPicker')) $('#wdClientMenu')?.classList.add('hidden');
});

// ---- Sidebar --------------------------------------------------------------
let lastCampaignView = 'report';

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebarOverlay').classList.remove('hidden');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarOverlay').classList.add('hidden');
}

$('#sidebarToggle')?.addEventListener('click', openSidebar);
$('#sidebarClose')?.addEventListener('click', closeSidebar);
$('#sidebarOverlay')?.addEventListener('click', closeSidebar);

$$('.sidebar-item').forEach((btn) => btn.addEventListener('click', () => {
  $$('.sidebar-item').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  closeSidebar();

  if (btn.dataset.nav === 'weekly-dump') {
    const activeTab = $('.tab[data-view].is-active');
    if (activeTab) lastCampaignView = activeTab.dataset.view;
    $$('.tab[data-view]').forEach((t) => t.classList.remove('is-active'));
    $$('.view').forEach((v) => v.classList.remove('is-active'));
    $('#campaignTabs')?.classList.add('hidden');
    $('#clientPicker')?.classList.add('hidden');
    $('#datasetPill')?.classList.add('hidden');
    $('#wdClientPicker')?.classList.remove('hidden');
    $('#view-weekly-dump').classList.add('is-active');
    loadWeeklyDump();
  } else {
    $$('.view').forEach((v) => v.classList.remove('is-active'));
    $('#campaignTabs')?.classList.remove('hidden');
    $('#clientPicker')?.classList.remove('hidden');
    $('#datasetPill')?.classList.remove('hidden');
    $('#wdClientPicker')?.classList.add('hidden');
    const target = $(`.tab[data-view="${lastCampaignView}"]`);
    if (target) {
      target.classList.add('is-active');
      $(`#view-${lastCampaignView}`)?.classList.add('is-active');
    } else {
      $('.tab[data-view="report"]')?.classList.add('is-active');
      $('#view-report')?.classList.add('is-active');
    }
  }
}));

$$('.sidebar-sub-item[data-nav-tab]').forEach((btn) => btn.addEventListener('click', () => {
  closeSidebar();
  const tabName = btn.dataset.navTab;
  // switch to campaign section
  $$('.sidebar-item').forEach((b) => b.classList.remove('is-active'));
  $('.sidebar-item[data-nav="campaign"]')?.classList.add('is-active');
  $$('.sidebar-sub-item').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  // show campaign views
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $('#campaignTabs')?.classList.remove('hidden');
  $('#clientPicker')?.classList.remove('hidden');
  $('#datasetPill')?.classList.remove('hidden');
  $('#wdClientPicker')?.classList.add('hidden');
  $('#view-weekly-dump')?.classList.remove('is-active');
  // activate specific tab
  $$('.tab[data-view]').forEach((t) => t.classList.remove('is-active'));
  $(`.tab[data-view="${tabName}"]`)?.classList.add('is-active');
  $(`#view-${tabName}`)?.classList.add('is-active');
  if (tabName === 'data') loadDatasets();
  if (tabName === 'settings') loadSettings();
  if (tabName === 'mappings') loadMap();
  if (tabName === 'duplicates') loadDup();
}));

$$('.sidebar-sub-item[data-wd-sub]').forEach((btn) => btn.addEventListener('click', () => {
  closeSidebar();
  const sub = btn.dataset.wdSub;
  $$('.sidebar-item').forEach((b) => b.classList.remove('is-active'));
  $('.sidebar-item[data-nav="weekly-dump"]')?.classList.add('is-active');
  $$('.sidebar-sub-item').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  // show WD section
  $$('.tab[data-view]').forEach((t) => t.classList.remove('is-active'));
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $('#campaignTabs')?.classList.add('hidden');
  $('#clientPicker')?.classList.add('hidden');
  $('#datasetPill')?.classList.add('hidden');
  $('#wdClientPicker')?.classList.remove('hidden');
  $('#view-weekly-dump')?.classList.add('is-active');
  // activate WD sub-view
  $$('.tab[data-wd-view]').forEach((t) => t.classList.remove('is-active'));
  $$('.wd-view').forEach((v) => v.classList.remove('is-active'));
  $(`.tab[data-wd-view="${sub}"]`)?.classList.add('is-active');
  $(`#wd-view-${sub}`)?.classList.add('is-active');
  loadWdClients();
  if (sub === 'report') loadWdReport();
  if (sub === 'setup') loadWdSetup();
  if (sub === 'datasets') loadWdDatasets();
}));

// ---- Weekly Dump ----------------------------------------------------------
const WD_FIELDS = [
  ['secondary_values', 'Secondary lead values (comma-sep)', 'list'],
  ['tertiary_values',  'Tertiary lead values (comma-sep)',  'list'],
  ['fi_column',  'Form Initiated — column',           'text'],
  ['fi_values',  'Form Initiated — values (comma-sep)', 'list'],
  ['app_column', 'Application — column',              'text'],
  ['app_values', 'Application — values (comma-sep)',  'list'],
  ['adm_column', 'Admission — column',                'text'],
  ['adm_values', 'Admission — values (comma-sep)',    'list'],
];

const WD_PRESETS = {
  NPF: { crm_type: 'NPF' },
  LSQ: {
    crm_type: 'LSQ',
    source_value:     'kollege',
    medium_column:    'MEDIUM',
    source_column:    'Source',
    campaign_column:  'Campaign',
    lead_type_column: 'LeadType',
    verified_column:  'VerificationStatus',
    verified_value:   'Verified',
    primary_value:     'Primary',
    secondary_value:   'Secondary',
    tertiary_value:    'Tertiary',
    secondary_values:  ['Secondary'],
    tertiary_values:   ['Tertiary'],
    fi_column:   'LeadStage',
    fi_values:   ['AR- Application Received', 'Offered', 'Offer Accepted'],
    app_column:  'LeadStage',
    app_values:  ['AR- Application Received', 'Offered', 'Offer Accepted'],
    adm_column:  'LeadStage',
    adm_values:  [],
  },
  Client: {
    crm_type: 'Client',
    source_value:     'kollegeapply',
    medium_column:    'Medium',
    source_column:    'Source',
    campaign_column:  'Campaign',
    lead_type_column: 'LeadType',
    verified_column:  '',
    verified_value:   '',
    primary_value:    'Primary',
    secondary_value:  'Secondary',
    tertiary_value:   'Tertiary',
    secondary_values:  ['Secondary'],
    tertiary_values:   ['Tertiary'],
    fi_column:   '',
    fi_values:   [],
    app_column:  '',
    app_values:  [],
    adm_column:  '',
    adm_values:  [],
  },
  ExtraEdge: {
    crm_type: 'ExtraEdge',
    source_value:     'kollegeapply',
    medium_column:    'Medium',
    source_column:    'Source',
    campaign_column:  'Campaign Name',
    lead_type_column: 'Lead Type',
    verified_column:  '',
    verified_value:   '',
    primary_value:    'Primary',
    secondary_value:  'Secondary',
    tertiary_value:   'Tertiary',
    secondary_values:  ['Secondary'],
    tertiary_values:   ['Tertiary'],
    fi_column:   'Stage',
    fi_values:   [],
    app_column:  'Stage',
    app_values:  [],
    adm_column:  'Stage',
    adm_values:  [],
  },
};

function renderWdSettingsForm(settings) {
  const form = $('#wdSettingsForm');
  if (!form) return;
  const crm = settings.crm_type || '';
  if (!crm) {
    form.innerHTML = '<p class="muted" style="margin:12px 0 0">Select a CRM above to configure.</p>';
    return;
  }
  if (crm === 'NPF') { form.innerHTML = ''; return; }
  form.innerHTML = `<div class="settings-grid" style="margin-top:1rem">${WD_FIELDS.map(([key, label, type]) => {
    const raw = settings[key] ?? '';
    const val = type === 'list' ? (Array.isArray(raw) ? raw.join(', ') : raw) : raw;
    return `<label class="field"><span>${label}</span>
      <input class="wd-setting" data-key="${key}" data-type="${type}" type="text" value="${String(val).replace(/"/g, '&quot;')}" /></label>`;
  }).join('')}</div>`;
}

function collectWdSettings() {
  const crm = $('#wdCrmType')?.value || '';
  const preset = WD_PRESETS[crm] || {};
  const out = { ...preset, crm_type: crm, tracking_id: $('#wdTrackingId')?.value || '' };
  $$('.wd-setting').forEach((inp) => {
    const { key, type } = inp.dataset;
    out[key] = type === 'list' ? inp.value.split(',').map((x) => x.trim()).filter(Boolean) : inp.value;
  });
  return out;
}

// ---- Weekly Dump Clients --------------------------------------------------
let wdClientSearchTimer = null;

async function loadWdClients(q = '') {
  const url = `/api/wd/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  const data = await fetch(url).then((r) => r.json()).catch(() => ({ clients: [], active: null }));
  const activeId = data.active?.id;
  const nameEl = $('#wdClientName');
  if (nameEl) nameEl.textContent = (data.active && data.active.name) || '—';
  const list = $('#wdClientList');
  if (!list) return;
  list.innerHTML = data.clients.length
    ? data.clients.map((c) => `<div class="client-item ${c.id === activeId ? 'active' : ''}" data-id="${c.id}">
        <span>${esc(c.name)}</span>
        <span class="meta">${fmtInt(c.rows)} rows</span>
        ${c.id === activeId ? '' : `<span class="del" data-del="${c.id}" title="delete">✕</span>`}
      </div>`).join('')
    : '<p class="muted" style="padding:8px 10px;margin:0">No clients yet. Create one below.</p>';
  list.querySelectorAll('.client-item[data-id]').forEach((b) => b.addEventListener('click', async (e) => {
    if (e.target.closest('[data-del]')) return;
    await fetch(`/api/wd/clients/${b.dataset.id}/activate`, { method: 'POST' });
    $('#wdClientMenu')?.classList.add('hidden');
    await switchWdClient();
  }));
  list.querySelectorAll('[data-del]').forEach((d) => d.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this WD client and all its data? This cannot be undone.')) return;
    await fetch(`/api/wd/clients/${d.dataset.del}`, { method: 'DELETE' });
    await loadWdClients(q);
  }));
}

async function switchWdClient() {
  await loadWdClients();
  await loadWdSettings();
  if ($('#wd-view-datasets').classList.contains('is-active')) await loadWdDatasets();
  if ($('#wd-view-report').classList.contains('is-active')) await loadWdReport();
}

async function loadWdDatasets() {
  const container = $('#wd-view-datasets .card') || $('#wd-view-datasets');
  if (!container) return;
  container.innerHTML = '<h2>Datasets</h2><p class="muted">Loading…</p>';
  const { tree } = await (await fetch('/api/wd/datasets/tree')).json();
  if (!tree || !tree.length) {
    container.innerHTML = '<h2>Datasets</h2><p class="muted" style="padding:24px 0;text-align:center">No clients or datasets yet. Create a client in <strong>Setup</strong> and upload data.</p>';
    return;
  }

  const html = tree.map((client) => {
    if (!client.datasets.length) {
      return `<div class="wd-folder">
        <div class="wd-folder-head" data-toggle-folder>
          <span class="wd-folder-arrow">▶</span>
          <span class="wd-folder-icon">📁</span>
          <span class="wd-folder-name">${esc(client.clientName)}</span>
          <span class="muted" style="margin-left:8px;font-size:12px">(no datasets)</span>
        </div>
      </div>`;
    }
    const dsHtml = client.datasets.map((ds) => {
      const sheetsHtml = ds.sheets.map((sh) =>
        `<div class="wd-file" data-view-file data-ds-id="${ds.id}" data-sheet="${esc(sh.name)}">
          <span class="wd-file-icon">📄</span>
          <span class="wd-file-name">${esc(sh.name)}</span>
          <span class="wd-file-rows">${fmtInt(sh.rowCount)} rows</span>
        </div>`
      ).join('');
      return `<div class="wd-dataset">
        <div class="wd-dataset-head" data-toggle-dataset>
          <span class="wd-folder-arrow">▶</span>
          <span class="wd-folder-icon">📦</span>
          <span class="wd-dataset-name">${esc(ds.name)}</span>
          <span class="muted" style="margin-left:8px;font-size:12px">${fmtInt(ds.rowCount)} rows · ${new Date(ds.uploadedAt).toLocaleDateString()}</span>
          ${ds.isActive ? '<span class="wd-active-badge">active</span>' : `<button class="btn ghost sm" data-wd-activate="${ds.id}" style="margin-left:8px">use</button>`}
          <button class="btn ghost sm" data-wd-del="${ds.id}" style="margin-left:4px">delete</button>
        </div>
        <div class="wd-dataset-files" style="display:none">${sheetsHtml}</div>
      </div>`;
    }).join('');
    return `<div class="wd-folder">
      <div class="wd-folder-head" data-toggle-folder>
        <span class="wd-folder-arrow">▶</span>
        <span class="wd-folder-icon">📁</span>
        <span class="wd-folder-name">${esc(client.clientName)}</span>
        <span class="muted" style="margin-left:8px;font-size:12px">${client.datasets.length} dataset${client.datasets.length > 1 ? 's' : ''}</span>
      </div>
      <div class="wd-folder-body" style="display:none">${dsHtml}</div>
    </div>`;
  }).join('');

  container.innerHTML = `<h2>Datasets</h2>${html}<div id="wdFileViewer" style="margin-top:20px"></div>`;

  container.querySelectorAll('[data-toggle-folder]').forEach((h) => h.addEventListener('click', () => {
    const folder = h.closest('.wd-folder');
    const body = folder.querySelector('.wd-folder-body');
    const arrow = h.querySelector('.wd-folder-arrow');
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    arrow.textContent = open ? '▶' : '▼';
  }));

  container.querySelectorAll('[data-toggle-dataset]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('[data-wd-activate]') || e.target.closest('[data-wd-del]')) return;
    const ds = h.closest('.wd-dataset');
    const files = ds.querySelector('.wd-dataset-files');
    const arrow = h.querySelector('.wd-folder-arrow');
    if (!files) return;
    const open = files.style.display !== 'none';
    files.style.display = open ? 'none' : 'block';
    arrow.textContent = open ? '▶' : '▼';
  }));

  container.querySelectorAll('[data-view-file]').forEach((f) => f.addEventListener('click', () => {
    const dsId = f.dataset.dsId;
    const sheet = f.dataset.sheet;
    container.querySelectorAll('[data-view-file]').forEach((x) => x.classList.remove('is-active'));
    f.classList.add('is-active');
    viewWdFile(dsId, sheet);
  }));

  container.querySelectorAll('[data-wd-activate]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch(`/api/wd/datasets/${b.dataset.wdActivate}/activate`, { method: 'POST' });
    loadWdDatasets();
    loadWdReport();
  }));

  container.querySelectorAll('[data-wd-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this dataset and all its rows?')) return;
    await fetch(`/api/wd/datasets/${b.dataset.wdDel}`, { method: 'DELETE' });
    loadWdDatasets();
    loadWdReport();
  }));
}

async function viewWdFile(dsId, sheet) {
  const viewer = $('#wdFileViewer');
  if (!viewer) return;
  viewer.innerHTML = '<p class="muted">Loading…</p>';
  const url = `/api/wd/datasets/${dsId}/view?sheet=${encodeURIComponent(sheet)}`;
  const { columns, rows } = await (await fetch(url)).json();
  if (!rows.length) {
    viewer.innerHTML = `<div class="card"><h3>${esc(sheet)}</h3><p class="muted">No rows.</p></div>`;
    return;
  }
  const numericCols = new Set(columns.filter((col) =>
    rows.every((r) => { const v = r[col]; return v === '' || v === null || v === undefined || !isNaN(Number(v)); }) &&
    rows.some((r) => r[col] !== '' && r[col] !== null && r[col] !== undefined && !isNaN(Number(r[col])))
  ));
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((r) =>
    `<tr>${columns.map((c) => {
      const v = r[c] ?? '';
      return `<td>${numericCols.has(c) ? fmtInt(v) : esc(String(v))}</td>`;
    }).join('')}</tr>`
  ).join('');
  viewer.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px">
      <h3 style="margin:0">${esc(sheet)}</h3>
      <span class="muted" style="font-size:13px">${fmtInt(rows.length)} rows</span>
    </div>
    <div class="tblwrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

async function loadWdSettings() {
  const res = await fetch('/api/wd/settings').catch(() => null);
  const json = res ? await res.json().catch(() => ({})) : {};
  const settings = json.settings || {};
  const sel = $('#wdCrmType');
  if (sel) sel.value = settings.crm_type || '';
  const tid = $('#wdTrackingId');
  if (tid) tid.value = settings.tracking_id || '';
  renderWdSettingsForm(settings);
  renderWdUploadSection(settings.crm_type || '');
}

async function saveWdSettings() {
  const s = $('#wdSettingsStatus');
  s.textContent = 'Saving…'; s.className = 'status';
  const settings = collectWdSettings();
  const res = await fetch('/api/wd/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (res.ok) {
    s.textContent = '✓ Saved'; s.className = 'status ok';
    setTimeout(() => { s.textContent = ''; s.className = 'status'; }, 2500);
  } else {
    const err = await res.json().catch(() => ({}));
    s.textContent = err.error || 'Save failed'; s.className = 'status err';
  }
}

// ---- Weekly Dump Report ---------------------------------------------------

async function loadWdReportClients() {
  const bar = $('#wdReportClientBar');
  if (!bar) return;
  const data = await fetch('/api/wd/clients').then((r) => r.json()).catch(() => ({ clients: [], active: null }));
  if (!data.clients || data.clients.length < 2) { bar.innerHTML = ''; return; }
  const activeId = data.active?.id;
  bar.innerHTML = `<div class="card" style="padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-size:13px;font-weight:600;flex:0 0 auto;color:var(--muted)">Client:</span>
    <div class="seg">${data.clients.map((c) =>
      `<button class="seg-btn${c.id === activeId ? ' is-active' : ''}" data-wd-report-client="${c.id}">${esc(c.name)}</button>`
    ).join('')}</div>
  </div>`;
  bar.querySelectorAll('[data-wd-report-client]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.wdReportClient);
      if (id === activeId) return;
      await fetch(`/api/wd/clients/${id}/activate`, { method: 'POST' });
      await switchWdClient();
    });
  });
}

function copyWdTable() {
  const table = $('#wd-report-body table');
  if (!table) { showToast('No table to copy', 'warn'); return; }
  const rows = [];
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    rows.push(cells.join('\t'));
  });
  if (!rows.length) { showToast('No data to copy', 'warn'); return; }
  navigator.clipboard.writeText(rows.join('\n'))
    .then(() => showToast('✓ Table copied to clipboard', 'ok'))
    .catch(() => showToast('Copy failed', 'err'));
}

async function loadWdReport() {
  const container = $('#wd-report-body');
  if (!container) return;
  loadWdReportClients();
  container.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';

  const data = await fetch('/api/wd/report').then((r) => r.json()).catch(() => ({ empty: true, reason: 'error' }));

  if (data.empty) {
    const msg = data.reason === 'no_client'
      ? 'Create a client in <strong>Setup</strong> to get started.'
      : 'Upload data in <strong>Setup</strong> to build the report.';
    container.innerHTML = `<div class="card"><p class="muted" style="padding:8px 0">${msg}</p></div>`;
    return;
  }

  if (data.report) {
    renderNpfReport(container, data);
    return;
  }

  const { sheets, dataset } = data;
  if (!sheets || !sheets.length) {
    container.innerHTML = '<div class="card"><p class="muted">No data in this dataset.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="card">
      <div class="report-toolbar" style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)">
        <div>
          <h2 style="margin:0">Weekly Dump Report</h2>
          <span class="muted" style="font-size:13px">${esc(dataset.name || '')} · ${new Date(dataset.uploaded_at).toLocaleDateString()}</span>
        </div>
        <button class="btn" id="wdCopyBtn" type="button">📋 Copy table</button>
      </div>
      <div class="map-bar" style="margin-bottom:16px">
        <div class="seg" id="wdReportSheetTabs">
          ${sheets.map((s, i) => `<button class="seg-btn${i === 0 ? ' is-active' : ''}" data-sheet-idx="${i}">${esc(s.name)}</button>`).join('')}
        </div>
      </div>
      <div id="wdReportSheetContent"></div>
    </div>`;

  renderWdSheet(sheets[0]);

  $$('#wdReportSheetTabs .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#wdReportSheetTabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderWdSheet(sheets[Number(btn.dataset.sheetIdx)]);
    });
  });

  $('#wdCopyBtn')?.addEventListener('click', copyWdTable);
}

function renderWdKpis(totals) {
  const kpis = [
    { label: 'Primary Leads', value: fmtInt(totals.primary_leads || 0), cls: 'primary' },
    { label: 'Secondary', value: fmtInt(totals.secondary_leads || 0), cls: 'secondary' },
    { label: 'Tertiary', value: fmtInt(totals.tertiary_leads || 0), cls: '' },
    { label: 'Form Initiated', value: fmtInt(totals.form_initiated || 0), cls: '' },
    { label: 'Applications', value: fmtInt(totals.payment_approved || 0), cls: '' },
    { label: 'Enrolments', value: fmtInt(totals.enrolments || 0), cls: 'good' },
  ];
  return `<div class="wd-kpi-grid">${kpis.map((k) => `<div class="wd-kpi ${k.cls}"><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`).join('')}</div>`;
}

function renderNpfReport(container, data) {
  const { report, dataset } = data;
  const { rows, totals } = report;

  if (!rows.length) {
    container.innerHTML = '<div class="card"><p class="muted" style="padding:8px 0">No data. Upload category files in <strong>Setup</strong>.</p></div>';
    return;
  }

  const numCols = [
    ['primary_leads', 'Primary Leads'],
    ['secondary_leads', 'Secondary Leads'],
    ['tertiary_leads', 'Tertiary Leads'],
    ['total_instances', 'Total Instances'],
    ['verified_leads', 'Verified Leads'],
    ['unverified_leads', 'Unverified Leads'],
    ['form_initiated', 'Form Initiated'],
    ['payment_approved', 'Payment Approved'],
    ['enrolments', 'Enrolments'],
    ['duplicate_leads', 'Duplicate Leads'],
    ['duplicate_fi', 'Duplicate Form Initiated'],
    ['duplicate_app', 'Duplicate Application'],
    ['duplicate_adm', 'Duplicate Admission'],
  ];

  const totalCells = numCols.map(([k]) => `<td>${fmtInt(totals[k])}</td>`).join('');
  const headerCells = numCols.map(([, h]) => `<th>${h}</th>`).join('');

  const dataRows = rows.map((r) => `<tr>
    <td class="txt">${esc(r.tracking_id)}</td>
    <td class="txt">${esc(r.crm)}</td>
    <td class="txt">${esc(r.client_name)}</td>
    <td class="txt">${esc(r.source)}</td>
    <td class="txt">${esc(r.medium)}</td>
    <td class="txt">${esc(r.campaign_name)}</td>
    ${numCols.map(([k]) => `<td>${fmtInt(r[k])}</td>`).join('')}
  </tr>`).join('');

  container.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <h2 style="margin:0">Weekly Dump Report</h2>
          <span class="muted" style="font-size:13px">${esc(dataset.name || '')} · ${new Date(dataset.uploaded_at).toLocaleDateString()}</span>
        </div>
        <button class="btn" id="wdNpfCopyBtn" type="button">📋 Copy table</button>
      </div>
      <div style="padding:16px 20px 4px">${renderWdKpis(totals)}</div>
      <div class="tblwrap">
        <table class="grid wd-npf-tbl">
          <thead>
            <tr class="wd-dump-row">
              <td colspan="5"></td><td style="font-weight:700">Dump</td>${totalCells}
            </tr>
            <tr class="wd-total-row">
              <td colspan="5"></td><td style="font-weight:700">Total</td>${totalCells}
            </tr>
            <tr class="wd-col-row">
              <th>Tracking ID</th><th>CRM</th><th>Client Name</th><th>Source</th><th>Medium</th><th>Campaign Name</th>${headerCells}
            </tr>
          </thead>
          <tbody>${dataRows}</tbody>
        </table>
      </div>
    </div>`;
  $('#wdNpfCopyBtn')?.addEventListener('click', copyWdTable);
}

function renderWdSheet(sheet) {
  const el = $('#wdReportSheetContent');
  if (!el) return;
  const { columns, rows } = sheet;
  if (!rows || !rows.length) {
    el.innerHTML = '<p class="muted" style="padding:12px 0">No rows in this sheet.</p>';
    return;
  }

  // Detect numeric columns (all non-empty values parse as numbers)
  const numericCols = new Set(columns.filter((col) =>
    rows.every((r) => { const v = r[col]; return v === '' || v === null || v === undefined || !isNaN(Number(v)); }) &&
    rows.some((r) => r[col] !== '' && r[col] !== null && r[col] !== undefined && !isNaN(Number(r[col])))
  ));

  // Totals for numeric columns
  const totals = {};
  for (const col of columns) {
    if (numericCols.has(col)) totals[col] = rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
  }

  const head = `<thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((r) =>
    `<tr>${columns.map((c) => {
      const v = r[c] ?? '';
      return `<td>${numericCols.has(c) ? fmtInt(v) : esc(String(v))}</td>`;
    }).join('')}</tr>`
  ).join('');
  const totalRow = `<tr class="total">${columns.map((c, i) =>
    numericCols.has(c) ? `<td>${fmtInt(totals[c])}</td>` : `<td>${i === 0 ? 'TOTAL' : ''}</td>`
  ).join('')}</tr>`;

  el.innerHTML = `<div class="tblwrap"><table class="grid">${head}<tbody>${body}${totalRow}</tbody></table></div>`;
}

function loadWeeklyDump() {
  loadWdClients();
  loadWdReport();
}

function loadWdSetup() {
  loadWdSettings();
}

function renderWdUploadSection(crm) {
  const body = $('#wdUploadBody');
  if (!body) return;
  if (!crm) {
    body.innerHTML = '<p class="muted">Select a CRM above to see upload options.</p>';
    return;
  }
  if (crm === 'NPF') {
    body.innerHTML = `
      <p class="muted" style="margin-bottom:12px">NPF requires 4 separate uploads — one for each category.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${['Leads', 'Form Initiated', 'Application', 'Admission'].map((label, i) => {
          const cat = ['leads', 'fi', 'apps', 'adm'][i];
          return `<div style="background:var(--bg-2);border:1px solid var(--line);border-radius:10px;padding:14px">
            <h3 style="margin-bottom:8px">${label}</h3>
            <form class="wd-cat-form" data-category="${cat}">
              <input type="file" accept=".csv,.tsv,.xlsx,.xls" required style="margin-bottom:8px;display:block;font-size:13px" />
              <div style="display:flex;align-items:center;gap:8px">
                <button class="btn primary sm" type="submit">Upload</button>
                <span class="status"></span>
              </div>
            </form>
          </div>`;
        }).join('')}
      </div>`;
    bindNpfUploadHandlers();
  } else {
    body.innerHTML = `
      <p class="muted" style="margin-bottom:12px">Upload a single dump file (CSV or XLSX). XLSX files with multiple sheets are imported automatically.</p>
      <form id="wdUploadForm">
        <label class="field">
          <span>File</span>
          <input type="file" id="wdFileInput" accept=".csv,.tsv,.xlsx,.xls" required />
        </label>
        <label class="field">
          <span>Name (optional)</span>
          <input type="text" id="wdUploadName" placeholder="e.g. Week 30" />
        </label>
        <button type="submit" class="btn primary" id="wdUploadBtn">Upload</button>
        <span id="wdUploadStatus" class="status"></span>
      </form>
      <div style="margin-top:1.5rem;border-top:1px solid var(--line);padding-top:1.5rem">
        <h3 style="margin-bottom:8px">Merge multiple files</h3>
        <p class="muted" style="margin-bottom:12px">Select 2+ CSV/XLSX files — all rows are combined into one dataset (columns are unioned).</p>
        <form id="wdMergeForm">
          <label class="field">
            <span>Files</span>
            <input type="file" id="wdMergeFiles" multiple accept=".csv,.tsv,.xlsx,.xls" required />
          </label>
          <div class="row" style="gap:8px;align-items:center">
            <input type="text" id="wdMergeName" class="inp" placeholder="Name (optional)" style="flex:1;min-width:140px" />
            <button class="btn primary" type="submit" id="wdMergeBtn">Merge &amp; upload</button>
            <span id="wdMergeStatus" class="status"></span>
          </div>
        </form>
      </div>`;
    bindSingleUploadHandler();
    bindWdMergeHandler();
  }
}

function bindNpfUploadHandlers() {
  $$('.wd-cat-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cat = form.dataset.category;
      const file = form.querySelector('input[type="file"]').files[0];
      const s = form.querySelector('.status');
      if (!file) { s.textContent = 'Choose a file'; s.className = 'status err'; return; }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      s.textContent = 'Uploading…'; s.className = 'status';
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('category', cat);
        const res = await fetch('/api/wd/upload/category', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        s.textContent = `✓ ${fmtInt(data.rowCount)} rows`; s.className = 'status ok';
        form.reset();
      } catch (err) {
        s.textContent = err.message; s.className = 'status err';
      } finally { btn.disabled = false; }
    });
  });
}

function bindSingleUploadHandler() {
  const form = $('#wdUploadForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = $('#wdUploadStatus');
    const btn = $('#wdUploadBtn');
    const file = $('#wdFileInput').files[0];
    const name = $('#wdUploadName').value;
    if (!file) { s.textContent = 'Choose a file'; s.className = 'status err'; return; }
    btn.disabled = true;
    try {
      const isCsv = /\.(csv|tsv|txt)$/i.test(file.name);
      if (isCsv) {
        const n = await wdChunkedUpload(file, name);
        s.textContent = `✓ Imported ${fmtInt(n)} rows`; s.className = 'status ok';
      } else {
        s.textContent = 'Uploading…'; s.className = 'status';
        const fd = new FormData();
        fd.append('file', file);
        if (name) fd.append('name', name);
        const res = await fetch('/api/wd/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        s.textContent = `✓ Imported ${fmtInt(data.rowCount)} rows${data.sheetCount > 1 ? ` (${data.sheetCount} sheets)` : ''}`; s.className = 'status ok';
      }
      form.reset();
    } catch (err) {
      s.textContent = err.message; s.className = 'status err';
    } finally { btn.disabled = false; }
  });
}

// Parses all CSV files client-side, unions headers, uploads via WD chunked API.
async function wdChunkedCsvMerge(files, name, statusEl) {
  const fileArr = [...files];
  const allHeaders = new Set();
  const parsed = [];
  for (const f of fileArr) {
    statusEl.textContent = `Reading ${f.name}…`; statusEl.className = 'status';
    const matrix = parseCSV(await f.text());
    const hIdx = detectHeaderRow(matrix);
    const headers = (matrix[hIdx] || []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    headers.forEach((h) => allHeaders.add(h));
    const rows = [];
    for (let r = hIdx + 1; r < matrix.length; r++) {
      const line = matrix[r] || [];
      if (line.every((c) => String(c ?? '').trim() === '')) continue;
      const obj = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c]] = line[c] ?? '';
      rows.push(obj);
    }
    parsed.push(rows);
  }
  const mergedHeaders = [...allHeaders];
  const mergedRows = parsed.flatMap((rows) => rows.map((row) => {
    const out = {};
    for (const h of mergedHeaders) out[h] = row[h] ?? '';
    return out;
  }));
  if (!mergedRows.length) throw new Error('No data rows found in any file');

  const dsName = name || `Merged (${fileArr.length} files)`;
  const started = await (await fetch('/api/wd/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: dsName, filename: dsName, headers: mergedHeaders }),
  })).json();
  if (!started.datasetId) throw new Error(started.error || 'Could not start upload');

  const CHUNK = 5000;
  let sent = 0;
  const chunks = [];
  for (let i = 0; i < mergedRows.length; i += CHUNK) chunks.push(mergedRows.slice(i, i + CHUNK));
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    await Promise.all(batch.map(async (chunk) => {
      const res = await fetch('/api/wd/upload/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId: started.datasetId, rows: chunk }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Batch upload failed');
      sent += chunk.length;
      statusEl.textContent = `Uploading ${fmtInt(Math.min(sent, mergedRows.length))} / ${fmtInt(mergedRows.length)} rows…`;
    }));
  }
  await fetch('/api/wd/upload/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId: started.datasetId }),
  });
  return { rowCount: sent, fileCount: fileArr.length };
}

function bindWdMergeHandler() {
  const form = $('#wdMergeForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = $('#wdMergeStatus');
    const btn = $('#wdMergeBtn');
    const files = $('#wdMergeFiles').files;
    const name = $('#wdMergeName').value;
    if (!files.length) { s.textContent = 'Choose files'; s.className = 'status err'; return; }
    const allCsv = [...files].every((f) => /\.(csv|tsv|txt)$/i.test(f.name));
    btn.disabled = true;
    s.textContent = 'Reading files…'; s.className = 'status';
    try {
      let data;
      if (allCsv) {
        data = await wdChunkedCsvMerge(files, name, s);
      } else {
        const fd = new FormData();
        for (const f of files) fd.append('files', f);
        if (name) fd.append('name', name);
        const res = await fetch('/api/wd/upload/merge', { method: 'POST', body: fd });
        const text = await res.text();
        try { data = JSON.parse(text); } catch {
          throw new Error(res.status === 413 || text.includes('Entity Too Large')
            ? 'Files too large — Vercel limits XLSX uploads to 4.5 MB total.'
            : `Server error (${res.status})`);
        }
        if (!res.ok) throw new Error(data.error || 'Merge failed');
      }
      s.textContent = `✓ Merged ${data.fileCount} files → ${fmtInt(data.rowCount)} rows`;
      s.className = 'status ok';
      form.reset();
    } catch (err) {
      s.textContent = err.message; s.className = 'status err';
    } finally { btn.disabled = false; }
  });
}

async function wdChunkedUpload(file, name) {
  const status = $('#wdUploadStatus');
  status.textContent = 'Reading file…'; status.className = 'status';
  const matrix = parseCSV(await file.text());
  const hIdx = detectHeaderRow(matrix);
  const headers = (matrix[hIdx] || []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  const rows = [];
  for (let r = hIdx + 1; r < matrix.length; r++) {
    const line = matrix[r] || [];
    if (line.every((c) => String(c ?? '').trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = line[c] ?? '';
    rows.push(obj);
  }
  if (!rows.length) throw new Error('No data rows found in file');

  const started = await (await fetch('/api/wd/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || file.name, filename: file.name, headers }),
  })).json();
  const datasetId = started.datasetId;
  if (!datasetId) throw new Error(started.error || 'Could not start upload');

  const CHUNK = 5000;
  const PARALLEL = 5;
  let sent = 0;
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const batch = chunks.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async (chunk) => {
      const res = await fetch('/api/wd/upload/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, rows: chunk }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Batch upload failed');
      sent += chunk.length;
      status.textContent = `Uploading ${fmtInt(Math.min(sent, rows.length))} / ${fmtInt(rows.length)} rows…`;
    }));
  }
  await fetch('/api/wd/upload/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId }),
  });
  return sent;
}

$('#wdNewClientBtn')?.addEventListener('click', async () => {
  const name = $('#wdNewClientName').value.trim();
  if (!name) return;
  const res = await fetch('/api/wd/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    $('#wdNewClientName').value = '';
    $('#wdClientMenu')?.classList.add('hidden');
    await switchWdClient();
    showToast('✓ Client created', 'ok');
  } else {
    const err = await res.json().catch(() => ({}));
    const s = $('#wdClientStatus');
    if (s) { s.textContent = err.error || 'Failed to create'; s.className = 'status err'; }
    else showToast(err.error || 'Failed to create client', 'err');
  }
});

$('#wdComputeBtn')?.addEventListener('click', () => {
  $$('.tab[data-wd-view]').forEach((b) => b.classList.remove('is-active'));
  $$('.wd-view').forEach((v) => v.classList.remove('is-active'));
  $('.tab[data-wd-view="report"]')?.classList.add('is-active');
  $('#wd-view-report')?.classList.add('is-active');
  loadWdReport();
});

$('#wdCrmType')?.addEventListener('change', () => {
  const crm = $('#wdCrmType').value;
  const preset = WD_PRESETS[crm];
  if (preset) renderWdSettingsForm(preset);
  else renderWdSettingsForm({ crm_type: crm });
  renderWdUploadSection(crm);
});

$('#wdSaveSettings')?.addEventListener('click', saveWdSettings);

// ---- Boot -----------------------------------------------------------------
updateMapPlaceholders();
loadClients();
loadReport();
loadDatasets();
