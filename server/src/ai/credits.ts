import { platformTx } from '../db/pools.ts';
import { fail } from '../core/errors.ts';
import { getSetting } from '../platform.ts';

// AI credits. A company's balance is billing data kept on the company row (history in ai_credit_ledger).
// Amounts are stored in milli-credits so small requests are not rounded to zero.
// One credit pays for `ai_credit_usd` dollars of actual Anthropic API cost (default 0.01).

// USD per million tokens (first-party API). Cache writes are the 5-minute ephemeral rate (1.25× input).
type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};
// Unknown model ids are charged at the most expensive known rate, never for free.
const priceOf = (model: string) => PRICES[model] ?? PRICES['claude-fable-5-1'];

export type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function addUsage(u: Usage, r: any) {
  u.input += r?.input_tokens ?? 0;
  u.output += r?.output_tokens ?? 0;
  u.cacheWrite += r?.cache_creation_input_tokens ?? 0;
  u.cacheRead += r?.cache_read_input_tokens ?? 0;
}

// $/MTok is the same number as micro-dollars per token.
export function costMicros(model: string, u: Usage) {
  const p = priceOf(model);
  return Math.ceil(u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead);
}

async function microsPerMilliCredit() {
  const usd = Number((await getSetting('ai_credit_usd')) ?? 0.01);
  return (usd > 0 ? usd : 0.01) * 1000; // 1 credit = usd * 1e6 micros → 1 milli-credit = usd * 1e3 micros
}

export async function usageToMilli(model: string, u: Usage) {
  const micros = costMicros(model, u);
  return micros > 0 ? Math.max(1, Math.ceil(micros / (await microsPerMilliCredit()))) : 0;
}

export async function balanceMilli(companyId: number): Promise<number> {
  const { rows: [t] } = await platformTx((x) => x.query('select ai_credits_milli from companies where id = $1', [companyId]));
  return Number(t?.ai_credits_milli ?? 0);
}

export async function requireCredits(tenantId: number) {
  if ((await balanceMilli(tenantId)) <= 0) fail('رصيد المحاسب الذكي منتهٍ — تواصل مع إدارة المنصة لشحن الرصيد', 402);
}

// Deducts what a request actually cost. The balance may dip slightly below zero on the last
// request; the next one is then refused by requireCredits.
export async function charge(tenantId: number, userId: number, model: string, u: Usage, note: string) {
  const milli = await usageToMilli(model, u);
  if (!milli) return balanceMilli(tenantId);
  return platformTx(async (c) => {
    const { rows: [t] } = await c.query('update companies set ai_credits_milli = ai_credits_milli - $2 where id = $1 returning ai_credits_milli', [tenantId, milli]);
    await c.query(
      `insert into ai_credit_ledger(company_id, kind, delta_milli, balance_after_milli, note, user_id, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd_micros)
       values ($1,'usage',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenantId, -milli, t.ai_credits_milli, note.slice(0, 200), userId, model, u.input, u.output, u.cacheWrite, u.cacheRead, costMicros(model, u)]);
    return Number(t.ai_credits_milli);
  });
}

// Super admin top-up (positive) or correction (negative).
export async function adjust(tenantId: number, byUserId: number, credits: number, note: string) {
  const milli = Math.round(credits * 1000);
  if (!milli) fail('أدخل عدد الأرصدة');
  return platformTx(async (c) => {
    const { rows: [t] } = await c.query('update companies set ai_credits_milli = ai_credits_milli + $2 where id = $1 and not is_demo returning ai_credits_milli', [tenantId, milli]);
    if (!t) fail('المنشأة غير موجودة', 404);
    await c.query(`insert into ai_credit_ledger(company_id, kind, delta_milli, balance_after_milli, note, user_id) values ($1,$2,$3,$4,$5,$6)`,
      [tenantId, milli > 0 ? 'topup' : 'adjust', milli, t.ai_credits_milli, note || null, byUserId]);
    await c.query('insert into platform_audit(user_id, company_id, action, detail) values ($1, $2, $3, $4)', [byUserId, tenantId, 'credits', JSON.stringify({ credits, note })]);
    return Number(t.ai_credits_milli);
  });
}

export async function ledger(tenantId: number, limit = 200) {
  const { rows } = await platformTx((x) => x.query(
    `select l.id, l.at, l.kind, l.delta_milli, l.balance_after_milli, l.note, l.model, l.input_tokens, l.output_tokens,
       l.cache_write_tokens, l.cache_read_tokens, l.cost_usd_micros, u.full_name as user_name
     from ai_credit_ledger l left join users u on u.id = l.user_id where l.company_id = $1 order by l.id desc limit $2`, [tenantId, limit]));
  return rows.map((r) => ({ ...r, credits: Number(r.delta_milli) / 1000, balance_after: Number(r.balance_after_milli) / 1000,
    cost_usd: r.cost_usd_micros == null ? null : Number(r.cost_usd_micros) / 1e6 }));
}
