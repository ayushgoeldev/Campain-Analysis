import { query } from './db.js';

// ---- Campaign Analysis clients --------------------------------------------

export async function activeClientId(req) {
  if (req?._clientId) return req._clientId;
  let id;
  if (req) {
    const { getSessionClientId } = await import('./auth.js');
    const sessionClientId = await getSessionClientId(req);
    if (sessionClientId) {
      const { rows } = await query(
        "SELECT id FROM clients WHERE id = $1 AND section = 'campaign'", [sessionClientId]);
      if (rows.length) id = rows[0].id;
    }
  }
  if (!id) {
    const { rows } = await query(
      "SELECT id FROM clients WHERE section = 'campaign' ORDER BY id LIMIT 1");
    if (rows.length) id = rows[0].id;
  }
  if (!id) {
    const ins = await query(
      "INSERT INTO clients (name, is_active, section) VALUES ('Default Client', true, 'campaign') RETURNING id");
    id = ins.rows[0].id;
  }
  if (req) req._clientId = id;
  return id;
}

export async function activeClient(req) {
  const id = await activeClientId(req);
  const { rows } = await query('SELECT id, name FROM clients WHERE id = $1', [id]);
  return rows[0] || { id, name: 'Default Client' };
}

export async function listClients(q = '', section = 'campaign') {
  const params = [section];
  let where = 'WHERE c.section = $1';
  if (q) { params.push(`%${q}%`); where += ` AND c.name ILIKE $${params.length}`; }
  const { rows } = await query(
    `SELECT c.id, c.name,
       (SELECT COALESCE(SUM(row_count), 0) FROM datasets d WHERE d.client_id = c.id)::int AS rows,
       (SELECT count(*) FROM duplicate_uploads du WHERE du.client_id = c.id)::int AS dup_files
     FROM clients c ${where}
     ORDER BY lower(c.name)`, params);
  return rows;
}

export async function createClient(name, req, section = 'campaign') {
  const ins = await query(
    'INSERT INTO clients (name, is_active, section) VALUES ($1, false, $2) RETURNING id',
    [name || 'New Client', section]);
  const id = ins.rows[0].id;
  if (section === 'campaign') {
    const { defaultSettings, saveSettingsFor } = await import('./settings.js');
    const def = await defaultSettings();
    await saveSettingsFor(id, { ...def, report_title: name || 'New Client' });
    await activateClient(id, req);
  } else {
    await activateWdClient(id, req);
  }
  return id;
}

export async function activateClient(id, req) {
  if (req) {
    const { setSessionClientId } = await import('./auth.js');
    await setSessionClientId(req, Number(id));
  }
}

// ---- Weekly Dump clients --------------------------------------------------

export async function activeWdClientId(req) {
  if (req?._wdClientId) return req._wdClientId;
  let id;
  if (req) {
    const { getSessionWdClientId } = await import('./auth.js');
    const sessionClientId = await getSessionWdClientId(req);
    if (sessionClientId) {
      const { rows } = await query(
        "SELECT id FROM clients WHERE id = $1 AND section = 'weekly_dump'", [sessionClientId]);
      if (rows.length) id = rows[0].id;
    }
  }
  if (!id) {
    const { rows } = await query(
      "SELECT id FROM clients WHERE section = 'weekly_dump' ORDER BY id LIMIT 1");
    if (rows.length) id = rows[0].id;
  }
  // No auto-create for WD clients — must be created explicitly
  if (req) req._wdClientId = id || null;
  return id || null;
}

export async function activeWdClient(req) {
  const id = await activeWdClientId(req);
  if (!id) return null;
  const { rows } = await query('SELECT id, name FROM clients WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function activateWdClient(id, req) {
  if (req) {
    const { setSessionWdClientId } = await import('./auth.js');
    await setSessionWdClientId(req, Number(id));
  }
}

// ---- Shared ---------------------------------------------------------------

export async function renameClient(id, name) {
  await query('UPDATE clients SET name = $2 WHERE id = $1', [Number(id), name]);
}

export async function deleteClient(id) {
  const cid = Number(id);
  await query('DELETE FROM datasets WHERE client_id = $1', [cid]);
  await query('DELETE FROM duplicate_rows WHERE client_id = $1', [cid]);
  await query('DELETE FROM duplicate_uploads WHERE client_id = $1', [cid]);
  await query('DELETE FROM annotations WHERE client_id = $1', [cid]);
  await query('DELETE FROM client_settings WHERE client_id = $1', [cid]);
  await query('DELETE FROM wd_client_settings WHERE client_id = $1', [cid]).catch(() => {});
  await query('DELETE FROM clients WHERE id = $1', [cid]);
}
