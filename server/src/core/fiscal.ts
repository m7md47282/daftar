import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { requireManager } from './types.ts';
import { fail } from './errors.ts';
import { audit, bumpBook, isDate, addDays } from './audit.ts';
import { consumeReauth } from './reauth.ts';

export const YEAR_LABEL: Record<string, string> = { open: 'مفتوحة', under_review: 'تحت المراجعة', needs_supplementary: 'تحتاج إقفالًا تكميليًا', final: 'معتمدة نهائيًا' };
export const PERIOD_LABEL: Record<string, string> = { open: 'مفتوحة', adjustments_only: 'تسويات المدير فقط', locked: 'مقفلة' };
const EVENT_LABEL: Record<string, string> = { lock: 'قفل', reopen: 'إعادة فتح', review: 'بدء المراجعة', close: 'إقفال' };

export async function listEvents(tx: Tx, c: Ctx) {
  const { rows } = await tx.query(
    `select e.*, u.full_name as user_name, p.start_date as period_start, y.name as year_name from period_events e
     left join users u on u.id = e.user_id left join periods p on p.id = e.period_id left join fiscal_years y on y.id = e.year_id
     where e.company_id = $1 order by e.id desc limit 200`, [c.companyId]);
  const st = (r: any, v: string | null) => (v == null ? '' : (r.period_id ? PERIOD_LABEL : YEAR_LABEL)[v] ?? v);
  return rows.map((r) => ({ ...r, action_label: EVENT_LABEL[r.action] ?? r.action, from_label: st(r, r.from_status), to_label: st(r, r.to_status),
    target: r.period_id ? `فترة ${String(r.period_start).slice(0, 7)}` : r.year_name ?? '' }));
}

// Monthly periods covering exactly the year's days (partial first/last months, leap years) (§12.1).
export function monthlyPeriods(start: string, end: string) {
  const out: { start: string; end: string }[] = [];
  let cur = start;
  while (cur <= end) {
    const [y, m] = cur.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month
    const pe = monthEnd < end ? monthEnd : end;
    out.push({ start: cur, end: pe });
    cur = addDays(pe, 1);
  }
  return out;
}

export async function listYears(tx: Tx, c: Ctx) {
  const { rows: years } = await tx.query('select * from fiscal_years where company_id = $1 order by start_date', [c.companyId]);
  const { rows: periods } = await tx.query('select * from periods where company_id = $1 order by start_date', [c.companyId]);
  return years.map((y) => ({ ...y, status_label: YEAR_LABEL[y.status], periods: periods.filter((p) => p.year_id === y.id).map((p) => ({ ...p, status_label: PERIOD_LABEL[p.status] })) }));
}

export async function createYear(tx: Tx, c: Ctx, input: { name?: string; start_date: string; end_date: string; gap_reason?: string }) {
  requireManager(c);
  const { start_date: s, end_date: e } = input;
  if (!isDate(s) || !isDate(e)) fail('تواريخ السنة غير صالحة');
  if (e < s) fail('لا تنتهي السنة قبل بدايتها');
  const { rows: overlap } = await tx.query(`select name from fiscal_years where company_id = $1 and daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`, [c.companyId, s, e]);
  if (overlap.length) fail(`تتداخل مع السنة ${overlap[0].name} — يمكن فتح أكثر من سنة للعمل لكن لا تتداخل المدد`);
  const { rows: [prev] } = await tx.query('select end_date from fiscal_years where company_id = $1 and end_date < $2 order by end_date desc limit 1', [c.companyId, s]);
  const { rows: [next] } = await tx.query('select start_date from fiscal_years where company_id = $1 and start_date > $2 order by start_date limit 1', [c.companyId, e]);
  const gap = (prev && addDays(prev.end_date, 1) !== s) || (next && addDays(e, 1) !== next.start_date);
  if (gap && !input.gap_reason?.trim()) fail('توجد فجوة زمنية بين هذه السنة والسنة المجاورة — اذكر سببها');
  const name = input.name?.trim() || (s.slice(0, 4) === e.slice(0, 4) ? `السنة المالية ${s.slice(0, 4)}` : `السنة المالية ${s.slice(0, 4)}/${e.slice(0, 4)}`);
  const { rows: [y] } = await tx.query(`insert into fiscal_years(company_id, name, start_date, end_date, gap_reason) values ($1,$2,$3,$4,$5) returning *`,
    [c.companyId, name, s, e, gap ? input.gap_reason!.trim() : null]);
  for (const p of monthlyPeriods(s, e)) await tx.query('insert into periods(company_id, year_id, start_date, end_date) values ($1,$2,$3,$4)', [c.companyId, y.id, p.start, p.end]);
  await audit(tx, c, 'year.create', 'fiscal_year', y.id, { after: { name, s, e } });
  return y;
}

export async function yearForDate(tx: Tx, companyId: number, date: string) {
  const { rows: [y] } = await tx.query('select * from fiscal_years where company_id = $1 and $2::date between start_date and end_date', [companyId, date]);
  return y ?? null;
}

export async function periodForDate(tx: Tx, companyId: number, date: string) {
  const { rows: [p] } = await tx.query('select * from periods where company_id = $1 and $2::date between start_date and end_date', [companyId, date]);
  return p ?? null;
}

async function event(tx: Tx, c: Ctx, e: { year_id?: number; period_id?: number; action: string; from?: string; to?: string; reason?: string }) {
  await tx.query(`insert into period_events(company_id, year_id, period_id, action, from_status, to_status, reason, user_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c.companyId, e.year_id ?? null, e.period_id ?? null, e.action, e.from ?? null, e.to ?? null, e.reason ?? null, c.userId]);
}

// Tightening a period (open → adjustments_only → locked). Needs personal re-confirmation.
export async function lockPeriod(tx: Tx, c: Ctx, periodId: number, to: 'adjustments_only' | 'locked', reauth?: string) {
  requireManager(c);
  await consumeReauth(tx, reauth, c.userId, c.companyId, 'period.lock');
  const { rows: [p] } = await tx.query('select * from periods where id = $1 and company_id = $2 for update', [periodId, c.companyId]);
  if (!p) fail('الفترة غير موجودة', 404);
  const rank = { open: 0, adjustments_only: 1, locked: 2 } as const;
  if (rank[to] <= rank[p.status as keyof typeof rank]) fail('هذا ليس تشديدًا للفترة — استخدم إعادة الفتح');
  await tx.query('update periods set status = $2 where id = $1', [periodId, to]);
  await event(tx, c, { year_id: p.year_id, period_id: p.id, action: 'lock', from: p.status, to });
  await audit(tx, c, 'period.lock', 'period', p.id, { before: p.status, after: to });
}

// Loosening needs a reason + re-confirmation (§13.2). Never edits entries.
export async function reopenPeriod(tx: Tx, c: Ctx, periodId: number, to: 'open' | 'adjustments_only', reason: string, reauth?: string) {
  requireManager(c);
  if (!reason?.trim()) fail('سبب إعادة الفتح مطلوب');
  await consumeReauth(tx, reauth, c.userId, c.companyId, 'period.reopen');
  const { rows: [p] } = await tx.query('select * from periods where id = $1 and company_id = $2 for update', [periodId, c.companyId]);
  if (!p) fail('الفترة غير موجودة', 404);
  const { rows: [y] } = await tx.query('select status from fiscal_years where id = $1', [p.year_id]);
  if (y.status === 'final') fail('السنة معتمدة نهائيًا — أعد فتح السنة أولًا');
  const rank = { open: 0, adjustments_only: 1, locked: 2 } as const;
  if (rank[to] >= rank[p.status as keyof typeof rank]) fail('هذا ليس تخفيفًا للفترة');
  await tx.query('update periods set status = $2 where id = $1', [periodId, to]);
  await event(tx, c, { year_id: p.year_id, period_id: p.id, action: 'reopen', from: p.status, to, reason });
  await audit(tx, c, 'period.reopen', 'period', p.id, { reason, before: p.status, after: to });
}

// open → under_review (no posting of normal entries; adjustments only).
export async function startReview(tx: Tx, c: Ctx, yearId: number) {
  requireManager(c);
  const { rows: [y] } = await tx.query('select * from fiscal_years where id = $1 and company_id = $2 for update', [yearId, c.companyId]);
  if (!y) fail('السنة غير موجودة', 404);
  if (y.status !== 'open') fail('السنة ليست مفتوحة');
  await tx.query(`update fiscal_years set status = 'under_review' where id = $1`, [yearId]);
  await event(tx, c, { year_id: yearId, action: 'review', from: y.status, to: 'under_review' });
  await audit(tx, c, 'year.review', 'fiscal_year', yearId, { before: y.status, after: 'under_review' });
}

// Reopening a closed/final year (§13.2, §26.3): later final years get a dependency flag; nothing is rewritten.
export async function reopenYear(tx: Tx, c: Ctx, yearId: number, to: 'open' | 'under_review', periodsTo: 'open' | 'adjustments_only', reason: string, reauth?: string) {
  requireManager(c);
  if (!reason?.trim()) fail('سبب إعادة الفتح مطلوب');
  await consumeReauth(tx, reauth, c.userId, c.companyId, 'year.reopen');
  const { rows: [y] } = await tx.query('select * from fiscal_years where id = $1 and company_id = $2 for update', [yearId, c.companyId]);
  if (!y) fail('السنة غير موجودة', 404);
  if (y.status === 'open') fail('السنة مفتوحة أصلًا');
  await tx.query('update fiscal_years set status = $2 where id = $1', [yearId, to]);
  await tx.query(`update periods set status = $2 where year_id = $1 and status <> $2`, [yearId, periodsTo]);
  const { rows: later } = await tx.query(`update fiscal_years set needs_dependency_review = true where company_id = $1 and start_date > $2 and status = 'final' returning id, name`, [c.companyId, y.end_date]);
  await bumpBook(tx, c.companyId);
  await event(tx, c, { year_id: yearId, action: 'reopen', from: y.status, to, reason });
  await audit(tx, c, 'year.reopen', 'fiscal_year', yearId, { reason, before: y.status, after: { status: to, periods: periodsTo, flagged_later_years: later.map((l) => l.name) } });
  return { flagged_later_years: later };
}

// Posting gate shared by every write path (§12.3–12.4, §15.2). Closing runs bypass it (special procedure).
export async function assertCanPost(tx: Tx, c: Ctx, date: string, purpose: 'normal' | 'adjustment' | 'opening') {
  if (!isDate(date)) fail('التاريخ المحاسبي غير صالح');
  const y = await yearForDate(tx, c.companyId, date);
  if (!y) fail(`لا توجد سنة مالية مهيأة تشمل التاريخ ${date}`);
  if (y.status === 'final') fail(`السنة ${y.name} معتمدة نهائيًا — لا تسجيل قبل إعادة فتح مخولة`);
  if ((y.status === 'under_review' || y.status === 'needs_supplementary') && purpose !== 'adjustment')
    fail(`السنة ${y.name} تحت المراجعة — يقتصر التسجيل على تسويات المراجعة`);
  const p = await periodForDate(tx, c.companyId, date);
  if (!p) fail('لا توجد فترة لهذا التاريخ');
  // lock the period row so a concurrent lock/reopen is ordered with this posting (§13.1, YR-07)
  const { rows: [pl] } = await tx.query('select status from periods where id = $1 for share', [p.id]);
  if (pl.status === 'locked') fail(`فترة ${p.start_date.slice(0, 7)} مقفلة — لا تسجيل قبل إعادة الفتح`);
  if (pl.status === 'adjustments_only') {
    if (purpose !== 'adjustment') fail(`فترة ${p.start_date.slice(0, 7)} مخصصة لتسويات المدير فقط`);
    if (c.role === 'employee') fail('فترة تسويات المدير فقط — لا يرحّل الموظف فيها');
  }
  return y;
}
