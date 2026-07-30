import XLSX from 'xlsx';
import { fullReport } from './report.js';
import { activeClientId } from './clients.js';
import { query } from './db.js';

const PCT = '0.0%';

async function annoMap() {
  const cid = await activeClientId();
  const { rows } = await query('SELECT scope, key, insights, challenges FROM annotations WHERE client_id = $1', [cid]);
  const m = {};
  for (const r of rows) (m[r.scope] ||= {})[r.key] = { insights: r.insights || '', challenges: r.challenges || '' };
  return m;
}
const noteOf = (m, scope) => (m[scope] && m[scope].__table__) || { insights: '', challenges: '' };

// Append an AOA sheet and format the given (0-based) columns as percentages.
function addSheet(wb, name, aoa, pctCols = []) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++) {
    for (const C of pctCols) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && typeof cell.v === 'number') cell.z = PCT;
    }
  }
  ws['!cols'] = aoa[0].map((_, c) => ({ wch: c === 0 ? 22 : (c >= aoa[0].length - 2 ? 40 : 11) }));
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

function rankAOA(firstHeader, block, note) {
  const head = [firstHeader, 'Leads', 'FI', 'Apps', 'Adms', 'Lead→FI', 'FI→App', 'App→Adm',
    'Dup Leads', 'Dup FI', 'Dup Apps', 'Dup Adms', 'Insights', 'Challenges'];
  const row = (r, first) => [r.key, r.leads, r.fi, r.apps, r.adm, r.lead_to_fi, r.fi_to_app, r.app_to_adm,
    r.dup_leads, r.dup_fi, r.dup_apps, r.dup_adm, first ? note.insights : '', first ? note.challenges : ''];
  const body = block.rows.map((r, i) => row(r, i === 0));
  if (block.others) body.push(row(block.others, false));
  if (block.total) body.push(row(block.total, false));
  return [head, ...body];
}

function monthAOA(keyHeader, rows, note) {
  const head = ['Month', keyHeader, 'Leads', 'FI', 'Apps', 'Adms', 'Lead→FI', 'FI→App', 'App→Adm', 'Insights', 'Challenges'];
  const body = rows.map((r, i) => [r.month, r.key, r.leads, r.fi, r.apps, r.adm, r.lead_to_fi, r.fi_to_app, r.app_to_adm,
    i === 0 ? note.insights : '', i === 0 ? note.challenges : '']);
  return [head, ...(body.length ? body : [['(no dated rows)']])];
}

function originMonthAOA(rows, note) {
  const head = ['Lead Origin', 'Month', 'Leads', 'FI', 'Apps', 'Adms', 'Lead→FI', 'FI→App', 'App→Adm', 'Insights', 'Challenges'];
  const body = rows.map((r, i) => [r.origin, r.month, r.leads, r.fi, r.apps, r.adm, r.lead_to_fi, r.fi_to_app, r.app_to_adm,
    i === 0 ? note.insights : '', i === 0 ? note.challenges : '']);
  return [head, ...(body.length ? body : [['(no rows)']])];
}

// Build the whole report as an .xlsx buffer + a filename.
export async function reportToXlsx(datasetId) {
  const d = await fullReport(datasetId);
  const m = await annoMap();
  const s = d.summary, c = s.conversions, du = s.conversions_dup, dup = s.duplicates;
  const totLeads = s.leads + dup.leads;
  const share = (x) => (totLeads ? x / totLeads : 0);
  const sNote = noteOf(m, 'summary');

  const wb = XLSX.utils.book_new();

  // Summary
  addSheet(wb, 'Summary', [
    ['Metric', 'Primary Count', 'Duplicate Count', 'Primary Conv %', 'Duplicate Conv %', 'Insights', 'Challenges'],
    ['Total Leads', s.leads, dup.leads, share(s.leads), share(dup.leads), sNote.insights, sNote.challenges],
    ['Form Initiated', s.fi, dup.fi, c.lead_to_fi, du.lead_to_fi, '', ''],
    ['Applications', s.apps, dup.apps, c.fi_to_app, du.fi_to_app, '', ''],
    ['Admissions', s.adm, dup.adm, c.app_to_adm, du.app_to_adm, '', ''],
    ['Target', s.target, '', '', '', '', ''],
    ['Target Achieved %', '', '', c.target_achieved, '', '', ''],
    ['Deal Type', s.deal_type, '', '', '', '', ''],
  ], [3, 4]);

  addSheet(wb, 'Top Lead Codes', rankAOA('Lead Code', d.top_lead_codes, noteOf(m, 'lead_codes')), [5, 6, 7]);
  addSheet(wb, 'Top Courses', rankAOA('Course', d.top_courses, noteOf(m, 'courses')), [5, 6, 7]);
  addSheet(wb, 'Top Cities', rankAOA('City', d.top_cities, noteOf(m, 'cities')), [5, 6, 7]);
  addSheet(wb, 'Lead Origin', rankAOA('Lead Origin', d.origin, noteOf(m, 'origin')), [5, 6, 7]);
  addSheet(wb, 'Lead Origin x Month', originMonthAOA(d.origin_month, noteOf(m, 'origin_month')), [6, 7, 8]);
  addSheet(wb, 'Medium by Month', monthAOA('Medium', d.top_medium_by_month, noteOf(m, 'medium_month')), [6, 7, 8]);
  addSheet(wb, 'Course by Month', monthAOA('Course', d.top_course_by_month, noteOf(m, 'course_month')), [6, 7, 8]);

  // Lead Stages
  addSheet(wb, 'Lead Stages', [
    ['Stage', 'Leads', '%'],
    ...d.lead_stages.rows.map((r) => [r.stage, r.leads, r.pct]),
    ['TOTAL', d.lead_stages.total, ''],
  ], [2]);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safe = String(s.report_title || 'report').replace(/[^\w.\- ]+/g, '').trim() || 'report';
  return { buf, filename: `${safe}.xlsx` };
}
