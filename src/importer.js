import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { withClient, query } from './db.js';
import { getSettings } from './settings.js';
import { loadMappings } from './mappings.js';
import { buildContext, deriveRow, resolveDateOrder } from './derive.js';
import { activeClientId, activeWdClientId } from './clients.js';

// --- File parsing ----------------------------------------------------------

function detectHeaderRow(matrix) {
  let best = 0;
  let bestScore = -1;
  const limit = Math.min(matrix.length, 25);
  for (let i = 0; i < limit; i++) {
    const cells = matrix[i] || [];
    const nonEmpty = cells.filter((c) => String(c ?? '').trim() !== '').length;
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
    if (line.every((c) => String(c ?? '').trim() === '')) continue;
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

// Parse all sheets in an XLSX — returns [{name, headers, rows}] with _sheet tag on each row.
// For CSV/TSV, returns a single-item array with sheet name 'Sheet1'.
export function parseFileAllSheets(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') {
    const { headers, rows } = parseFile(filePath);
    return [{ name: 'Sheet1', headers, rows: rows.map((r) => ({ ...r, _sheet: 'Sheet1' })) }];
  }
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: true });
  return wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const headerRowIndex = detectHeaderRow(matrix);
    const { headers, rows } = matrixToRows(matrix, headerRowIndex);
    return {
      name: sheetName,
      headers,
      rows: rows.map((r) => ({ ...r, _sheet: sheetName })),
    };
  });
}

// --- Loading into Postgres --------------------------------------------------

const COLS = [
  'dataset_id', 'data', 'record_key', 'lead_code', 'kapp_course', 'city',
  'origin', 'month', 'lead_stage', 'fi_flag', 'app_flag', 'adm_flag', 'prim_flag', 'dup_flag',
];

async function insertBatch(client, datasetId, batch, ctx) {
  const values = [];
  const params = [];
  let p = 1;
  for (const row of batch) {
    const d = deriveRow(row, ctx);
    params.push(
      datasetId, JSON.stringify(row), d.record_key, d.lead_code, d.kapp_course,
      d.city, d.origin, d.month, d.lead_stage, d.fi_flag, d.app_flag, d.adm_flag, d.prim_flag, d.dup_flag
    );
    const ph = COLS.map(() => `$${p++}`);
    values.push(`(${ph.join(',')})`);
  }
  await client.query(
    `INSERT INTO leads (${COLS.join(',')}) VALUES ${values.join(',')}`,
    params
  );
}

export async function importRows(rows, { name, filename, headers } = {}, req) {
  const settings = await getSettings(req);
  const { courseRows, leadCodeRows } = await loadMappings();
  const sample = rows.slice(0, 5000).map((r) => r[settings.date_column]);
  const dateOrder = resolveDateOrder(settings, sample);
  const ctx = buildContext(settings, courseRows, leadCodeRows, dateOrder);
  const cols = headers && headers.length ? headers : Object.keys(rows[0] || {});

  const clientId = await activeClientId(req);
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
      await client.query(`UPDATE datasets SET is_active = (id = $1) WHERE client_id = $2`, [datasetId, clientId]);
      await client.query('COMMIT');
      return { datasetId, rowCount: rows.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// --- Chunked upload --------------------------------------------------------

export async function startDataset({ name, filename, headers } = {}, req) {
  const clientId = await activeClientId(req);
  const cols = headers && headers.length ? headers : null;
  const ds = await query(
    `INSERT INTO datasets (name, source_filename, row_count, columns, client_id, is_active)
     VALUES ($1,$2,0,$3,$4,false) RETURNING id`,
    [name || filename || 'Upload', filename || null, cols, clientId]);
  return ds.rows[0].id;
}

export async function appendRows(datasetId, rows, req) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const settings = await getSettings(req);
  const { courseRows, leadCodeRows } = await loadMappings();
  const dateOrder = resolveDateOrder(settings, rows.slice(0, 5000).map((r) => r[settings.date_column]));
  const ctx = buildContext(settings, courseRows, leadCodeRows, dateOrder);
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const BATCH = 1000;
      for (let i = 0; i < rows.length; i += BATCH) {
        await insertBatch(client, datasetId, rows.slice(i, i + BATCH), ctx);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  });
  return rows.length;
}

export async function finishDataset(datasetId) {
  const meta = await query('SELECT client_id FROM datasets WHERE id = $1', [datasetId]);
  const clientId = meta.rows[0] && meta.rows[0].client_id;
  const cnt = await query('SELECT count(*)::int AS n FROM leads WHERE dataset_id = $1', [datasetId]);
  const n = cnt.rows[0].n;
  await query('UPDATE datasets SET row_count = $1 WHERE id = $2', [n, datasetId]);
  if (clientId != null) await query('UPDATE datasets SET is_active = (id = $1) WHERE client_id = $2', [datasetId, clientId]);
  return n;
}

// --- Weekly Dump upload (raw rows only — no field derivation) --------------

export async function startWdDataset({ name, filename, headers } = {}, req) {
  const clientId = await activeWdClientId(req);
  if (!clientId) throw new Error('No active Weekly Dump client. Create one in the Clients tab first.');
  const cols = headers && headers.length ? headers : null;
  const ds = await query(
    `INSERT INTO datasets (name, source_filename, row_count, columns, client_id, is_active, source_type)
     VALUES ($1,$2,0,$3,$4,false,'weekly_dump') RETURNING id`,
    [name || filename || 'Upload', filename || null, cols, clientId]);
  return ds.rows[0].id;
}

export async function appendWdRows(datasetId, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const BATCH = 1000;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const values = [];
        const params = [];
        let p = 1;
        for (const row of batch) {
          params.push(datasetId, JSON.stringify(row));
          values.push(`($${p++}, $${p++})`);
        }
        await client.query(`INSERT INTO leads (dataset_id, data) VALUES ${values.join(',')}`, params);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  });
  return rows.length;
}

export async function finishWdDataset(datasetId) {
  const meta = await query('SELECT client_id FROM datasets WHERE id = $1', [datasetId]);
  const clientId = meta.rows[0]?.client_id;
  const cnt = await query('SELECT count(*)::int AS n FROM leads WHERE dataset_id = $1', [datasetId]);
  const n = cnt.rows[0].n;
  await query('UPDATE datasets SET row_count = $1 WHERE id = $2', [n, datasetId]);
  if (clientId != null) {
    await query(
      `UPDATE datasets SET is_active = (id = $1) WHERE client_id = $2 AND source_type = 'weekly_dump'`,
      [datasetId, clientId]);
  }
  return n;
}

// Recompute derived fields for a dataset.
export async function recomputeDataset(datasetId, req) {
  const settings = await getSettings(req);
  const { courseRows, leadCodeRows } = await loadMappings();
  const dateSample = await query(
    `SELECT data->>$2 AS d FROM leads
       WHERE dataset_id = $1 AND NULLIF(btrim(data->>$2), '') IS NOT NULL
       LIMIT 5000`,
    [datasetId, settings.date_column]
  );
  const dateOrder = resolveDateOrder(settings, dateSample.rows.map((r) => r.d));
  const ctx = buildContext(settings, courseRows, leadCodeRows, dateOrder);

  // Fetch all IDs first, then process in parallel batches
  const BATCH = 20000;
  const PARALLEL = 3;

  const { rows: allRows } = await query(
    `SELECT id, data FROM leads WHERE dataset_id = $1 ORDER BY id`,
    [datasetId]
  );

  const chunks = [];
  for (let i = 0; i < allRows.length; i += BATCH) {
    chunks.push(allRows.slice(i, i + BATCH));
  }

  async function processChunk(rows) {
    const ids = [], rk = [], lc = [], kc = [], ci = [], og = [], mo = [], ls = [], fi = [], ap = [], ad = [], pr = [], du = [];
    for (const r of rows) {
      const d = deriveRow(r.data, ctx);
      ids.push(r.id); rk.push(d.record_key); lc.push(d.lead_code); kc.push(d.kapp_course);
      ci.push(d.city); og.push(d.origin); mo.push(d.month); ls.push(d.lead_stage);
      fi.push(d.fi_flag); ap.push(d.app_flag); ad.push(d.adm_flag); pr.push(d.prim_flag); du.push(d.dup_flag);
    }
    await query(
      `UPDATE leads AS l SET
         record_key = d.record_key, lead_code = d.lead_code, kapp_course = d.kapp_course,
         city = d.city, origin = d.origin, month = d.month, lead_stage = d.lead_stage,
         fi_flag = d.fi_flag, app_flag = d.app_flag, adm_flag = d.adm_flag, prim_flag = d.prim_flag, dup_flag = d.dup_flag
       FROM (
         SELECT * FROM unnest(
           $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
           $7::text[], $8::text[], $9::smallint[], $10::smallint[], $11::smallint[], $12::smallint[], $13::smallint[]
         ) AS t(id, record_key, lead_code, kapp_course, city, origin, month, lead_stage,
                fi_flag, app_flag, adm_flag, prim_flag, dup_flag)
       ) AS d
       WHERE l.id = d.id`,
      [ids, rk, lc, kc, ci, og, mo, ls, fi, ap, ad, pr, du]
    );
    return rows.length;
  }

  let total = 0;
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const group = chunks.slice(i, i + PARALLEL);
    const results = await Promise.all(group.map(processChunk));
    total += results.reduce((a, b) => a + b, 0);
  }
  return { recomputed: total };
}