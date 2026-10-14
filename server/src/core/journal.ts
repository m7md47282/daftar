import { createHash } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { isManager, PURPOSE_LABEL } from './types.ts';
import { fail, DomainError } from './errors.ts';
import { audit, bumpBook, isDate, today } from './audit.ts';
import { parseAmount, toStr, fromDb } from './money.ts';
import { assertCanPost, yearForDate } from './fiscal.ts';
import { definitionsAsOf } from './accounts.ts';

export type Purpose = 'normal' | 'adjustment' | 'opening' | 'closing';
export type EquityClass = 'contribution' | 'distribution' | 'reserve_transfer' | 'prior_adjustment' | 'other';
export const EQUITY_CLASS_LABEL: Record<string, string> = { contribution: 'مساهمات', distribution: 'توزيعات أو مسحوبات', reserve_transfer: 'تحويل احتياطي', prior_adjustment: 'تعديل مباشر سابق', other: 'حركات أخرى' };

export type LineIn = { account_id: number; debit?: unknown; credit?: unknown; description?: string | null; party_id?: number | null; cost_center_id?: number | null; branch_id?: number | null };
export type EntryIn = {
  date: string; description: string; purpose: Purpose; batch_id?: number | null; reference?: string | null; equity_class?: EquityClass | null;
  source_entry_id?: number | null; reverses_entry_id?: number | null; branch_id?: number | null;
  origin?: 'journal' | 'invoice' | 'voucher' | 'closing'; request_id?: string | null; draft_id?: number | null;
  closing_run_id?: number | null; created_by?: number; created_by_name?: string;
  lines: LineIn[];
};

const hashOf = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

// Normalizes and validates lines. Blank rows are dropped; a row with an amount must be one-sided and positive.
async function normalizeLines(tx: Tx, c: Ctx, date: string, lines: LineIn[], opts: { allowInactive?: boolean; branchId: number | null }) {
  const out: { account_id: number; debit: bigint; credit: bigint; description: string | null; party_id: number | null; cost_center_id: number | null; branch_id: number | null }[] = [];
  for (const [i, l] of (lines ?? []).entries()) {
    const d = parseAmount(l.debit, `السطر ${i + 1} مدين`) ?? 0n;
    const cr = parseAmount(l.credit, `السطر ${i + 1} دائن`) ?? 0n;
    if (!l.account_id && d === 0n && cr === 0n) continue; // empty row
    if (!l.account_id) fail(`السطر ${i + 1}: اختر الحساب`);
    if (d === 0n && cr === 0n) fail(`السطر ${i + 1}: مبلغ صفري — أدخل مبلغًا في جانب واحد أو احذف السطر`);
    if (d > 0n && cr > 0n) fail(`السطر ${i + 1}: مبلغ في المدين والدائن معًا — جانب واحد فقط`);
    if (l.description && l.description.length > 500) fail(`السطر ${i + 1}: البيان حتى 500 حرف`);
    out.push({ account_id: Number(l.account_id), debit: d, credit: cr, description: l.description?.trim() || null, party_id: l.party_id ?? null,
      cost_center_id: l.cost_center_id ?? null, branch_id: l.branch_id ?? opts.branchId });
  }
  if (out.length < 2) fail('القيد يحتاج سطرين مؤثرين على الأقل');
  const ids = [...new Set(out.map((l) => l.account_id))];
  const { rows: accs } = await tx.query('select * from accounts where id = any($1) and company_id = $2 and deleted_at is null', [ids, c.companyId]);
  const defs = await definitionsAsOf(tx, c.companyId, date, ids);
  for (const l of out) {
    const a = accs.find((x) => x.id === l.account_id);
    if (!a) fail('حساب غير موجود في هذه الشركة');
    const def = defs.get(a.id)!;
    if (a.is_group) fail(`الحساب ${def.code} - ${def.name} تجميعي ولا يقبل الترحيل`);
    if (!opts.allowInactive) {
      if (date < a.start_date) fail(`الحساب ${def.code} - ${def.name} يبدأ استخدامه في ${a.start_date}`);
      if (a.stop_date && date > a.stop_date) fail(`الحساب ${def.code} - ${def.name} موقوف عن الاستخدام الجديد منذ ${a.stop_date}`);
    }
    if (a.branch_id && l.branch_id && a.branch_id !== l.branch_id) fail(`الحساب ${def.code} - ${def.name} يخص فرعًا آخر`);
    (l as any).code = def.code; (l as any).name = def.name;
  }
  const td = out.reduce((s, l) => s + l.debit, 0n), tc = out.reduce((s, l) => s + l.credit, 0n);
  if (td !== tc) fail(`القيد غير متوازن: المدين ${toStr(td)} والدائن ${toStr(tc)} (الفرق ${toStr(td > tc ? td - tc : tc - td)})`);
  if (td === 0n) fail('إجمالي القيد صفر');
  return out as (typeof out[number] & { code: string; name: string })[];
}

async function checkBatch(tx: Tx, c: Ctx, batchId: number | null | undefined, date: string, yearId: number) {
  if (!batchId) fail('تسوية المراجعة تحتاج دفعة تسويات');
  const { rows: [b] } = await tx.query(
    `select b.status as bstatus, r.status as cstatus, r.start_date, r.end_date, r.year_id from adjustment_batches b join review_cycles r on r.id = b.cycle_id
     where b.id = $1 and b.company_id = $2`, [batchId, c.companyId]);
  if (!b) fail('دفعة التسويات غير موجودة في هذه الشركة');
  if (b.bstatus !== 'open' || b.cstatus !== 'open') fail('دفعة التسويات أو دورة المراجعة غير مفتوحة');
  if (b.year_id !== yearId || date < b.start_date || date > b.end_date) fail('تاريخ التسوية خارج مدى دورة المراجعة أو سنتها');
}

// The single posting path. Invoices, vouchers, drafts and closing all come through here (§15).
export async function postEntry(tx: Tx, c: Ctx, e: EntryIn, opts: { system?: boolean } = {}) {
  const purpose = e.purpose;
  if (purpose === 'closing' && !opts.system) fail('غرض الإقفال النظامي يولده إجراء إقفال السنة فقط');
  if (!['normal', 'adjustment', 'opening', 'closing'].includes(purpose)) fail('غرض القيد غير صالح');
  const desc = (e.description ?? '').trim();
  if (!desc) fail('بيان القيد مطلوب');
  if (desc.length > 500) fail('بيان القيد حتى 500 حرف');
  if (e.reference && e.reference.length > 200) fail('المرجع حتى 200 حرف');
  if (!isDate(e.date)) fail('التاريخ المحاسبي غير صالح');

  // idempotency (§2.4): the same request never creates a second entry
  const reqHash = hashOf({ ...e, lines: e.lines.map((l) => ({ ...l, debit: String(l.debit ?? ''), credit: String(l.credit ?? '') })) });
  if (e.request_id) {
    const { rows: [ex] } = await tx.query('select id, request_hash from journal_entries where company_id = $1 and request_id = $2', [c.companyId, e.request_id]);
    if (ex) { if (ex.request_hash !== reqHash) fail('رقم الطلب مستخدم لمحتوى مختلف — لا يُستبدل الطلب الأول'); return getEntry(tx, c, ex.id); }
  }

  const { rows: [co] } = await tx.query('select chart_state from companies where id = $1', [c.companyId]);
  if (co.chart_state === 'pending_template') fail('لا ترحيل قبل اكتمال تأسيس دليل الحسابات');

  let year;
  if (opts.system) { year = await yearForDate(tx, c.companyId, e.date); if (!year) fail('لا توجد سنة مالية لهذا التاريخ'); }
  else year = await assertCanPost(tx, c, e.date, purpose as 'normal' | 'adjustment' | 'opening');

  if (purpose === 'adjustment') await checkBatch(tx, c, e.batch_id, e.date, year.id);
  else if (e.batch_id) fail('دفعة التسويات خاصة بقيود التسوية');
  if (purpose === 'opening') {
    const { rows } = await tx.query(`select 1 from journal_entries where company_id = $1 and purpose = 'opening' limit 1`, [c.companyId]);
    if (rows.length) fail('افتتاح التأسيس يسجل مرة واحدة لبدء الدفتر — استخدم قيدًا عاديًا');
  }
  // employees post in their own branch (extension D2)
  let branchId = e.branch_id ?? null;
  if (c.role === 'employee' && c.branchId) {
    if (branchId && branchId !== c.branchId) fail('لا تملك صلاحية على هذا الفرع', 403);
    branchId = c.branchId;
  }

  const lines = await normalizeLines(tx, c, e.date, e.lines, { allowInactive: purpose === 'closing', branchId });

  if (e.reverses_entry_id) {
    const { rows: [orig] } = await tx.query('select * from journal_entries where id = $1 and company_id = $2', [e.reverses_entry_id, c.companyId]);
    if (!orig) fail('القيد المراد عكسه غير موجود');
    if (orig.purpose === 'closing') fail('قيد الإقفال النظامي لا يُعكس من اليومية — استخدم الإقفال التكميلي');
    const { rows: ol } = await tx.query('select account_id, debit, credit from journal_lines where entry_id = $1 order by line_no', [orig.id]);
    const mirror = ol.length === lines.length && ol.every((o, i) => o.account_id === lines[i].account_id && fromDb(o.debit) === lines[i].credit && fromDb(o.credit) === lines[i].debit);
    if (!mirror) fail('العكس المرتبط يجب أن يطابق القيد الأصلي عكسًا كاملًا — للتعديل الجزئي استخدم قيدًا مستقلًا');
    const { rows: dup } = await tx.query('select number from journal_entries where reverses_entry_id = $1', [orig.id]);
    if (dup.length) fail(`القيد معكوس مسبقًا بالقيد رقم ${dup[0].number}`);
  }

  const { rows: [{ next }] } = await tx.query('update entry_sequences set next = next + 1 where company_id = $1 returning next - 1 as next', [c.companyId]);
  const { rows: [je] } = await tx.query(
    `insert into journal_entries(company_id, number, date, year_id, description, purpose, batch_id, reference, equity_class, source_entry_id, reverses_entry_id,
       branch_id, origin, closing_run_id, request_id, request_hash, draft_id, created_by, created_by_name, posted_by, posted_by_name, via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
    [c.companyId, next, e.date, year.id, desc, purpose, e.batch_id ?? null, e.reference?.trim() || null, e.equity_class ?? null, e.source_entry_id ?? null,
      e.reverses_entry_id ?? null, branchId, e.origin ?? 'journal', e.closing_run_id ?? null, e.request_id ?? null, e.request_id ? reqHash : null, e.draft_id ?? null,
      e.created_by ?? c.userId, e.created_by_name ?? c.userName, c.userId, c.role === 'platform' ? `${c.userName} (إدارة المنصة)` : c.userName, c.via]);
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `insert into journal_lines(company_id, entry_id, line_no, account_id, account_code, account_name, description, debit, credit, date, purpose, batch_id, branch_id, party_id, cost_center_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [c.companyId, je.id, i + 1, l.account_id, l.code, l.name, l.description, toStr(l.debit), toStr(l.credit), e.date, purpose, e.batch_id ?? null, l.branch_id, l.party_id, l.cost_center_id]);
  }
  // a posting into a year that already had a closing run leaves a remainder to transfer (§12.3)
  if (purpose !== 'closing') {
    await tx.query(`update fiscal_years set status = 'needs_supplementary' where id = $1 and last_closing_run_id is not null and status = 'under_review'
      and exists (select 1 from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = $2 and a.closing = 'temporary')`, [year.id, je.id]);
  }
  await bumpBook(tx, c.companyId);
  await audit(tx, c, 'entry.post', 'journal_entry', je.id, { after: { number: next, date: e.date, purpose, total: toStr(lines.reduce((s, l) => s + l.debit, 0n)) } });
  return getEntry(tx, c, je.id);
}

export async function getEntry(tx: Tx, c: Ctx, id: number) {
  const { rows: [e] } = await tx.query(
    `select e.*, s.number as source_number, r.number as reverses_number, (select number from journal_entries x where x.reverses_entry_id = e.id) as reversed_by_number,
       b.name as batch_name, y.name as year_name
     from journal_entries e left join journal_entries s on s.id = e.source_entry_id left join journal_entries r on r.id = e.reverses_entry_id
     left join adjustment_batches b on b.id = e.batch_id join fiscal_years y on y.id = e.year_id
     where e.id = $1 and e.company_id = $2`, [id, c.companyId]);
  if (!e) return fail('القيد غير موجود', 404);
  const { rows: lines } = await tx.query(
    `select l.*, p.name as party_name from journal_lines l left join parties p on p.id = l.party_id where l.entry_id = $1 order by l.line_no`, [id]);
  const { rows: atts } = await tx.query('select id, filename, mime, size, uploaded_at, excluded_at, exclusion_reason from attachments where entry_id = $1 order by id', [id]);
  const td = lines.reduce((s, l) => s + fromDb(l.debit), 0n);
  return {
    id: e.id, number: e.number, date: e.date, year_id: e.year_id, year_name: e.year_name, description: e.description, purpose: e.purpose,
    purpose_label: PURPOSE_LABEL[e.purpose], batch_id: e.batch_id, batch_name: e.batch_name, reference: e.reference, equity_class: e.equity_class,
    equity_class_label: e.equity_class ? EQUITY_CLASS_LABEL[e.equity_class] : null,
    source_entry_id: e.source_entry_id, source_number: e.source_number, reverses_entry_id: e.reverses_entry_id, reverses_number: e.reverses_number,
    reversed_by_number: e.reversed_by_number, branch_id: e.branch_id, origin: e.origin, closing_run_id: e.closing_run_id,
    created_by_name: e.created_by_name ?? 'غير معلوم في السجل السابق', posted_by_name: e.posted_by_name, via: e.via,
    created_at: e.created_at, posted_at: e.posted_at, total: toStr(td),
    lines: lines.map((l) => ({ line_no: l.line_no, account_id: l.account_id, account_code: l.account_code, account_name: l.account_name,
      description: l.description, debit: l.debit, credit: l.credit, party_id: l.party_id, party_name: l.party_name, branch_id: l.branch_id, cost_center_id: l.cost_center_id })),
    attachments: atts,
  };
}

export async function findEntry(tx: Tx, c: Ctx, number: number) {
  const { rows: [e] } = await tx.query('select id from journal_entries where company_id = $1 and number = $2', [c.companyId, number]);
  if (!e) fail(`القيد رقم ${number} غير موجود`, 404);
  return getEntry(tx, c, e.id);
}

// §19 journal list with search
export async function listEntries(tx: Tx, c: Ctx, f: { from?: string; to?: string; purpose?: string; q?: string; limit?: number }) {
  const q = (f.q ?? '').trim();
  const { rows } = await tx.query(
    `select e.id, e.number, e.date, e.description, e.reference, e.purpose, e.origin, e.created_at, e.posted_by_name, e.via, e.reverses_entry_id,
       (select coalesce(sum(debit),0) from journal_lines l where l.entry_id = e.id) as total
     from journal_entries e where e.company_id = $1
       and ($2::date is null or e.date >= $2) and ($3::date is null or e.date <= $3) and ($4::text is null or e.purpose = $4)
       and ($5 = '' or e.number::text = $5 or e.description ilike '%' || $5 || '%' or coalesce(e.reference,'') ilike '%' || $5 || '%')
     order by e.date desc, e.id desc limit $6`,
    [c.companyId, f.from ?? null, f.to ?? null, f.purpose || null, q, Math.min(f.limit ?? 300, 1000)]);
  return rows.map((r) => ({ ...r, purpose_label: PURPOSE_LABEL[r.purpose] }));
}

// ================================================================ drafts (§16)
export type DraftIn = {
  purpose?: 'normal' | 'adjustment' | 'opening'; date?: string | null; description?: string | null; reference?: string | null;
  batch_id?: number | null; equity_class?: EquityClass | null; branch_id?: number | null;
  lines?: { account_id?: number | null; debit?: unknown; credit?: unknown; description?: string | null; party_id?: number | null; cost_center_id?: number | null }[];
};

// A draft may be incomplete or unbalanced, but never holds an invalid amount or a foreign account.
async function cleanDraft(tx: Tx, c: Ctx, d: DraftIn) {
  if (d.date && !isDate(d.date)) fail('التاريخ غير صالح');
  if (d.description && d.description.length > 500) fail('البيان حتى 500 حرف');
  if (d.reference && d.reference.length > 200) fail('المرجع حتى 200 حرف');
  if (d.purpose && !['normal', 'adjustment', 'opening'].includes(d.purpose)) fail('غرض غير صالح للمسودة');
  const lines = (d.lines ?? []).slice(0, 200).map((l, i) => {
    const debit = parseAmount(l.debit, `السطر ${i + 1} مدين`), credit = parseAmount(l.credit, `السطر ${i + 1} دائن`);
    return { account_id: l.account_id ? Number(l.account_id) : null, debit: debit === null ? '' : toStr(debit), credit: credit === null ? '' : toStr(credit),
      description: l.description ?? null, party_id: l.party_id ?? null, cost_center_id: l.cost_center_id ?? null };
  });
  if ((d.lines ?? []).length > 200) fail('حد صفوف الإدخال 200');
  const ids = [...new Set(lines.map((l) => l.account_id).filter(Boolean))];
  if (ids.length) {
    const { rows } = await tx.query('select id from accounts where id = any($1) and company_id = $2 and deleted_at is null', [ids, c.companyId]);
    if (rows.length !== ids.length) fail('حساب غير موجود في هذه الشركة');
  }
  if (d.batch_id) {
    const { rows } = await tx.query('select 1 from adjustment_batches where id = $1 and company_id = $2', [d.batch_id, c.companyId]);
    if (!rows.length) fail('دفعة التسويات غير موجودة في هذه الشركة');
  }
  return lines;
}

export async function saveDraft(tx: Tx, c: Ctx, d: DraftIn, id?: number, expectedVersion?: number) {
  const lines = await cleanDraft(tx, c, d);
  const branchId = c.role === 'employee' && c.branchId ? c.branchId : d.branch_id ?? null;
  if (!id) {
    const { rows: [r] } = await tx.query(
      `insert into drafts(company_id, purpose, date, description, reference, batch_id, equity_class, branch_id, lines, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id`,
      [c.companyId, d.purpose ?? 'normal', d.date ?? null, d.description ?? null, d.reference ?? null, d.batch_id ?? null, d.equity_class ?? null, branchId, JSON.stringify(lines), c.userId]);
    await audit(tx, c, 'draft.create', 'draft', r.id);
    return getDraft(tx, c, r.id);
  }
  const { rows: [cur] } = await tx.query('select * from drafts where id = $1 and company_id = $2 for update', [id, c.companyId]);
  if (!cur) fail('المسودة غير موجودة', 404);
  if (cur.status !== 'draft') fail(`المسودة بحالة ${cur.status === 'posted' ? 'مرحّلة' : cur.status === 'cancelled' ? 'ملغاة' : 'مؤجلة'} ولا تُعدّل`);
  if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new DomainError('عدّل شخص آخر هذه المسودة بعد فتحك لها — أعد تحميلها ثم راجع التعديلات', 409);
  await tx.query(
    `update drafts set purpose = $2, date = $3, description = $4, reference = $5, batch_id = $6, equity_class = $7, branch_id = $8, lines = $9,
       version = version + 1, updated_by = $10, updated_at = now() where id = $1`,
    [id, d.purpose ?? cur.purpose, d.date ?? null, d.description ?? null, d.reference ?? null, d.batch_id ?? null, d.equity_class ?? null, branchId, JSON.stringify(lines), c.userId]);
  return getDraft(tx, c, id);
}

export async function getDraft(tx: Tx, c: Ctx, id: number) {
  const { rows: [d] } = await tx.query(
    `select d.*, e.number as entry_number, s.number as source_number, r.number as reverses_number, cu.full_name as created_by_name, uu.full_name as updated_by_name
     from drafts d left join journal_entries e on e.id = d.entry_id left join journal_entries s on s.id = d.source_entry_id
     left join journal_entries r on r.id = d.reverses_entry_id left join users cu on cu.id = d.created_by left join users uu on uu.id = d.updated_by
     where d.id = $1 and d.company_id = $2`, [id, c.companyId]);
  if (!d) return fail('المسودة غير موجودة', 404);
  const { rows: atts } = await tx.query('select id, filename, mime, size, uploaded_at, excluded_at from attachments where draft_id = $1 order by id', [id]);
  let td = 0n, tc = 0n;
  for (const l of d.lines) { td += parseAmount(l.debit) ?? 0n; tc += parseAmount(l.credit) ?? 0n; }
  return { ...d, attachments: atts, totals: { debit: toStr(td), credit: toStr(tc), difference: toStr(td - tc) } };
}

export async function listDrafts(tx: Tx, c: Ctx, status = 'draft') {
  const { rows } = await tx.query(
    `select d.id, d.purpose, d.date, d.description, d.status, d.status_reason, d.version, d.updated_at, u.full_name as updated_by_name, e.number as entry_number
     from drafts d left join users u on u.id = d.updated_by left join journal_entries e on e.id = d.entry_id
     where d.company_id = $1 and ($2 = 'all' or d.status = $2) order by d.updated_at desc limit 300`, [c.companyId, status]);
  return rows;
}

// Posting a draft is idempotent: a posted draft returns its entry (§2.4, JRN-02).
export async function postDraft(tx: Tx, c: Ctx, id: number, expectedVersion?: number) {
  const { rows: [d] } = await tx.query('select * from drafts where id = $1 and company_id = $2 for update', [id, c.companyId]);
  if (!d) fail('المسودة غير موجودة', 404);
  if (d.status === 'posted') return getEntry(tx, c, d.entry_id);
  if (d.status !== 'draft') fail('المسودة ملغاة أو مؤجلة ولا تُرحّل');
  if (expectedVersion !== undefined && d.version !== expectedVersion) throw new DomainError('تغيرت المسودة بعد فتحك لها — أعد تحميلها وراجعها قبل الترحيل', 409);
  if (!d.date) fail('حدد التاريخ المحاسبي');
  const { rows: [creator] } = await tx.query('select full_name from users where id = $1', [d.created_by]);
  const entry = await postEntry(tx, c, {
    date: d.date, description: d.description ?? '', purpose: d.purpose, batch_id: d.batch_id, reference: d.reference, equity_class: d.equity_class,
    source_entry_id: d.source_entry_id, reverses_entry_id: d.reverses_entry_id, branch_id: d.branch_id, draft_id: d.id,
    request_id: `draft:${d.id}`, created_by: d.created_by, created_by_name: creator?.full_name, lines: d.lines,
  });
  await tx.query(`update drafts set status = 'posted', entry_id = $2, updated_by = $3, updated_at = now() where id = $1`, [id, entry.id, c.userId]);
  await tx.query('update attachments set entry_id = $2 where draft_id = $1', [id, entry.id]);
  return getEntry(tx, c, entry.id);
}

export async function setDraftStatus(tx: Tx, c: Ctx, id: number, status: 'cancelled' | 'deferred', reason: string) {
  if (!reason?.trim()) fail('اذكر السبب');
  const { rows: [d] } = await tx.query('select status from drafts where id = $1 and company_id = $2 for update', [id, c.companyId]);
  if (!d) fail('المسودة غير موجودة', 404);
  if (d.status !== 'draft') fail('المسودة ليست قيد العمل');
  await tx.query('update drafts set status = $2, status_reason = $3, updated_by = $4, updated_at = now(), version = version + 1 where id = $1', [id, status, reason.trim(), c.userId]);
  await audit(tx, c, `draft.${status}`, 'draft', id, { reason });
}

// §17.1 copy → independent draft (opening becomes normal; closing can't be copied; batch is re-chosen)
export async function copyEntry(tx: Tx, c: Ctx, entryId: number) {
  const e = await getEntry(tx, c, entryId);
  if (e.purpose === 'closing') fail('لا يُنسخ قيد إقفال نظامي إلى اليومية');
  const { rows: [r] } = await tx.query(
    `insert into drafts(company_id, purpose, date, description, reference, equity_class, branch_id, source_entry_id, lines, created_by, updated_by)
     values ($1,$2,null,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
    [c.companyId, e.purpose === 'adjustment' ? 'adjustment' : 'normal', e.description, e.reference, e.equity_class, e.branch_id, e.id,
      JSON.stringify(e.lines.map((l) => ({ account_id: l.account_id, debit: l.debit === '0.00' ? '' : l.debit, credit: l.credit === '0.00' ? '' : l.credit, description: l.description, party_id: l.party_id, cost_center_id: l.cost_center_id }))), c.userId]);
  await audit(tx, c, 'entry.copy', 'journal_entry', entryId, { after: { draft_id: r.id } });
  return getDraft(tx, c, r.id);
}

// §17.2 linked full reversal as a draft; one open reversal draft per entry
export async function reverseEntry(tx: Tx, c: Ctx, entryId: number, date?: string) {
  const e = await getEntry(tx, c, entryId);
  if (e.purpose === 'closing') fail('قيد الإقفال النظامي لا يُعكس من اليومية — استخدم الإقفال التكميلي');
  if (e.reversed_by_number) fail(`القيد معكوس مسبقًا بالقيد رقم ${e.reversed_by_number}`);
  const { rows: [open] } = await tx.query(`select id from drafts where company_id = $1 and reverses_entry_id = $2 and status = 'draft'`, [c.companyId, entryId]);
  if (open) return getDraft(tx, c, open.id);
  const d = date ?? today();
  // same year keeps the original batch; a later year needs a batch of that year's review
  let batchId: number | null = null;
  if (e.purpose === 'adjustment') {
    const y = await yearForDate(tx, c.companyId, d);
    batchId = y && y.id === e.year_id ? e.batch_id : null;
  }
  const { rows: [r] } = await tx.query(
    `insert into drafts(company_id, purpose, date, description, reference, batch_id, branch_id, reverses_entry_id, lines, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id`,
    [c.companyId, e.purpose === 'adjustment' ? 'adjustment' : 'normal', d, `عكس القيد رقم ${e.number}: ${e.description}`.slice(0, 500), e.reference,
      batchId, e.branch_id, e.id, JSON.stringify(e.lines.map((l) => ({ account_id: l.account_id, debit: l.credit === '0.00' ? '' : l.credit, credit: l.debit === '0.00' ? '' : l.debit, description: l.description, party_id: l.party_id, cost_center_id: l.cost_center_id }))), c.userId]);
  await audit(tx, c, 'entry.reverse_draft', 'journal_entry', entryId, { after: { draft_id: r.id } });
  return getDraft(tx, c, r.id);
}

// direct linked reversal (used by trader-pack voids): reverse + post in one step
export async function reverseAndPost(tx: Tx, c: Ctx, entryId: number, date: string, description: string, requestId?: string) {
  const e = await getEntry(tx, c, entryId);
  return postEntry(tx, c, {
    date, description, purpose: e.purpose === 'adjustment' ? 'adjustment' : 'normal', batch_id: e.purpose === 'adjustment' ? e.batch_id : null,
    reference: e.reference, reverses_entry_id: e.id, branch_id: e.branch_id, origin: 'voucher', request_id: requestId ?? null,
    lines: e.lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: l.description, party_id: l.party_id, cost_center_id: l.cost_center_id, branch_id: l.branch_id })),
  });
}

export const canDecideDrafts = isManager;
