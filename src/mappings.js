import { query } from './db.js';

// Small in-process cache so a chunked upload (many small batches) doesn't reload
// thousands of mapping rows on every batch. Invalidated on any mapping edit.
let cache = null;
let cachedAt = 0;
const TTL_MS = 120000;

export async function loadMappings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const [course, code] = await Promise.all([
    query('SELECT course, kapp FROM course_mapping'),
    query('SELECT medium, code FROM lead_code_mapping'),
  ]);
  cache = { courseRows: course.rows, leadCodeRows: code.rows };
  cachedAt = Date.now();
  return cache;
}

export function invalidateMappings() {
  cache = null;
}
