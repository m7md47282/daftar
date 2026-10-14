import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { fail } from './errors.ts';
import { isDate, addDays } from './audit.ts';
import { fromDb, toStr } from './money.ts';
import { definitionsAsOf, type Presentation } from './accounts.ts';
import { yearForDate } from './fiscal.ts';
import { PROFILE, PROFILE_VERSION, DERIVED } from './template-fabric.ts';
import { EQUITY_CLASS_LABEL } from './journal.ts';

export { PROFILE_VERSION };
type Issue = { code: 'unmapped' | 'wrong_statement' | 'not_balanced' | 'unreconciled' | 'unclassified_equity' | 'equity_mismatch'; message: string; accounts?: { code: string; name: string; amount: string }[] };
type AccAmt = { account_id: number; code: string; name: string; amount: string };

const lineById = new Map(PROFILE.map((l) => [l.id, l]));
// signed (debit − credit) amount shown on a line according to its direction
const shown = (signed: bigint, line: number) => (lineById.get(line)!.dir === 'debit' ? signed : -signed);
function lineFor(p: Presentation, signed: bigint): number | null {
  if (!p) return null;
  if (p.type === 'fixed') return p.line;
  return signed >= 0n ? p.debit_line : p.credit_line; // each account decides alone — no netting across accounts (§11.3)
}

async function accountsMeta(tx: Tx, c: Ctx, defsDate: string) {
  const { rows } = await tx.query('select id, classification, closing, is_group from accounts where company_id = $1', [c.companyId]);
  const defs = await definitionsAsOf(tx, c.companyId, defsDate);
  return new Map(rows.filter((a) => !a.is_group).map((a) => [a.id, { ...a, def: defs.get(a.id)! }]));
}

async function signedSums(tx: Tx, c: Ctx, where: string, params: unknown[]) {
  const { rows } = await tx.query(`select account_id, coalesce(sum(debit - credit),0)::text as v from journal_lines jl where jl.company_id = $1 and ${where} group by account_id`, [c.companyId, ...params]);
  return new Map(rows.map((r) => [r.account_id as number, fromDb(r.v)]));
}

async function yearOf(tx: Tx, c: Ctx, from: string, to: string) {
  if (!isDate(from) || !isDate(to) || from > to) fail('مدة القائمة غير صالحة');
  const y = await yearForDate(tx, c.companyId, from);
  if (!y || to > y.end_date) fail('القائمة المالية تخص مدة داخل سنة مالية واحدة');
  return y;
}

// ---------------------------------------------------------------- income statement (§23.2)
export async function incomeStatement(tx: Tx, c: Ctx, r: { from: string; to: string; definitions_date?: string; branch_id?: number | null }) {
  const year = await yearOf(tx, c, r.from, r.to);
  const meta = await accountsMeta(tx, c, r.definitions_date ?? r.to);
  // movement of the period, without system closing entries — the year's result never becomes zero
  const mv = await signedSums(tx, c, `jl.date between $2 and $3 and jl.purpose <> 'closing' and ($4::int is null or jl.branch_id = $4)`, [r.from, r.to, r.branch_id ?? null]);
  const lines = new Map<number, { amount: bigint; accounts: AccAmt[] }>();
  const issues: Issue[] = [];
  const unmapped: AccAmt[] = [], wrong: AccAmt[] = [];
  let bookResult = 0n;
  for (const [id, v] of mv) {
    const a = meta.get(id);
    if (!a || a.closing !== 'temporary' || v === 0n) continue;
    bookResult -= v;
    const ln = lineFor(a.def.presentation, v);
    const aa = { account_id: id, code: a.def.code, name: a.def.name, amount: toStr(v) };
    if (!ln) { unmapped.push(aa); continue; }
    if (lineById.get(ln)!.statement !== 'is') { wrong.push(aa); continue; }
    const cur = lines.get(ln) ?? { amount: 0n, accounts: [] };
    cur.amount += shown(v, ln); cur.accounts.push({ ...aa, amount: toStr(shown(v, ln)) });
    lines.set(ln, cur);
  }
  if (unmapped.length) issues.push({ code: 'unmapped', message: 'حسابات مؤثرة بلا قاعدة عرض صالحة — تمنع الاعتماد النهائي', accounts: unmapped });
  if (wrong.length) issues.push({ code: 'wrong_statement', message: 'حسابات مؤقتة مربوطة ببنود المركز المالي', accounts: wrong });
  const L = (id: number) => lines.get(id)?.amount ?? 0n;
  const gross = L(27) - L(28);
  const operating = gross + L(32) + L(33) - L(34) - L(29) - L(30) - L(31);
  const pretax = operating - L(35);
  const net = pretax - L(36) - L(37);
  if (net !== bookResult && !unmapped.length && !wrong.length) issues.push({ code: 'unreconciled', message: `نتيجة القائمة (${toStr(net)}) لا تطابق نتيجة الدفاتر (${toStr(bookResult)})` });
  const line = (id: number) => ({ id, name: lineById.get(id)!.name, amount: toStr(L(id)), accounts: lines.get(id)?.accounts ?? [] });
  return {
    type: 'income_statement', from: r.from, to: r.to, year: { id: year.id, name: year.name, status: year.status }, profile_version: PROFILE_VERSION, currency: 'SAR',
    lines: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37].map(line),
    totals: { net_sales: toStr(L(27)), gross_profit: toStr(gross), operating_profit: toStr(operating), profit_before_tax: toStr(pretax), net_result: toStr(net), book_result: toStr(bookResult) },
    issues,
  };
}

// ---------------------------------------------------------------- balance sheet (§23.3)
export async function balanceSheet(tx: Tx, c: Ctx, r: { to: string; definitions_date?: string; branch_id?: number | null }) {
  if (!isDate(r.to)) fail('تاريخ القائمة غير صالح');
  const year = await yearForDate(tx, c.companyId, r.to);
  if (!year) fail('لا توجد سنة مالية لتاريخ القائمة');
  const meta = await accountsMeta(tx, c, r.definitions_date ?? r.to);
  const bal = await signedSums(tx, c, `jl.date <= $2 and ($3::int is null or jl.branch_id = $3)`, [r.to, r.branch_id ?? null]);
  const prior = await signedSums(tx, c, `jl.date < $2 and ($3::int is null or jl.branch_id = $3)`, [year.start_date, r.branch_id ?? null]);
  const lines = new Map<number, { amount: bigint; accounts: AccAmt[] }>();
  const unmapped: AccAmt[] = [], wrong: AccAmt[] = [];
  let priorUnclosed = 0n, currentUnclosed = 0n;
  for (const [id, v] of bal) {
    const a = meta.get(id);
    if (!a || v === 0n && !(a.closing === 'temporary')) continue;
    if (a.closing === 'temporary') {
      // remaining in result accounts after the closings already posted (§23.3)
      const p = prior.get(id) ?? 0n;
      priorUnclosed -= p; currentUnclosed -= v - p;
      continue;
    }
    if (v === 0n) continue;
    const ln = lineFor(a.def.presentation, v);
    const aa = { account_id: id, code: a.def.code, name: a.def.name, amount: toStr(v) };
    if (!ln) { unmapped.push(aa); continue; }
    if (lineById.get(ln)!.statement !== 'bs') { wrong.push(aa); continue; }
    const cur = lines.get(ln) ?? { amount: 0n, accounts: [] };
    cur.amount += shown(v, ln); cur.accounts.push({ ...aa, amount: toStr(shown(v, ln)) });
    lines.set(ln, cur);
  }
  const L = (id: number) => lines.get(id)?.amount ?? 0n;
  const sumL = (a: number, b: number) => { let s = 0n; for (let i = a; i <= b; i++) s += L(i); return s; };
  const assets = sumL(1, 12), liabilities = sumL(13, 21);
  const equity = sumL(22, 26) + priorUnclosed + currentUnclosed;
  const issues: Issue[] = [];
  if (unmapped.length) issues.push({ code: 'unmapped', message: 'حسابات مؤثرة بلا قاعدة عرض صالحة — تمنع الاعتماد النهائي', accounts: unmapped });
  if (wrong.length) issues.push({ code: 'wrong_statement', message: 'حسابات دائمة مربوطة ببنود قائمة الدخل', accounts: wrong });
  if (assets !== liabilities + equity) issues.push({ code: 'not_balanced', message: `القائمة غير متوازنة: الأصول ${toStr(assets)} والالتزامات وحقوق الملكية ${toStr(liabilities + equity)}` });
  const line = (id: number) => ({ id, group: lineById.get(id)!.group, name: lineById.get(id)!.name, amount: toStr(L(id)), accounts: lines.get(id)?.accounts ?? [] });
  return {
    type: 'balance_sheet', to: r.to, year: { id: year.id, name: year.name, status: year.status, start_date: year.start_date }, profile_version: PROFILE_VERSION, currency: 'SAR',
    assets: Array.from({ length: 12 }, (_, i) => line(i + 1)),
    liabilities: Array.from({ length: 9 }, (_, i) => line(i + 13)),
    equity: [...Array.from({ length: 5 }, (_, i) => line(i + 22)),
      { id: 'prior_unclosed', name: DERIVED.prior_unclosed, amount: toStr(priorUnclosed), accounts: [] },
      { id: 'current_unclosed', name: DERIVED.current_unclosed, amount: toStr(currentUnclosed), accounts: [] }],
    totals: { assets: toStr(assets), liabilities: toStr(liabilities), equity: toStr(equity), liabilities_and_equity: toStr(liabilities + equity),
      permanent_equity: toStr(sumL(22, 26)), unclosed_result: toStr(priorUnclosed + currentUnclosed) },
    balanced: assets === liabilities + equity,
    issues,
  };
}

// ---------------------------------------------------------------- changes in equity (§23.4)
const CATS = ['contribution', 'distribution', 'reserve_transfer', 'prior_adjustment', 'other', 'unclassified'] as const;
export async function equityChanges(tx: Tx, c: Ctx, r: { from: string; to: string; definitions_date?: string; branch_id?: number | null }) {
  const year = await yearOf(tx, c, r.from, r.to);
  const meta = await accountsMeta(tx, c, r.definitions_date ?? r.to);
  const dayBefore = addDays(r.from, -1);
  const open = await signedSums(tx, c, `jl.date <= $2 and ($3::int is null or jl.branch_id = $3)`, [dayBefore, r.branch_id ?? null]);
  const { rows: moves } = await tx.query(
    `select jl.account_id, e.purpose, e.equity_class, coalesce(sum(jl.debit - jl.credit),0)::text as v
     from journal_lines jl join journal_entries e on e.id = jl.entry_id
     where jl.company_id = $1 and jl.date between $2 and $3 and ($4::int is null or jl.branch_id = $4)
     group by jl.account_id, e.purpose, e.equity_class`, [c.companyId, r.from, r.to, r.branch_id ?? null]);
  type Comp = { id: string | number; name: string; opening: bigint; result: bigint; closing_transfer: bigint; closing: bigint } & Record<typeof CATS[number], bigint>;
  const comps = new Map<string, Comp>();
  const comp = (id: string | number, name: string) => {
    const k = String(id);
    if (!comps.has(k)) comps.set(k, { id, name, opening: 0n, result: 0n, closing_transfer: 0n, closing: 0n, contribution: 0n, distribution: 0n, reserve_transfer: 0n, prior_adjustment: 0n, other: 0n, unclassified: 0n });
    return comps.get(k)!;
  };
  for (const id of [22, 23, 24, 25, 26]) comp(id, lineById.get(id)!.name);
  const unclosed = comp('unclosed', 'نتائج غير محولة (سابقة وحالية)');
  // opening
  for (const [id, v] of open) {
    const a = meta.get(id); if (!a) continue;
    if (a.closing === 'temporary') { unclosed.opening -= v; continue; }
    if (a.classification !== 'equity') continue;
    const ln = lineFor(a.def.presentation, v) ?? 26;
    comp(ln, lineById.get(ln)?.name ?? '').opening -= v;
  }
  const unclassifiedAccounts: AccAmt[] = [];
  for (const m of moves) {
    const a = meta.get(m.account_id); if (!a) continue;
    const v = fromDb(m.v);
    if (a.closing === 'temporary') {
      if (m.purpose === 'closing') unclosed.closing_transfer -= v; else unclosed.result -= v;
      continue;
    }
    if (a.classification !== 'equity') continue;
    const ln = lineFor(a.def.presentation, v) ?? 26;
    const k = comp(ln, lineById.get(ln)?.name ?? '');
    if (m.purpose === 'closing') k.closing_transfer -= v;
    else if (m.equity_class) (k as any)[m.equity_class] -= v;
    else { k.unclassified -= v; unclassifiedAccounts.push({ account_id: a.id, code: a.def.code, name: a.def.name, amount: toStr(-v) }); }
  }
  for (const k of comps.values()) k.closing = k.opening + k.result + k.closing_transfer + CATS.reduce((s, cat) => s + k[cat], 0n);
  const bs = await balanceSheet(tx, c, { to: r.to, definitions_date: r.definitions_date, branch_id: r.branch_id });
  const total = [...comps.values()].reduce((s, k) => s + k.closing, 0n);
  const issues: Issue[] = [];
  if (unclassifiedAccounts.length) issues.push({ code: 'unclassified_equity', message: 'حركات مباشرة على حقوق الملكية بلا تصنيف — تمنع الاعتماد النهائي حتى تفسيرها', accounts: unclassifiedAccounts });
  if (toStr(total) !== bs.totals.equity) issues.push({ code: 'equity_mismatch', message: `ختامي القائمة (${toStr(total)}) لا يطابق حقوق الملكية في المركز المالي (${bs.totals.equity})` });
  const s = (v: bigint) => toStr(v);
  return {
    type: 'equity_changes', from: r.from, to: r.to, year: { id: year.id, name: year.name, status: year.status }, profile_version: PROFILE_VERSION, currency: 'SAR',
    categories: { result: 'نتيجة الفترة', ...EQUITY_CLASS_LABEL, unclassified: 'غير مصنف', closing_transfer: 'نقل الإقفال داخل الحقوق' },
    components: [...comps.values()].map((k) => ({ id: k.id, name: k.name, opening: s(k.opening), result: s(k.result), contribution: s(k.contribution), distribution: s(k.distribution),
      reserve_transfer: s(k.reserve_transfer), prior_adjustment: s(k.prior_adjustment), other: s(k.other), unclassified: s(k.unclassified),
      closing_transfer: s(k.closing_transfer), closing: s(k.closing) })),
    totals: { closing: s(total), closing_transfer: s([...comps.values()].reduce((x, k) => x + k.closing_transfer, 0n)) },
    issues: [...issues, ...bs.issues.filter((i) => i.code !== 'not_balanced')],
  };
}

export const hasBlockingIssues = (st: { issues: Issue[] }) => st.issues.length > 0;
