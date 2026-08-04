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

function configuredUsers() {
  const users = [];
  const adminUser = process.env.ADMIN_USERNAME || process.env.APP_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD;
  if (adminUser && adminPass) users.push({ username: adminUser, password: adminPass, role: 'admin' });
  const viewUser = process.env.USER_USERNAME;
  const viewPass = process.env.USER_PASSWORD;
  if (viewUser && viewPass) users.push({ username: viewUser, password: viewPass, role: 'user' });
  return users;
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

export async function getSessionWdClientId(req) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;
  try {
    const { rows } = await query(
      `SELECT active_wd_client_id FROM sessions WHERE id = $1 AND created_at > now() - interval '12 hours'`,
      [sessionId]
    );
    return rows[0]?.active_wd_client_id || null;
  } catch {
    return null;
  }
}

export async function setSessionWdClientId(req, clientId) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return;
  await query(
    `UPDATE sessions SET active_wd_client_id = $1 WHERE id = $2`,
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

export async function getSessionRole(req) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;
  try {
    const { rows } = await query(
      `SELECT role FROM sessions WHERE id = $1 AND created_at > now() - interval '12 hours'`,
      [sessionId]
    );
    return rows[0]?.role || null;
  } catch {
    return null;
  }
}

export async function requireAuth(req, res, next) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sessionId) {
    try {
      const { rows } = await query(
        `SELECT id, role, username FROM sessions WHERE id = $1 AND created_at > now() - interval '12 hours'`,
        [sessionId]
      );
      if (rows.length > 0) {
        req.sessionRole = rows[0].role || 'admin';
        req.sessionUsername = rows[0].username || rows[0].role || 'unknown';
        return next();
      }
    } catch {}
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  return res.redirect('/login.html');
}

export async function requireAdmin(req, res, next) {
  const role = req.sessionRole || (await getSessionRole(req));
  if (role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
  return res.redirect('/login.html');
}

export const authRouter = Router();

authRouter.get('/session', async (req, res) => {
  const authenticated = await isAuthed(req);
  const role = authenticated ? (await getSessionRole(req)) : null;
  res.json({ authenticated, role });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const users = configuredUsers();
  if (!users.length) return res.status(503).json({ error: 'Login is not configured' });
  const matched = users.find((u) => constantTimeEqual(username, u.username) && constantTimeEqual(password, u.password));
  if (!matched) {
    return res.status(401).json({ error: 'Invalid ID or password' });
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  try {
    await query(
      `INSERT INTO sessions (id, created_at, role, username) VALUES ($1, now(), $2, $3)`,
      [sessionId, matched.role, matched.username]
    );
  } catch {
    return res.status(500).json({ error: 'Failed to create session' });
  }
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions(req));
  res.json({ ok: true, role: matched.role });
});

authRouter.post('/logout', async (req, res) => {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sessionId) {
    await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]).catch(() => {});
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
