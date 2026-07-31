import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from './db.js';
import { activeClientId } from './clients.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultsPath = path.join(here, '..', 'db', 'seed', 'default_settings.json');

let defaultsCache = null;
export async function defaultSettings() {
  if (!defaultsCache) defaultsCache = JSON.parse(await readFile(defaultsPath, 'utf8'));
  return { ...defaultsCache };
}

export async function getSettings(req) {
  const clientId = await activeClientId(req);
  const { rows } = await query('SELECT config FROM client_settings WHERE client_id = $1', [clientId]);
  if (rows.length) return rows[0].config;
  const def = await defaultSettings();
  await saveSettingsFor(clientId, def);
  return def;
}

export async function saveSettings(config, req) {
  return saveSettingsFor(await activeClientId(req), config);
}

export async function saveSettingsFor(clientId, config) {
  await query(
    `INSERT INTO client_settings (client_id, config, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (client_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [clientId, config]);
  return config;
}