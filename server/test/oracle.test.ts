// Appendix D — the 3-year financial oracle of the functional spec, end to end.
// 13 recording events (3 of them produced by the closing procedure, never typed in), 12 checkpoints,
// three trial-balance modes per checkpoint, statement totals, and the equity split.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.PG_DATABASE = `daftar_oracle_${randomBytes(4).toString('hex')}`;
const { ensureDatabase, dropDatabase } = await import('../src/db/bootstrap.ts');
const { tx, pool, platformTx } = await import('../src/db/pools.ts');
const { publishTemplate, applyTemplate } = await import('../src/core/templates.ts');
const { fabricTemplateContent } = await import('../src/core/template-fabric.ts');
const { createCompany, acceptInvitation, hashPassword } = await import('../src/core/companies.ts');
const { createYear, startReview, reopenYear } = await import('../src/core/fiscal.ts');
const { postEntry } = await import('../src/core/journal.ts');
const { createCycle, createBatch } = await import('../src/core/review.ts');
const { closeYear } = await import('../src/core/closing.ts');
const { issueReauth } = await import('../src/core/reauth.ts');
const { trialBalance } = await import('../src/core/books.ts');
const { incomeStatement, balanceSheet, equityChanges } = await import('../src/core/statements.ts');
const { freeze, getSnapshot } = await import('../src/core/snapshots.ts');
type Ctx = import('../src/core/types.ts').Ctx;

let C: Ctx;               // the company manager
const acc = new Map<string, number>();
let batch26 = 0;
const years: Record<string, number> = {};

const T = <X>(fn: (t: any) => Promise<X>, opts?: any) => tx({ companyId: C.companyId, branchScope: 'all', userId: C.userId }, fn, opts);
const reauth = async (action: string) => {
  const t = await T((x) => issueReauth(x, C.userId, C.companyId, action, 'manager-pass-1'));
  assert.ok(t, 'reauth issued');
  return t!;
};
const post = (ref: string, date: string, purpose: any, lines: [string, number, number][], extra: any = {}) =>
  T((x) => postEntry(x, C, { date, description: ref, reference: ref, purpose, lines: lines.map(([code, d, c]) => ({ account_id: acc.get(code)!, debit: d ? String(d) : null, credit: c ? String(c) : null })), ...extra }));

before(async () => {
  await ensureDatabase(process.env.PG_DATABASE, { fresh: true });
  const { rows: [admin] } = await pool.query(`insert into users(username, password_hash, full_name, is_platform_admin) values ('root', $1, 'مدير المنصة', true) returning id`, [hashPassword('root-pass-1')]);
  const tpl = await platformTx((x) => publishTemplate(x, admin.id, fabricTemplateContent()));
  const { company, manager_invite_token } = await platformTx((x) => createCompany(x, admin.id, { code: 'ORACLE', name: 'شركة المرجع المالي', manager_email: 'm@oracle.test', manager_name: 'مدير المرجع' }));
  const { user_id } = await platformTx((x) => acceptInvitation(x, manager_invite_token!, { username: 'oracle-manager', password: 'manager-pass-1' }));
  C = { userId: user_id, userName: 'مدير المرجع', companyId: company.id, role: 'manager', branchId: null, via: 'web' };
  const P: Ctx = { ...C, userId: admin.id, userName: 'مدير المنصة', role: 'platform' };
  await tx({ companyId: company.id, branchScope: 'all' }, (x) => applyTemplate(x, P, tpl.id, '2026-01-01', true));
  const { rows } = await tx({ companyId: company.id }, (x) => x.query('select account_id, code from account_definitions'));
  for (const r of rows) acc.set(r.code, r.account_id);
  years['2026'] = (await T((x) => createYear(x, C, { start_date: '2026-01-01', end_date: '2026-12-31' }))).id;
  years['2027'] = (await T((x) => createYear(x, C, { start_date: '2027-01-01', end_date: '2027-12-31' }))).id;
});

after(async () => { await pool.end(); await dropDatabase(process.env.PG_DATABASE!); });

// ---- expected trial balances (thousands of SAR): code → [opening D, opening C, movement D, movement C, closing D, closing C]
type TB = Record<string, number[]>;
const TB_2026_PRE: TB = { '110101': [0, 0, 300, 12, 288, 0], '110301': [0, 0, 60, 40, 20, 0], '210101': [0, 0, 0, 60, 0, 60], '310101': [0, 0, 0, 200, 0, 200], '410101': [0, 0, 0, 100, 0, 100], '510101': [0, 0, 40, 0, 40, 0], '520101': [0, 0, 12, 0, 12, 0] };
const TB_2026_ADJ1: TB = { ...TB_2026_PRE, '110301': [0, 0, 60, 41, 19, 0], '210205': [0, 0, 0, 6, 0, 6], '510104': [0, 0, 1, 0, 1, 0], '530110': [0, 0, 6, 0, 6, 0] };
const TB_2026_ADJ2: TB = { ...TB_2026_ADJ1, '210205': [0, 0, 0, 8, 0, 8], '530110': [0, 0, 8, 0, 8, 0] };
const TB_2027_JAN_A: TB = { '110101': [288, 0, 30, 0, 318, 0], '110301': [20, 0, 0, 10, 10, 0], '210101': [0, 60, 0, 0, 0, 60], '310101': [0, 200, 0, 0, 0, 200], '410101': [0, 100, 0, 30, 0, 130], '510101': [40, 0, 10, 0, 50, 0], '520101': [12, 0, 0, 0, 12, 0] };
const TB_2027_JAN_B: TB = { ...TB_2027_JAN_A, '110301': [19, 0, 0, 10, 9, 0], '210205': [0, 6, 0, 0, 0, 6], '510104': [1, 0, 0, 0, 1, 0], '530110': [6, 0, 0, 0, 6, 0] };
const TB_2027_JAN_C: TB = { '110101': [288, 0, 30, 0, 318, 0], '110301': [19, 0, 0, 10, 9, 0], '210101': [0, 60, 0, 0, 0, 60], '210205': [0, 6, 0, 0, 0, 6], '310101': [0, 200, 0, 0, 0, 200], '330101': [0, 41, 0, 0, 0, 41], '410101': [0, 0, 0, 30, 0, 30], '510101': [0, 0, 10, 0, 10, 0] };
const TB_2027_JAN_D: TB = { ...TB_2027_JAN_C, '210205': [0, 8, 0, 0, 0, 8], '530110': [2, 0, 0, 0, 2, 0] };
const TB_2027_JAN_E: TB = { ...TB_2027_JAN_C, '210205': [0, 8, 0, 0, 0, 8], '330101': [0, 39, 0, 0, 0, 39] };
const RAW_2026_C1: TB = { ...TB_2026_ADJ1, '330101': [0, 0, 0, 41, 0, 41], '410101': [0, 0, 100, 100, 0, 0], '510101': [0, 0, 40, 40, 0, 0], '510104': [0, 0, 1, 1, 0, 0], '520101': [0, 0, 12, 12, 0, 0], '530110': [0, 0, 6, 6, 0, 0] };
const RAW_2026_A3: TB = { ...RAW_2026_C1, '210205': [0, 0, 0, 8, 0, 8], '530110': [0, 0, 8, 6, 2, 0] };
const RAW_2026_C2: TB = { ...RAW_2026_A3, '330101': [0, 0, 2, 41, 0, 39], '530110': [0, 0, 8, 8, 0, 0] };
const RAW_2027_C: TB = { ...TB_2027_JAN_E, '330101': [0, 39, 0, 20, 0, 59], '410101': [0, 0, 30, 30, 0, 0], '510101': [0, 0, 10, 10, 0, 0] };
const TB_2028: TB = { '110101': [318, 0, 0, 0, 318, 0], '110301': [9, 0, 0, 0, 9, 0], '210101': [0, 60, 0, 0, 0, 60], '210205': [0, 8, 0, 0, 0, 8], '310101': [0, 200, 0, 0, 0, 200], '330101': [0, 59, 0, 0, 0, 59] };

async function checkTB(label: string, from: string, to: string, mode: string, expected: TB) {
  const tb: any = await T((x) => trialBalance(x, C, { from, to, mode: mode as any }));
  const leaves = tb.rows.filter((r: any) => !r.is_group);
  const got: TB = {};
  for (const r of leaves) {
    const v = [r.opening_debit, r.opening_credit, r.debit, r.credit, r.closing_debit, r.closing_credit].map((s: string) => Number(s) / 1000);
    if (v.some((n) => n !== 0)) got[r.code] = v;
  }
  assert.deepEqual(got, expected, `${label} — ${mode}`);
  const sum = (i: number) => Object.values(expected).reduce((s, v) => s + v[i], 0);
  assert.deepEqual([tb.totals.opening_debit, tb.totals.opening_credit, tb.totals.debit, tb.totals.credit, tb.totals.closing_debit, tb.totals.closing_credit].map((s: string) => Number(s) / 1000),
    [0, 1, 2, 3, 4, 5].map(sum), `${label} totals — ${mode}`);
}

// revenues, expenses, result, assets, liabilities, equity (+ permanent / unclosed split)
async function checkPoint(label: string, from: string, to: string, e: { rev: number; exp: number; res: number; a: number; l: number; eq: number; perm: number; unclosed: number }) {
  const is: any = await T((x) => incomeStatement(x, C, { from, to }));
  const bs: any = await T((x) => balanceSheet(x, C, { to }));
  const L = (id: number) => Number(is.lines.find((l: any) => l.id === id).amount);
  const rev = L(27) + L(32) + L(33);
  const exp = L(28) + L(29) + L(30) + L(31) + L(34) + L(35) + L(36) + L(37);
  assert.deepEqual(
    { rev, exp, res: Number(is.totals.net_result), a: Number(bs.totals.assets), l: Number(bs.totals.liabilities), eq: Number(bs.totals.equity), perm: Number(bs.totals.permanent_equity), unclosed: Number(bs.totals.unclosed_result) },
    Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v * 1000])), label);
  assert.equal(is.issues.length, 0, `${label}: income statement issues ${JSON.stringify(is.issues)}`);
  assert.ok(bs.balanced, `${label}: balance sheet balances`);
  return { is, bs };
}

test('ح1 — 2026 before adjustments (events 1–5)', async () => {
  await post('O26-01', '2026-01-01', 'opening', [['110101', 200000, 0], ['310101', 0, 200000]], { equity_class: 'contribution' });
  await post('N26-02', '2026-01-05', 'normal', [['110301', 60000, 0], ['210101', 0, 60000]]);
  await post('N26-03', '2026-12-01', 'normal', [['110101', 100000, 0], ['410101', 0, 100000]]);
  await post('N26-04', '2026-12-01', 'normal', [['510101', 40000, 0], ['110301', 0, 40000]]);
  await post('N26-05', '2026-12-15', 'normal', [['520101', 12000, 0], ['110101', 0, 12000]]);
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح1', '2026-01-01', '2026-12-31', m, TB_2026_PRE);
  await checkPoint('ح1', '2026-01-01', '2026-12-31', { rev: 100, exp: 52, res: 48, a: 308, l: 60, eq: 248, perm: 200, unclosed: 48 });
});

let snapH6: number;
test('ح2 — January 2027 while 2026 is under review (events 6–7)', async () => {
  await T((x) => startReview(x, C, years['2026']));
  await assert.rejects(post('late normal', '2026-12-20', 'normal', [['520101', 1, 0], ['110101', 0, 1]]), /تحت المراجعة/);
  await post('N27-01', '2027-01-10', 'normal', [['110101', 30000, 0], ['410101', 0, 30000]]);
  await post('N27-02', '2027-01-10', 'normal', [['510101', 10000, 0], ['110301', 0, 10000]]);
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح2', '2027-01-01', '2027-01-31', m, TB_2027_JAN_A);
  await checkPoint('ح2', '2027-01-01', '2027-01-31', { rev: 30, exp: 10, res: 20, a: 328, l: 60, eq: 268, perm: 200, unclosed: 68 });
});

test('ح3/ح4 — first 2026 adjustments recorded after 2027 started (events 8–9)', async () => {
  const cy = await T((x) => createCycle(x, C, { year_id: years['2026'], name: 'مراجعة 2026', start_date: '2026-01-01', end_date: '2026-12-31' }));
  batch26 = (await T((x) => createBatch(x, C, { cycle_id: cy.id, name: 'الدفعة الأولى' }))).id;
  await assert.rejects(post('no batch', '2026-12-31', 'adjustment', [['530110', 1, 0], ['210205', 0, 1]]), /دفعة/);
  await post('A26-01', '2026-12-31', 'adjustment', [['530110', 6000, 0], ['210205', 0, 6000]], { batch_id: batch26 });
  await post('A26-02', '2026-12-31', 'adjustment', [['510104', 1000, 0], ['110301', 0, 1000]], { batch_id: batch26 });
  await checkTB('ح3', '2026-01-01', '2026-12-31', 'raw', TB_2026_ADJ1);
  await checkTB('ح3', '2026-01-01', '2026-12-31', 'after_adjustments', TB_2026_ADJ1);
  await checkTB('ح3', '2026-01-01', '2026-12-31', 'before_adjustments', TB_2026_PRE);
  await checkPoint('ح3', '2026-01-01', '2026-12-31', { rev: 100, exp: 59, res: 41, a: 307, l: 66, eq: 241, perm: 200, unclosed: 41 });
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح4', '2027-01-01', '2027-01-31', m, TB_2027_JAN_B);
  await checkPoint('ح4', '2027-01-01', '2027-01-31', { rev: 30, exp: 10, res: 20, a: 327, l: 66, eq: 261, perm: 200, unclosed: 61 });
});

test('ح5/ح6 — first final close of 2026 (event 10 generated by the procedure)', async () => {
  const r: any = await T(async (x) => closeYear(x, C, { year_id: years['2026'], mode: 'final', reason: 'اعتماد 2026', reauth: await reauth('year.close'), request_id: 'close-2026-1' }));
  assert.equal(r.entry.lines.length, 6, 'CLS-01: six lines');
  assert.equal(r.net_result, '41000.00');
  // CLS-02: the same request again changes nothing
  const again: any = await T((x) => closeYear(x, C, { year_id: years['2026'], mode: 'final', reason: 'x', request_id: 'close-2026-1' }));
  assert.ok(again.repeated);
  await checkTB('ح5', '2026-01-01', '2026-12-31', 'raw', RAW_2026_C1);
  await checkTB('ح5', '2026-01-01', '2026-12-31', 'after_adjustments', TB_2026_ADJ1);
  await checkTB('ح5', '2026-01-01', '2026-12-31', 'before_adjustments', TB_2026_PRE);
  // CLS-08: the income statement keeps the year's result after closing
  await checkPoint('ح5', '2026-01-01', '2026-12-31', { rev: 100, exp: 59, res: 41, a: 307, l: 66, eq: 241, perm: 241, unclosed: 0 });
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح6', '2027-01-01', '2027-01-31', m, TB_2027_JAN_C);
  await checkPoint('ح6', '2027-01-01', '2027-01-31', { rev: 30, exp: 10, res: 20, a: 327, l: 66, eq: 261, perm: 241, unclosed: 20 });
  snapH6 = (await T((x) => freeze(x, C, { report_type: 'balance_sheet', params: { to: '2027-01-31' }, purpose: 'ح6' }), { serializable: true })).id;
  // locked periods refuse everyday entries
  await assert.rejects(post('late', '2026-12-31', 'adjustment', [['530110', 1, 0], ['210205', 0, 1]], { batch_id: batch26 }), /معتمدة نهائيًا/);
});

test('ح7/ح8 — reopen 2026 and record a late adjustment (event 11)', async () => {
  await assert.rejects(T((x) => reopenYear(x, C, years['2026'], 'under_review', 'open', 'تسوية متأخرة', 'bad-token')), /تأكيد الهوية/);
  await T(async (x) => reopenYear(x, C, years['2026'], 'under_review', 'open', 'أتعاب مراجعة إضافية', await reauth('year.reopen')));
  await post('A26-03', '2026-12-31', 'adjustment', [['530110', 2000, 0], ['210205', 0, 2000]], { batch_id: batch26 });
  await checkTB('ح7', '2026-01-01', '2026-12-31', 'raw', RAW_2026_A3);
  await checkTB('ح7', '2026-01-01', '2026-12-31', 'after_adjustments', TB_2026_ADJ2);
  await checkTB('ح7', '2026-01-01', '2026-12-31', 'before_adjustments', TB_2026_PRE);
  await checkPoint('ح7', '2026-01-01', '2026-12-31', { rev: 100, exp: 61, res: 39, a: 307, l: 68, eq: 239, perm: 241, unclosed: -2 });
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح8', '2027-01-01', '2027-01-31', m, TB_2027_JAN_D);
  await checkPoint('ح8', '2027-01-01', '2027-01-31', { rev: 30, exp: 10, res: 20, a: 327, l: 68, eq: 259, perm: 241, unclosed: 18 });
  // SNP-02: the frozen ح6 copy keeps 261,000 while the live report shows 259,000, with a reason
  const s: any = await T((x) => getSnapshot(x, C, snapH6));
  assert.equal(s.content.totals.equity, '261000.00');
  assert.ok(s.integrity_ok);
  assert.ok(s.stale_reasons.length > 0);
});

test('ح9/ح10 — supplementary close transfers only the difference (event 12)', async () => {
  const r: any = await T(async (x) => closeYear(x, C, { year_id: years['2026'], mode: 'final', reason: 'إعادة اعتماد 2026', reauth: await reauth('year.close') }));
  assert.equal(r.entry.lines.length, 2);
  assert.equal(r.net_result, '-2000.00', 'CLS-03: only the 2,000 difference');
  await checkTB('ح9', '2026-01-01', '2026-12-31', 'raw', RAW_2026_C2);
  await checkTB('ح9', '2026-01-01', '2026-12-31', 'after_adjustments', TB_2026_ADJ2);
  await checkTB('ح9', '2026-01-01', '2026-12-31', 'before_adjustments', TB_2026_PRE);
  await checkPoint('ح9', '2026-01-01', '2026-12-31', { rev: 100, exp: 61, res: 39, a: 307, l: 68, eq: 239, perm: 239, unclosed: 0 });
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح10', '2027-01-01', '2027-01-31', m, TB_2027_JAN_E);
  await checkPoint('ح10', '2027-01-01', '2027-01-31', { rev: 30, exp: 10, res: 20, a: 327, l: 68, eq: 259, perm: 239, unclosed: 20 });
});

test('ح11/ح12 — close 2027 after 2026 is final, then open 2028 with no opening entry (event 13)', async () => {
  const r: any = await T(async (x) => closeYear(x, C, { year_id: years['2027'], mode: 'final', reason: 'اعتماد 2027', reauth: await reauth('year.close') }));
  assert.equal(r.net_result, '20000.00');
  await checkTB('ح11', '2027-01-01', '2027-12-31', 'raw', RAW_2027_C);
  await checkTB('ح11', '2027-01-01', '2027-12-31', 'after_adjustments', TB_2027_JAN_E);
  await checkTB('ح11', '2027-01-01', '2027-12-31', 'before_adjustments', TB_2027_JAN_E);
  await checkPoint('ح11', '2027-01-01', '2027-12-31', { rev: 30, exp: 10, res: 20, a: 327, l: 68, eq: 259, perm: 259, unclosed: 0 });
  years['2028'] = (await T((x) => createYear(x, C, { start_date: '2028-01-01', end_date: '2028-12-31' }))).id;
  for (const m of ['raw', 'after_adjustments', 'before_adjustments']) await checkTB('ح12', '2028-01-01', '2028-01-31', m, TB_2028);
  await checkPoint('ح12', '2028-01-01', '2028-01-31', { rev: 0, exp: 0, res: 0, a: 327, l: 68, eq: 259, perm: 259, unclosed: 0 });
  const { rows: [n] } = await T((x) => x.query(`select count(*)::int as n from journal_lines`));
  assert.equal(n.n, 31, '13 events, 31 financial lines');
});

test('equity statement: closing transfer nets to zero and ties to the balance sheet', async () => {
  const eq: any = await T((x) => equityChanges(x, C, { from: '2026-01-01', to: '2026-12-31' }));
  assert.equal(eq.issues.length, 0, JSON.stringify(eq.issues));
  assert.equal(eq.totals.closing_transfer, '0.00');
  assert.equal(eq.totals.closing, '239000.00');
});
