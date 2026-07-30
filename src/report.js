import { query } from './db.js';
import { getSettings } from './settings.js';
import { duplicateTotals, duplicatesByMedium } from './duplicates.js';
import { activeClientId, activeClient } from './clients.js';

const norm = (v) => String(v ?? '').trim().toLowerCase();
const pct = (num, den) => (den ? num / den : 0);

// Resolve which dataset to report on within the active client (else its newest).
export async function resolveDataset(datasetId) {
  if (datasetId) return Number(datasetId);
  const cid = await activeClientId();
  let { rows } = await query(
    `SELECT id FROM datasets WHERE client_id = $1 AND is_active ORDER BY uploaded_at DESC LIMIT 1`, [cid]);
  if (rows.length) return rows[0].id;
  ({ rows } = await query(`SELECT id FROM datasets WHERE client_id = $1 ORDER BY uploaded_at DESC LIMIT 1`, [cid]));
  return rows.length ? rows[0].id : null;
}

// Column headers + a few raw sample rows (for configuring SETUP).
export async function preview(datasetId, limit = 8) {
  const ds = await query('SELECT name, columns, row_count FROM datasets WHERE id = $1', [datasetId]);
  const meta = ds.rows[0] || {};
  const sample = await query(
    'SELECT data FROM leads WHERE dataset_id = $1 ORDER BY id LIMIT $2', [datasetId, limit]);
  const rows = sample.rows.map((r) => r.data);
  let columns = meta.columns;
  if (!columns || !columns.length) {
    const seen = new Set();
    columns = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  }
  return { name: meta.name, row_count: meta.row_count, columns, rows };
}

// Headline metrics: primary counts, duplicate counts, and conversion % for each.
export async function summary(datasetId) {
  const settings = await getSettings();
  const { rows } = await query(
    `SELECT SUM(prim_flag) AS leads, SUM(fi_flag*prim_flag) AS fi,
            SUM(app_flag*prim_flag) AS apps, SUM(adm_flag*prim_flag) AS adm
     FROM leads WHERE dataset_id = $1`, [datasetId]);
  const r = rows[0] || {};
  const n = (x) => Number(x || 0);
  const leads = n(r.leads), fi = n(r.fi), apps = n(r.apps), adm = n(r.adm);
  const dup = await duplicateTotals();               // { leads, fi, apps, adm }
  const target = Number(settings.target || 0);
  const dealType = String(settings.deal_type || 'CPA').toUpperCase() === 'CPS' ? 'CPS' : 'CPA';
  const targetMetric = dealType === 'CPS' ? 'Admissions' : 'Applications';
  const achieved = dealType === 'CPS' ? adm : apps;
  const client = await activeClient();
  const reportTitle = (settings.report_title && settings.report_title.trim()) || client.name || 'Weekly Report';

  return {
    report_title: reportTitle, client_name: client.name,
    target, deal_type: dealType, target_metric: targetMetric, target_achieved_count: achieved,
    leads, fi, apps, adm,
    duplicates: dup,
    conversions: {
      lead_to_fi: pct(fi, leads), lead_to_app: pct(apps, leads), lead_to_adm: pct(adm, leads),
      fi_to_app: pct(apps, fi), app_to_adm: pct(adm, apps), target_achieved: pct(achieved, target),
    },
    conversions_dup: {
      lead_to_fi: pct(dup.fi, dup.leads), lead_to_app: pct(dup.apps, dup.leads), lead_to_adm: pct(dup.adm, dup.leads),
      fi_to_app: pct(dup.apps, dup.fi), app_to_adm: pct(dup.adm, dup.apps),
    },
  };
}

// Shape a raw group row into the full metric object (primary + duplicate + ratios).
function shapeRow(key, p, d) {
  return {
    key,
    leads: p.leads, fi: p.fi, apps: p.apps, adm: p.adm,
    dup_leads: d.leads, dup_fi: d.fi, dup_apps: d.apps, dup_adm: d.adm,
    // Funnel ratios: FI from leads, App from FI, Adm from App.
    lead_to_fi: pct(p.fi, p.leads), fi_to_app: pct(p.apps, p.fi), app_to_adm: pct(p.adm, p.apps),
    lead_to_app: pct(p.apps, p.leads),
    dup_lead_to_fi: pct(d.fi, d.leads), dup_fi_to_app: pct(d.apps, d.fi), dup_app_to_adm: pct(d.adm, d.apps),
    // combined (primary + duplicate) totals used only for ranking:
    _apps: p.apps + d.apps, _adm: p.adm + d.adm, _fi: p.fi + d.fi, _leads: p.leads + d.leads,
  };
}

// "Top <dimension>" table. Ranked by the deal-type conversion metric counting
// primary + duplicate together (CPA -> applications, CPS -> admissions), with
// form-initiated then leads as tie-breakers. Only rows that actually have that
// metric (or form-initiated) are shown — no padding. Duplicate columns come
// from the per-Medium uploads (lead_code only), matched by key.
export async function topBy(datasetId, column, { limit = 15, dupMaps = null, dupTotals = null, dealType = 'CPA' } = {}) {
  const allowed = { lead_code: 'lead_code', kapp_course: 'kapp_course', city: 'city' };
  const col = allowed[column];
  if (!col) throw new Error(`Unsupported group column: ${column}`);

  const { rows } = await query(
    `SELECT COALESCE(NULLIF(btrim(${col}), ''), '(blank)') AS key,
       SUM(prim_flag) AS leads, SUM(fi_flag*prim_flag) AS fi,
       SUM(app_flag*prim_flag) AS apps, SUM(adm_flag*prim_flag) AS adm
     FROM leads
     WHERE dataset_id = $1 AND ${col} IS NOT NULL AND btrim(${col}) <> ''
     GROUP BY key`, [datasetId]);

  const dupOf = (cat, key) => (dupMaps ? (dupMaps[cat].get(norm(key)) || 0) : 0);
  const all = rows.map((r) => shapeRow(r.key,
    { leads: +r.leads, fi: +r.fi, apps: +r.apps, adm: +r.adm },
    { leads: dupOf('leads', r.key), fi: dupOf('fi', r.key), apps: dupOf('apps', r.key), adm: dupOf('adm', r.key) }));

  // Pick ranking metric with a fallback chain so the table is never empty.
  const grand = (f) => all.reduce((s, x) => s + x[f], 0);
  let metric = '_apps', filter = true;
  if (dealType === 'CPS' && grand('_adm') > 0) metric = '_adm';
  else if (grand('_apps') > 0) metric = '_apps';
  else if (grand('_fi') > 0) metric = '_fi';
  else { metric = '_leads'; filter = false; }

  const ranked = all.slice().sort((a, b) => b[metric] - a[metric] || b._fi - a._fi || b._leads - a._leads);
  const qualifying = filter ? ranked.filter((x) => x[metric] > 0 || x._fi > 0) : ranked;
  const top = qualifying.slice(0, limit);
  const topKeys = new Set(top.map((x) => x.key));
  const rest = all.filter((x) => !topKeys.has(x.key));

  const sumField = (arr, f) => arr.reduce((s, x) => s + x[f], 0);
  const agg = (label, arr, dupOverride) => {
    const p = { leads: sumField(arr, 'leads'), fi: sumField(arr, 'fi'), apps: sumField(arr, 'apps'), adm: sumField(arr, 'adm') };
    const d = dupOverride || { leads: sumField(arr, 'dup_leads'), fi: sumField(arr, 'dup_fi'), apps: sumField(arr, 'dup_apps'), adm: sumField(arr, 'dup_adm') };
    return shapeRow(label, p, d);
  };

  const total = agg('TOTAL (all)', all, dupTotals || null);
  const remDup = {
    leads: Math.max(0, total.dup_leads - sumField(top, 'dup_leads')),
    fi: Math.max(0, total.dup_fi - sumField(top, 'dup_fi')),
    apps: Math.max(0, total.dup_apps - sumField(top, 'dup_apps')),
    adm: Math.max(0, total.dup_adm - sumField(top, 'dup_adm')),
  };
  const leftover = remDup.leads + remDup.fi + remDup.apps + remDup.adm;
  const others = (rest.length || leftover > 0) ? agg('Others', rest, remDup) : null;

  return { rows: top, others, total };
}

// Lead Stage distribution among primary leads.
export async function leadStages(datasetId) {
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(btrim(lead_stage), ''), '(blank)') AS stage, COUNT(*) AS leads
     FROM leads WHERE dataset_id = $1 AND prim_flag = 1 GROUP BY stage ORDER BY leads DESC`, [datasetId]);
  const total = rows.reduce((s, r) => s + Number(r.leads), 0);
  return { rows: rows.map((r) => ({ stage: r.stage, leads: Number(r.leads), pct: pct(Number(r.leads), total) })), total };
}

// Overall Lead Origin (no month). Duplicate columns are 0 — the per-Medium
// duplicate exports carry no origin, so duplicates can't be attributed here.
export async function byOrigin(datasetId) {
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(btrim(origin), ''), '(blank)') AS key,
       SUM(prim_flag) AS leads, SUM(fi_flag*prim_flag) AS fi,
       SUM(app_flag*prim_flag) AS apps, SUM(adm_flag*prim_flag) AS adm
     FROM leads WHERE dataset_id = $1 GROUP BY key ORDER BY leads DESC`, [datasetId]);
  const zero = { leads: 0, fi: 0, apps: 0, adm: 0 };
  const all = rows.map((r) => shapeRow(r.key, { leads: +r.leads, fi: +r.fi, apps: +r.apps, adm: +r.adm }, zero));
  const sumField = (arr, f) => arr.reduce((s, x) => s + x[f], 0);
  const total = shapeRow('TOTAL (all)',
    { leads: sumField(all, 'leads'), fi: sumField(all, 'fi'), apps: sumField(all, 'apps'), adm: sumField(all, 'adm') }, zero);
  return { rows: all, others: null, total };
}

// Lead Origin x Month breakdown (primary metrics + funnel; duplicates 0).
export async function byOriginMonth(datasetId) {
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(btrim(origin), ''), '(blank)') AS origin, COALESCE(month, '(none)') AS month,
       SUM(prim_flag) AS leads, SUM(fi_flag*prim_flag) AS fi,
       SUM(app_flag*prim_flag) AS apps, SUM(adm_flag*prim_flag) AS adm
     FROM leads WHERE dataset_id = $1 GROUP BY origin, month ORDER BY month, leads DESC`, [datasetId]);
  return rows.map((r) => ({
    origin: r.origin, month: r.month, leads: +r.leads, fi: +r.fi, apps: +r.apps, adm: +r.adm,
    lead_to_fi: pct(+r.fi, +r.leads), fi_to_app: pct(+r.apps, +r.fi), app_to_adm: pct(+r.adm, +r.apps),
    dup_leads: 0, dup_apps: 0, dup_adm: 0,
  }));
}

// Top performing medium/course per month, ranked by the deal-type conversion.
async function topPerMonth(datasetId, col, dealType = 'CPA') {
  const rankMetric = String(dealType).toUpperCase() === 'CPS' ? 'adm DESC, apps DESC' : 'apps DESC, adm DESC';
  const { rows } = await query(
    `SELECT DISTINCT ON (month) COALESCE(month,'(none)') AS month,
            COALESCE(NULLIF(btrim(${col}), ''), '(blank)') AS key,
            SUM(prim_flag) AS leads, SUM(fi_flag*prim_flag) AS fi,
            SUM(app_flag*prim_flag) AS apps, SUM(adm_flag*prim_flag) AS adm
     FROM leads WHERE dataset_id = $1 AND month IS NOT NULL
     GROUP BY month, key ORDER BY month, ${rankMetric}, leads DESC`, [datasetId]);
  return rows.map((r) => ({
    month: r.month, key: r.key,
    leads: +r.leads, fi: +r.fi, apps: +r.apps, adm: +r.adm,
    lead_to_fi: pct(+r.fi, +r.leads), fi_to_app: pct(+r.apps, +r.fi), app_to_adm: pct(+r.adm, +r.apps),
    dup_leads: 0, dup_apps: 0, dup_adm: 0,
  }));
}
export const topMediumByMonth = (id, dealType) => topPerMonth(id, 'lead_code', dealType);
export const topCourseByMonth = (id, dealType) => topPerMonth(id, 'kapp_course', dealType);

// The whole report in one payload.
export async function fullReport(datasetId) {
  const settings = await getSettings();
  const limit = Number(settings.top_n || 15);
  const dealType = String(settings.deal_type || 'CPA').toUpperCase() === 'CPS' ? 'CPS' : 'CPA';
  const [dupMaps, dupTotals] = [await duplicatesByMedium(), await duplicateTotals()];
  const [sum, leadCodes, courses, cities, stages, origin, originMonth, mediumMonth, courseMonth] =
    await Promise.all([
      summary(datasetId),
      topBy(datasetId, 'lead_code', { limit, dupMaps, dupTotals, dealType }),
      topBy(datasetId, 'kapp_course', { limit, dealType }),
      topBy(datasetId, 'city', { limit, dealType }),
      leadStages(datasetId),
      byOrigin(datasetId),
      byOriginMonth(datasetId),
      topMediumByMonth(datasetId, dealType),
      topCourseByMonth(datasetId, dealType),
    ]);
  return {
    dataset_id: datasetId,
    summary: sum,
    top_lead_codes: leadCodes,
    top_courses: courses,
    top_cities: cities,
    lead_stages: stages,
    origin,
    origin_month: originMonth,
    top_medium_by_month: mediumMonth,
    top_course_by_month: courseMonth,
  };
}
