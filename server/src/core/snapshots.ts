import { createHash } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { requireManager } from './types.ts';
import { fail } from './errors.ts';
import { audit } from './audit.ts';
import { consumeReauth } from './reauth.ts';
import { trialBalance, worksheet, ledger } from './books.ts';
import { incomeStatement, balanceSheet, equityChanges, PROFILE_VERSION } from './statements.ts';

export type ReportType = 'trial_balance' | 'income_statement' | 'balance_sheet' | 'equity_changes' | 'worksheet' | 'ledger';
export const REPORT_LABEL: Record<ReportType, string> = {
  trial_balance: 'ميزان المراجعة', income_statement: 'قائمة الدخل', balance_sheet: 'قائمة المركز المالي',
  equity_changes: 'قائمة التغيرات في حقوق الملكية', worksheet: 'ورقة التسويات', ledger: 'دفتر الأستاذ',
};

export async function runReport(tx: Tx, c: Ctx, type: ReportType, p: any): Promise<any> {
  switch (type) {
    case 'trial_balance': return trialBalance(tx, c, p);
    case 'income_statement': return incomeStatement(tx, c, p);
    case 'balance_sheet': return balanceSheet(tx, c, p);
    case 'equity_changes': return equityChanges(tx, c, p);
    case 'worksheet': return worksheet(tx, c, p);
    case 'ledger': return ledger(tx, c, p.account_id, p);
    default: return fail('نوع تقرير غير معروف');
  }
}

const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
export const contentHash = (x: unknown) => createHash('sha256').update(canon(x)).digest('hex');

// Must run in a repeatable-read transaction so the content is one consistent state of the books (§24.5).
export async function freeze(tx: Tx, c: Ctx, input: { report_type: ReportType; params: any; purpose?: string; approve?: boolean; reauth?: string; closing_run_id?: number }) {
  requireManager(c);
  const content = await runReport(tx, c, input.report_type, input.params);
  const yearId = content.year?.id ?? null;
  if (input.approve) {
    await consumeReauth(tx, input.reauth, c.userId, c.companyId, 'snapshot.approve');
    await assertApprovable(tx, c, content);
  }
  const { rows: [co] } = await tx.query('select book_version from companies where id = $1', [c.companyId]);
  const { rows: [le] } = await tx.query('select max(id) as id from journal_entries where company_id = $1', [c.companyId]);
  const { rows: [s] } = await tx.query(
    `insert into report_snapshots(company_id, report_type, params, status, year_id, closing_run_id, purpose, book_version, last_entry_id, profile_version, content, content_hash, issued_by, issued_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, issued_at`,
    [c.companyId, input.report_type, JSON.stringify(input.params), input.approve ? 'approved' : 'frozen', yearId, input.closing_run_id ?? null, input.purpose ?? null,
      co.book_version, le.id, PROFILE_VERSION, JSON.stringify(content), contentHash(content), c.userId, c.userName]);
  await audit(tx, c, input.approve ? 'snapshot.approve' : 'snapshot.freeze', 'report_snapshot', s.id, { reason: input.purpose, after: { type: input.report_type, params: input.params } });
  return getSnapshot(tx, c, s.id);
}

// Final internal approval: no issues, and every earlier year final without pending dependency review (§24.4).
export async function assertApprovable(tx: Tx, c: Ctx, content: any) {
  if (content.issues?.length) fail('لا يُعتمد تقرير فيه مشكلات: ' + content.issues.map((i: any) => i.message).join('؛ '));
  if (content.finality && !content.finality.final) fail(content.finality.warning);
  const start = content.year?.start_date ?? content.from ?? content.to;
  const { rows } = await tx.query(`select name from fiscal_years where company_id = $1 and end_date < $2 and (status <> 'final' or needs_dependency_review)`, [c.companyId, start]);
  if (rows.length) fail(`لا تُعتمد نهائيًا قبل اعتماد السنة السابقة (${rows.map((r) => r.name).join('، ')}) — يمكن تجميد نسخة مؤقتة`);
}

// Why a stored snapshot may no longer represent the latest books (kept intact; §24.4).
async function staleReasons(tx: Tx, c: Ctx, s: any) {
  const reasons: string[] = [];
  const to = s.params.to ?? s.params.date;
  const { rows: [e] } = await tx.query('select count(*)::int as n from journal_entries where company_id = $1 and posted_at > $2 and ($3::date is null or date <= $3)', [c.companyId, s.issued_at, to ?? null]);
  if (e.n) reasons.push(`سُجّل ${e.n} قيد يؤثر في مدته بعد الإصدار`);
  const { rows: [d] } = await tx.query('select count(*)::int as n from account_definitions where company_id = $1 and created_at > $2', [c.companyId, s.issued_at]);
  if (d.n) reasons.push('تغيرت تعريفات حسابات بعد الإصدار');
  if (s.year_id) {
    const { rows: [r] } = await tx.query(`select count(*)::int as n from period_events where company_id = $1 and action = 'reopen' and at > $2 and (year_id = $3 or year_id in (select id from fiscal_years where company_id = $1 and end_date < (select start_date from fiscal_years where id = $3)))`, [c.companyId, s.issued_at, s.year_id]);
    if (r.n) reasons.push('أعيد فتح السنة أو سنة سابقة بعد الإصدار');
  }
  return reasons;
}

export async function getSnapshot(tx: Tx, c: Ctx, id: number) {
  const { rows: [s] } = await tx.query('select * from report_snapshots where id = $1 and company_id = $2', [id, c.companyId]);
  if (!s) return fail('النسخة غير موجودة', 404);
  const intact = contentHash(s.content) === s.content_hash;
  return { ...s, label: REPORT_LABEL[s.report_type as ReportType], integrity_ok: intact, stale_reasons: await staleReasons(tx, c, s) };
}

export async function listSnapshots(tx: Tx, c: Ctx, f: { report_type?: string; year_id?: number } = {}) {
  const { rows } = await tx.query(
    `select id, report_type, params, status, year_id, closing_run_id, purpose, book_version, issued_by_name, issued_at, content_hash
     from report_snapshots where company_id = $1 and ($2::text is null or report_type = $2) and ($3::int is null or year_id = $3) order by id desc limit 300`,
    [c.companyId, f.report_type ?? null, f.year_id ?? null]);
  return rows.map((r) => ({ ...r, label: REPORT_LABEL[r.report_type as ReportType] }));
}

// §24.1 comparisons
export async function withComparison(tx: Tx, c: Ctx, type: ReportType, params: any, compare?: any) {
  const current = await runReport(tx, c, type, params);
  if (!compare) return { current, comparison: null };
  if (compare.type === 'as_issued') {
    const s = await getSnapshot(tx, c, Number(compare.snapshot_id));
    if (s.report_type !== type) fail('النسخة المحفوظة من نوع قائمة مختلف');
    return { current, comparison: { type: 'as_issued', label: 'كما صدرت', snapshot_id: s.id, issued_at: s.issued_at, profile_version: s.profile_version, stale_reasons: s.stale_reasons, data: s.content } };
  }
  const cp = { ...params, from: compare.from, to: compare.to };
  if (compare.type === 'restated') {
    const data = await runReport(tx, c, type, { ...cp, definitions_date: params.to });
    return { current, comparison: { type: 'restated', label: 'معاد عرضها بتعريفات حديثة', definitions_date: params.to, profile_version: PROFILE_VERSION, data } };
  }
  const data = await runReport(tx, c, type, cp);
  return { current, comparison: { type: 'historical', label: 'مقارنة تاريخية', profile_version: PROFILE_VERSION, data } };
}
