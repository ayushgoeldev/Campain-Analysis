import { Router } from 'express';
import crypto from 'node:crypto';

const SESSION_COOKIE = 'lead_report_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

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
    sameSite: 'none',
    secure: true,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

function configuredUser() {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  console.log('Auth config:', { username, hasPassword: !!password }); // ← add this
  if (!username || !password) return null;
  return { username, password };
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function isAuthed(req) {
  pruneSessions();
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.lastSeenAt = Date.now();
  return true;
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  return res.redirect('/login.html');
}

export const authRouter = Router();

authRouter.get('/session', (req, res) => {
  res.json({ authenticated: isAuthed(req) });
});

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = configuredUser();
  if (!user) return res.status(503).json({ error: 'Login is not configured' });
  if (!constantTimeEqual(username, user.username) || !constantTimeEqual(password, user.password)) {
    return res.status(401).json({ error: 'Invalid ID or password' });
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { createdAt: Date.now(), lastSeenAt: Date.now() });
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions(req));
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
