import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { fail } from './errors.ts';
import { isDate, today } from './audit.ts';
import { fromDb, toStr } from './money.ts';
import { definitionsAsOf } from './accounts.ts';
import { yearForDate } from './fiscal.ts';

// ---------------------------------------------------------------- report modes (§21.3)
export type Mode = 'raw' | 'before_adjustments' | 'adjustments_only' | 'after_adjustments' | 'after_close';
export const MODE_LABEL: Record<Mode, string> = {
  raw: 'الدفتر الخام', before_adjustments: 'قبل التسويات', adjustments_only: 'التسويات فقط',
  after_adjustments: 'بعد التسويات وقبل الإقفال', after_close: 'بعد الإقفال',
};
export type Range = { from: string; to: string; mode?: Mode; cycle_id?: number | null; branch_id?: number | null; definitions_date?: string };

type Sums = { opening: bigint; debit: bigint; credit: bigint };
// every query binds the same 7 parameters; this keeps unused ones typed for Postgres
const ALL_ARGS = `and $4::date is not null and $5::date is not null and ($6::int[] is null or cardinality($6::int[]) >= 0)`;

// Resolves the target year and the SQL that decides which lines count, per mode.
async function scope(tx: Tx, c: Ctx, r: Range) {
  if (!isDate(r.from) || !isDate(r.to)) fail('حدد تاريخ البداية والنهاية');
  if (r.from > r.to) fail('تاريخ البداية بعد تاريخ النهاية');
  const mode: Mode = r.mode ?? 'raw';
  let year: any = null;
  if (mode !== 'raw') {
    year = await yearForDate(tx, c.companyId, r.from);
    if (!year || r.to > year.end_date) fail('هذا الوضع يحتاج مدة داخل سنة مالية واحدة');
  } else year = await yearForDate(tx, c.companyId, r.to);
  let batchIds: number[] | null = null;
  if (r.cycle_id) {
    const { rows: [cy] } = await tx.query('select * from review_cycles where id = $1 and company_id = $2', [r.cycle_id, c.companyId]);
    if (!cy) fail('دورة المراجعة غير موجودة في هذه الشركة');
    if (year && cy.year_id !== year.id) fail('دورة المراجعة لا تخص سنة المدة المختارة');
    const { rows } = await tx.query('select id from adjustment_batches where cycle_id = $1', [cy.id]);
    batchIds = rows.map((x) => x.id);
  }
  const ys = year?.start_date ?? '0001-01-01', ye = year?.end_date ?? '0001-01-01';
  // $1 company, $2 from, $3 to, $4 ys, $5 ye, $6 batch ids (or null), $7 branch
  const closingY = `(jl.purpose = 'closing' and jl.date between $4 and $5)`;
  const adjIn = `(jl.purpose = 'adjustment' and jl.date between $2 and $3 and ($6::int[] is null or jl.batch_id = any($6)))`;
  const period: Record<Mode, string> = {
    raw: 'true', after_close: 'true',
    after_adjustments: `not ${closingY}`,
    before_adjustments: `not ${closingY} and not ${adjIn}`,
    adjustments_only: adjIn,
  };
  return { mode, year, params: [c.companyId, r.from, r.to, ys, ye, batchIds, r.branch_id ?? null], periodSql: period[mode], openingSql: mode === 'adjustments_only' ? 'false' : 'true' };
}

async function sums(tx: Tx, c: Ctx, r: Range, accountId?: number) {
  const s = await scope(tx, c, r);
  const { rows } = await tx.query(
    `select jl.account_id,
       coalesce(sum(case when jl.date < $2 and (${s.openingSql}) then jl.debit - jl.credit end), 0)::text as opening,
       coalesce(sum(case when jl.date between $2 and $3 and (${s.periodSql}) then jl.debit end), 0)::text as debit,
       coalesce(sum(case when jl.date between $2 and $3 and (${s.periodSql}) then jl.credit end), 0)::text as credit
     from journal_lines jl
     where jl.company_id = $1 and jl.date <= $3 and ($7::int is null or jl.branch_id = $7) ${ALL_ARGS} ${accountId ? `and jl.account_id = ${Number(accountId)}` : ''}
     group by jl.account_id`, s.params);
  const map = new Map<number, Sums>(rows.map((x) => [x.account_id, { opening: fromDb(x.opening), debit: fromDb(x.debit), credit: fromDb(x.credit) }]));
  return { ...s, map };
}

function finality(mode: Mode, year: any, to: string) {
  if (mode !== 'after_close') return null;
  if (!year) return { final: false, warning: 'لا توجد سنة مالية لتاريخ التقرير' };
  if (to !== year.end_date) return { final: false, warning: 'التقرير لا ينتهي بنهاية السنة — لا يكتسب صفة "بعد إقفال السنة"' };
  if (year.status !== 'final') return { final: false, warning: 'لا يوجد إقفال نهائي ساري لهذه السنة' };
  if (year.needs_dependency_review) return { final: false, warning: 'السنة تحتاج مراجعة لتغير سنة سابقة' };
  return { final: true, warning: null };
}

const side = (v: bigint) => ({ debit: v > 0n ? toStr(v) : '0.00', credit: v < 0n ? toStr(-v) : '0.00' });

// ---------------------------------------------------------------- trial balance (§21)
export async function trialBalance(tx: Tx, c: Ctx, r: Range & { include_zero?: boolean }) {
  const s = await sums(tx, c, r);
  const defs = await definitionsAsOf(tx, c.companyId, r.definitions_date ?? r.to);
  const { rows: accs } = await tx.query('select id, parent_id, is_group, classification from accounts where company_id = $1 and deleted_at is null', [c.companyId]);
  type Agg = { od: bigint; oc: bigint; d: bigint; cr: bigint; cd: bigint; cc: bigint };
  const agg = new Map<number, Agg>(accs.map((a) => [a.id, { od: 0n, oc: 0n, d: 0n, cr: 0n, cd: 0n, cc: 0n }]));
  const byId = new Map(accs.map((a) => [a.id, a]));
  const tot: Agg = { od: 0n, oc: 0n, d: 0n, cr: 0n, cd: 0n, cc: 0n };
  for (const [id, v] of s.map) {
    const close = v.opening + v.debit - v.credit;
    const leaf: Agg = { od: v.opening > 0n ? v.opening : 0n, oc: v.opening < 0n ? -v.opening : 0n, d: v.debit, cr: v.credit, cd: close > 0n ? close : 0n, cc: close < 0n ? -close : 0n };
    for (const k of Object.keys(tot) as (keyof Agg)[]) tot[k] += leaf[k];
    // each leaf's own sides roll up; a parent never nets debit and credit balances of different children (§21.2)
    let a: any = byId.get(id);
    while (a) { const g = agg.get(a.id)!; for (const k of Object.keys(g) as (keyof Agg)[]) g[k] += leaf[k]; a = a.parent_id ? byId.get(a.parent_id) : null; }
  }
  const depth = (a: any): number => (a.parent_id ? 1 + depth(byId.get(a.parent_id)) : 0);
  const rows = accs.map((a) => ({ a, g: agg.get(a.id)! }))
    .filter(({ g }) => r.include_zero || g.od || g.oc || g.d || g.cr)
    .map(({ a, g }) => ({
      account_id: a.id, code: defs.get(a.id)!.code, name: defs.get(a.id)!.name, is_group: a.is_group, level: depth(a), classification: a.classification,
      opening_debit: toStr(g.od), opening_credit: toStr(g.oc), debit: toStr(g.d), credit: toStr(g.cr), closing_debit: toStr(g.cd), closing_credit: toStr(g.cc),
    }))
    .sort((x, y) => x.code.localeCompare(y.code, 'en'));
  return {
    from: r.from, to: r.to, mode: s.mode, mode_label: MODE_LABEL[s.mode], year: s.year ? { id: s.year.id, name: s.year.name, status: s.year.status } : null,
    cycle_id: r.cycle_id ?? null, finality: finality(s.mode, s.year, r.to), currency: 'SAR', rows,
    totals: { opening_debit: toStr(tot.od), opening_credit: toStr(tot.oc), debit: toStr(tot.d), credit: toStr(tot.cr), closing_debit: toStr(tot.cd), closing_credit: toStr(tot.cc) },
    balanced: tot.cd === tot.cc && tot.d === tot.cr,
  };
}

// ---------------------------------------------------------------- ledger (§20)
export async function ledger(tx: Tx, c: Ctx, accountId: number, r: Range) {
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2', [accountId, c.companyId]);
  if (!a) fail('الحساب غير موجود في هذه الشركة', 404);
  if (a.is_group) fail('دفتر الأستاذ لحساب قابل للترحيل؛ تجميعات الحسابات تظهر في ميزان المراجعة');
  const s = await scope(tx, c, r);
  const { rows: [op] } = await tx.query(
    `select coalesce(sum(jl.debit - jl.credit), 0)::text as v from journal_lines jl
     where jl.company_id = $1 and jl.account_id = ${Number(accountId)} and jl.date < $2 and (${s.openingSql}) and ($7::int is null or jl.branch_id = $7)
       and $3::date is not null ${ALL_ARGS}`, s.params);
  const { rows } = await tx.query(
    `select jl.date, e.id as entry_id, e.number, e.purpose, e.origin, jl.line_no, coalesce(jl.description, e.description) as description, jl.debit, jl.credit, p.name as party_name
     from journal_lines jl join journal_entries e on e.id = jl.entry_id left join parties p on p.id = jl.party_id
     where jl.company_id = $1 and jl.account_id = ${Number(accountId)} and jl.date between $2 and $3 and (${s.periodSql}) and ($7::int is null or jl.branch_id = $7)
       ${ALL_ARGS}
     order by jl.date, e.id, jl.line_no`, s.params);
  let bal = fromDb(op.v), td = 0n, tc = 0n;
  const opening = bal;
  const lines = rows.map((x) => {
    const d = fromDb(x.debit), cr = fromDb(x.credit);
    bal += d - cr; td += d; tc += cr;
    return { date: x.date, entry_id: x.entry_id, number: x.number, purpose: x.purpose, origin: x.origin, description: x.description, party_name: x.party_name,
      debit: toStr(d), credit: toStr(cr), balance: toStr(bal < 0n ? -bal : bal), balance_side: bal > 0n ? 'مدين' : bal < 0n ? 'دائن' : '' };
  });
  const def = (await definitionsAsOf(tx, c.companyId, r.definitions_date ?? r.to)).get(a.id)!;
  return { account: { id: a.id, code: def.code, name: def.name, classification: a.classification }, from: r.from, to: r.to, mode: s.mode, mode_label: MODE_LABEL[s.mode],
    currency: 'SAR', finality: finality(s.mode, s.year, r.to),
    opening: toStr(opening < 0n ? -opening : opening), opening_side: opening > 0n ? 'مدين' : opening < 0n ? 'دائن' : '',
    total_debit: toStr(td), total_credit: toStr(tc), closing: toStr(bal < 0n ? -bal : bal), closing_side: bal > 0n ? 'مدين' : bal < 0n ? 'دائن' : '', lines };
}

// subsidiary ledger by party (trader extension)
export async function partyStatement(tx: Tx, c: Ctx, partyId: number, r: { from: string; to: string }) {
  const { rows: [p] } = await tx.query('select * from parties where id = $1 and company_id = $2', [partyId, c.companyId]);
  if (!p) fail('الطرف غير موجود', 404);
  const { rows: [op] } = await tx.query(`select coalesce(sum(debit - credit),0)::text as v from journal_lines where company_id = $1 and party_id = $2 and date < $3`, [c.companyId, partyId, r.from]);
  const { rows } = await tx.query(
    `select jl.date, e.id as entry_id, e.number, e.origin, coalesce(jl.description, e.description) as description, jl.debit, jl.credit, jl.account_code, jl.account_name
     from journal_lines jl join journal_entries e on e.id = jl.entry_id where jl.company_id = $1 and jl.party_id = $2 and jl.date between $3 and $4
     order by jl.date, e.id, jl.line_no`, [c.companyId, partyId, r.from, r.to]);
  let bal = fromDb(op.v), td = 0n, tc = 0n;
  const opening = bal;
  const lines = rows.map((x) => { const d = fromDb(x.debit), cr = fromDb(x.credit); bal += d - cr; td += d; tc += cr; return { ...x, debit: toStr(d), credit: toStr(cr), balance: toStr(bal) }; });
  return { party: { id: p.id, name: p.name, kind: p.kind }, from: r.from, to: r.to, opening: toStr(opening), total_debit: toStr(td), total_credit: toStr(tc), closing: toStr(bal), lines };
}

export async function partyBalances(tx: Tx, c: Ctx, kind: 'customer' | 'supplier') {
  const { rows } = await tx.query(
    `select p.id, p.name, p.phone, p.vat_number, p.branch_id, coalesce(sum(jl.debit - jl.credit), 0)::text as balance
     from parties p left join journal_lines jl on jl.party_id = p.id where p.company_id = $1 and p.kind = $2 group by p.id order by p.name`, [c.companyId, kind]);
  return rows.map((r) => ({ ...r, balance: toStr(fromDb(r.balance)) }));
}

// ---------------------------------------------------------------- adjustment worksheet (§22.3–22.4)
export async function worksheet(tx: Tx, c: Ctx, r: { from: string; to: string; cycle_id?: number | null; branch_id?: number | null }) {
  const before = await sums(tx, c, { ...r, mode: 'before_adjustments' });
  const adj = await sums(tx, c, { ...r, mode: 'adjustments_only' });
  const defs = await definitionsAsOf(tx, c.companyId, r.to);
  const ids = new Set([...before.map.keys(), ...adj.map.keys()]);
  let t = { bd: 0n, bc: 0n, ad: 0n, ac: 0n, fd: 0n, fc: 0n };
  const rows = [...ids].map((id) => {
    const b = before.map.get(id), a = adj.map.get(id);
    const bv = b ? b.opening + b.debit - b.credit : 0n;
    const ad = a?.debit ?? 0n, ac = a?.credit ?? 0n;
    const after = bv + ad - ac; // signed math: the side may flip (§22.3)
    t = { bd: t.bd + (bv > 0n ? bv : 0n), bc: t.bc + (bv < 0n ? -bv : 0n), ad: t.ad + ad, ac: t.ac + ac, fd: t.fd + (after > 0n ? after : 0n), fc: t.fc + (after < 0n ? -after : 0n) };
    const d = defs.get(id)!;
    return { account_id: id, code: d.code, name: d.name, before: side(bv), adjustments: { debit: toStr(ad), credit: toStr(ac) }, after: side(after), changed: ad !== 0n || ac !== 0n };
  }).filter((x) => x.before.debit !== '0.00' || x.before.credit !== '0.00' || x.changed).sort((x, y) => x.code.localeCompare(y.code, 'en'));
  return { from: r.from, to: r.to, cycle_id: r.cycle_id ?? null, year: before.year ? { id: before.year.id, name: before.year.name } : null, rows,
    totals: { before: { debit: toStr(t.bd), credit: toStr(t.bc) }, adjustments: { debit: toStr(t.ad), credit: toStr(t.ac) }, after: { debit: toStr(t.fd), credit: toStr(t.fc) } } };
}

export const defaultRange = async (tx: Tx, c: Ctx) => {
  const y = await yearForDate(tx, c.companyId, today());
  return { from: y?.start_date ?? today().slice(0, 4) + '-01-01', to: today() };
};
