import { query } from './db.js';

// req is passed through so we can read/write the session's active client.
export async function activeClientId(req) {
  // 1. Try session-scoped active client first
  if (req) {
    const { getSessionClientId } = await import('./auth.js');
    const sessionClientId = await getSessionClientId(req);
    if (sessionClientId) {
      const { rows } = await query('SELECT id FROM clients WHERE id = $1', [sessionClientId]);
      if (rows.length) return rows[0].id;
    }
  }

  // 2. Fall back to first client (no global is_active dependency)
  const { rows } = await query('SELECT id FROM clients ORDER BY id LIMIT 1');
  if (rows.length) return rows[0].id;

  // 3. Create default client if none exists
  const ins = await query("INSERT INTO clients (name, is_active) VALUES ('Default Client', true) RETURNING id");
  return ins.rows[0].id;
}

export async function activeClient(req) {
  const id = await activeClientId(req);
  const { rows } = await query('SELECT id, name FROM clients WHERE id = $1', [id]);
  return rows[0] || { id, name: 'Default Client' };
}

export async function listClients(q = '') {
  const where = q ? 'WHERE c.name ILIKE $1' : '';
  const params = q ? [`%${q}%`] : [];
  const { rows } = await query(
    `SELECT c.id, c.name,
       (SELECT COALESCE(SUM(row_count), 0) FROM datasets d WHERE d.client_id = c.id)::int AS rows,
       (SELECT count(*) FROM duplicate_uploads du WHERE du.client_id = c.id)::int AS dup_files
     FROM clients c ${where}
     ORDER BY lower(c.name)`, params);
  return rows;
}

export async function createClient(name, req) {
  const ins = await query('INSERT INTO clients (name, is_active) VALUES ($1, false) RETURNING id', [name || 'New Client']);
  const id = ins.rows[0].id;
  const { defaultSettings, saveSettingsFor } = await import('./settings.js');
  const def = await defaultSettings();
  await saveSettingsFor(id, { ...def, report_title: name || 'New Client' });
  await activateClient(id, req);
  return id;
}

export async function activateClient(id, req) {
  // Only update session — never touch the global DB flag
  if (req) {
    const { setSessionClientId } = await import('./auth.js');
    await setSessionClientId(req, Number(id));
  }
}

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
  await query('DELETE FROM clients WHERE id = $1', [cid]);
}