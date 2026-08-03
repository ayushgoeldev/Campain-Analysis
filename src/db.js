import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Prefer DATABASE_URL; otherwise fall back to standard PG* env vars.
const config = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'leadreport',
    };

// Always disable SSL cert verification for managed Postgres (AWS RDS, Neon, Supabase etc.)
config.ssl = { rejectUnauthorized: false };

export const pool = new pg.Pool(config);

export function query(text, params) {
  return pool.query(text, params);
}

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}