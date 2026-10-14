import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { requireManager } from './types.ts';
import { fail } from './errors.ts';
import { audit, bumpBook } from './audit.ts';
import { fromDb, toStr } from './money.ts';
import { consumeReauth } from './reauth.ts';
import { postEntry } from './journal.ts';
import { incomeStatement, balanceSheet, equityChanges } from './statements.ts';
import { freeze } from './snapshots.ts';
import { definitionsAsOf } from './accounts.ts';
import { YEAR_LABEL } from './fiscal.ts';

// What is still left in each result (temporary) account for the year, including earlier closings (§25.3).
export async function remainders(tx: Tx, c: Ctx, year: any) {
  const { rows } = await tx.query(
    `select jl.account_id, coalesce(sum(jl.debit - jl.credit),0)::text as v from journal_lines jl join accounts a on a.id = jl.account_id
     where jl.company_id = $1 and a.closing = 'temporary' and jl.date between $2 and $3 group by jl.account_id`, [c.companyId, year.start_date, year.end_date]);
  return rows.map((r) => ({ account_id: r.account_id as number, v: fromDb(r.v) })).filter((r) => r.v !== 0n);
}

export async function closingPreview(tx: Tx, c: Ctx, yearId: number) {
  const { rows: [y] } = await tx.query('select * from fiscal_years where id = $1 and company_id = $2', [yearId, c.companyId]);
  if (!y) fail('السنة غير موجودة', 404);
  const rem = await remainders(tx, c, y);
  const defs = await definitionsAsOf(tx, c.companyId, y.end_date);
  const net = rem.reduce((s, r) => s - r.v, 0n);
  const blockers = await finalBlockers(tx, c, y);
  const { rows: runs } = await tx.query('select id, run_no, mode, kind, amount, user_name, reason, at, entry_id from closing_runs where year_id = $1 order by run_no', [y.id]);
  return { year: { ...y, status_label: YEAR_LABEL[y.status] }, lines: rem.map((r) => ({ account_id: r.account_id, code: defs.get(r.account_id)!.code, name: defs.get(r.account_id)!.name, remaining: toStr(r.v) })),
    net_result: toStr(net), blockers, runs };
}

async function finalBlockers(tx: Tx, c: Ctx, y: any) {
  const out: string[] = [];
  const { rows: [co] } = await tx.query('select result_account_id from companies where id = $1', [c.companyId]);
  if (!co.result_account_id) out.push('حدد حساب تحويل النتيجة');
  else {
    const { rows: [a] } = await tx.query('select * from accounts where id = $1', [co.result_account_id]);
    if (!a || a.is_group || a.classification !== 'equity' || a.closing !== 'permanent' || a.deleted_at) out.push('حساب تحويل النتيجة ليس حساب حقوق ملكية دائمًا قابلًا للترحيل');
  }
  const { rows: [d] } = await tx.query(`select count(*)::int as n from drafts where company_id = $1 and status = 'draft' and date between $2 and $3`, [c.companyId, y.start_date, y.end_date]);
  if (d.n) out.push(`${d.n} مسودة غير محسومة داخل السنة — رحّلها أو ألغها أو أجّلها مسببًا`);
  const { rows: prev } = await tx.query(`select name from fiscal_years where company_id = $1 and end_date < $2 and (status <> 'final' or needs_dependency_review)`, [c.companyId, y.start_date]);
  if (prev.length) out.push(`السنوات السابقة غير نهائية: ${prev.map((p) => p.name).join('، ')}`);
  const is = await incomeStatement(tx, c, { from: y.start_date, to: y.end_date });
  const bs = await balanceSheet(tx, c, { to: y.end_date });
  const eq = await equityChanges(tx, c, { from: y.start_date, to: y.end_date });
  for (const i of [...is.issues, ...bs.issues, ...eq.issues]) out.push(i.message);
  return [...new Set(out)];
}

// §25 year-end close. 'preliminary' transfers the result and keeps the year under review;
// 'final' also approves: periods locked, five reference snapshots saved. Re-running only moves what is left.
export async function closeYear(tx: Tx, c: Ctx, input: { year_id: number; mode: 'preliminary' | 'final'; reason: string; reauth?: string; request_id?: string }) {
  requireManager(c);
  if (!input.reason?.trim()) fail('سبب الإجراء مطلوب');
  if (input.request_id) {
    const { rows: [ex] } = await tx.query('select * from closing_runs where company_id = $1 and request_id = $2', [c.companyId, input.request_id]);
    if (ex) return { run: ex, repeated: true };
  }
  await consumeReauth(tx, input.reauth, c.userId, c.companyId, 'year.close');
  const { rows: [y] } = await tx.query('select * from fiscal_years where id = $1 and company_id = $2 for update', [input.year_id, c.companyId]);
  if (!y) fail('السنة غير موجودة', 404);
  if (y.status === 'final' && !y.needs_dependency_review) {
    const rem0 = await remainders(tx, c, y);
    if (!rem0.length) fail('السنة معتمدة نهائيًا ولا يوجد متبقٍ يحتاج تحويلًا');
  }
  const { rows: [co] } = await tx.query('select result_account_id, book_version from companies where id = $1', [c.companyId]);
  if (input.mode === 'final') {
    const b = await finalBlockers(tx, c, y);
    if (b.length) fail('لا يكتمل الإقفال النهائي: ' + b.join('؛ '));
  } else if (!co.result_account_id) fail('حدد حساب تحويل النتيجة');

  const rem = await remainders(tx, c, y);
  const net = rem.reduce((s, r) => s - r.v, 0n); // profit > 0
  const { rows: [{ n }] } = await tx.query('select coalesce(max(run_no),0) + 1 as n from closing_runs where year_id = $1', [y.id]);
  const { rows: [run] } = await tx.query(
    `insert into closing_runs(company_id, year_id, run_no, mode, kind, book_version, result_account_id, amount, reason, user_id, user_name, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [c.companyId, y.id, n, input.mode, rem.length ? 'transfer' : 'verify', co.book_version, co.result_account_id, toStr(net < 0n ? -net : net), input.reason.trim(), c.userId, c.userName, input.request_id ?? null]);
  let entry: any = null;
  if (rem.length) {
    const lines: any[] = rem.map((r) => ({ account_id: r.account_id, debit: r.v < 0n ? toStr(-r.v) : null, credit: r.v > 0n ? toStr(r.v) : null }));
    // profit credits equity, loss debits it; a zero result needs no equity line (§25.3)
    if (net > 0n) lines.push({ account_id: co.result_account_id, credit: toStr(net) });
    if (net < 0n) lines.push({ account_id: co.result_account_id, debit: toStr(-net) });
    entry = await postEntry(tx, c, {
      date: y.end_date, description: `${n === 1 ? 'إقفال' : 'إقفال تكميلي'} نتيجة ${y.name}`, purpose: 'closing', origin: 'closing', closing_run_id: run.id, lines,
    }, { system: true });
    await tx.query('update closing_runs set entry_id = $2 where id = $1', [run.id, entry.id]);
  }
  const status = input.mode === 'final' ? 'final' : 'under_review';
  await tx.query('update fiscal_years set status = $2, last_closing_run_id = $3, needs_dependency_review = case when $2 = \'final\' then false else needs_dependency_review end where id = $1', [y.id, status, run.id]);
  if (input.mode === 'final') {
    await tx.query(`update periods set status = 'locked' where year_id = $1`, [y.id]);
    const p = { from: y.start_date, to: y.end_date };
    for (const [type, params] of [['trial_balance', { ...p, mode: 'after_adjustments' }], ['trial_balance', { ...p, mode: 'after_close' }],
      ['income_statement', p], ['balance_sheet', { to: y.end_date }], ['equity_changes', p]] as const) {
      await freeze(tx, c, { report_type: type, params, purpose: `إقفال ${y.name} — إجراء رقم ${n}`, closing_run_id: run.id });
    }
  }
  await bumpBook(tx, c.companyId);
  await audit(tx, c, `year.close_${input.mode}`, 'fiscal_year', y.id, { reason: input.reason, after: { run_no: n, kind: run.kind, net: toStr(net), entry: entry?.number ?? null } });
  return { run: { ...run, entry_id: entry?.id ?? null }, entry, net_result: toStr(net) };
}
