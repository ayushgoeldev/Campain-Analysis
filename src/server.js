import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import api from './routes/api.js';
import { authRouter, isAuthed, requireAuth } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '5mb' }));
const publicDir = path.join(here, '..', 'public');

// ✅ Add this BEFORE any auth middleware
app.get('/api/debug-env', (req, res) => {
  res.json({
    hasUsername: !!process.env.APP_USERNAME,
    hasPassword: !!process.env.APP_PASSWORD,
  });
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