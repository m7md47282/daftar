import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { requireManager } from './types.ts';
import { fail } from './errors.ts';
import { audit, isDate } from './audit.ts';

// §22 review cycles (year + date range) and their adjustment batches
export async function createCycle(tx: Tx, c: Ctx, input: { year_id: number; name: string; start_date: string; end_date: string }) {
  requireManager(c);
  const { rows: [y] } = await tx.query('select * from fiscal_years where id = $1 and company_id = $2', [input.year_id, c.companyId]);
  if (!y) fail('السنة غير موجودة في هذه الشركة');
  if (!isDate(input.start_date) || !isDate(input.end_date) || input.start_date > input.end_date) fail('مدى الدورة غير صالح');
  if (input.start_date < y.start_date || input.end_date > y.end_date) fail('مدى الدورة يجب أن يقع داخل السنة');
  if (!input.name?.trim()) fail('اسم الدورة مطلوب');
  const { rows: [r] } = await tx.query(`insert into review_cycles(company_id, year_id, name, start_date, end_date, created_by) values ($1,$2,$3,$4,$5,$6) returning *`,
    [c.companyId, y.id, input.name.trim(), input.start_date, input.end_date, c.userId]);
  await audit(tx, c, 'review.cycle', 'review_cycle', r.id, { after: input });
  return r;
}

export async function createBatch(tx: Tx, c: Ctx, input: { cycle_id: number; name: string }) {
  requireManager(c);
  const { rows: [cy] } = await tx.query('select * from review_cycles where id = $1 and company_id = $2', [input.cycle_id, c.companyId]);
  if (!cy) fail('دورة المراجعة غير موجودة في هذه الشركة');
  if (cy.status !== 'open') fail('دورة المراجعة مغلقة');
  if (!input.name?.trim()) fail('اسم الدفعة مطلوب');
  const { rows: [b] } = await tx.query('insert into adjustment_batches(company_id, cycle_id, name, created_by) values ($1,$2,$3,$4) returning *', [c.companyId, cy.id, input.name.trim(), c.userId]);
  await audit(tx, c, 'review.batch', 'adjustment_batch', b.id, { after: input });
  return b;
}

export async function setCycleStatus(tx: Tx, c: Ctx, id: number, status: 'open' | 'closed') {
  requireManager(c);
  const { rowCount } = await tx.query('update review_cycles set status = $2 where id = $1 and company_id = $3', [id, status, c.companyId]);
  if (!rowCount) fail('الدورة غير موجودة', 404);
  await audit(tx, c, `review.cycle_${status}`, 'review_cycle', id);
}

export async function setBatchStatus(tx: Tx, c: Ctx, id: number, status: 'open' | 'closed') {
  requireManager(c);
  const { rowCount } = await tx.query('update adjustment_batches set status = $2 where id = $1 and company_id = $3', [id, status, c.companyId]);
  if (!rowCount) fail('الدفعة غير موجودة', 404);
  await audit(tx, c, `review.batch_${status}`, 'adjustment_batch', id);
}

export async function listReview(tx: Tx, c: Ctx) {
  const { rows: cycles } = await tx.query(
    `select r.*, y.name as year_name from review_cycles r join fiscal_years y on y.id = r.year_id where r.company_id = $1 order by r.start_date desc, r.id desc`, [c.companyId]);
  const { rows: batches } = await tx.query(
    `select b.*, (select count(*) from journal_entries e where e.batch_id = b.id)::int as entries from adjustment_batches b where b.company_id = $1 order by b.id`, [c.companyId]);
  return cycles.map((cy) => ({ ...cy, batches: batches.filter((b) => b.cycle_id === cy.id) }));
}
