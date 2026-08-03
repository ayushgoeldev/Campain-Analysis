import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import { query, withClient } from '../db.js';
import { getSettings, saveSettings, defaultSettings } from '../settings.js';
import { parseFile, parseFileAllSheets, importRows, recomputeDataset, startDataset, appendRows, finishDataset, startWdDataset, appendWdRows, finishWdDataset } from '../importer.js';
import { invalidateMappings } from '../mappings.js';
import { fullReport, resolveDataset, preview } from '../report.js';
import { reportToXlsx } from '../reportxlsx.js';
import { importDuplicates, duplicatePreview, duplicatesSummary, clearDuplicates } from '../duplicates.js';
import { activeClientId, activeClient, activeWdClientId, activeWdClient, listClients, createClient, activateClient, activateWdClient, renameClient, deleteClient } from '../clients.js';

const router = Router();
const maxMb = Number(process.env.MAX_UPLOAD_MB || 200);
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: maxMb * 1024 * 1024 } });

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

router.get('/health', wrap(async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));
router.get('/debug-env', (req, res) => {
  res.json({
    hasUsername: !!process.env.APP_USERNAME,
    hasPassword: !!process.env.APP_PASSWORD,
  });
});

// --- Settings --------------------------------------------------------------
router.get('/settings', wrap(async (req, res) => {
  res.json({ settings: await getSettings(req), defaults: await defaultSettings() });
}));

router.put('/settings', wrap(async (req, res) => {
  const saved = await saveSettings(req.body, req);
  const title = (req.body && req.body.report_title || '').trim();
  if (title) await renameClient(await activeClientId(req), title);
  res.json({ settings: saved });
}));

// --- Campaign Analysis clients --------------------------------------------
router.get('/clients', wrap(async (req, res) => {
  const clients = await listClients((req.query.q || '').trim(), 'campaign');
  const active = await activeClient(req);
  res.json({ clients, active });
}));

router.post('/clients', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const id = await createClient(name, req, 'campaign');
  res.json({ id });
}));

router.post('/clients/:id/activate', wrap(async (req, res) => {
  await activateClient(req.params.id, req);
  res.json({ ok: true });
}));

router.put('/clients/:id', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  await renameClient(req.params.id, name);
  res.json({ ok: true });
}));

router.delete('/clients/:id', wrap(async (req, res) => {
  await deleteClient(req.params.id);
  res.json({ ok: true });
}));

// --- Weekly Dump clients --------------------------------------------------
router.get('/wd/clients', wrap(async (req, res) => {
  const clients = await listClients((req.query.q || '').trim(), 'weekly_dump');
  const active = await activeWdClient(req);
  res.json({ clients, active });
}));

router.post('/wd/clients', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const id = await createClient(name, req, 'weekly_dump');
  res.json({ id });
}));

router.post('/wd/clients/:id/activate', wrap(async (req, res) => {
  await activateWdClient(req.params.id, req);
  res.json({ ok: true });
}));

router.delete('/wd/clients/:id', wrap(async (req, res) => {
  await deleteClient(req.params.id);
  res.json({ ok: true });
}));

// --- Datasets (campaign, scoped to the active client) ---------------------
router.get('/datasets', wrap(async (req, res) => {
  const cid = await activeClientId(req);
  const { rows } = await query(
    `SELECT id, name, source_filename, row_count, uploaded_at, is_active
     FROM datasets WHERE client_id = $1 AND source_type = 'campaign' ORDER BY uploaded_at DESC`, [cid]);
  res.json({ datasets: rows });
}));

router.post('/datasets/:id/activate', wrap(async (req, res) => {
  await query(
    `UPDATE datasets SET is_active = (id = $1)
     WHERE client_id = (SELECT client_id FROM datasets WHERE id = $1)`, [Number(req.params.id)]);
  res.json({ ok: true });
}));

router.delete('/datasets/:id', wrap(async (req, res) => {
  await query(`DELETE FROM datasets WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));

// --- Upload merge (campaign analysis, multiple files → one dataset) ---------
router.post('/upload/merge', upload.array('files', 20), wrap(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const tmpPaths = req.files.map((f) => f.path);
  try {
    const allHeadersSet = new Set();
    const fileData = [];
    for (const file of req.files) {
      const { headers, rows } = parseFile(file.path);
      if (rows.length) { headers.forEach((h) => allHeadersSet.add(h)); fileData.push({ rows }); }
    }
    if (!fileData.length) return res.status(400).json({ error: 'No data rows found in any file' });
    const mergedHeaders = [...allHeadersSet];
    const mergedRows = fileData.flatMap(({ rows }) => rows.map((row) => {
      const out = {};
      for (const h of mergedHeaders) out[h] = row[h] ?? '';
      return out;
    }));
    const name = (req.body.name || '').trim() || `Merged (${fileData.length} files)`;
    const result = await importRows(mergedRows, { name, filename: name, headers: mergedHeaders }, req);
    res.json({ ...result, headers: mergedHeaders, columns: mergedHeaders.length, fileCount: fileData.length });
  } finally {
    tmpPaths.forEach((p) => fs.unlink(p, () => {}));
  }
}));

// --- Upload / import -------------------------------------------------------
router.post('/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  try {
    const headerRow = req.body.headerRow != null && req.body.headerRow !== ''
      ? Number(req.body.headerRow) : null;
    const { headers, rows } = parseFile(req.file.path, { headerRow });
    if (!rows.length) return res.status(400).json({ error: 'No data rows found in file' });
    const result = await importRows(rows, {
      name: req.body.name || req.file.originalname,
      filename: req.file.originalname,
      headers,
    }, req);
    res.json({ ...result, headers, columns: headers.length });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

router.post('/upload/start', wrap(async (req, res) => {
  const { name, filename, headers } = req.body || {};
  const datasetId = await startDataset({ name, filename, headers }, req);
  res.json({ datasetId });
}));

router.post('/upload/rows', wrap(async (req, res) => {
  const { datasetId, rows } = req.body || {};
  if (!datasetId || !Array.isArray(rows)) return res.status(400).json({ error: 'datasetId and rows[] required' });
  const inserted = await appendRows(Number(datasetId), rows, req);
  res.json({ inserted });
}));

router.post('/upload/finish', wrap(async (req, res) => {
  const { datasetId } = req.body || {};
  if (!datasetId) return res.status(400).json({ error: 'datasetId required' });
  const rowCount = await finishDataset(Number(datasetId));
  res.json({ ok: true, rowCount });
}));

router.post('/recompute', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.body?.datasetId, req);
  if (!datasetId) return res.status(400).json({ error: 'No dataset to recompute' });
  res.json(await recomputeDataset(datasetId, req));
}));

// --- Report ----------------------------------------------------------------
router.get('/report', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.query.datasetId, req);
  if (!datasetId) return res.json({ empty: true });
  const n = Number(req.query.top_n);
  if (n > 0) req._topNOverride = n;
  res.json(await fullReport(datasetId, req));
}));

router.get('/report.xlsx', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.query.datasetId, req);
  if (!datasetId) return res.status(400).json({ error: 'No data to export' });
  const { buf, filename } = await reportToXlsx(datasetId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}));

router.get('/preview', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.query.datasetId, req);
  if (!datasetId) return res.json({ empty: true });
  const limit = Math.min(Number(req.query.limit) || 8, 50);
  res.json(await preview(datasetId, limit, req));
}));

// --- Annotations -----------------------------------------------------------
router.get('/annotations', wrap(async (req, res) => {
  const cid = await activeClientId(req);
  const { rows } = await query('SELECT scope, key, insights, challenges FROM annotations WHERE client_id = $1', [cid]);
  const out = {};
  for (const r of rows) {
    (out[r.scope] ||= {})[r.key] = { insights: r.insights || '', challenges: r.challenges || '' };
  }
  res.json(out);
}));

router.put('/annotations', wrap(async (req, res) => {
  const { scope, key } = req.body || {};
  if (!scope || key == null) return res.status(400).json({ error: 'scope and key are required' });
  const cid = await activeClientId(req);
  await query(
    `INSERT INTO annotations (client_id, scope, key, insights, challenges, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (client_id, scope, key) DO UPDATE SET insights = EXCLUDED.insights,
       challenges = EXCLUDED.challenges, updated_at = now()`,
    [cid, String(scope), String(key), req.body.insights || '', req.body.challenges || '']);
  res.json({ ok: true });
}));

// --- Duplicate uploads -----------------------------------------------------
router.get('/duplicates', wrap(async (req, res) => {
  res.json(await duplicatesSummary(req));
}));

router.get('/duplicates/:category', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  res.json(await duplicatePreview(req.params.category, { q, limit: req.query.limit }, req));
}));

router.post('/duplicates/:category', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  try {
    const { headers, rows } = parseFile(req.file.path);
    if (!rows.length) return res.status(400).json({ error: 'No data rows found in file' });
    res.json(await importDuplicates(req.params.category, headers, rows, req.file.originalname, req));
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

router.delete('/duplicates/:category', wrap(async (req, res) => {
  await clearDuplicates(req.params.category, req);
  res.json({ ok: true });
}));

// --- Mappings --------------------------------------------------------------
const MAP_TABLES = {
  course:    { table: 'course_mapping',    key: 'course', value: 'kapp', conflict: 'lower(btrim(course))' },
  lead_code: { table: 'lead_code_mapping', key: 'medium', value: 'code', conflict: 'lower(btrim(medium))' },
};
const mapCfg = (type) => {
  const cfg = MAP_TABLES[type];
  if (!cfg) throw new Error('Unknown mapping type (use course or lead_code)');
  return cfg;
};

router.get('/mappings', wrap(async (req, res) => {
  const cfg = mapCfg(req.query.type);
  const q = (req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = q ? `WHERE ${cfg.key} ILIKE $1 OR ${cfg.value} ILIKE $1` : '';
  const params = q ? [`%${q}%`] : [];
  const rows = await query(
    `SELECT id, ${cfg.key} AS key, ${cfg.value} AS value FROM ${cfg.table} ${where}
     ORDER BY ${cfg.key} LIMIT ${limit} OFFSET ${offset}`, params);
  const total = await query(`SELECT count(*)::int AS n FROM ${cfg.table} ${where}`, params);
  res.json({ rows: rows.rows, total: total.rows[0].n, limit, offset });
}));

router.post('/mappings', wrap(async (req, res) => {
  const cfg = mapCfg(req.body.type);
  const key = (req.body.key || '').trim();
  const value = (req.body.value || '').trim();
  if (!key || !value) return res.status(400).json({ error: 'Both key and value are required' });
  const r = await query(
    `INSERT INTO ${cfg.table} (${cfg.key}, ${cfg.value}) VALUES ($1, $2)
     ON CONFLICT (${cfg.conflict}) DO UPDATE SET ${cfg.value} = EXCLUDED.${cfg.value}
     RETURNING id`, [key, value]);
  invalidateMappings();
  res.json({ id: r.rows[0].id });
}));

router.put('/mappings/:id', wrap(async (req, res) => {
  const cfg = mapCfg(req.body.type);
  const key = (req.body.key || '').trim();
  const value = (req.body.value || '').trim();
  if (!key || !value) return res.status(400).json({ error: 'Both key and value are required' });
  try {
    await query(`UPDATE ${cfg.table} SET ${cfg.key} = $1, ${cfg.value} = $2 WHERE id = $3`,
      [key, value, Number(req.params.id)]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That key already exists' });
    throw e;
  }
  invalidateMappings();
  res.json({ ok: true });
}));

router.delete('/mappings/:id', wrap(async (req, res) => {
  const cfg = mapCfg(req.query.type);
  await query(`DELETE FROM ${cfg.table} WHERE id = $1`, [Number(req.params.id)]);
  invalidateMappings();
  res.json({ ok: true });
}));

router.delete('/mappings/:type/all', wrap(async (req, res) => {
  const cfg = mapCfg(req.params.type);
  await query(`DELETE FROM ${cfg.table}`);
  invalidateMappings();
  res.json({ ok: true });
}));

router.get('/mappings/:type/sample', wrap(async (req, res) => {
  const type = req.params.type;
  mapCfg(type);
  const csv = type === 'course'
    ? 'Course,KAPP Course\nPGDM,MBA/PGDM\nMBA,MBA/PGDM\nBachelor of Design (B.DES),B.Des\n'
    : 'Lead Medium,New Lead Code\nbm79,bm\nAMU01,AMU01\ncad90 AMU01,AMU01\nCTK1026,CTK1026\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}_mapping_sample.csv"`);
  res.send(csv);
}));

router.post('/mappings/:type/upload', upload.single('file'), wrap(async (req, res) => {
  const cfg = mapCfg(req.params.type);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  try {
    const { headers, rows } = parseFile(req.file.path);
    if (headers.length < 2) return res.status(400).json({ error: 'File needs at least two columns (key, value)' });
    const kH = headers[0], vH = headers[1];
    const tuples = [];
    for (const r of rows) {
      const key = String(r[kH] ?? '').trim();
      const val = String(r[vH] ?? '').trim();
      if (key && val) tuples.push([key, val]);
    }
    if (!tuples.length) return res.status(400).json({ error: 'No key/value rows found' });
    const replace = req.body.replace === 'true' || req.body.replace === true;
    let inserted = 0;
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        if (replace) await client.query(`DELETE FROM ${cfg.table}`);
        const BATCH = 500;
        for (let i = 0; i < tuples.length; i += BATCH) {
          const slice = tuples.slice(i, i + BATCH);
          const params = [];
          const values = slice.map((t) => `(${t.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
          await client.query(
            `INSERT INTO ${cfg.table} (${cfg.key}, ${cfg.value}) VALUES ${values.join(',')}
             ON CONFLICT (${cfg.conflict}) DO UPDATE SET ${cfg.value} = EXCLUDED.${cfg.value}`, params);
          inserted += slice.length;
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    });
    invalidateMappings();
    res.json({ count: inserted, replaced: replace });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

// --- Weekly Dump datasets ---------------------------------------------------
router.get('/wd/datasets', wrap(async (req, res) => {
  const cid = await activeWdClientId(req);
  if (!cid) return res.json({ datasets: [] });
  const { rows } = await query(
    `SELECT id, name, source_filename, row_count, uploaded_at, is_active
     FROM datasets WHERE client_id = $1 AND source_type = 'weekly_dump' ORDER BY uploaded_at DESC`, [cid]);
  res.json({ datasets: rows });
}));

router.post('/wd/datasets/:id/activate', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const meta = await query('SELECT client_id FROM datasets WHERE id = $1', [id]);
  const clientId = meta.rows[0]?.client_id;
  if (clientId) await query(
    `UPDATE datasets SET is_active = (id = $1) WHERE client_id = $2 AND source_type = 'weekly_dump'`,
    [id, clientId]);
  res.json({ ok: true });
}));

router.delete('/wd/datasets/:id', wrap(async (req, res) => {
  await query(`DELETE FROM datasets WHERE id = $1 AND source_type = 'weekly_dump'`, [Number(req.params.id)]);
  res.json({ ok: true });
}));

// --- Weekly Dump datasets tree (all clients → datasets → sheets) -----------
router.get('/wd/datasets/tree', wrap(async (req, res) => {
  const { rows: clients } = await query(
    `SELECT id, name FROM clients WHERE section = 'weekly_dump' ORDER BY name`);
  const tree = [];
  for (const c of clients) {
    const { rows: datasets } = await query(
      `SELECT id, name, source_filename, row_count, uploaded_at, is_active
       FROM datasets WHERE client_id = $1 AND source_type = 'weekly_dump' ORDER BY uploaded_at DESC`, [c.id]);
    const dsItems = [];
    for (const ds of datasets) {
      const { rows: sheetRows } = await query(
        `SELECT data->>'_sheet' AS sheet, count(*)::int AS cnt
         FROM leads WHERE dataset_id = $1 GROUP BY data->>'_sheet' ORDER BY 1`, [ds.id]);
      const sheets = sheetRows.map((r) => ({ name: r.sheet || 'Data', rowCount: r.cnt }));
      dsItems.push({ id: ds.id, name: ds.name || ds.source_filename || 'Untitled', filename: ds.source_filename, rowCount: ds.row_count, uploadedAt: ds.uploaded_at, isActive: ds.is_active, sheets });
    }
    tree.push({ clientId: c.id, clientName: c.name, datasets: dsItems });
  }
  res.json({ tree });
}));

router.get('/wd/datasets/:id/view', wrap(async (req, res) => {
  const dsId = Number(req.params.id);
  const sheet = req.query.sheet || null;
  let sql = `SELECT data FROM leads WHERE dataset_id = $1`;
  const params = [dsId];
  if (sheet) {
    sql += ` AND data->>'_sheet' = $2`;
    params.push(sheet);
  }
  sql += ' ORDER BY id';
  const { rows } = await query(sql, params);
  const data = rows.map((r) => {
    const { _sheet, ...rest } = r.data;
    return rest;
  });
  const columns = data.length ? Object.keys(data[0]) : [];
  res.json({ columns, rows: data });
}));

// --- Weekly Dump report -----------------------------------------------------
function buildGenericReport(allRows, { trackingId, crmType, clientName, settings }) {
  const getCol = (row, name) => {
    if (!row || !name) return '';
    const lower = name.toLowerCase();
    for (const k of Object.keys(row)) {
      if (k === '_sheet') continue;
      if (k.toLowerCase() === lower) return row[k] ?? '';
    }
    return '';
  };

  const medCol      = settings.medium_column   || 'MEDIUM';
  const srcCol      = settings.source_column   || 'Source';
  const srcValFixed = settings.source_value    || '';
  const campCol     = settings.campaign_column || 'Campaign';
  const ltCol    = settings.lead_type_column|| 'LeadType';
  const verCol   = settings.verified_column || '';
  const verVal   = (settings.verified_value || 'Verified').toLowerCase();
  const priVal   = (settings.primary_value   || 'Primary').toLowerCase();
  const secVal   = (settings.secondary_value || 'Secondary').toLowerCase();
  const terVal   = (settings.tertiary_value  || 'Tertiary').toLowerCase();

  const toSet = (arr) => new Set((arr || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean));
  const fiVals  = toSet(settings.fi_values);
  const appVals = toSet(settings.app_values);
  const admVals = toSet(settings.adm_values);
  const fiCol   = settings.fi_column  || '';
  const appCol  = settings.app_column || '';
  const admCol  = settings.adm_column || '';

  const matches = (row, col, vals) => vals.size > 0 && col && vals.has(String(getCol(row, col)).trim().toLowerCase());

  const byMedium = {};
  for (const row of allRows) {
    if (row._sheet) continue;
    const med = String(getCol(row, medCol)).trim() || '(unknown)';
    if (!byMedium[med]) byMedium[med] = [];
    byMedium[med].push(row);
  }

  const reportRows = [];
  for (const [medium, rows] of Object.entries(byMedium)) {
    const source   = srcValFixed || String(getCol(rows[0], srcCol)).trim();
    const campaign = getCol(rows[0], campCol);

    const primary   = rows.filter((r) => String(getCol(r, ltCol)).trim().toLowerCase() === priVal);
    const secondary = rows.filter((r) => String(getCol(r, ltCol)).trim().toLowerCase() === secVal);
    const tertiary  = rows.filter((r) => String(getCol(r, ltCol)).trim().toLowerCase() === terVal);

    const verified   = verCol ? primary.filter((r) => String(getCol(r, verCol)).trim().toLowerCase() === verVal).length : 0;
    const unverified = primary.length - verified;

    const fi_p  = primary.filter((r) => matches(r, fiCol, fiVals)).length;
    const fi_s  = secondary.filter((r) => matches(r, fiCol, fiVals)).length;
    const fi_t  = tertiary.filter((r) => matches(r, fiCol, fiVals)).length;
    const app_p = primary.filter((r) => matches(r, appCol, appVals)).length;
    const app_s = secondary.filter((r) => matches(r, appCol, appVals)).length;
    const app_t = tertiary.filter((r) => matches(r, appCol, appVals)).length;
    const adm_p = primary.filter((r) => matches(r, admCol, admVals)).length;
    const adm_s = secondary.filter((r) => matches(r, admCol, admVals)).length;
    const adm_t = tertiary.filter((r) => matches(r, admCol, admVals)).length;

    reportRows.push({
      tracking_id: trackingId,
      crm: crmType,
      client_name: clientName,
      source,
      medium,
      campaign_name: String(campaign),
      primary_leads:    primary.length,
      secondary_leads:  secondary.length,
      tertiary_leads:   tertiary.length,
      total_instances:  rows.length,
      verified_leads:   verified,
      unverified_leads: unverified,
      form_initiated:   fi_p,
      payment_approved: app_p,
      enrolments:       adm_p,
      duplicate_leads:  secondary.length + tertiary.length,
      duplicate_fi:     fi_s  + fi_t,
      duplicate_app:    app_s + app_t,
      duplicate_adm:    adm_s + adm_t,
    });
  }

  reportRows.sort((a, b) => b.primary_leads - a.primary_leads);

  const numKeys = ['primary_leads', 'secondary_leads', 'tertiary_leads', 'total_instances',
    'verified_leads', 'unverified_leads', 'form_initiated', 'payment_approved', 'enrolments',
    'duplicate_leads', 'duplicate_fi', 'duplicate_app', 'duplicate_adm'];
  const totals = {};
  for (const key of numKeys) totals[key] = reportRows.reduce((s, r) => s + (r[key] || 0), 0);

  return { rows: reportRows, totals };
}

function buildNpfReport(allRows, { trackingId, crmType, clientName }) {
  const getCol = (row, name) => {
    if (!row) return '';
    const lower = name.toLowerCase();
    for (const k of Object.keys(row)) {
      if (k === '_sheet') continue;
      if (k.toLowerCase() === lower) return row[k];
    }
    return '';
  };
  const num = (v) => Number(v) || 0;

  const bySheet = {};
  for (const row of allRows) {
    const s = row._sheet || '';
    if (!bySheet[s]) bySheet[s] = [];
    bySheet[s].push(row);
  }

  const categorize = (sheetName) => {
    const s = sheetName.toLowerCase().replace(/[^a-z]/g, '');
    if (s.includes('lead')) return 'leads';
    if (s.includes('form') || s.startsWith('fi')) return 'fi';
    if (s.includes('app') || s.includes('payment')) return 'app';
    if (s.includes('adm') || s.includes('enrol')) return 'adm';
    return null;
  };

  const catRows = { leads: [], fi: [], app: [], adm: [] };
  for (const [sheet, rows] of Object.entries(bySheet)) {
    const cat = categorize(sheet);
    if (cat) catRows[cat].push(...rows);
  }

  const buildLookup = (sheetRows) => {
    const lookup = {};
    for (const row of sheetRows) {
      const med = String(getCol(row, 'Medium')).trim();
      if (!med) continue;
      if (!lookup[med]) { lookup[med] = {}; }
      for (const k of Object.keys(row)) {
        if (k === '_sheet') continue;
        const v = Number(row[k]);
        if (!isNaN(v) && row[k] !== '' && row[k] !== null) {
          lookup[med][k] = (lookup[med][k] || 0) + v;
        } else if (!(k in lookup[med])) {
          lookup[med][k] = row[k];
        }
      }
    }
    return lookup;
  };

  const leadsLookup = buildLookup(catRows.leads);
  const fiLookup = buildLookup(catRows.fi);
  const appLookup = buildLookup(catRows.app);
  const admLookup = buildLookup(catRows.adm);

  const allMediums = new Set([
    ...Object.keys(leadsLookup),
    ...Object.keys(fiLookup),
    ...Object.keys(appLookup),
    ...Object.keys(admLookup),
  ]);

  const reportRows = [];
  for (const medium of allMediums) {
    const lead = leadsLookup[medium];
    const fi = fiLookup[medium];
    const app = appLookup[medium];
    const adm = admLookup[medium];

    const source = getCol(lead || fi || app || adm, 'Source');
    const campaign = getCol(lead || fi || app || adm, 'Campaign Name') || getCol(lead || fi || app || adm, 'Campaign');

    const primaryLeads = num(getCol(lead, 'Primary Leads'));
    const secondaryLeads = num(getCol(lead, 'Secondary Leads'));
    const tertiaryLeads = num(getCol(lead, 'Tertiary Leads'));
    const verifiedLeads = num(getCol(lead, 'Verified Leads'));
    const unverifiedLeads = num(getCol(lead, 'Unverified Leads'));

    reportRows.push({
      tracking_id: trackingId,
      crm: crmType,
      client_name: clientName,
      source,
      medium,
      campaign_name: String(campaign),
      primary_leads: primaryLeads,
      secondary_leads: secondaryLeads,
      tertiary_leads: tertiaryLeads,
      total_instances: primaryLeads + secondaryLeads + tertiaryLeads,
      verified_leads: verifiedLeads,
      unverified_leads: unverifiedLeads,
      form_initiated: num(getCol(fi, 'Primary Leads')),
      payment_approved: num(getCol(app, 'Primary Leads')),
      enrolments: num(getCol(adm, 'Primary Leads')),
      duplicate_leads: secondaryLeads + tertiaryLeads,
      duplicate_fi: num(getCol(fi, 'Secondary Leads')) + num(getCol(fi, 'Tertiary Leads')),
      duplicate_app: num(getCol(app, 'Secondary Leads')) + num(getCol(app, 'Tertiary Leads')),
      duplicate_adm: num(getCol(adm, 'Secondary Leads')) + num(getCol(adm, 'Tertiary Leads')),
    });
  }

  reportRows.sort((a, b) => b.primary_leads - a.primary_leads);

  const numKeys = ['primary_leads', 'secondary_leads', 'tertiary_leads', 'total_instances',
    'verified_leads', 'unverified_leads', 'form_initiated', 'payment_approved', 'enrolments',
    'duplicate_leads', 'duplicate_fi', 'duplicate_app', 'duplicate_adm'];
  const totals = {};
  for (const key of numKeys) totals[key] = reportRows.reduce((s, r) => s + (r[key] || 0), 0);

  return { rows: reportRows, totals };
}

router.get('/wd/report', wrap(async (req, res) => {
  const cid = await activeWdClientId(req);
  if (!cid) return res.json({ empty: true, reason: 'no_client' });

  const clientInfo = await query('SELECT name FROM clients WHERE id = $1', [cid]);
  const clientName = clientInfo.rows[0]?.name || '';
  const settingsRes = await query('SELECT config FROM wd_client_settings WHERE client_id = $1', [cid]);
  const wdSettings = settingsRes.rows[0]?.config || {};
  const crmType = wdSettings.crm_type || '';
  const trackingId = wdSettings.tracking_id || '';

  const dsMeta = await query(
    `SELECT id, name, uploaded_at FROM datasets
     WHERE client_id = $1 AND source_type = 'weekly_dump' AND is_active = true
     LIMIT 1`, [cid]);
  if (!dsMeta.rows.length) return res.json({ empty: true, reason: 'no_dataset' });

  const ds = dsMeta.rows[0];
  const { rows } = await query(
    `SELECT data FROM leads WHERE dataset_id = $1 ORDER BY id`, [ds.id]);
  const allRows = rows.map((r) => r.data);

  if (crmType === 'NPF') {
    const report = buildNpfReport(allRows, { trackingId, crmType, clientName });
    return res.json({ empty: false, crmType: 'NPF', dataset: { name: ds.name, uploaded_at: ds.uploaded_at }, report });
  }

  if (wdSettings.fi_column || wdSettings.medium_column) {
    const report = buildGenericReport(allRows, { trackingId, crmType, clientName, settings: wdSettings });
    return res.json({ empty: false, crmType, dataset: { name: ds.name, uploaded_at: ds.uploaded_at }, report });
  }

  const sheetMap = {};
  const sheetOrder = [];
  for (const row of allRows) {
    const sheet = row._sheet || 'Data';
    if (!sheetMap[sheet]) { sheetMap[sheet] = []; sheetOrder.push(sheet); }
    const { _sheet, ...rest } = row;
    sheetMap[sheet].push(rest);
  }
  const sheets = sheetOrder.map((name) => {
    const sheetRows = sheetMap[name];
    const columns = sheetRows.length ? Object.keys(sheetRows[0]) : [];
    return { name, columns, rows: sheetRows };
  });
  res.json({ empty: false, crmType, dataset: { name: ds.name, uploaded_at: ds.uploaded_at }, sheets });
}));

// --- Weekly Dump upload: per-category (NPF 4-file mode) --------------------
router.post('/wd/upload/category', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const cid = await activeWdClientId(req);
  if (!cid) return res.status(400).json({ error: 'No active Weekly Dump client' });
  const category = req.body.category;
  if (!category) return res.status(400).json({ error: 'category required' });

  const SHEET_NAMES = { leads: 'Leads-Medium', fi: 'FI-Medium', apps: 'App-Medium', adm: 'Adm-Medium' };
  const sheetName = SHEET_NAMES[category] || category;

  try {
    const { headers, rows } = parseFile(req.file.path);
    if (!rows.length) return res.status(400).json({ error: 'No data rows found' });

    const taggedRows = rows.map((r) => ({ ...r, _sheet: sheetName }));

    const existing = await query(
      `SELECT id FROM datasets WHERE client_id = $1 AND source_type = 'weekly_dump' AND is_active = true LIMIT 1`, [cid]);

    let datasetId;
    if (existing.rows.length) {
      datasetId = existing.rows[0].id;
      await query(`DELETE FROM leads WHERE dataset_id = $1 AND data->>'_sheet' = $2`, [datasetId, sheetName]);
    } else {
      datasetId = await startWdDataset({ name: 'NPF Upload', filename: req.file.originalname, headers: [...headers, '_sheet'] }, req);
      await query(`UPDATE datasets SET is_active = (id = $1) WHERE client_id = $2 AND source_type = 'weekly_dump'`, [datasetId, cid]);
    }

    await appendWdRows(datasetId, taggedRows);
    const cnt = await query('SELECT count(*)::int AS n FROM leads WHERE dataset_id = $1', [datasetId]);
    await query('UPDATE datasets SET row_count = $1 WHERE id = $2', [cnt.rows[0].n, datasetId]);

    res.json({ datasetId, rowCount: taggedRows.length, totalRows: cnt.rows[0].n });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

// --- Weekly Dump upload (XLSX multi-sheet, single request) -----------------
router.post('/wd/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
  const cid = await activeWdClientId(req);
  if (!cid) return res.status(400).json({ error: 'No active Weekly Dump client. Create one in the Clients tab first.' });
  try {
    const sheets = parseFileAllSheets(req.file.path);
    const allRows = sheets.flatMap((s) => s.rows);
    const allHeaders = [...new Set(sheets.flatMap((s) => s.headers))];
    if (!allRows.length) return res.status(400).json({ error: 'No data rows found in file' });
    const datasetId = await startWdDataset({
      name: req.body.name || req.file.originalname,
      filename: req.file.originalname,
      headers: allHeaders,
    }, req);
    await appendWdRows(datasetId, allRows);
    const rowCount = await finishWdDataset(datasetId);
    res.json({ datasetId, rowCount, sheetCount: sheets.length });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

// --- Weekly Dump upload (chunked, browser-parsed) ---------------------------
router.post('/wd/upload/start', wrap(async (req, res) => {
  const cid = await activeWdClientId(req);
  if (!cid) return res.status(400).json({ error: 'No active Weekly Dump client. Create one in the Clients tab first.' });
  const { name, filename, headers } = req.body || {};
  const datasetId = await startWdDataset({ name, filename, headers }, req);
  res.json({ datasetId });
}));

router.post('/wd/upload/rows', wrap(async (req, res) => {
  const { datasetId, rows } = req.body || {};
  if (!datasetId || !Array.isArray(rows)) return res.status(400).json({ error: 'datasetId and rows[] required' });
  const inserted = await appendWdRows(Number(datasetId), rows);
  res.json({ inserted });
}));

router.post('/wd/upload/finish', wrap(async (req, res) => {
  const { datasetId } = req.body || {};
  if (!datasetId) return res.status(400).json({ error: 'datasetId required' });
  const rowCount = await finishWdDataset(Number(datasetId));
  res.json({ ok: true, rowCount });
}));

// --- Weekly Dump upload merge (multiple files → one dataset) ----------------
router.post('/wd/upload/merge', upload.array('files', 20), wrap(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const cid = await activeWdClientId(req);
  if (!cid) return res.status(400).json({ error: 'No active Weekly Dump client. Create one in the Clients tab first.' });
  const tmpPaths = req.files.map((f) => f.path);
  try {
    const allHeadersSet = new Set();
    const fileData = [];
    for (const file of req.files) {
      const { headers, rows } = parseFile(file.path);
      if (rows.length) { headers.forEach((h) => allHeadersSet.add(h)); fileData.push({ rows }); }
    }
    if (!fileData.length) return res.status(400).json({ error: 'No data rows found in any file' });
    const mergedHeaders = [...allHeadersSet];
    const mergedRows = fileData.flatMap(({ rows }) => rows.map((row) => {
      const out = {};
      for (const h of mergedHeaders) out[h] = row[h] ?? '';
      return out;
    }));
    const name = (req.body.name || '').trim() || `Merged (${fileData.length} files)`;
    const datasetId = await startWdDataset({ name, filename: name, headers: mergedHeaders }, req);
    await appendWdRows(datasetId, mergedRows);
    const rowCount = await finishWdDataset(datasetId);
    res.json({ datasetId, rowCount, fileCount: fileData.length });
  } finally {
    tmpPaths.forEach((p) => fs.unlink(p, () => {}));
  }
}));

// --- Weekly Dump settings ---------------------------------------------------
router.get('/wd/settings', wrap(async (req, res) => {
  const cid = await activeWdClientId(req);
  if (!cid) return res.json({ settings: {} });
  const { rows } = await query('SELECT config FROM wd_client_settings WHERE client_id = $1', [cid]);
  res.json({ settings: rows[0]?.config || {} });
}));

router.put('/wd/settings', wrap(async (req, res) => {
  const cid = await activeWdClientId(req);
  if (!cid) return res.status(400).json({ error: 'No active WD client' });
  await query(
    `INSERT INTO wd_client_settings (client_id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (client_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [cid, JSON.stringify(req.body || {})]);
  res.json({ ok: true });
}));

export default router;
