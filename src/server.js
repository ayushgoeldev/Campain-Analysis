import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import api from './routes/api.js';
import { authRouter, isAuthed, requireAuth } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '50mb' }));
const publicDir = path.join(here, '..', 'public');


// Temp debug routes - remove after testing
app.get('/api/debug-env', (req, res) => {
  res.json({
    hasUsername: !!process.env.APP_USERNAME,
    hasPassword: !!process.env.APP_PASSWORD,
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    hasPgHost: !!process.env.PGHOST,
  });
});
app.get('/api/debug-db', async (req, res) => {
  try {
    const { query } = await import('./db.js');
    await query('SELECT 1');
    const tables = await query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    res.json({ connected: true, tables: tables.rows.map(r => r.tablename) });
  } catch(e) {
    res.json({ connected: false, error: e.message });
  }
});

app.use('/api/auth', authRouter);
app.get('/login.html', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get(['/favicon.svg', '/logo.svg'], (req, res) => res.sendFile(path.join(publicDir, req.path.slice(1))));
app.get('/', (req, res, next) => {
  if (isAuthed(req)) return next();
  return res.redirect('/login.html');
});
app.use('/api', requireAuth, api);
app.use(requireAuth, express.static(publicDir));

export default app;