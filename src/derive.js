// Per-lead derivation — the app equivalent of the sheet's "Rank" tab.
// Pure functions so they can be unit-tested and reused by import + recompute.

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (v) => s(v).toLowerCase();

// Parse the many date shapes a CRM export throws at us into 'YYYY-MM'.
// Handles: 9-Jul-2026, 9-Jul-2026 12:10 PM, 2026-07-09, 07/09/2026, 9/7/2026.
// Parse a date into 'YYYY-MM'. `order` disambiguates purely-numeric dates whose
// two leading numbers could be day or month: 'MDY' (US, 07-24-2026 = 24 Jul),
// 'DMY' (24-07-2026 = 24 Jul), or 'YMD'. Month-name and ISO dates are
// unambiguous and parsed regardless of `order`. No reliance on `new Date`,
// which parses ambiguous strings inconsistently across platforms.
export function toMonth(value, order = 'MDY') {
  const str = s(value);
  if (!str) return null;

  // ISO: 2026-07-09 / 2026/07/09
  let m = str.match(/^(\d{4})[-/](\d{1,2})[-/]\d{1,2}/);
  if (m) return `${m[1]}-${String(Math.min(12, Number(m[2]))).padStart(2, '0')}`;

  // 9-Jul-2026 / 9 Jul 2026
  m = str.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/);
  if (m) { const mm = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mm) return `${m[3]}-${mm}`; }
  // Jul 9, 2026 / Jul-2026
  m = str.match(/^([A-Za-z]{3,})[-\s,]+(?:\d{1,2}[-\s,]+)?(\d{4})/);
  if (m) { const mm = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mm) return `${m[2]}-${mm}`; }

  // Numeric d/m/y or m/d/y with '-' or '/' separators, resolved by `order`.
  m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    const p1 = Number(m[1]), p2 = Number(m[2]), year = m[3];
    let month = order === 'DMY' ? p2 : p1;
    const otherIsMonth = order === 'DMY' ? p1 : p2;
    // If the chosen slot can't be a month but the other can, use the other.
    if (month > 12 && otherIsMonth <= 12) month = otherIsMonth;
    if (month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}`;
  }
  return null;
}

// Infer the day/month order of a column of numeric dates from the data itself:
// if any first number > 12 it must be the day (DMY); if any second number > 12
// it must be the day (MDY). Returns 'YMD' | 'DMY' | 'MDY', or null if ambiguous.
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
  return null; // ambiguous — caller falls back to the configured/default order
}

// Resolve the order to use from settings + sample values.
export function resolveDateOrder(settings, sampleValues = []) {
  const fmt = String(settings?.date_format || 'auto').toLowerCase();
  if (fmt === 'mdy') return 'MDY';
  if (fmt === 'dmy') return 'DMY';
  if (fmt === 'ymd') return 'YMD';
  return detectDateOrder(sampleValues) || 'MDY';
}

// Nth token (1-based) of `value` split on `delim`, trimmed.
export function nthToken(value, delim, n) {
  const parts = s(value).split(delim || '/');
  const idx = (Number(n) || 1) - 1;
  return s(parts[idx] ?? '');
}

// non-empty AND (allowed set empty ? matches-anything : value in set), case-insensitive.
function flagInSet(value, allowedLowerSet) {
  const v = norm(value);
  if (!v) return 0;
  if (!allowedLowerSet || allowedLowerSet.size === 0) return 1;
  return allowedLowerSet.has(v) ? 1 : 0;
}

// Build fast lookup structures once, reuse across every row.
// `dateOrder` (MDY/DMY/YMD) is resolved once per dataset and applied to every row.
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
  };
}

// Compute one lead's derived fields from its raw row object (header -> value).
export function deriveRow(row, ctx) {
  const cfg = ctx.settings;
  const get = (col) => row[col];

  // Lead code: parse the configured token, then normalize via the mapping.
  const rawToken = nthToken(get(cfg.lead_source_column), cfg.lead_code_delimiter, cfg.lead_code_token);
  const leadCode = ctx.leadCodeMap.get(norm(rawToken)) || rawToken || null;

  // Course: normalize via the mapping, fall back to the raw value.
  const rawCourse = s(get(cfg.course_column));
  const kappCourse = ctx.courseMap.get(norm(rawCourse)) || rawCourse || null;

  // Primary/instance flag.
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
    // Dedicated lead-stage column; falls back to the admission column if unset.
    lead_stage: s(get(cfg.lead_stage_column || cfg.admission_column)) || null,
    fi_flag: flagInSet(get(cfg.form_initiated_column), ctx.fiSet),
    app_flag: flagInSet(get(cfg.application_column), ctx.appSet),
    adm_flag: flagInSet(get(cfg.admission_column), ctx.admSet),
    prim_flag: prim,
  };
}
