import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';

// §28.1: who, which company, when, what, why, and the state before/after.
export async function audit(tx: Tx, c: Ctx, action: string, entity: string | null, entityId: number | null,
  extra: { reason?: string | null; before?: unknown; after?: unknown } = {}) {
  await tx.query(
    `insert into audit_log(company_id, user_id, user_name, via, action, entity, entity_id, reason, before, after)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.companyId, c.userId, c.role === 'platform' ? `${c.userName} (إدارة المنصة)` : c.userName, c.via, action, entity, entityId,
      extra.reason ?? null, extra.before === undefined ? null : JSON.stringify(extra.before), extra.after === undefined ? null : JSON.stringify(extra.after)]);
}

// "مرجع تحديث الدفتر": every change that can alter a report bumps the company's book version.
export async function bumpBook(tx: Tx, companyId: number): Promise<number> {
  const { rows: [r] } = await tx.query('update companies set book_version = book_version + 1 where id = $1 returning book_version', [companyId]);
  return r.book_version;
}

export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
export const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
