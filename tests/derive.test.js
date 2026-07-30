import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMonth, nthToken, buildContext, deriveRow, detectDateOrder, resolveDateOrder } from '../src/derive.js';

test('toMonth parses unambiguous shapes regardless of order', () => {
  assert.equal(toMonth('9-Jul-2026 12:10 PM'), '2026-07');
  assert.equal(toMonth('9-Jul-2026'), '2026-07');
  assert.equal(toMonth('Jul 9, 2026'), '2026-07');
  assert.equal(toMonth('2026-07-09'), '2026-07');
  assert.equal(toMonth(''), null);
  assert.equal(toMonth('not a date'), null);
});

test('toMonth respects day/month order for numeric dates (dash or slash)', () => {
  // MDY: month first
  assert.equal(toMonth('07-24-2026', 'MDY'), '2026-07');
  assert.equal(toMonth('07/24/2026', 'MDY'), '2026-07');
  assert.equal(toMonth('08-05-2025', 'MDY'), '2025-08');
  // DMY: day first
  assert.equal(toMonth('24-07-2026', 'DMY'), '2026-07');
  assert.equal(toMonth('05-08-2025', 'DMY'), '2025-08');
  // Self-correcting when the chosen slot can't be a month
  assert.equal(toMonth('24-07-2026', 'MDY'), '2026-07'); // 24 isn't a month -> use 07
});

test('detectDateOrder infers order from the data', () => {
  assert.equal(detectDateOrder(['07-24-2026', '08-15-2025', '09-03-2025']), 'MDY'); // 24,15 > 12
  assert.equal(detectDateOrder(['24-07-2026', '15-08-2025']), 'DMY');               // 24,15 first
  assert.equal(detectDateOrder(['2026-07-24', '2025-08-15']), 'YMD');
  assert.equal(detectDateOrder(['05-06-2025']), null);                              // ambiguous
  assert.equal(resolveDateOrder({ date_format: 'auto' }, ['07-24-2026']), 'MDY');
  assert.equal(resolveDateOrder({ date_format: 'DMY' }, ['07-24-2026']), 'DMY');    // manual override
});

test('nthToken splits by delimiter and is 1-based', () => {
  assert.equal(nthToken('src/AMU01/x', '/', 2), 'AMU01');
  assert.equal(nthToken('src/AMU01/x', '/', 1), 'src');
  assert.equal(nthToken('  a / b ', '/', 2), 'b');
});

const settings = {
  record_key_column: 'Name', lead_source_column: 'Campaign',
  lead_code_delimiter: '/', lead_code_token: 2,
  course_column: 'Course', city_column: 'City', lead_origin_column: 'Lead Origin',
  form_initiated_column: 'FI', application_column: 'App', admission_column: 'Adm',
  date_column: 'Date', instance_column: 'Instance', instance_filter: 'Primary',
  application_values: ['1'], admission_values: ['Submitted'], form_initiated_values: ['1', '2'],
};
const ctx = buildContext(settings,
  [{ course: 'PGDM', kapp: 'MBA/PGDM' }],
  [{ medium: 'bm79', code: 'bm' }]);

test('deriveRow computes flags and normalizations', () => {
  const d = deriveRow({
    Name: 'A', Campaign: 'x/bm79/y', Course: 'PGDM', City: 'Pune',
    'Lead Origin': 'Website', FI: '2', App: '1', Adm: 'Submitted',
    Date: '5-Jan-2026', Instance: 'Primary',
  }, ctx);
  assert.equal(d.lead_code, 'bm');        // mapped from bm79
  assert.equal(d.kapp_course, 'MBA/PGDM'); // mapped from PGDM
  assert.equal(d.month, '2026-01');
  assert.deepEqual([d.fi_flag, d.app_flag, d.adm_flag, d.prim_flag], [1, 1, 1, 1]);
});

test('deriveRow: non-primary instance and non-matching values', () => {
  const d = deriveRow({
    Name: 'B', Campaign: 'x/unknown/y', Course: 'Unmapped', City: '',
    FI: '', App: '0', Adm: 'In Progress', Date: '', Instance: 'Duplicate',
  }, ctx);
  assert.equal(d.lead_code, 'unknown');    // falls back to raw token
  assert.equal(d.kapp_course, 'Unmapped'); // falls back to raw course
  assert.equal(d.prim_flag, 0);
  assert.deepEqual([d.fi_flag, d.app_flag, d.adm_flag], [0, 0, 0]);
});

test('blank allowed-set means any non-empty value counts', () => {
  const ctx2 = buildContext({ ...settings, application_values: [] },
    [], []);
  const d = deriveRow({ App: 'anything', Instance: 'Primary' }, ctx2);
  assert.equal(d.app_flag, 1);
  const d2 = deriveRow({ App: '', Instance: 'Primary' }, ctx2);
  assert.equal(d2.app_flag, 0);
});
