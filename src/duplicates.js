// Duplicate uploads — per-Medium exports for leads / fi / apps / adm.
import { withClient, query } from './db.js';
import { loadMappings } from './mappings.js';
import { activeClientId } from './clients.js';

export const DUP_CATEGORIES = ['leads', 'fi', 'apps', 'adm'];
export const DUP_LABELS = { leads: 'Leads', fi: 'Form Initiated', apps: 'Applications', adm: 'Admissions' };

const norm = (v) => String(v ?? '').trim().toLowerCase();
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

function resolveHeaders(headers) {
  const L = headers.map((h) => [h, String(h).toLowerCase()]);
  const find = (pred) => (L.find(([, l]) => pred(l)) || [])[0] || null;
  return {
    source: find((l) => l.includes('source')),
    medium: find((l) => l.includes('medium') && !l.includes('kapp')),
    campaign: find((l) => l.includes('campaign')),
    primary: find((l) => l.includes('primary')),
    secondary: find((l) => l.includes('secondary')),
    tertiary: find((l) => l.includes('tertiary')),
    total_instances: find((l) => l.includes('total') && l.includes('insta')),
    verified: find((l) => l.includes('verified') && !l.includes('unverified')),
    unverified: find((l) => l.includes('unverified')),
    form_initiated: find((l) => l.includes('form')),
    payment_approved: find((l) => l.includes('payment')),
  };
}

const DB_COLS = ['client_id', 'category', 'source', 'medium', 'campaign', 'primary_leads', 'secondary_leads',
  'tertiary_leads', 'total_instances', 'verified', 'unverified', 'form_initiated',
  'payment_approved', 'dup_count', 'kapp_medium'];

export async function importDuplicates(category, headers, rows, filename, req) {
  if (!DUP_CATEGORIES.includes(category)) throw new Error('Unknown duplicate category');
  const H = resolveHeaders(headers);
  if (!H.medium) throw new Error('Could not find a "Medium" column in the file');

  const clientId = await activeClientId(req);
  const { leadCodeRows } = await loadMappings();
  const map = new Map(leadCodeRows.map((r) => [norm(r.medium), r.code]));

  const records = rows.map((r) => {
    const medium = String(r[H.medium] ?? '').trim();
    const secondary = num(r[H.secondary]);
    const tertiary = num(r[H.tertiary]);
    return {
      source: String(r[H.source] ?? '').trim() || null,
      medium,
      campaign: String(r[H.campaign] ?? '').trim() || null,
      primary_leads: num(r[H.primary]),
      secondary_leads: secondary,
      tertiary_leads: tertiary,
      total_instances: num(r[H.total_instances]),
      verified: num(r[H.verified]),
      unverified: num(r[H.unverified]),
      form_initiated: num(r[H.form_initiated]),
      payment_approved: num(r[H.payment_approved]),
      dup_count: secondary + tertiary,
      kapp_medium: map.get(norm(medium)) || medium || null,
    };
  }).filter((x) => x.medium);

  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM duplicate_rows WHERE category = $1 AND client_id = $2', [category, clientId]);
      const BATCH = 500;
      for (let i = 0; i < records.length; i += BATCH) {
        const slice = records.slice(i, i + BATCH);
        const params = [];
        const values = slice.map((rec) => {
          const tuple = [clientId, category, rec.source, rec.medium, rec.campaign, rec.primary_leads,
            rec.secondary_leads, rec.tertiary_leads, rec.total_instances, rec.verified,
            rec.unverified, rec.form_initiated, rec.payment_approved, rec.dup_count, rec.kapp_medium];
          return `(${tuple.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`;
        });
        await client.query(`INSERT INTO duplicate_rows (${DB_COLS.join(',')}) VALUES ${values.join(',')}`, params);
      }
      await client.query(
        `INSERT INTO duplicate_uploads (client_id, category, source_filename, row_count, uploaded_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (client_id, category) DO UPDATE SET source_filename = EXCLUDED.source_filename,
           row_count = EXCLUDED.row_count, uploaded_at = now()`,
        [clientId, category, filename || null, records.length]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });

  return { category, rowCount: records.length, dupTotal: records.reduce((s, x) => s + x.dup_count, 0) };
}

export async function clearDuplicates(category, req) {
  const cid = await activeClientId(req);
  await query('DELETE FROM duplicate_rows WHERE category = $1 AND client_id = $2', [category, cid]);
  await query('DELETE FROM duplicate_uploads WHERE category = $1 AND client_id = $2', [category, cid]);
}

export async function duplicateTotals(req, datasetId = null) {
  const cid = await activeClientId(req);
  const { rows } = await query('SELECT category, COALESCE(SUM(dup_count),0)::int AS total FROM duplicate_rows WHERE client_id = $1 GROUP BY category', [cid]);
  const out = { leads: 0, fi: 0, apps: 0, adm: 0 };
  for (const r of rows) if (r.category in out) out[r.category] = Number(r.total);
  if (datasetId) {
    const { rows: dr } = await query(
      `SELECT SUM(dup_flag) AS leads, SUM(fi_flag*dup_flag) AS fi,
              SUM(app_flag*dup_flag) AS apps, SUM(adm_flag*dup_flag) AS adm
       FROM leads WHERE dataset_id = $1`, [datasetId]);
    if (dr[0]) {
      out.leads += Number(dr[0].leads || 0);
      out.fi    += Number(dr[0].fi    || 0);
      out.apps  += Number(dr[0].apps  || 0);
      out.adm   += Number(dr[0].adm   || 0);
    }
  }
  return out;
}

export async function duplicatesByMedium(req) {
  const cid = await activeClientId(req);
  const { rows } = await query(
    `SELECT category, lower(btrim(kapp_medium)) AS k, COALESCE(SUM(dup_count),0)::int AS total
     FROM duplicate_rows WHERE client_id = $1 AND kapp_medium IS NOT NULL GROUP BY category, k`, [cid]);
  const maps = { leads: new Map(), fi: new Map(), apps: new Map(), adm: new Map() };
  for (const r of rows) if (maps[r.category]) maps[r.category].set(r.k, Number(r.total));
  return maps;
}

export async function duplicatePreview(category, { limit = 200, q = '' } = {}, req) {
  if (!DUP_CATEGORIES.includes(category)) throw new Error('Unknown duplicate category');
  const cid = await activeClientId(req);
  const where = q ? 'AND (medium ILIKE $3 OR kapp_medium ILIKE $3 OR campaign ILIKE $3)' : '';
  const params = q ? [category, cid, `%${q}%`] : [category, cid];
  const rows = await query(
    `SELECT id, source, medium, campaign, primary_leads, secondary_leads, tertiary_leads,
            total_instances, verified, unverified, form_initiated, payment_approved,
            dup_count, kapp_medium
     FROM duplicate_rows WHERE category = $1 AND client_id = $2 ${where}
     ORDER BY dup_count DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`, params);
  const totals = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(dup_count),0)::int AS dup,
            COALESCE(SUM(primary_leads),0)::int AS prim FROM duplicate_rows WHERE category = $1 AND client_id = $2`, [category, cid]);
  const meta = await query('SELECT source_filename, row_count, uploaded_at FROM duplicate_uploads WHERE category = $1 AND client_id = $2', [category, cid]);
  return { rows: rows.rows, totals: totals.rows[0], meta: meta.rows[0] || null };
}

export async function duplicatesSummary(req) {
  const cid = await activeClientId(req);
  const { rows } = await query('SELECT category, source_filename, row_count, uploaded_at FROM duplicate_uploads WHERE client_id = $1', [cid]);
  const tot = await duplicateTotals(req);
  const byCat = {};
  for (const c of DUP_CATEGORIES) byCat[c] = { uploaded: false, dup: tot[c] };
  for (const r of rows) byCat[r.category] = { uploaded: true, filename: r.source_filename, rowCount: r.row_count, uploaded_at: r.uploaded_at, dup: tot[r.category] };
  return byCat;
}