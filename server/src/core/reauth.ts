import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import { fail } from './errors.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
}

// Actions that need the person to re-enter their own password (§13, §24.3, §25).
export const REAUTH_ACTIONS = ['period.lock', 'period.reopen', 'year.reopen', 'year.close', 'snapshot.approve'] as const;
export type ReauthAction = typeof REAUTH_ACTIONS[number];

// Valid 5 minutes, for one user + company + action, single use. 5 failures in 15 minutes block new tokens.
export async function issueReauth(tx: Tx, userId: number, companyId: number, action: string, password: string) {
  if (!(REAUTH_ACTIONS as readonly string[]).includes(action)) fail('إجراء غير معروف');
  const { rows: [f] } = await tx.query(`select count(*)::int as n, max(at) as last from reauth_failures where user_id = $1 and at > now() - interval '15 minutes'`, [userId]);
  if (f.n >= 5) fail('محاولات تحقق فاشلة كثيرة — حاول بعد ربع ساعة', 429);
  const { rows: [u] } = await tx.query('select password_hash from users where id = $1 and active', [userId]);
  if (!u || !verifyPassword(password ?? '', u.password_hash)) {
    await tx.query('insert into reauth_failures(user_id) values ($1)', [userId]);
    return null; // caller commits the failure, then reports it
  }
  const token = randomBytes(24).toString('base64url');
  await tx.query(`insert into reauth_tokens(token_hash, user_id, company_id, action, expires_at) values ($1,$2,$3,$4, now() + interval '5 minutes')`,
    [sha(token), userId, companyId, action]);
  return token;
}

export async function consumeReauth(tx: Tx, token: string | undefined, userId: number, companyId: number, action: ReauthAction) {
  if (!token) fail('هذا الإجراء يحتاج تأكيد هويتك بكلمة مرورك', 401);
  const { rows } = await tx.query(
    `update reauth_tokens set used_at = now() where token_hash = $1 and user_id = $2 and company_id = $3 and action = $4
       and used_at is null and expires_at > now() returning 1`, [sha(token!), userId, companyId, action]);
  if (!rows.length) fail('تأكيد الهوية غير صالح أو منتهٍ أو لإجراء آخر — أعد التأكيد', 401);
}
