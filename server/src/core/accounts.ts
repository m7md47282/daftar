import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { requireManager } from './types.ts';
import { fail } from './errors.ts';
import { audit, bumpBook, isDate, addDays, today } from './audit.ts';

export type Presentation = { type: 'fixed'; line: number } | { type: 'by_balance'; debit_line: number; credit_line: number } | null;
export type Def = { code: string; name: string; presentation: Presentation; valid_from: string };
const CLASSES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

function checkPresentation(p: unknown): Presentation {
  if (p === null || p === undefined) return null;
  const x = p as any;
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 37;
  if (x.type === 'fixed' && ok(x.line)) return { type: 'fixed', line: x.line };
  if (x.type === 'by_balance' && ok(x.debit_line) && ok(x.credit_line)) return { type: 'by_balance', debit_line: x.debit_line, credit_line: x.credit_line };
  return fail('قاعدة العرض غير صالحة');
}

// Definition of every account as of a date. Before an account's first definition, its first one applies.
export async function definitionsAsOf(tx: Tx, companyId: number, date: string, ids?: number[]): Promise<Map<number, Def>> {
  const { rows } = await tx.query(
    `select distinct on (account_id) account_id, code, name, presentation, valid_from
     from account_definitions where company_id = $1 and ($3::int[] is null or account_id = any($3))
     order by account_id, (valid_from <= $2::date) desc, case when valid_from <= $2::date then valid_from end desc nulls last, valid_from asc`,
    [companyId, date, ids ?? null]);
  return new Map(rows.map((r) => [r.account_id, { code: r.code, name: r.name, presentation: r.presentation, valid_from: r.valid_from }]));
}

export async function chartState(tx: Tx, companyId: number) {
  const { rows: [c] } = await tx.query('select chart_state, result_account_id, chart_start_date from companies where id = $1', [companyId]);
  return c;
}

async function usedIds(tx: Tx, companyId: number): Promise<Set<number>> {
  const { rows } = await tx.query('select distinct account_id from journal_lines where company_id = $1', [companyId]);
  return new Set(rows.map((r) => r.account_id));
}

// The tree as of a date, with usage and protection flags for the UI.
export async function listAccounts(tx: Tx, c: Ctx, asOf = today()) {
  const { rows } = await tx.query(
    `select a.*, (select count(*) from account_definitions d where d.account_id = a.id)::int as definitions
     from accounts a where a.company_id = $1 and a.deleted_at is null order by a.id`, [c.companyId]);
  const defs = await definitionsAsOf(tx, c.companyId, asOf);
  const used = await usedIds(tx, c.companyId);
  const { rows: [co] } = await tx.query('select result_account_id from companies where id = $1', [c.companyId]);
  const byParent = new Map<number | null, any[]>();
  for (const a of rows) { const k = a.parent_id ?? null; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k)!.push(a); }
  const usedDeep = (a: any): boolean => used.has(a.id) || (byParent.get(a.id) ?? []).some(usedDeep);
  const out = rows.map((a) => {
    const d = defs.get(a.id)!;
    return {
      id: a.id, parent_id: a.parent_id, code: d.code, name: d.name, classification: a.classification, is_group: a.is_group,
      nature: a.nature, closing: a.closing, presentation: d.presentation, start_date: a.start_date, stop_date: a.stop_date,
      ref_function: a.ref_function, template_origin: a.template_origin, branch_id: a.branch_id,
      active: a.start_date <= asOf && (!a.stop_date || a.stop_date >= asOf),
      used: usedDeep(a), has_children: (byParent.get(a.id) ?? []).length > 0, definitions: a.definitions,
      is_result_account: co.result_account_id === a.id,
      unmapped: !a.is_group && !d.presentation,
    };
  });
  return out.sort((x, y) => x.code.localeCompare(y.code, 'en'));
}

export async function getAccount(tx: Tx, c: Ctx, id: number) {
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [id, c.companyId]);
  if (!a) return fail('الحساب غير موجود', 404);
  const { rows: defs } = await tx.query('select code, name, presentation, valid_from, valid_to, created_at from account_definitions where account_id = $1 order by valid_from', [id]);
  const { rows: [u] } = await tx.query('select count(*)::int as n, min(date) as first, max(date) as last from journal_lines where account_id = $1', [id]);
  return { ...a, definitions: defs, usage: u };
}

export async function searchAccounts(tx: Tx, c: Ctx, q: string, opts: { postable?: boolean; date?: string } = {}) {
  const date = opts.date ?? today();
  const all = await listAccounts(tx, c, date);
  const s = q.trim();
  return all.filter((a) => (!opts.postable || (!a.is_group && a.active)) && (!s || a.code.startsWith(s) || a.name.includes(s))).slice(0, 40);
}

async function reserveCode(tx: Tx, companyId: number, code: string, accountId: number) {
  await tx.query('insert into account_codes(company_id, code, account_id) values ($1,$2,$3) on conflict do nothing', [companyId, code, accountId]);
  const { rows: [r] } = await tx.query('select account_id from account_codes where company_id = $1 and code = $2', [companyId, code]);
  if (r.account_id !== accountId) fail(`الرمز ${code} مستخدم (أو كان مستخدمًا تاريخيًا) لحساب آخر ولا يُعاد منحه`);
}

async function assertNotInFinalYear(tx: Tx, companyId: number, date: string) {
  const { rows } = await tx.query(`select name from fiscal_years where company_id = $1 and $2::date between start_date and end_date and status = 'final'`, [companyId, date]);
  if (rows.length) fail(`لا يبدأ تعريف جديد داخل سنة معتمدة نهائيًا (${rows[0].name}) — اختر تاريخ سريان لاحقًا`);
}

export type NewAccount = {
  parent_id?: number | null; code: string; name: string; classification?: string; is_group: boolean;
  nature?: 'debit' | 'credit' | 'variable'; closing?: 'permanent' | 'temporary'; start_date?: string;
  presentation?: Presentation; ref_function?: string | null; template_origin?: string | null; branch_id?: number | null;
};

export async function createAccount(tx: Tx, c: Ctx, input: NewAccount, opts: { skipStateCheck?: boolean; skipAudit?: boolean } = {}) {
  requireManager(c);
  if (!opts.skipStateCheck) {
    const st = await chartState(tx, c.companyId);
    if (st.chart_state === 'pending_template') fail('أسس دليل الحسابات أولًا: اختر قالبًا أو حدد أن الدليل يدوي');
  }
  const code = (input.code ?? '').trim(), name = (input.name ?? '').trim();
  if (!code || code.length > 50) fail('رمز الحساب مطلوب (حتى 50 خانة)');
  if (!name || name.length > 200) fail('اسم الحساب مطلوب (حتى 200 حرف)');
  let classification = input.classification;
  if (input.parent_id) {
    const { rows: [p] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [input.parent_id, c.companyId]);
    if (!p) fail('الحساب الأب غير موجود في هذه الشركة');
    if (!p.is_group) fail('لا يضاف حساب تحت حساب قابل للترحيل؛ اختر حسابًا تجميعيًا');
    if (classification && classification !== p.classification) fail('تصنيف الحساب يجب أن يطابق تصنيف الأب');
    classification = p.classification;
  }
  if (!classification || !CLASSES.includes(classification)) fail('حدد تصنيف الحساب');
  if (!input.is_group && (!input.nature || !input.closing)) fail('الحساب القابل للترحيل يحتاج طبيعة وسلوك إقفال');
  const start = input.start_date ?? today();
  if (!isDate(start)) fail('تاريخ بداية الاستخدام غير صالح');
  const pres = input.is_group ? null : checkPresentation(input.presentation);
  const { rows: [a] } = await tx.query(
    `insert into accounts(company_id, parent_id, classification, is_group, nature, closing, start_date, ref_function, template_origin, branch_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [c.companyId, input.parent_id ?? null, classification, input.is_group, input.is_group ? null : input.nature, input.is_group ? null : input.closing,
      start, input.ref_function ?? null, input.template_origin ?? null, input.branch_id ?? null]);
  await reserveCode(tx, c.companyId, code, a.id);
  await tx.query(`insert into account_definitions(company_id, account_id, code, name, presentation, valid_from, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
    [c.companyId, a.id, code, name, pres ? JSON.stringify(pres) : null, start, c.userId]);
  if (!opts.skipAudit) { await bumpBook(tx, c.companyId); await audit(tx, c, 'account.create', 'account', a.id, { after: { code, name, classification, is_group: input.is_group } }); }
  return a;
}

// §10: a new dated definition (name/code/presentation). Identity and balance never move.
export async function addDefinition(tx: Tx, c: Ctx, accountId: number, input: { code?: string; name?: string; presentation?: Presentation; valid_from: string; reason?: string }) {
  requireManager(c);
  if (!isDate(input.valid_from)) fail('تاريخ السريان غير صالح');
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [accountId, c.companyId]);
  if (!a) fail('الحساب غير موجود', 404);
  const { rows: [last] } = await tx.query('select * from account_definitions where account_id = $1 order by valid_from desc limit 1', [accountId]);
  const code = (input.code ?? last.code).trim(), name = (input.name ?? last.name).trim();
  if (!code || code.length > 50 || !name || name.length > 200) fail('الرمز (≤50) والاسم (≤200) مطلوبان');
  const pres = a.is_group ? null : input.presentation === undefined ? last.presentation : checkPresentation(input.presentation);
  if (code === last.code && name === last.name && JSON.stringify(pres) === JSON.stringify(last.presentation)) fail('لا يوجد تغيير في التعريف');
  if (input.valid_from <= last.valid_from) fail(`يبدأ التعريف الجديد بعد آخر تعريف محفوظ (${last.valid_from}) — لا يُستبدل تعريف تاريخي`);
  if (input.valid_from < a.start_date) fail('لا يسري تعريف قبل بداية استخدام الحساب');
  await assertNotInFinalYear(tx, c.companyId, input.valid_from);
  if (code !== last.code) await reserveCode(tx, c.companyId, code, accountId);
  await tx.query('update account_definitions set valid_to = $2 where id = $1', [last.id, addDays(input.valid_from, -1)]);
  await tx.query(`insert into account_definitions(company_id, account_id, code, name, presentation, valid_from, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
    [c.companyId, accountId, code, name, pres ? JSON.stringify(pres) : null, input.valid_from, c.userId]);
  await bumpBook(tx, c.companyId);
  await audit(tx, c, 'account.definition', 'account', accountId, { reason: input.reason, before: { code: last.code, name: last.name, presentation: last.presentation }, after: { code, name, presentation: pres, valid_from: input.valid_from } });
  return getAccount(tx, c, accountId);
}

async function isUsedDeep(tx: Tx, accountId: number) {
  const { rows: [r] } = await tx.query(
    `with recursive t as (select id from accounts where id = $1 union all select a.id from accounts a join t on a.parent_id = t.id)
     select exists (select 1 from journal_lines where account_id in (select id from t)) as used`, [accountId]);
  return r.used as boolean;
}

// Structural changes are only allowed while no entry (on it or below it) exists (§9.3).
export async function updateStructure(tx: Tx, c: Ctx, accountId: number, patch: { parent_id?: number | null; classification?: string; is_group?: boolean; closing?: 'permanent' | 'temporary'; nature?: 'debit' | 'credit' | 'variable'; start_date?: string }) {
  requireManager(c);
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [accountId, c.companyId]);
  if (!a) fail('الحساب غير موجود', 404);
  const structural = ['parent_id', 'classification', 'is_group', 'closing', 'start_date'].filter((k) => k in patch && (patch as any)[k] !== a[k]);
  if (structural.length && (await isUsedDeep(tx, accountId)))
    fail('لا يتغير الأب أو التصنيف أو النوع أو سلوك الإقفال أو بداية الاستخدام لحساب عليه حركات (أو تحته حركات)');
  if (patch.parent_id !== undefined && patch.parent_id !== a.parent_id && patch.parent_id !== null) {
    const { rows: [p] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [patch.parent_id, c.companyId]);
    if (!p || !p.is_group) fail('الأب يجب أن يكون حسابًا تجميعيًا من الشركة نفسها');
    const { rows: [cyc] } = await tx.query(
      `with recursive t as (select id from accounts where id = $1 union all select a.id from accounts a join t on a.parent_id = t.id) select exists (select 1 from t where id = $2) as bad`, [accountId, patch.parent_id]);
    if (cyc.bad) fail('لا يصبح الحساب أبًا لنفسه أو لأحد أحفاده');
    if (p.classification !== (patch.classification ?? a.classification)) fail('التصنيف يجب أن يطابق تصنيف الأب');
  }
  if (patch.is_group === false) {
    const { rows } = await tx.query('select 1 from accounts where parent_id = $1 and deleted_at is null limit 1', [accountId]);
    if (rows.length) fail('الحساب القابل للترحيل لا يحتوي أبناء');
  }
  const next = { ...a, ...patch };
  if (!next.is_group && (!next.nature || !next.closing)) fail('الحساب القابل للترحيل يحتاج طبيعة وسلوك إقفال');
  await tx.query(`update accounts set parent_id = $2, classification = $3, is_group = $4, closing = $5, nature = $6, start_date = $7 where id = $1`,
    [accountId, next.parent_id, next.classification, next.is_group, next.is_group ? null : next.closing, next.is_group ? null : next.nature, next.start_date]);
  await bumpBook(tx, c.companyId);
  await audit(tx, c, 'account.structure', 'account', accountId, { before: a, after: patch });
  return getAccount(tx, c, accountId);
}

// Stop new everyday entries after a date (null = re-activate). Reports keep the account.
export async function setStopDate(tx: Tx, c: Ctx, accountId: number, stop: string | null, reason?: string) {
  requireManager(c);
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [accountId, c.companyId]);
  if (!a) fail('الحساب غير موجود', 404);
  if (stop !== null && (!isDate(stop) || stop < a.start_date)) fail('تاريخ الإيقاف غير صالح');
  await tx.query('update accounts set stop_date = $2 where id = $1', [accountId, stop]);
  await audit(tx, c, stop ? 'account.stop' : 'account.reactivate', 'account', accountId, { reason, before: { stop_date: a.stop_date }, after: { stop_date: stop } });
  return getAccount(tx, c, accountId);
}

// Only an unused leaf with no protected role can go. Its codes stay reserved forever.
export async function deleteAccount(tx: Tx, c: Ctx, accountId: number) {
  requireManager(c);
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [accountId, c.companyId]);
  if (!a) fail('الحساب غير موجود', 404);
  if (await isUsedDeep(tx, accountId)) fail('لا يحذف حساب مستخدم في قيد — يمكنك إيقاف استخدامه الجديد');
  const { rows: kids } = await tx.query('select 1 from accounts where parent_id = $1 and deleted_at is null limit 1', [accountId]);
  if (kids.length) fail('لا يحذف حساب له أبناء');
  const { rows: [co] } = await tx.query('select result_account_id from companies where id = $1', [c.companyId]);
  if (co.result_account_id === accountId) fail('لا يحذف حساب تحويل النتيجة');
  if (a.ref_function) fail('لا يحذف حساب مرتبط بوظيفة مرجعية يستخدمها النظام');
  const { rows: br } = await tx.query('select 1 from branches where cash_account_id = $1 limit 1', [accountId]);
  if (br.length) fail('لا يحذف صندوق فرع مرتبط بفرع');
  const { rows: dr } = await tx.query(`select 1 from drafts where status = 'draft' and lines @> $1::jsonb limit 1`, [JSON.stringify([{ account_id: accountId }])]);
  if (dr.length) fail('الحساب مستخدم في مسودة قائمة');
  await tx.query('update accounts set deleted_at = now() where id = $1', [accountId]);
  await bumpBook(tx, c.companyId);
  await audit(tx, c, 'account.delete', 'account', accountId);
  return { ok: true };
}

export async function setResultAccount(tx: Tx, c: Ctx, accountId: number) {
  requireManager(c);
  const { rows: [a] } = await tx.query('select * from accounts where id = $1 and company_id = $2 and deleted_at is null', [accountId, c.companyId]);
  if (!a || a.is_group || a.classification !== 'equity' || a.closing !== 'permanent') fail('حساب تحويل النتيجة يجب أن يكون حساب حقوق ملكية دائمًا قابلًا للترحيل');
  const { rows: runs } = await tx.query('select 1 from closing_runs where company_id = $1 limit 1', [c.companyId]);
  const { rows: [co] } = await tx.query('select result_account_id from companies where id = $1', [c.companyId]);
  if (runs.length && co.result_account_id && co.result_account_id !== accountId) fail('لا يتغير حساب تحويل النتيجة بعد وجود إقفال مسجل');
  await tx.query('update companies set result_account_id = $2 where id = $1', [c.companyId, accountId]);
  await audit(tx, c, 'company.result_account', 'account', accountId, { before: co.result_account_id, after: accountId });
}
