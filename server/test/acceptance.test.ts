// Acceptance cases from Appendix F of the functional spec (ids in test names), against a throwaway database.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.PG_DATABASE = `daftar_accept_${randomBytes(4).toString('hex')}`;
process.env.STORAGE_DIR = `/tmp/daftar-accept-${randomBytes(3).toString('hex')}`;
const { ensureDatabase, dropDatabase } = await import('../src/db/bootstrap.ts');
const { tx, pool, platformTx } = await import('../src/db/pools.ts');
const TP = await import('../src/core/templates.ts');
const { fabricTemplateContent } = await import('../src/core/template-fabric.ts');
const CO = await import('../src/core/companies.ts');
const F = await import('../src/core/fiscal.ts');
const J = await import('../src/core/journal.ts');
const A = await import('../src/core/accounts.ts');
const RV = await import('../src/core/review.ts');
const CL = await import('../src/core/closing.ts');
const B = await import('../src/core/books.ts');
const S = await import('../src/core/statements.ts');
const SN = await import('../src/core/snapshots.ts');
const AT = await import('../src/core/attachments.ts');
const { issueReauth } = await import('../src/core/reauth.ts');
const { parseAmount, toStr } = await import('../src/core/money.ts');
const { resolveCtx } = await import('../src/platform.ts');
type Ctx = import('../src/core/types.ts').Ctx;

let adminId = 0, tplId = 0;
const T = <X>(c: Ctx, fn: (t: any) => Promise<X>, opts?: any) => tx({ companyId: c.companyId, branchScope: c.role === 'employee' && c.branchId ? c.branchId : 'all', userId: c.userId }, fn, opts);
const pw = 'secret-pass-1';

// a company with the fabric chart, a manager, and an open year
async function company(code: string, opts: { template?: boolean; seats?: number } = {}) {
  const { company: co, manager_invite_token } = await platformTx((t) => CO.createCompany(t, adminId, { code, name: `شركة ${code}`, manager_email: `${code.toLowerCase()}@m.test`, manager_name: `مدير ${code}`, seat_limit: opts.seats ?? 2 }));
  const { user_id } = await platformTx((t) => CO.acceptInvitation(t, manager_invite_token!, { username: `${code.toLowerCase()}-mgr`, password: pw }));
  const m: Ctx = { userId: user_id, userName: `مدير ${code}`, companyId: co.id, role: 'manager', branchId: null, via: 'web' };
  if (opts.template !== false) {
    await T(m, (t) => TP.applyTemplate(t, { ...m, userId: adminId, role: 'platform' }, tplId, '2026-01-01', true));
    await T(m, (t) => F.createYear(t, m, { start_date: '2026-01-01', end_date: '2026-12-31' }));
  }
  return m;
}
async function acc(c: Ctx, code: string) { return (await T(c, (t) => t.query('select account_id from account_definitions where code = $1', [code]))).rows[0].account_id as number; }
async function post(c: Ctx, date: string, lines: [string, string | null, string | null][], extra: any = {}) {
  const L = [];
  for (const [code, d, cr] of lines) L.push({ account_id: await acc(c, code), debit: d, credit: cr });
  return T(c, (t) => J.postEntry(t, c, { date, description: extra.description ?? 'قيد اختبار', purpose: 'normal', lines: L, ...extra }));
}
const reauth = (c: Ctx, action: string) => T(c, (t) => issueReauth(t, c.userId, c.companyId, action, pw));

before(async () => {
  await ensureDatabase(process.env.PG_DATABASE, { fresh: true });
  adminId = (await pool.query(`insert into users(username, password_hash, full_name, is_platform_admin) values ('root', $1, 'مدير المنصة', true) returning id`, [CO.hashPassword(pw)])).rows[0].id;
  tplId = (await platformTx((t) => TP.publishTemplate(t, adminId, fabricTemplateContent()))).id;
});
after(async () => { await pool.end(); await dropDatabase(process.env.PG_DATABASE!); });

describe('الأساس والمستخدمون', () => {
  test('BAS-03 a fresh install has no companies, accounts or entries', async () => {
    const fresh = `daftar_fresh_${randomBytes(3).toString('hex')}`;
    await ensureDatabase(fresh, { fresh: true });
    const { adminPool } = await import('../src/db/pools.ts');
    const a = adminPool(fresh);
    const { rows: [r] } = await a.query('select (select count(*) from companies) + (select count(*) from accounts) + (select count(*) from journal_entries) as n');
    await a.end(); await dropDatabase(fresh);
    assert.equal(Number(r.n), 0);
  });

  test('TEN-01/03 a manager cannot read another company, and the refusal reveals nothing', async () => {
    const a = await company('TENA'), b = await company('TENB');
    await post(b, '2026-02-01', [['110101', '500', null], ['310101', null, '500']], { purpose: 'opening', equity_class: 'contribution' });
    const { rows } = await T(a, (t) => t.query('select count(*)::int as n from journal_entries'));
    assert.equal(rows[0].n, 0, 'row-level security hides company B');
    const u = (await pool.query('select id, username, full_name, email, is_platform_admin, ui_mode from users where id = $1', [a.userId])).rows[0];
    await assert.rejects(resolveCtx(u, b.companyId), /لا تملك صلاحية على هذه الشركة/);
  });

  test('TEN-04/05/06 two seats: the third invitation is refused; an expired invitation frees its seat', async () => {
    const c = await company('SEAT', { template: false });
    await T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'e1@x.test', display_name: 'موظف 1' }));
    await T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'e2@x.test', display_name: 'موظف 2' }));
    await assert.rejects(T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'e3@x.test', display_name: 'موظف 3' })), /لا يوجد مقعد متاح/);
    await T(c, (t) => t.query(`update invitations set expires_at = now() - interval '1 minute' where email = 'e1@x.test'`));
    await T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'e3@x.test', display_name: 'موظف 3' }));
    // two concurrent requests for the last seat: exactly one succeeds
    await T(c, (t) => t.query(`update invitations set status = 'cancelled' where email = 'e3@x.test'`));
    const r = await Promise.allSettled([
      T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'r1@x.test', display_name: 'سباق 1' })),
      T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'r2@x.test', display_name: 'سباق 2' }))]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  });

  test('TEN-07/08/12 stopping a membership refuses the next action but keeps the person and other companies', async () => {
    const a = await company('STPA'), b = await company('STPB');
    const tok = (await T(a, (t) => CO.inviteMember(t, a, { role: 'employee', email: 'both@x.test', display_name: 'مشترك' }))).token;
    const { user_id } = await platformTx((t) => CO.acceptInvitation(t, tok, { username: 'both', password: pw }));
    const tok2 = (await T(b, (t) => CO.inviteMember(t, b, { role: 'employee', email: 'both@x.test', display_name: 'مشترك' }))).token;
    await platformTx((t) => CO.acceptInvitation(t, tok2, { userId: user_id }));
    await assert.rejects(platformTx((t) => CO.acceptInvitation(t, tok2, { userId: user_id })), /غير صالحة/, 'used invitation');
    const u = (await pool.query('select id, username, full_name, email, is_platform_admin, ui_mode from users where id = $1', [user_id])).rows[0];
    const ctxA = await resolveCtx(u, a.companyId);
    const { rows: [m] } = await T(a, (t) => t.query('select id from memberships where user_id = $1 and company_id = $2', [user_id, a.companyId]));
    await T(a, (t) => CO.setMemberStatus(t, a, m.id, 'inactive', 'انتهاء العمل'));
    await assert.rejects(resolveCtx(u, a.companyId), /لا تملك صلاحية/);
    assert.equal((await resolveCtx(u, b.companyId)).role, 'employee');
    assert.ok(ctxA);
  });

  test('TEN-10/09 the seat limit cannot drop below seats in use', async () => {
    const c = await company('LIM', { template: false });
    await T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'l1@x.test', display_name: 'ل1' }));
    await assert.rejects(platformTx((t) => CO.setSeatLimit(t, adminId, c.companyId, 0)), /لا يقل الحد/);
  });
});

describe('القالب', () => {
  test('TPL-01/03 the fabric template gives 157 accounts (41 group, 116 postable) once', async () => {
    const c = await company('TPL1');
    const { rows: [r] } = await T(c, (t) => t.query('select count(*)::int as n, count(*) filter (where is_group)::int as g from accounts'));
    assert.deepEqual([r.n, r.g, r.n - r.g], [157, 41, 116]);
    const again = await T(c, (t) => TP.applyTemplate(t, { ...c, userId: adminId, role: 'platform' }, tplId, '2026-01-01', true));
    assert.ok((again as any).already);
  });
  test('TPL-05 a template is never applied over existing accounts; TPL-02 nothing posts before setup', async () => {
    const c = await company('TPL2', { template: false });
    await assert.rejects(T(c, (t) => J.postEntry(t, c, { date: '2026-01-02', description: 'x', purpose: 'normal', lines: [] })), /تأسيس دليل الحسابات/);
    await T(c, (t) => TP.setManualChart(t, c));
    await T(c, (t) => A.createAccount(t, c, { code: 'X1', name: 'حساب يدوي', classification: 'asset', is_group: false, nature: 'debit', closing: 'permanent', start_date: '2026-01-01' }));
    await assert.rejects(T(c, (t) => TP.applyTemplate(t, { ...c, role: 'platform' }, tplId, '2026-01-01', true)), /دليل قائم|حسابات قائمة/);
  });
  test('TPL-07 a published version is immutable', async () => {
    await assert.rejects(platformTx((t) => t.query(`update chart_templates set name = 'x' where id = $1`, [tplId])), /المنشور ثابت/);
    const changed = { ...fabricTemplateContent(), description: 'نص مختلف' };
    await assert.rejects(platformTx((t) => TP.publishTemplate(t, adminId, changed)), /إصدار جديد|إصدارًا جديدًا|رقم إصدار/);
  });
});

describe('تاريخ الحساب والعرض', () => {
  test('ACC-01/03/04 dated definitions keep identity and history; codes are reserved forever', async () => {
    const c = await company('ACC1');
    const bank = await acc(c, '110101');
    await post(c, '2026-03-01', [['110101', '1000', null], ['310101', null, '1000']], { purpose: 'opening', equity_class: 'contribution' });
    await T(c, (t) => A.addDefinition(t, c, bank, { code: '1101-BNK', name: 'بنك الراجحي', valid_from: '2027-01-01' }));
    const d26 = await T(c, (t) => A.definitionsAsOf(t, c.companyId, '2026-12-31'));
    const d27 = await T(c, (t) => A.definitionsAsOf(t, c.companyId, '2027-01-01'));
    assert.equal(d26.get(bank)!.name, 'البنك الرئيسي');
    assert.equal(d27.get(bank)!.name, 'بنك الراجحي');
    await assert.rejects(T(c, (t) => A.addDefinition(t, c, bank, { name: 'تاريخي', valid_from: '2026-06-01' })), /بعد آخر تعريف/);
    const cash = await acc(c, '110102');
    await assert.rejects(T(c, (t) => A.addDefinition(t, c, cash, { code: '110101', valid_from: '2027-02-01' })), /لحساب آخر/);
    const e = await T(c, (t) => J.findEntry(t, c, 1));
    assert.equal(e.lines[0].account_name, 'البنك الرئيسي', 'entry keeps the name in force on its date');
  });
  test('ACC-02 an account starting in 2027 refuses a 2026 date and has no invented balance', async () => {
    const c = await company('ACC2');
    await T(c, (t) => F.createYear(t, c, { start_date: '2027-01-01', end_date: '2027-12-31' }));
    const parent = await acc(c, '1101');
    const n = await T(c, (t) => A.createAccount(t, c, { parent_id: parent, code: '110109', name: 'بنك جديد', is_group: false, nature: 'debit', closing: 'permanent', start_date: '2027-01-01', presentation: { type: 'fixed', line: 1 } }));
    await assert.rejects(T(c, (t) => J.postEntry(t, c, { date: '2026-12-31', description: 'x', purpose: 'normal', lines: [{ account_id: n.id, debit: '5' }, { account_id: parent, credit: '5' }] })), /يبدأ استخدامه/);
  });
  test('ACC-05/06 a used account cannot be deleted or restructured; a stopped account refuses new entries', async () => {
    const c = await company('ACC3');
    await post(c, '2026-02-01', [['530104', '100', null], ['110101', null, '100']]);
    const elec = await acc(c, '530104');
    await assert.rejects(T(c, (t) => A.deleteAccount(t, c, elec)), /مستخدم في قيد/);
    await assert.rejects(T(c, (t) => A.updateStructure(t, c, elec, { closing: 'permanent' })), /لا يتغير/);
    await T(c, (t) => A.setStopDate(t, c, elec, '2026-03-01'));
    await assert.rejects(post(c, '2026-03-02', [['530104', '1', null], ['110101', null, '1']]), /موقوف/);
    const unused = await acc(c, '530112');
    await T(c, (t) => A.deleteAccount(t, c, unused));
    const parent = await acc(c, '53');
    await assert.rejects(T(c, (t) => A.createAccount(t, c, { parent_id: parent, code: '530112', name: 'إعادة استعمال', is_group: false, nature: 'debit', closing: 'temporary', presentation: { type: 'fixed', line: 31 } })), /لحساب آخر/);
  });
  test('ACC-08/09 Appendix C presentation cases (contra, variable, partners never netted)', async () => {
    const c = await company('ACC4');
    const pid = await acc(c, '2106');
    const partner2 = await T(c, (t) => A.createAccount(t, c, { parent_id: pid, code: '210603', name: 'جاري شريك ثانٍ', is_group: false, nature: 'variable', closing: 'permanent', start_date: '2026-01-01', presentation: { type: 'by_balance', debit_line: 8, credit_line: 18 } }));
    await post(c, '2026-01-02', [['110101', '20000', null], ['310101', null, '20000']], { purpose: 'opening', equity_class: 'contribution' });
    await post(c, '2026-01-03', [['210601', '1000', null], ['110101', null, '1000']]);                                     // partner 1 owes us
    await T(c, async (t) => J.postEntry(t, c, { date: '2026-01-03', description: 'شريك 2', purpose: 'normal', lines: [{ account_id: await acc(c, '110101'), debit: '600' }, { account_id: partner2.id, credit: '600' }] }));
    await post(c, '2026-01-04', [['530113', '1000', null], ['120203', null, '1000']]);                                       // accumulated depreciation
    await post(c, '2026-01-05', [['420101', '500', null], ['110101', null, '500']]);                                         // sales returns
    await post(c, '2026-01-06', [['210302', '1500', null], ['110101', null, '1500']]);                                       // VAT settlement debit
    await post(c, '2026-01-07', [['110101', '700', null], ['550101', null, '700']]);                                         // disposal gain
    const bs: any = await T(c, (t) => S.balanceSheet(t, c, { to: '2026-01-31' }));
    const line = (id: number) => bs.assets.concat(bs.liabilities, bs.equity).find((l: any) => l.id === id);
    assert.equal(line(8).amount, '1000.00', 'partner 1 is a receivable');
    assert.equal(line(18).amount, '600.00', 'partner 2 is a payable — not netted to 400');
    assert.equal(line(9).amount, '-1000.00', 'accumulated depreciation reduces fixed assets');
    assert.equal(line(7).amount, '1500.00', 'VAT settlement debit is a tax receivable');
    assert.ok(bs.balanced);
    const is: any = await T(c, (t) => S.incomeStatement(t, c, { from: '2026-01-01', to: '2026-01-31' }));
    assert.equal(is.lines.find((l: any) => l.id === 27).amount, '-500.00', 'returns reduce net sales');
    assert.equal(is.lines.find((l: any) => l.id === 33).amount, '700.00', 'disposal gain is other gains, not sales');
  });
  test('ACC-10 an effective account without a presentation rule blocks approval; no balancing figure', async () => {
    const c = await company('ACC5');
    const parent = await acc(c, '1101');
    const x = await T(c, (t) => A.createAccount(t, c, { parent_id: parent, code: '110190', name: 'بلا عرض', is_group: false, nature: 'debit', closing: 'permanent', start_date: '2026-01-01' }));
    await T(c, async (t) => J.postEntry(t, c, { date: '2026-01-02', description: 'x', purpose: 'normal', lines: [{ account_id: x.id, debit: '10' }, { account_id: await acc(c, '210206'), credit: '10' }] }));
    const bs: any = await T(c, (t) => S.balanceSheet(t, c, { to: '2026-01-31' }));
    assert.ok(bs.issues.some((i: any) => i.code === 'unmapped'));
    const tb: any = await T(c, (t) => B.trialBalance(t, c, { from: '2026-01-01', to: '2026-01-31' }));
    assert.ok(tb.rows.some((r: any) => r.code === '110190'), 'still in the trial balance');
  });
});

describe('السنوات والفترات', () => {
  test('YR-02/03 overlapping years are refused; a short first year starting mid-month gets partial periods; leap February', async () => {
    const c = await company('YR1', { template: false });
    await T(c, (t) => F.createYear(t, c, { start_date: '2027-07-15', end_date: '2028-06-30' }));
    await assert.rejects(T(c, (t) => F.createYear(t, c, { start_date: '2028-01-01', end_date: '2028-12-31' })), /تتداخل/);
    const ys = await T(c, (t) => F.listYears(t, c));
    const per = ys[0].periods;
    assert.equal(per[0].start_date, '2027-07-15'); assert.equal(per[0].end_date, '2027-07-31');
    assert.ok(per.some((p: any) => p.start_date === '2028-02-01' && p.end_date === '2028-02-29'));
    assert.equal(per.length, 12);
  });
  test('YR-04 a date outside any year is refused', async () => {
    const c = await company('YR2');
    await assert.rejects(post(c, '2030-01-01', [['110101', '1', null], ['310101', null, '1']]), /لا توجد سنة مالية/);
  });
  test('YR-05/06/08/09/10 period states, re-confirmation rules, and lockout', async () => {
    const c = await company('YR3');
    const tok = (await T(c, (t) => CO.inviteMember(t, c, { role: 'employee', email: 'yr3e@x.test', display_name: 'موظف' }))).token;
    const { user_id } = await platformTx((t) => CO.acceptInvitation(t, tok, { username: 'yr3e', password: pw }));
    const emp: Ctx = { userId: user_id, userName: 'موظف', companyId: c.companyId, role: 'employee', branchId: null, via: 'web' };
    const { rows: [mar] } = await T(c, (t) => t.query(`select id from periods where start_date = '2026-03-01'`));
    await assert.rejects(T(c, (t) => F.lockPeriod(t, c, mar.id, 'adjustments_only', undefined)), /تأكيد هويتك/);
    await T(c, async (t) => F.lockPeriod(t, c, mar.id, 'adjustments_only', await reauthIn(t, c, 'period.lock')));
    const yid = await yearId(c);
    const cy = await T(c, (t) => RV.createCycle(t, c, { year_id: yid, name: 'دورة', start_date: '2026-01-01', end_date: '2026-12-31' }));
    const bt = await T(c, (t) => RV.createBatch(t, c, { cycle_id: cy.id, name: 'دفعة' }));
    const L = [{ account_id: await acc(c, '530110'), debit: '10' }, { account_id: await acc(c, '210205'), credit: '10' }];
    await assert.rejects(T(emp, (t) => J.postEntry(t, emp, { date: '2026-03-10', description: 'x', purpose: 'adjustment', batch_id: bt.id, lines: L })), /المدير فقط|لا يرحّل الموظف/);
    await T(c, (t) => J.postEntry(t, c, { date: '2026-03-10', description: 'تسوية مدير', purpose: 'adjustment', batch_id: bt.id, lines: L }));
    await assert.rejects(T(c, (t) => J.postEntry(t, c, { date: '2026-03-10', description: 'عادي', purpose: 'normal', lines: L })), /تسويات المدير فقط/);
    // a token for one action does not work for another, and is single use
    const tk = await reauth(c, 'period.lock');
    await assert.rejects(T(c, (t) => F.reopenPeriod(t, c, mar.id, 'open', 'سبب', tk!)), /لإجراء آخر|غير صالح/);
    await T(c, (t) => F.lockPeriod(t, c, mar.id, 'locked', tk!));
    await assert.rejects(T(c, (t) => F.lockPeriod(t, c, mar.id, 'locked', tk!)), /غير صالح|ليس تشديدًا/);
    await assert.rejects(T(c, async (t) => F.reopenPeriod(t, c, mar.id, 'open', '', await reauthIn(t, c, 'period.reopen'))), /سبب/);
    await T(c, async (t) => F.reopenPeriod(t, c, mar.id, 'open', 'تصحيح مستند', await reauthIn(t, c, 'period.reopen')));
    const { rows: ev } = await T(c, (t) => t.query(`select action, reason from period_events where period_id = $1 order by id`, [mar.id]));
    assert.equal(ev.at(-1).reason, 'تصحيح مستند');
    // 5 wrong passwords in 15 minutes block new tokens
    for (let i = 0; i < 5; i++) assert.equal(await T(c, (t) => issueReauth(t, c.userId, c.companyId, 'period.lock', 'wrong')), null);
    await assert.rejects(T(c, (t) => issueReauth(t, c.userId, c.companyId, 'period.lock', pw)), /محاولات تحقق فاشلة/);
  });
});
async function yearId(c: Ctx) { return (await T(c, (t) => t.query('select id from fiscal_years order by start_date limit 1'))).rows[0].id; }
async function reauthIn(t: any, c: Ctx, action: string) { return (await issueReauth(t, c.userId, c.companyId, action, pw))!; }

describe('اليومية', () => {
  test('JRN-06/07/12 money parsing: Arabic digits, ambiguity, decimals, limits, no lost halala', () => {
    assert.equal(parseAmount('١٬٢٣٤٫٥٦'), 123456n);
    assert.equal(parseAmount('1234.56'), 123456n);
    assert.equal(parseAmount('1,234.56'), 123456n);
    assert.throws(() => parseAmount('1,234'), /ملتبسة/);
    assert.throws(() => parseAmount('1.234,56'), /ملتبسة|غير رقمية/);
    assert.throws(() => parseAmount('1.005'), /منزلتان/);
    assert.throws(() => parseAmount('-5'), /السالبة/);
    assert.throws(() => parseAmount(Infinity), /غير صالحة/);
    assert.throws(() => parseAmount('10000000000000000.00'), /الحد الأقصى/);
    assert.equal(toStr(parseAmount('9999999999999999.99')!), '9999999999999999.99');
  });
  test('JRN-12 huge balanced amounts keep the last halala end to end', async () => {
    const c = await company('JRN0');
    const e = await post(c, '2026-01-02', [['110101', '9999999999999999.99', null], ['110102', '0.01', null], ['310101', null, '9999999999999999.99'], ['310102', null, '0.01']],
      { purpose: 'opening', equity_class: 'contribution' });
    assert.equal(e.total, '10000000000000000.00');
    const tb: any = await T(c, (t) => B.trialBalance(t, c, { from: '2026-01-01', to: '2026-12-31' }));
    assert.equal(tb.totals.debit, '10000000000000000.00');
  });
  test('JRN-01/02/05 drafts: unbalanced allowed, no effect, version conflict, idempotent post', async () => {
    const c = await company('JRN1');
    const d = await T(c, async (t) => J.saveDraft(t, c, { date: '2026-02-01', description: 'مسودة', lines: [{ account_id: await acc(c, '530104'), debit: '100' }] }));
    const tb: any = await T(c, (t) => B.trialBalance(t, c, { from: '2026-01-01', to: '2026-12-31' }));
    assert.equal(tb.rows.length, 0, 'a draft has no financial effect');
    await T(c, async (t) => J.saveDraft(t, c, { date: '2026-02-01', description: 'مسودة', lines: [{ account_id: await acc(c, '530104'), debit: '100' }, { account_id: await acc(c, '110101'), credit: '100' }] }, d.id, 1));
    await assert.rejects(T(c, (t) => J.saveDraft(t, c, { description: 'قديم' }, d.id, 1)), /عدّل شخص آخر/);
    const e1 = await T(c, (t) => J.postDraft(t, c, d.id, 2));
    const e2 = await T(c, (t) => J.postDraft(t, c, d.id));
    assert.equal(e1.id, e2.id);
    const { rows: [n] } = await T(c, (t) => t.query('select count(*)::int as n from journal_entries'));
    assert.equal(n.n, 1);
  });
  test('JRN-03 copying produces an independent identical entry; §2.4 a request id never duplicates', async () => {
    const c = await company('JRN2');
    const e = await post(c, '2026-02-01', [['530104', '50', null], ['110101', null, '50']], { request_id: 'req-1' });
    const again = await post(c, '2026-02-01', [['530104', '50', null], ['110101', null, '50']], { request_id: 'req-1' });
    assert.equal(again.id, e.id);
    await assert.rejects(post(c, '2026-02-01', [['530104', '51', null], ['110101', null, '51']], { request_id: 'req-1' }), /لمحتوى مختلف/);
    const d = await T(c, (t) => J.copyEntry(t, c, e.id));
    await T(c, (t) => J.saveDraft(t, c, { ...d, date: '2026-02-02' } as any, d.id, d.version));
    const e2 = await T(c, (t) => J.postDraft(t, c, d.id));
    assert.notEqual(e2.id, e.id); assert.equal(e2.total, e.total); assert.equal(e2.source_number, e.number);
  });
  test('JRN-08/09 posted entries are immutable even in SQL; closing purpose is not selectable', async () => {
    const c = await company('JRN3');
    await post(c, '2026-02-01', [['530104', '50', null], ['110101', null, '50']]);
    await assert.rejects(T(c, (t) => t.query('update journal_lines set debit = 1 where true')), /لا تُعدّل/);
    await assert.rejects(T(c, (t) => t.query('delete from journal_entries')), /لا تُعدّل/);
    await assert.rejects(post(c, '2026-02-01', [['530104', '1', null], ['110101', null, '1']], { purpose: 'closing' }), /إجراء إقفال السنة/);
  });
  test('JRN-10 one linked reversal; history before and after the reversal date', async () => {
    const c = await company('JRN4');
    const e = await post(c, '2026-02-05', [['530106', '100', null], ['110101', null, '100']], { description: 'صيانة' });
    const d = await T(c, (t) => J.reverseEntry(t, c, e.id, '2026-02-06'));
    const d2 = await T(c, (t) => J.reverseEntry(t, c, e.id, '2026-02-06'));
    assert.equal(d.id, d2.id, 'no duplicate reversal draft');
    await T(c, (t) => J.postDraft(t, c, d.id));
    await assert.rejects(T(c, (t) => J.reverseEntry(t, c, e.id)), /معكوس مسبقًا/);
    await post(c, '2026-02-06', [['530106', '10', null], ['110101', null, '10']], { description: 'الصحيح' });
    const led = async (to: string) => (await T(c, async (t) => B.ledger(t, c, await acc(c, '530106'), { from: '2026-01-01', to }))).closing;
    assert.equal(await led('2026-02-05'), '100.00');
    assert.equal(await led('2026-02-06'), '10.00');
  });
  test('§15 lines: zero row, both sides, unbalanced, single line, group account', async () => {
    const c = await company('JRN5');
    await assert.rejects(post(c, '2026-02-01', [['530104', '0', null], ['110101', null, '5']]), /مبلغ صفري/);
    await assert.rejects(post(c, '2026-02-01', [['530104', '5', '5'], ['110101', null, '5']]), /جانب واحد/);
    await assert.rejects(post(c, '2026-02-01', [['530104', '5', null], ['110101', null, '4']]), /غير متوازن/);
    await assert.rejects(post(c, '2026-02-01', [['530104', '5', null]]), /سطرين/);
    await assert.rejects(post(c, '2026-02-01', [['53', '5', null], ['110101', null, '5']]), /تجميعي/);
  });
});

describe('المرفقات', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  test('DOC-01/02/03/04 type by content, limits, isolation, exclusion with reason', async () => {
    const c = await company('DOC1'), other = await company('DOC2');
    const e = await post(c, '2026-02-01', [['530104', '50', null], ['110101', null, '50']]);
    const a = await T(c, (t) => AT.addAttachment(t, c, { entry_id: e.id }, { filename: 'فاتورة.pdf', data: pdf }));
    await assert.rejects(T(c, (t) => AT.addAttachment(t, c, { entry_id: e.id }, { filename: 'x.pdf', data: Buffer.from('<html>not a pdf</html>') })), /غير مقبول/);
    await assert.rejects(T(c, (t) => AT.addAttachment(t, c, { entry_id: e.id }, { filename: 'x.pdf', data: Buffer.from('%PDF-1.4 /JavaScript (app.alert) %%EOF') })), /نشطًا/);
    for (let i = 0; i < 4; i++) await T(c, (t) => AT.addAttachment(t, c, { entry_id: e.id }, { filename: `p${i}.pdf`, data: pdf }));
    await assert.rejects(T(c, (t) => AT.addAttachment(t, c, { entry_id: e.id }, { filename: 'six.pdf', data: pdf })), /خمسة مرفقات/);
    await assert.rejects(T(other, (t) => AT.readAttachment(t, other, a.id)), /غير موجود/);
    const f = await T(c, (t) => AT.readAttachment(t, c, a.id));
    assert.equal(f.mime, 'application/pdf');
    await assert.rejects(T(c, (t) => AT.excludeAttachment(t, c, a.id, '')), /سبب/);
    await T(c, (t) => AT.excludeAttachment(t, c, a.id, 'رفع بالخطأ'));
    assert.ok(await T(c, (t) => AT.readAttachment(t, c, a.id)), 'excluded evidence stays available');
  });
});

describe('النسخ والإقفال', () => {
  test('SNP-01/03/04 a frozen copy keeps its numbers and names; integrity hash holds', async () => {
    const c = await company('SNP1');
    await post(c, '2026-01-02', [['110101', '1000', null], ['310101', null, '1000']], { purpose: 'opening', equity_class: 'contribution' });
    const s = await T(c, (t) => SN.freeze(t, c, { report_type: 'trial_balance', params: { from: '2026-01-01', to: '2026-12-31' } }), { serializable: true });
    await post(c, '2026-01-03', [['530104', '100', null], ['110101', null, '100']]);
    await T(c, async (t) => A.addDefinition(t, c, await acc(c, '110101'), { name: 'اسم جديد', valid_from: '2026-06-01' }));
    const g: any = await T(c, (t) => SN.getSnapshot(t, c, s.id));
    assert.equal(g.content.totals.debit, '1000.00');
    assert.ok(g.content.rows.some((r: any) => r.name === 'البنك الرئيسي'));
    assert.ok(g.integrity_ok);
    assert.equal(g.stale_reasons.length, 2);
    await assert.rejects(T(c, (t) => t.query('update report_snapshots set content = $1', ['{}'])), /لا تُعدّل/);
  });
  test('SNP-06 a later year cannot be approved before the earlier one is final', async () => {
    const c = await company('SNP2');
    await T(c, (t) => F.createYear(t, c, { start_date: '2027-01-01', end_date: '2027-12-31' }));
    await post(c, '2026-01-02', [['110101', '1000', null], ['310101', null, '1000']], { purpose: 'opening', equity_class: 'contribution' });
    await assert.rejects(T(c, async (t) => SN.freeze(t, c, { report_type: 'balance_sheet', params: { to: '2027-12-31' }, approve: true, reauth: await reauthIn(t, c, 'snapshot.approve') })), /السنة السابقة/);
  });
  test('CLS-04/05/06/07 closing rules: result account, losses, zero result, no movement', async () => {
    const c = await company('CLS1');
    await T(c, (t) => F.createYear(t, c, { start_date: '2027-01-01', end_date: '2027-12-31' }));
    await post(c, '2026-01-02', [['110101', '1000', null], ['310101', null, '1000']], { purpose: 'opening', equity_class: 'contribution' });
    await post(c, '2026-02-01', [['530104', '300', null], ['110101', null, '300']]);
    // CLS-05 a loss debits retained earnings
    const r: any = await T(c, async (t) => CL.closeYear(t, c, { year_id: await yearId(c), mode: 'final', reason: 'خسارة', reauth: await reauthIn(t, c, 'year.close') }));
    assert.equal(r.net_result, '-300.00');
    const re = r.entry.lines.find((l: any) => l.account_code === '330101');
    assert.equal(re.debit, '300.00');
    // CLS-06 zero result with revenue and expense: closes them with no equity line
    await post(c, '2027-02-01', [['110101', '500', null], ['410101', null, '500']]);
    await post(c, '2027-02-02', [['530104', '500', null], ['110101', null, '500']]);
    const y27 = (await T(c, (t) => t.query(`select id from fiscal_years where start_date = '2027-01-01'`))).rows[0].id;
    const z: any = await T(c, async (t) => CL.closeYear(t, c, { year_id: y27, mode: 'final', reason: 'صفر', reauth: await reauthIn(t, c, 'year.close') }));
    assert.equal(z.entry.lines.length, 2);
    assert.ok(!z.entry.lines.some((l: any) => l.account_code === '330101'));
    // CLS-07 a year without movement: no zero entry, a verification run
    const c2 = await company('CLS2');
    const v: any = await T(c2, async (t) => CL.closeYear(t, c2, { year_id: await yearId(c2), mode: 'final', reason: 'بلا حركة', reauth: await reauthIn(t, c2, 'year.close') }));
    assert.equal(v.entry, null); assert.equal(v.run.kind, 'verify');
  });
  test('CLS-13/14 open drafts block the final close; closing entries cannot be reversed or copied', async () => {
    const c = await company('CLS3');
    await post(c, '2026-01-02', [['110101', '1000', null], ['310101', null, '1000']], { purpose: 'opening', equity_class: 'contribution' });
    await post(c, '2026-03-01', [['110101', '100', null], ['410101', null, '100']]);
    const d = await T(c, (t) => J.saveDraft(t, c, { date: '2026-05-01', description: 'معلقة' }));
    await assert.rejects(T(c, async (t) => CL.closeYear(t, c, { year_id: await yearId(c), mode: 'final', reason: 'x', reauth: await reauthIn(t, c, 'year.close') })), /مسودة غير محسومة/);
    await T(c, (t) => J.setDraftStatus(t, c, d.id, 'deferred', 'تخص السنة القادمة'));
    const r: any = await T(c, async (t) => CL.closeYear(t, c, { year_id: await yearId(c), mode: 'final', reason: 'اعتماد', reauth: await reauthIn(t, c, 'year.close') }));
    await assert.rejects(T(c, (t) => J.reverseEntry(t, c, r.entry.id)), /الإقفال النظامي/);
    await assert.rejects(T(c, (t) => J.copyEntry(t, c, r.entry.id)), /لا يُنسخ/);
  });
  test('FIN-05 an unclassified direct equity movement blocks the final close', async () => {
    const c = await company('FIN5');
    await post(c, '2026-01-02', [['110101', '1000', null], ['310101', null, '1000']]);   // no equity class
    const eq: any = await T(c, (t) => S.equityChanges(t, c, { from: '2026-01-01', to: '2026-12-31' }));
    assert.ok(eq.issues.some((i: any) => i.code === 'unclassified_equity'));
    await assert.rejects(T(c, async (t) => CL.closeYear(t, c, { year_id: await yearId(c), mode: 'final', reason: 'x', reauth: await reauthIn(t, c, 'year.close') })), /بلا تصنيف/);
  });
});

describe('support access and demo users', () => {
  test('SUP-01 the platform admin enters without membership, attributed and visible in the owner log', async () => {
    const m = await company('SUP1', { template: false });
    const P = await import('../src/platform.ts');
    const admin = { id: adminId, username: 'root', full_name: 'مدير المنصة', email: null, is_platform_admin: true, ui_mode: 'system' } as any;
    const c = await resolveCtx(admin, m.companyId);
    assert.equal(c.role, 'platform');
    await P.logAccess(c, 'دخول دعم فني: فحص', '127.0.0.1');
    const log = (await T(m, (t) => t.query('select user_name, role, action from access_log where company_id = $1', [m.companyId]))).rows;
    assert.ok(log.some((r: any) => r.role === 'platform' && /الدعم الفني/.test(r.user_name) && /دخول دعم فني/.test(r.action)));
    const pa = (await pool.query(`select count(*)::int as n from platform_audit where company_id = $1 and action = 'support.access'`, [m.companyId])).rows[0].n;
    assert.equal(pa, 1);
    // a normal user of another company is refused
    const other = await company('SUP2', { template: false });
    const stranger = { id: other.userId, username: 'sup2-mgr', full_name: 'x', email: null, is_platform_admin: false, ui_mode: 'system' } as any;
    await assert.rejects(resolveCtx(stranger, m.companyId), /لا تملك صلاحية/);
  });
  test('SUP-02 demo users cannot sign in with the login form', async () => {
    const P = await import('../src/platform.ts');
    await pool.query(`insert into users(username, password_hash, full_name) values ('demo-mgr-test01', $1, 'تجريبي')`, [CO.hashPassword('demo1234')]);
    await assert.rejects(P.login('demo-mgr-test01', 'demo1234'), /غير صحيحة/);
  });
});
