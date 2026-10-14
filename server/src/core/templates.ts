import { createHash } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { fail } from './errors.ts';
import { audit, bumpBook, isDate } from './audit.ts';
import { createAccount } from './accounts.ts';

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

// §8.2 checks before a template version can be published.
export function validateTemplate(content: any): string[] {
  const errs: string[] = [];
  const accs: any[] = content?.accounts ?? [];
  if (!accs.length) errs.push('القالب بلا حسابات');
  const by = new Map<string, any>();
  for (const a of accs) { if (by.has(a.code)) errs.push(`رمز مكرر ${a.code}`); by.set(a.code, a); }
  for (const a of accs) {
    if (a.parent) {
      const p = by.get(a.parent);
      if (!p) errs.push(`أب غير موجود للحساب ${a.code}`);
      else {
        if (!p.is_group) errs.push(`الأب ${p.code} ليس تجميعيًا`);
        if (p.classification !== a.classification) errs.push(`تصنيف ${a.code} يخالف أباه`);
      }
    }
    // no cycles
    const seen = new Set<string>(); let x = a;
    while (x?.parent) { if (seen.has(x.code)) { errs.push(`دوران في الشجرة عند ${a.code}`); break; } seen.add(x.code); x = by.get(x.parent); }
    if (!a.is_group) {
      if (!a.nature || !a.closing) errs.push(`الحساب ${a.code} بلا طبيعة أو سلوك إقفال`);
      if (!a.presentation) errs.push(`الحساب ${a.code} بلا قاعدة عرض`);
      if (a.closing === 'temporary' && !['revenue', 'expense'].includes(a.classification)) errs.push(`الحساب المؤقت ${a.code} يجب أن يكون إيرادًا أو مصروفًا`);
      if (a.closing === 'permanent' && ['revenue', 'expense'].includes(a.classification)) errs.push(`حساب النتيجة ${a.code} يجب أن يكون مؤقتًا`);
    }
  }
  const refs = accs.filter((a) => a.ref_function).map((a) => a.ref_function);
  if (new Set(refs).size !== refs.length) errs.push('وظيفة مرجعية مكررة لأكثر من حساب');
  const re = accs.find((a) => a.ref_function === 'retained_earnings');
  if (!re || re.is_group || re.classification !== 'equity' || re.closing !== 'permanent') errs.push('حساب الأرباح المبقاة غير صالح لتحويل النتيجة');
  return errs;
}

// Explicit platform action; never on start-up (§8.2).
export async function publishTemplate(tx: Tx, userId: number, content: any) {
  const errs = validateTemplate(content);
  if (errs.length) fail('القالب غير صالح: ' + errs.slice(0, 5).join('؛ '));
  const { rows: [ex] } = await tx.query('select * from chart_templates where slug = $1 and version = $2', [content.slug, content.version]);
  if (ex) {
    if (ex.content_hash !== hash(content)) fail('هذا الإصدار منشور بمحتوى مختلف — انشر رقم إصدار جديدًا');
    return ex;
  }
  const { rows: [t] } = await tx.query(
    `insert into chart_templates(slug, version, name, activity, currency, description, content, content_hash, status, published_at, published_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'published',now(),$9) returning *`,
    [content.slug, content.version, content.name, content.activity, content.currency, content.description, JSON.stringify(content), hash(content), userId]);
  await tx.query('insert into platform_audit(user_id, action, detail) values ($1,$2,$3)', [userId, 'template.publish', JSON.stringify({ slug: t.slug, version: t.version })]);
  return t;
}

export async function listTemplates(tx: Tx) {
  const { rows } = await tx.query(`select id, slug, version, name, activity, currency, description, published_at,
    jsonb_array_length(content->'accounts') as accounts from chart_templates where status = 'published' order by slug, published_at`);
  return rows;
}

export async function templatePreview(tx: Tx, id: number) {
  const { rows: [t] } = await tx.query(`select * from chart_templates where id = $1 and status = 'published'`, [id]);
  if (!t) fail('القالب غير منشور', 404);
  const a = t.content.accounts;
  return { id: t.id, slug: t.slug, version: t.version, name: t.name, description: t.description, activity: t.activity,
    counts: { total: a.length, groups: a.filter((x: any) => x.is_group).length, postable: a.filter((x: any) => !x.is_group).length },
    has_variable_presentation: a.some((x: any) => x.presentation?.type === 'by_balance'), accounts: a };
}

// §8.3 apply to an empty company: all or nothing, once.
export async function applyTemplate(tx: Tx, c: Ctx, templateId: number, startDate: string, acceptPolicy: boolean) {
  const { rows: [co] } = await tx.query('select * from companies where id = $1 for update', [c.companyId]);
  if (c.role !== 'platform' && !(c.role === 'manager' && co.template_choice === 'manager')) fail('اختيار القالب من صلاحية إدارة المنصة لهذه الشركة', 403);
  if (co.chart_state === 'from_template' && co.template_id === templateId) return { already: true };
  if (co.chart_state !== 'pending_template') fail('لا يُطبق قالب على شركة لها دليل قائم — لا يتم استبدال أو دمج الحسابات');
  const { rows: existing } = await tx.query('select 1 from accounts where company_id = $1 limit 1', [c.companyId]);
  if (existing.length) fail('للشركة حسابات قائمة — لا يُطبق القالب عليها');
  if (!isDate(startDate)) fail('حدد تاريخ بدء استخدام الحسابات');
  const { rows: [t] } = await tx.query(`select * from chart_templates where id = $1 and status = 'published'`, [templateId]);
  if (!t) fail('القالب غير منشور', 404);
  const content = t.content;
  if (content.accounts.some((a: any) => a.presentation?.type === 'by_balance') && !acceptPolicy)
    fail('القالب يحتوي حسابات متغيرة العرض — أكد سياسة العرض بحسب رصيد كل حساب ومنع المقاصة');
  const ids = new Map<string, number>();
  for (const a of content.accounts) {
    const row = await createAccount(tx, c, {
      parent_id: a.parent ? ids.get(a.parent)! : null, code: a.code, name: a.name, classification: a.classification, is_group: a.is_group,
      nature: a.nature ?? undefined, closing: a.closing ?? undefined, start_date: startDate, presentation: a.presentation,
      ref_function: a.ref_function, template_origin: `${t.slug}@${t.version}:${a.code}`,
    }, { skipStateCheck: true, skipAudit: true });
    ids.set(a.code, row.id);
  }
  const ref = (f: string) => { const a = content.accounts.find((x: any) => x.ref_function === f); return a ? ids.get(a.code) : undefined; };
  const pack = {
    sales: ref('sales'), sales_returns: ids.get('420101'), cogs: ref('cogs'), inventory: ref('inventory'),
    input_vat: ref('input_vat'), output_vat: ref('output_vat'), customers: ref('trade_receivables'), suppliers: ref('trade_payables'),
    cash: ref('cash_main'), bank: ref('bank_main'), cash_group: ids.get('1101'),
  };
  await tx.query(`update companies set chart_state = 'from_template', template_id = $2, template_applied_at = now(), template_applied_by = $3,
    chart_start_date = $4, result_account_id = $5, pack_accounts = $6 where id = $1`,
    [c.companyId, t.id, c.userId, startDate, ref('retained_earnings'), JSON.stringify(pack)]);
  // the main branch's cash box is the template's main cash account
  await tx.query('update branches set cash_account_id = $2 where company_id = $1 and cash_account_id is null', [c.companyId, pack.cash]);
  await bumpBook(tx, c.companyId);
  await audit(tx, c, 'template.apply', 'company', c.companyId, { after: { template: `${t.slug}@${t.version}`, accounts: content.accounts.length, start: startDate } });
  return { applied: true, accounts: content.accounts.length };
}

export async function setManualChart(tx: Tx, c: Ctx) {
  const { rows: [co] } = await tx.query('select chart_state from companies where id = $1 for update', [c.companyId]);
  if (co.chart_state !== 'pending_template') fail('الدليل مؤسس مسبقًا');
  await tx.query(`update companies set chart_state = 'manual' where id = $1`, [c.companyId]);
  await audit(tx, c, 'chart.manual', 'company', c.companyId);
}
