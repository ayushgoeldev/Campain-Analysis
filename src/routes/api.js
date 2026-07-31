import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import { query, withClient } from '../db.js';
import { getSettings, saveSettings, defaultSettings } from '../settings.js';
import { parseFile, importRows, recomputeDataset, startDataset, appendRows, finishDataset } from '../importer.js';
import { invalidateMappings } from '../mappings.js';
import { fullReport, resolveDataset, preview } from '../report.js';
import { reportToXlsx } from '../reportxlsx.js';
import { importDuplicates, duplicatePreview, duplicatesSummary, clearDuplicates } from '../duplicates.js';
import { activeClientId, activeClient, listClients, createClient, activateClient, renameClient, deleteClient } from '../clients.js';

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
  // Keep the client's name in sync with the report title typed in SETUP.
  const title = (req.body && req.body.report_title || '').trim();
  if (title) await renameClient(await activeClientId(req), title);
  res.json({ settings: saved });
}));

// --- Clients ---------------------------------------------------------------
router.get('/clients', wrap(async (req, res) => {
  res.json({ clients: await listClients((req.query.q || '').trim()), active: await activeClient(req) });
}));

router.post('/clients', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const id = await createClient(name, req);
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

// --- Datasets (scoped to the active client) --------------------------------
router.get('/datasets', wrap(async (req, res) => {
  const cid = await activeClientId(req);
  const { rows } = await query(
    `SELECT id, name, source_filename, row_count, uploaded_at, is_active
     FROM datasets WHERE client_id = $1 ORDER BY uploaded_at DESC`, [cid]);
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

// --- Chunked upload (browser parses the CSV and sends rows in small batches) -
// Works from any browser and avoids the serverless per-request body limit.
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

// Recompute derived fields for the active (or given) dataset.
router.post('/recompute', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.body?.datasetId, req);
  if (!datasetId) return res.status(400).json({ error: 'No dataset to recompute' });
  res.json(await recomputeDataset(datasetId, req));
}));

// --- Report ----------------------------------------------------------------
router.get('/report', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.query.datasetId, req);
  if (!datasetId) return res.json({ empty: true });
  res.json(await fullReport(datasetId, req));
}));

// Full report as a downloadable .xlsx (one sheet per table).
router.get('/report.xlsx', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.query.datasetId, req);
  if (!datasetId) return res.status(400).json({ error: 'No data to export' });
  const { buf, filename } = await reportToXlsx(datasetId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}));

// Column headers + sample rows of the active dataset (for configuring SETUP).
router.get('/preview', wrap(async (req, res) => {
  const datasetId = await resolveDataset(req.query.datasetId, req);
  if (!datasetId) return res.json({ empty: true });
  const limit = Math.min(Number(req.query.limit) || 8, 50);
  res.json(await preview(datasetId, limit, req));
}));

// --- Annotations (editable Insights / Challenges) --------------------------
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

// --- Mappings (course / lead code) ----------------------------------------
// Column names come only from this fixed config, never from user input.
const MAP_TABLES = {
  course:    { table: 'course_mapping',    key: 'course', value: 'kapp', conflict: 'lower(btrim(course))' },
  lead_code: { table: 'lead_code_mapping', key: 'medium', value: 'code', conflict: 'lower(btrim(medium))' },
};
const mapCfg = (type) => {
  const cfg = MAP_TABLES[type];
  if (!cfg) throw new Error('Unknown mapping type (use course or lead_code)');
  return cfg;
};

// List with optional search + pagination.
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

// Add or update-by-key (upsert on the case-insensitive key).
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

// Edit an existing row by id.
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

// Delete ALL mappings of a type.
router.delete('/mappings/:type/all', wrap(async (req, res) => {
  const cfg = mapCfg(req.params.type);
  await query(`DELETE FROM ${cfg.table}`);
  invalidateMappings();
  res.json({ ok: true });
}));

// Download a sample file showing the expected two-column format.
router.get('/mappings/:type/sample', wrap(async (req, res) => {
  const type = req.params.type;
  mapCfg(type); // validate
  const csv = type === 'course'
    ? 'Course,KAPP Course\nPGDM,MBA/PGDM\nMBA,MBA/PGDM\nBachelor of Design (B.DES),B.Des\n'
    : 'Lead Medium,New Lead Code\nbm79,bm\nAMU01,AMU01\ncad90 AMU01,AMU01\nCTK1026,CTK1026\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}_mapping_sample.csv"`);
  res.send(csv);
}));

// Bulk upload mappings from a CSV/XLSX (first column = key, second = value).
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


export default router;