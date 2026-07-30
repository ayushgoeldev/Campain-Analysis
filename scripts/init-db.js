// Create the schema and seed lookups + default settings.
// Usage: node scripts/init-db.js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, query, withClient } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const seedDir = path.join(root, 'db', 'seed');

async function run() {
  const schema = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8');
  await query(schema);
  console.log('✓ schema created');

  const courses = JSON.parse(await readFile(path.join(seedDir, 'course_mapping.json'), 'utf8'));
  const codes = JSON.parse(await readFile(path.join(seedDir, 'lead_code_mapping.json'), 'utf8'));
  const settings = JSON.parse(await readFile(path.join(seedDir, 'default_settings.json'), 'utf8'));

  await seed('course_mapping', ['course', 'kapp'], courses.map((r) => [r.course, r.kapp]),
    'ON CONFLICT (lower(btrim(course))) DO NOTHING');
  console.log(`✓ seeded course_mapping (${courses.length} rows)`);

  await seed('lead_code_mapping', ['medium', 'code'], codes.map((r) => [r.medium, r.code]),
    'ON CONFLICT (lower(btrim(medium))) DO NOTHING');
  console.log(`✓ seeded lead_code_mapping (${codes.length} rows)`);

  await query(
    `INSERT INTO settings (id, config) VALUES (1, $1)
     ON CONFLICT (id) DO NOTHING`, [settings]);
  console.log('✓ default settings ready');

  await pool.end();
  console.log('Done.');
}

async function seed(table, cols, tuples, conflict) {
  if (!tuples.length) return;
  await withClient(async (client) => {
    const BATCH = 500;
    for (let i = 0; i < tuples.length; i += BATCH) {
      const slice = tuples.slice(i, i + BATCH);
      const params = [];
      const values = slice.map((tuple) => {
        const ph = tuple.map((v) => { params.push(v); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      await client.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')} ${conflict}`,
        params
      );
    }
  });
}

run().catch((err) => { console.error(err); process.exit(1); });
