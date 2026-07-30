import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { withClient, query } from './db.js';
import { getSettings } from './settings.js';
import { loadMappings } from './mappings.js';
import { buildContext, deriveRow, resolveDateOrder } from './derive.js';
import { activeClientId } from './clients.js';

// --- File parsing ----------------------------------------------------------

// Rows arrive as arrays; find the header row even when a CRM export prepends
// banner/notification rows (as meritto's "RAW" view does).
function detectHeaderRow(matrix) {
  let best = 0;
  let bestScore = -1;
  const limit = Math.min(matrix.length, 25);
  for (let i = 0; i < limit; i++) {
    const cells = matrix[i] || [];
    const nonEmpty = cells.filter((c) => String(c ?? '').trim() !== '').length;
    // Prefer a row with many short, distinct-looking text headers.
    const shortText = cells.filter((c) => {
      const v = String(c ?? '').trim();
      return v && v.length <= 40;
    }).length;
    const score = nonEmpty + shortText;
    if (nonEmpty >= 3 && score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function matrixToRows(matrix, headerRowIndex) {
  const headers = (matrix[headerRowIndex] || []).map((h, i) => {
    const name = String(h ?? '').trim();
    return name || `Column ${i + 1}`;
  });
  const rows = [];
  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const line = matrix[r] || [];
    if (line.every((c) => String(c ?? '').trim() === '')) continue; // skip blank
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = line[c] ?? '';
    rows.push(obj);
  }
  return { headers, rows };
}

// Parse .csv/.tsv/.xlsx/.xls into { headers, rows: [{header: value}] }.
export function parseFile(filePath, { headerRow = null } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  let matrix;
  if (ext === '.csv' || ext === '.tsv') {
    const text = fs.readFileSync(filePath, 'utf8');
    matrix = parse(text, {
      delimiter: ext === '.tsv' ? '\t' : ',',
      relax_column_count: true,
      skip_empty_lines: false,
      trim: false,
    });
  } else {
    const wb = XLSX.readFile(filePath, { cellDates: false, raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  }
  const headerRowIndex = headerRow != null ? headerRow : detectHeaderRow(matrix);
  return matrixToRows(matrix, headerRowIndex);
}

// --- Loading into Postgres --------------------------------------------------

const COLS = [
  'dataset_id', 'data', 'record_key', 'lead_code', 'kapp_course', 'city',
  'origin', 'month', 'lead_stage', 'fi_flag', 'app_flag', 'adm_flag', 'prim_flag',
];

async function insertBatch(client, datasetId, batch, ctx) {
  const values = [];
  const params = [];
  let p = 1;
  for (const row of batch) {
    const d = deriveRow(row, ctx);
    params.push(
      datasetId, JSON.stringify(row), d.record_key, d.lead_code, d.kapp_course,
      d.city, d.origin, d.month, d.lead_stage, d.fi_flag, d.app_flag, d.adm_flag, d.prim_flag
    );
    const ph = COLS.map(() => `$${p++}`);
    values.push(`(${ph.join(',')})`);
  }
  await client.query(
    `INSERT INTO leads (${COLS.join(',')}) VALUES ${values.join(',')}`,
    params
  );
}

// Import a parsed file into a new dataset. Returns { datasetId, rowCount }.
export async function importRows(rows, { name, filename, headers } = {}) {
  const settings = await getSettings();
  const { courseRows, leadCodeRows } = await loadMappings();
  // Resolve the date order once, from a sample of this file's date column.
  const sample = rows.slice(0, 5000).map((r) => r[settings.date_column]);
  const dateOrder = resolveDateOrder(settings, sample);
  const ctx = buildContext(settings, courseRows, leadCodeRows, dateOrder);
  const cols = headers && headers.length ? headers : Object.keys(rows[0] || {});

  const clientId = await activeClientId();
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const ds = await client.query(
        `INSERT INTO datasets (name, source_filename, row_count, columns, client_id) VALUES ($1,$2,0,$3,$4) RETURNING id`,
        [name || filename || 'Upload', filename || null, cols, clientId]
      );
      const datasetId = ds.rows[0].id;

      const BATCH = 1000;
      for (let i = 0; i < rows.length; i += BATCH) {
        await insertBatch(client, datasetId, rows.slice(i, i + BATCH), ctx);
      }

      await client.query(`UPDATE datasets SET row_count = $1 WHERE id = $2`, [rows.length, datasetId]);
      // New upload becomes the active dataset for THIS client.
      await client.query(`UPDATE datasets SET is_active = (id = $1) WHERE client_id = $2`, [datasetId, clientId]);
      await client.query('COMMIT');
      return { datasetId, rowCount: rows.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// Recompute derived fields for a dataset (after settings/mappings change),
// re-reading the untouched raw `data` jsonb. Streams in batches.
export async function recomputeDataset(datasetId) {
  const settings = await getSettings();
  const { courseRows, leadCodeRows } = await loadMappings();
  // Sample the date column from the stored rows to resolve day/month order once.
  const dateSample = await query(
    `SELECT data->>$2 AS d FROM leads
       WHERE dataset_id = $1 AND NULLIF(btrim(data->>$2), '') IS NOT NULL
       LIMIT 5000`,
    [datasetId, settings.date_column]
  );
  const dateOrder = resolveDateOrder(settings, dateSample.rows.map((r) => r.d));
  const ctx = buildContext(settings, courseRows, leadCodeRows, dateOrder);

  const BATCH = 5000;
  let lastId = 0;
  let total = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT id, data FROM leads WHERE dataset_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [datasetId, lastId, BATCH]
    );
    if (!rows.length) break;

    // Build parallel arrays and update the whole batch in ONE statement via
    // unnest — one round-trip per batch instead of one per row.
    const ids = [], rk = [], lc = [], kc = [], ci = [], og = [], mo = [], ls = [], fi = [], ap = [], ad = [], pr = [];
    for (const r of rows) {
      const d = deriveRow(r.data, ctx);
      ids.push(r.id); rk.push(d.record_key); lc.push(d.lead_code); kc.push(d.kapp_course);
      ci.push(d.city); og.push(d.origin); mo.push(d.month); ls.push(d.lead_stage);
      fi.push(d.fi_flag); ap.push(d.app_flag); ad.push(d.adm_flag); pr.push(d.prim_flag);
    }
    await query(
      `UPDATE leads AS l SET
         record_key = d.record_key, lead_code = d.lead_code, kapp_course = d.kapp_course,
         city = d.city, origin = d.origin, month = d.month, lead_stage = d.lead_stage,
         fi_flag = d.fi_flag, app_flag = d.app_flag, adm_flag = d.adm_flag, prim_flag = d.prim_flag
       FROM (
         SELECT * FROM unnest(
           $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
           $7::text[], $8::text[], $9::smallint[], $10::smallint[], $11::smallint[], $12::smallint[]
         ) AS t(id, record_key, lead_code, kapp_course, city, origin, month, lead_stage,
                fi_flag, app_flag, adm_flag, prim_flag)
       ) AS d
       WHERE l.id = d.id`,
      [ids, rk, lc, kc, ci, og, mo, ls, fi, ap, ad, pr]
    );

    lastId = rows[rows.length - 1].id;
    total += rows.length;
  }
  return { recomputed: total };
}
