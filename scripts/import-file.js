// Bulk-import a CSV/XLSX export into Postgres from the command line.
// Usage: node scripts/import-file.js <path-to-file> [--header-row N] [--name "Week 30"]
import { pool } from '../src/db.js';
import { parseFile, importRows } from '../src/importer.js';

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/import-file.js <file.csv|.xlsx> [--header-row N] [--name "..."]');
    process.exit(1);
  }
  const hrIdx = args.indexOf('--header-row');
  const headerRow = hrIdx >= 0 ? Number(args[hrIdx + 1]) : null;
  const nameIdx = args.indexOf('--name');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

  console.log(`Parsing ${file} ...`);
  const { headers, rows } = parseFile(file, { headerRow });
  console.log(`  ${rows.length} rows, ${headers.length} columns`);
  console.log('Importing into Postgres ...');
  const result = await importRows(rows, { name, filename: file.split('/').pop(), headers });
  console.log(`✓ dataset #${result.datasetId} loaded with ${result.rowCount} rows`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
