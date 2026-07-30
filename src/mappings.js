import { query } from './db.js';

export async function loadMappings() {
  const [course, code] = await Promise.all([
    query('SELECT course, kapp FROM course_mapping'),
    query('SELECT medium, code FROM lead_code_mapping'),
  ]);
  return { courseRows: course.rows, leadCodeRows: code.rows };
}
