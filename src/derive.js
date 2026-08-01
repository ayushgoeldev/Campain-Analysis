// Per-lead derivation — the app equivalent of the sheet's "Rank" tab.
// Pure functions so they can be unit-tested and reused by import + recompute.

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (v) => s(v).toLowerCase();

export function toMonth(value, order = 'MDY') {
  const str = s(value);
  if (!str) return null;

  let m = str.match(/^(\d{4})[-/](\d{1,2})[-/]\d{1,2}/);
  if (m) return `${m[1]}-${String(Math.min(12, Number(m[2]))).padStart(2, '0')}`;

  m = str.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/);
  if (m) { const mm = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mm) return `${m[3]}-${mm}`; }
  m = str.match(/^([A-Za-z]{3,})[-\s,]+(?:\d{1,2}[-\s,]+)?(\d{4})/);
  if (m) { const mm = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mm) return `${m[2]}-${mm}`; }

  m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    const p1 = Number(m[1]), p2 = Number(m[2]), year = m[3];
    let month = order === 'DMY' ? p2 : p1;
    const otherIsMonth = order === 'DMY' ? p1 : p2;
    if (month > 12 && otherIsMonth <= 12) month = otherIsMonth;
    if (month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}`;
  }
  return null;
}

export function detectDateOrder(values) {
  let firstGt12 = 0, secondGt12 = 0, ymd = 0;
  for (const v of values) {
    const str = s(v);
    if (!str) continue;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(str)) { ymd++; continue; }
    const m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) firstGt12++;
    if (Number(m[2]) > 12) secondGt12++;
  }
  if (ymd > 0 && firstGt12 === 0 && secondGt12 === 0) return 'YMD';
  if (firstGt12 > secondGt12) return 'DMY';
  if (secondGt12 > firstGt12) return 'MDY';
  return null;
}

export function resolveDateOrder(settings, sampleValues = []) {
  const fmt = String(settings?.date_format || 'auto').toLowerCase();
  if (fmt === 'mdy') return 'MDY';
  if (fmt === 'dmy') return 'DMY';
  if (fmt === 'ymd') return 'YMD';
  return detectDateOrder(sampleValues) || 'MDY';
}

export function nthToken(value, delim, n) {
  const parts = s(value).split(delim || '/');
  const idx = (Number(n) || 1) - 1;
  return s(parts[idx] ?? '');
}

function flagInSet(value, allowedLowerSet) {
  const v = norm(value);
  if (!v) return 0;
  if (!allowedLowerSet || allowedLowerSet.size === 0) return 1;
  return allowedLowerSet.has(v) ? 1 : 0;
}

export function buildContext(settings, courseRows, leadCodeRows, dateOrder = 'MDY') {
  const courseMap = new Map();
  for (const r of courseRows) courseMap.set(norm(r.course), r.kapp);
  const leadCodeMap = new Map();
  for (const r of leadCodeRows) leadCodeMap.set(norm(r.medium), r.code);

  return {
    settings,
    courseMap,
    leadCodeMap,
    dateOrder,
    appSet: new Set((settings.application_values || []).map(norm).filter(Boolean)),
    admSet: new Set((settings.admission_values || []).map(norm).filter(Boolean)),
    fiSet: new Set((settings.form_initiated_values || []).map(norm).filter(Boolean)),
    dupSet: new Set((settings.duplicate_instance_values || []).map(norm).filter(Boolean)),
  };
}

export function deriveRow(row, ctx) {
  const cfg = ctx.settings;
  const get = (col) => row[col];

  const rawToken = nthToken(get(cfg.lead_source_column), cfg.lead_code_delimiter, cfg.lead_code_token);
  const leadCode = ctx.leadCodeMap.get(norm(rawToken)) || rawToken || null;

  const rawCourse = s(get(cfg.course_column));
  const kappCourse = ctx.courseMap.get(norm(rawCourse)) || rawCourse || null;

  const instVal = s(get(cfg.instance_column));
  const filter = s(cfg.instance_filter);
  let prim = 0;
  if (instVal) prim = !filter ? 1 : (norm(instVal) === norm(filter) ? 1 : 0);

  return {
    record_key: s(get(cfg.record_key_column)) || null,
    lead_code: leadCode,
    kapp_course: kappCourse,
    city: s(get(cfg.city_column)) || null,
    origin: s(get(cfg.lead_origin_column)) || null,
    month: toMonth(get(cfg.date_column), ctx.dateOrder),
    lead_stage: s(get(cfg.lead_stage_column || cfg.admission_column)) || null,
    fi_flag: flagInSet(get(cfg.form_initiated_column), ctx.fiSet),
    app_flag: flagInSet(get(cfg.application_column), ctx.appSet),
    adm_flag: flagInSet(get(cfg.admission_column), ctx.admSet),
    prim_flag: prim,
    dup_flag: ctx.dupSet.size > 0 ? flagInSet(get(cfg.instance_column), ctx.dupSet) : 0,
  };
}