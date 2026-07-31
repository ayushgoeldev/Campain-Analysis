import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from './db.js';

const SESSION_COOKIE = 'lead_report_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return ['', ''];
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
  }).filter(([key]) => key));
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function cookieOptions(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL === '1';
  return {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

function configuredUser() {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

export async function getSessionClientId(req) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;
  try {
    const { rows } = await query(
      `SELECT active_client_id FROM sessions WHERE id = $1 AND created_at > now() - interval '12 hours'`,
      [sessionId]
    );
    return rows[0]?.active_client_id || null;
  } catch {
    return null;
  }
}

export async function setSessionClientId(req, clientId) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return;
  await query(
    `UPDATE sessions SET active_client_id = $1 WHERE id = $2`,
    [clientId, sessionId]
  ).catch(() => {});
}

export async function isAuthed(req) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return false;
  try {
    const { rows } = await query(
      `SELECT id FROM sessions WHERE id = $1 AND created_at > now() - interval '12 hours'`,
      [sessionId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function requireAuth(req, res, next) {
  if (await isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  return res.redirect('/login.html');
}

export const authRouter = Router();

authRouter.get('/session', async (req, res) => {
  res.json({ authenticated: await isAuthed(req) });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = configuredUser();
  if (!user) return res.status(503).json({ error: 'Login is not configured' });
  if (!constantTimeEqual(username, user.username) || !constantTimeEqual(password, user.password)) {
    return res.status(401).json({ error: 'Invalid ID or password' });
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  try {
    await query(
      `INSERT INTO sessions (id, created_at) VALUES ($1, now())`,
      [sessionId]
    );
  } catch {
    return res.status(500).json({ error: 'Failed to create session' });
  }
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions(req));
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sessionId) {
    await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]).catch(() => {});
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});