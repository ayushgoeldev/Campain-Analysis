// Lead Report dashboard — vanilla JS SPA talking to /api.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');
// Show 2 decimals for sub-1% values so small funnel rates aren't shown as 0.0%.
const fmtPct = (x) => {
  const v = Number(x || 0) * 100;
  return `${v > 0 && v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
};

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
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.remove('is-active'));
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  btn.classList.add('is-active');
  $(`#view-${btn.dataset.view}`).classList.add('is-active');
  if (btn.dataset.view === 'data') loadDatasets();
  if (btn.dataset.view === 'settings') loadSettings();
  if (btn.dataset.view === 'mappings') loadMap();
  if (btn.dataset.view === 'duplicates') loadDup();
}));

// ---- Report ---------------------------------------------------------------
let annos = {};
const annoOf = (scope, key) => (annos[scope] && annos[scope][key]) || { insights: '', challenges: '' };

async function loadReport() {
  annos = await (await fetch('/api/annotations')).json().catch(() => ({}));
  const data = await (await fetch('/api/report')).json();
  const empty = data.empty;
  $('#reportEmpty').classList.toggle('hidden', !empty);
  $('#reportBody').classList.toggle('hidden', !!empty);
  if (empty) { $('#reportBody').innerHTML = ''; $('#reportSub').textContent = ''; return; }
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

// Short headers (no "Primary" prefix — the Dup columns carry the distinction),
// funnel ratios (Lead→FI, FI→App, App→Adm), duplicate counts.
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

// Summary as a funnel (image-4 style). Total Leads = primary + duplicate with
// each side's share; FI converts from Leads, App from FI, Adm from App.
function summaryHtml(s) {
  const c = s.conversions, d = s.conversions_dup, dup = s.duplicates;
  const totLeads = s.leads + dup.leads;
  const share = (x) => (totLeads ? fmtPct(x / totLeads) : '—');
  const rows = [
    ['Total Leads', fmtInt(totLeads), `${fmtInt(s.leads)} · ${share(s.leads)}`, `${fmtInt(dup.leads)} · ${share(dup.leads)}`, '', ''],
    ['Form Initiated', '', fmtInt(s.fi), fmtInt(dup.fi), fmtPct(c.lead_to_fi), fmtPct(d.lead_to_fi)],
    ['Applications', '', fmtInt(s.apps), fmtInt(dup.apps), fmtPct(c.fi_to_app), fmtPct(d.fi_to_app)],
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

function renderReport(d) {
  $('#reportBody').innerHTML = [
    drawer('Summary', summaryHtml(d.summary)),
    drawer('Top Lead Codes', rankTableHtml('Lead Code', d.top_lead_codes, 'lead_codes')),
    drawer('Top Courses', rankTableHtml('Course', d.top_courses, 'courses')),
    drawer('Top Cities', rankTableHtml('City', d.top_cities, 'cities')),
    drawer('Lead Origin (overall)', rankTableHtml('Lead Origin', d.origin, 'origin')),
    drawer('Lead Origin × Month', originMonthTableHtml(d.origin_month, 'origin_month')),
    drawer('Top Performing Medium by Month', monthTableHtml('Medium', d.top_medium_by_month, 'medium_month')),
    drawer('Top Performing Course by Month', monthTableHtml('Course', d.top_course_by_month, 'course_month')),
    drawer('Lead Stages', stagesHtml(d.lead_stages), false),
  ].join('');
}

// Drawer open/close (delegated, covers report tables + SETUP preview).
document.addEventListener('click', (e) => {
  const t = e.target.closest('.drawer-toggle');
  if (!t) return;
  const card = t.closest('.card');
  const collapsed = card.classList.toggle('collapsed');
  t.setAttribute('aria-expanded', String(!collapsed));
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

$('#downloadPdf')?.addEventListener('click', () => {
  // Print as-is: collapsed drawers are excluded from the PDF (see print CSS).
  window.print();
});
$('#downloadXlsx')?.addEventListener('click', () => { window.location.href = '/api/report.xlsx'; });
$('#expandAll')?.addEventListener('click', () => $$('#reportBody .card').forEach((c) => c.classList.remove('collapsed')));
$('#collapseAll')?.addEventListener('click', () => $$('#reportBody .card').forEach((c) => c.classList.add('collapsed')));

// ---- Datasets -------------------------------------------------------------
async function loadDatasets() {
  const { datasets } = await (await fetch('/api/datasets')).json();
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

// Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF).
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

// Find the header row even when a CRM export prepends banner rows.
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

// Large CSVs: parse in the browser and POST rows in small batches so we never
// hit the serverless per-request body limit. Works from any browser.
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

  const CHUNK = 1500; let sent = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const res = await fetch('/api/upload/rows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId, rows: batch }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed at row ${sent}`);
    sent += batch.length;
    status.textContent = `Uploading ${fmtInt(sent)} / ${fmtInt(rows.length)} rows…`;
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
      // Browser-side chunked upload — no size limit, works on any laptop.
      const n = await chunkedCsvUpload(file, name, headerRow);
      status.textContent = `✓ Imported ${fmtInt(n)} rows`; status.className = 'status ok';
    } else {
      // XLSX/other: single multipart request (fine for smaller files).
      status.textContent = 'Uploading & importing…'; status.className = 'status';
      const res = await fetch('/api/upload', { method: 'POST', body: new FormData(e.target) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      status.textContent = `✓ Imported ${fmtInt(data.rowCount)} rows (${data.columns} cols)`; status.className = 'status ok';
    }
    e.target.reset();
    loadDatasets(); loadReport();
  } catch (err) {
    status.textContent = err.message; status.className = 'status err';
  } finally { btn.disabled = false; }
});

// ---- Settings -------------------------------------------------------------
const FIELDS = [
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
  ['top_n', 'Top N rows per table', 'number'],
];
let defaultsCache = null;

async function loadSettings() {
  const { settings, defaults } = await (await fetch('/api/settings')).json();
  defaultsCache = defaults;
  renderSettings(settings);
  loadPreview();
}

async function loadPreview() {
  const data = await (await fetch('/api/preview?limit=8')).json();
  const chips = $('#previewChips');
  const table = $('#previewTable');
  if (data.empty || !data.columns) {
    chips.innerHTML = '<span class="muted">No dataset yet — upload one on the Data tab.</span>';
    table.innerHTML = '';
    return;
  }
  chips.innerHTML = data.columns.map((c) =>
    `<button type="button" class="chip" data-col="${String(c).replace(/"/g, '&quot;')}">${c}</button>`).join('');
  chips.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.col;
    navigator.clipboard?.writeText(name).catch(() => {});
    b.classList.add('copied'); const t = b.textContent; b.textContent = 'copied ✓';
    setTimeout(() => { b.classList.remove('copied'); b.textContent = t; }, 900);
  }));
  const head = `<thead><tr>${data.columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${data.rows.map((r) =>
    `<tr>${data.columns.map((c) => `<td title="${String(r[c] ?? '').replace(/"/g, '&quot;')}">${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
  table.innerHTML = head + body;
}

function renderSettings(s) {
  $('#settingsForm').innerHTML = FIELDS.map(([key, label, type, options]) => {
    if (type === 'select') {
      const current = String(s[key] ?? (options && options[0]) ?? '');
      const opts = (options || []).map((o) =>
        `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('');
      return `<label class="field"><span>${label}</span>
        <select data-key="${key}" data-type="select">${opts}</select></label>`;
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
  if (res.ok) { loadReport(); loadClients(); }   // refresh heading + client selector label
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

// Bulk: download sample, upload (add/update or replace), clear all.
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

// ---- Clients --------------------------------------------------------------
let clientSearchTimer = null;

async function loadClients(q = '') {
  const data = await (await fetch(`/api/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json();
  $('#clientName').textContent = (data.active && data.active.name) || '—';
  const list = $('#clientList');
  list.innerHTML = data.clients.length ? data.clients.map((c) => `<div class="client-item ${c.is_active ? 'active' : ''}" data-id="${c.id}">
      <span>${esc(c.name)}</span>
      <span class="meta">${fmtInt(c.rows)} rows · ${c.dup_files}/4 dup</span>
      ${c.is_active ? '' : `<span class="del" data-del="${c.id}" title="delete client">✕</span>`}
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
  if (!e.target.closest('.client-picker')) $('#clientMenu')?.classList.add('hidden');
});

// ---- Boot -----------------------------------------------------------------
updateMapPlaceholders();
loadClients();
loadReport();
loadDatasets();
