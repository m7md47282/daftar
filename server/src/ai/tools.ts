import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import type { Ctx } from '../core/types.ts';
import { fail } from '../core/errors.ts';
import * as J from '../core/journal.ts';
import * as A from '../core/accounts.ts';
import * as B from '../core/books.ts';
import * as S from '../core/statements.ts';
import { listYears } from '../core/fiscal.ts';
import { listReview } from '../core/review.ts';
import * as M from '../trader/masters.ts';
import * as inv from '../trader/invoices.ts';
import * as vch from '../trader/vouchers.ts';
import * as TR from '../trader/reports.ts';

// One registry for the in-app assistant. Every tool is a thin call into the same core and trader
// functions the screens use, so the AI can only do what the system allows (spec §2, D3).
// Write tools never execute directly: they produce a preview and the human confirms it.
// Locking, reopening, closing and approval are deliberately absent: they need the person's own password.
export type Tool = {
  name: string;
  description: string;
  input: z.ZodObject<any>;
  write: boolean;
  run: (tx: Tx, c: Ctx, input: any) => Promise<unknown>;
  summarize?: (result: any) => string;
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.union([z.string(), z.number()]).describe('SAR amount, max 2 decimals, e.g. "1250.50"');
const id = z.number().int().positive();
const range = z.object({ from: date, to: date, branch_id: id.optional() });
const mode = z.enum(['raw', 'before_adjustments', 'adjustments_only', 'after_adjustments', 'after_close']).optional()
  .describe('raw=الدفتر الخام, before_adjustments=قبل التسويات, adjustments_only, after_adjustments=بعد التسويات وقبل الإقفال, after_close=بعد الإقفال');
const kindDesc = 'sale=فاتورة مبيعات, sale_return=مرتجع مبيعات, purchase=فاتورة مشتريات, purchase_return=مرتجع مشتريات';
const invoiceKind = z.enum(['sale', 'sale_return', 'purchase', 'purchase_return']);

const invoiceLine = z.object({
  item_id: id.optional(), item_code: z.string().optional(), barcode: z.string().optional(), unit_name: z.string().optional().describe('e.g. متر, رول'),
  warehouse_id: id.optional(), qty: z.number().positive(), free_qty: z.number().min(0).optional(),
  price: money.optional().describe('per unit, SAR excluding VAT; omit to use the item default'), discount_pct: z.number().min(0).max(100).optional(),
});
const journalLine = z.object({ account_id: id, debit: money.optional(), credit: money.optional(), description: z.string().max(500).optional(), party_id: id.optional() });

export const TOOLS: Tool[] = [
  { name: 'get_company_setup', write: false, description: 'Company profile, branches, warehouses, cost centers, sales reps, fiscal years with period states, and review cycles with batches. Call first.',
    input: z.object({}), run: async (t, c) => ({ company: await M.getCompany(t, c), ...(await M.structure(t, c)), years: await listYears(t, c), review: await listReview(t, c) }) },
  { name: 'search_accounts', write: false, description: 'Search the chart of accounts by code or Arabic name. Returns postable, active accounts by default.',
    input: z.object({ query: z.string(), include_groups: z.boolean().optional() }), run: (t, c, i) => A.searchAccounts(t, c, i.query, { postable: !i.include_groups }) },
  { name: 'list_chart_of_accounts', write: false, description: 'Full chart of accounts (code, name, classification, group/postable, nature, closing behaviour, presentation).',
    input: z.object({}), run: (t, c) => A.listAccounts(t, c) },
  { name: 'search_parties', write: false, description: 'Find customers or suppliers. Returns id and current balance (customers: positive = they owe us).',
    input: z.object({ kind: z.enum(['customer', 'supplier']), query: z.string().optional() }), run: (t, c, i) => M.listParties(t, c, i.kind, i.query ?? '') },
  { name: 'search_items', write: false, description: 'Find items (أصناف) by code, name or barcode, with units, stock and average cost.',
    input: z.object({ query: z.string().optional() }), run: (t, c, i) => M.listItems(t, c, i.query ?? '') },
  { name: 'get_item', write: false, description: 'Item details: units, stock per warehouse, average cost, last sale price.', input: z.object({ item_id: id }), run: (t, c, i) => M.getItem(t, c, i.item_id) },
  { name: 'get_invoice', write: false, description: `One invoice with lines and its journal entry. kind: ${kindDesc}.`, input: z.object({ kind: invoiceKind, number: z.number().int() }),
    run: (t, c, i) => inv.findInvoice(t, c, i.kind, i.number) },
  { name: 'list_invoices', write: false, description: `List invoices. kind: ${kindDesc}.`,
    input: z.object({ kind: invoiceKind.optional(), from: date.optional(), to: date.optional(), party_id: id.optional(), branch_id: id.optional(), limit: z.number().int().max(200).optional() }),
    run: (t, c, i) => inv.listInvoices(t, c, { ...i, limit: i.limit ?? 50 }) },
  { name: 'get_voucher', write: false, description: 'One voucher: receipt=سند قبض, payment=سند صرف.', input: z.object({ kind: z.enum(['receipt', 'payment']), number: z.number().int() }),
    run: (t, c, i) => vch.findVoucher(t, c, i.kind, i.number) },
  { name: 'list_vouchers', write: false, description: 'List receipt/payment vouchers.', input: z.object({ kind: z.enum(['receipt', 'payment']).optional(), from: date.optional(), to: date.optional() }),
    run: (t, c, i) => vch.listVouchers(t, c, i) },
  { name: 'get_journal_entry', write: false, description: 'One posted journal entry (any origin) by its number, with lines, links and attachments list.', input: z.object({ number: z.number().int() }),
    run: (t, c, i) => J.findEntry(t, c, i.number) },
  { name: 'list_journal_entries', write: false, description: 'Search posted journal entries by number, text or reference; filter by date and purpose (normal, adjustment, opening, closing).',
    input: z.object({ from: date.optional(), to: date.optional(), purpose: z.string().optional(), q: z.string().optional() }), run: (t, c, i) => J.listEntries(t, c, { ...i, limit: 100 }) },
  { name: 'list_drafts', write: false, description: 'Journal entry drafts waiting to be posted (no financial effect).', input: z.object({}), run: (t, c) => J.listDrafts(t, c) },
  { name: 'export_pdf', write: false, description: 'Printable PDF of an invoice or voucher. The user sees a download button; do not paste the URL.',
    input: z.object({ kind: z.enum(['sale', 'sale_return', 'purchase', 'purchase_return', 'receipt', 'payment']), number: z.number().int() }),
    run: async (t, c, i) => {
      const isV = i.kind === 'receipt' || i.kind === 'payment';
      const d: any = isV ? await vch.findVoucher(t, c, i.kind, i.number) : await inv.findInvoice(t, c, i.kind, i.number);
      return { label: d.label, number: d.number, total: d.total, pdf_url: `/api/${isV ? 'vouchers' : 'invoices'}/id/${d.id}/pdf` };
    } },
  { name: 'report_dashboard', write: false, description: 'Today and month-to-date sales, purchases, gross margin, cash and receivables.', input: z.object({ branch_id: id.optional() }), run: (t, c, i) => TR.dashboard(t, c, i) },
  { name: 'report_ledger', write: false, description: 'دفتر الأستاذ for one postable account: opening, movements with running balance, closing.',
    input: range.extend({ account_id: id, mode }), run: (t, c, i) => B.ledger(t, c, i.account_id, i) },
  { name: 'report_party_statement', write: false, description: 'كشف حساب عميل أو مورد (subsidiary ledger).', input: z.object({ party_id: id, from: date, to: date }), run: (t, c, i) => B.partyStatement(t, c, i.party_id, i) },
  { name: 'report_trial_balance', write: false, description: 'ميزان المراجعة. Non-raw modes need a period inside one fiscal year.', input: range.extend({ mode, cycle_id: id.optional() }),
    run: (t, c, i) => B.trialBalance(t, c, i) },
  { name: 'report_worksheet', write: false, description: 'ورقة التسويات: before / adjustments / after per account.', input: range.extend({ cycle_id: id.optional() }), run: (t, c, i) => B.worksheet(t, c, i) },
  { name: 'report_income_statement', write: false, description: 'قائمة الدخل for a period within one fiscal year.', input: range, run: (t, c, i) => S.incomeStatement(t, c, i) },
  { name: 'report_balance_sheet', write: false, description: 'قائمة المركز المالي as of a date.', input: z.object({ to: date, branch_id: id.optional() }), run: (t, c, i) => S.balanceSheet(t, c, i) },
  { name: 'report_equity_changes', write: false, description: 'قائمة التغيرات في حقوق الملكية for a period within one fiscal year.', input: range, run: (t, c, i) => S.equityChanges(t, c, i) },
  { name: 'report_vat', write: false, description: 'تقرير ضريبة القيمة المضافة from tax invoices.', input: range, run: (t, c, i) => TR.vatReport(t, c, i) },
  { name: 'report_stock', write: false, description: 'Stock on hand per item and warehouse.', input: z.object({ branch_id: id.optional(), q: z.string().optional() }), run: (t, c, i) => TR.stockReport(t, c, i) },
  { name: 'report_item_movement', write: false, description: 'حركة صنف.', input: range.extend({ item_id: id }), run: (t, c, i) => TR.itemMovement(t, c, i.item_id, i) },
  // ----- writes (preview first, human confirms) -----
  { name: 'create_invoice', write: true,
    description: `Create and post an invoice. kind: ${kindDesc}. Posts a journal entry, so the date must be in an open period.`,
    input: z.object({ kind: invoiceKind, branch_id: id.optional(), date: date.optional(), party_id: id, party_name: z.string().optional(), party_phone: z.string().optional(),
      sales_rep_id: id.optional(), cost_center_id: id.optional(), payment_method: z.enum(['cash', 'credit']), paid: money.optional(), ref: z.string().optional(), notes: z.string().optional(),
      original_invoice_number: z.number().int().optional(), discount_pct: z.number().min(0).max(100).optional(), lines: z.array(invoiceLine).min(1) }),
    run: (t, c, i) => inv.createInvoice(t, c, i), summarize: (r) => `${r.label} للطرف ${r.party_name} — ${r.lines.length} صنف — الصافي ${r.total} ر.س شامل الضريبة ${r.vat}` },
  { name: 'create_voucher', write: true,
    description: 'Receipt (سند قبض: money in; each line credits an account or a customer via party_id) or payment (سند صرف: money out; each line debits an expense account or a supplier via party_id).',
    input: z.object({ kind: z.enum(['receipt', 'payment']), branch_id: id.optional(), date: date.optional(), counterparty: z.string().optional(), method: z.enum(['cash', 'cheque']).optional(),
      cheque_no: z.string().optional(), about: z.string().optional(), cash_account_id: id.optional(), notes: z.string().optional(),
      lines: z.array(z.object({ account_id: id.optional(), party_id: id.optional(), amount: money, description: z.string().optional() })).min(1) }),
    run: (t, c, i) => vch.createVoucher(t, c, i), summarize: (r) => `${r.label} — ${r.counterparty ?? r.about ?? ''} — ${r.total} ر.س` },
  { name: 'void_voucher', write: true, description: 'Void a voucher by a linked full reversal (vouchers are never deleted).',
    input: z.object({ kind: z.enum(['receipt', 'payment']), number: z.number().int(), reason: z.string().optional() }),
    run: async (t, c, i) => { const v = await vch.findVoucher(t, c, i.kind, i.number); return vch.voidVoucher(t, c, v.id, i.reason); },
    summarize: (r) => `إلغاء ${r.label} رقم ${r.number} بمبلغ ${r.total} ر.س` },
  { name: 'create_journal_entry', write: true,
    description: 'Post a manual journal entry (سند قيد): balanced lines, one side per line, postable accounts. purpose normal or adjustment (adjustment needs batch_id of an open review batch). equity_class when it touches equity directly.',
    input: z.object({ date, description: z.string().min(1).max(500), purpose: z.enum(['normal', 'adjustment']).optional(), batch_id: id.optional(), reference: z.string().max(200).optional(),
      equity_class: z.enum(['contribution', 'distribution', 'reserve_transfer', 'prior_adjustment', 'other']).optional(), lines: z.array(journalLine).min(2) }),
    run: (t, c, i) => J.postEntry(t, c, { ...i, purpose: i.purpose ?? 'normal' }), summarize: (r) => `قيد يومية رقم ${r.number} — ${r.description} — ${r.total} ر.س` },
  { name: 'save_journal_draft', write: true, description: 'Save a journal entry as a draft (no financial effect) for the owner to review and post later.',
    input: z.object({ date: date.optional(), description: z.string().max(500).optional(), purpose: z.enum(['normal', 'adjustment']).optional(), batch_id: id.optional(), lines: z.array(journalLine).min(1) }),
    run: (t, c, i) => J.saveDraft(t, c, i), summarize: (r) => `مسودة قيد رقم ${r.id} — ${r.description ?? ''}` },
  { name: 'post_draft', write: true, description: 'Post an existing draft as a journal entry.', input: z.object({ draft_id: id }),
    run: (t, c, i) => J.postDraft(t, c, i.draft_id), summarize: (r) => `ترحيل المسودة كقيد رقم ${r.number} — ${r.total} ر.س` },
  { name: 'reverse_entry', write: true, description: 'Create a linked full-reversal DRAFT for a posted entry on a chosen date (the original stays).',
    input: z.object({ number: z.number().int(), date: date.optional() }),
    run: async (t, c, i) => { const e = await J.findEntry(t, c, i.number); return J.reverseEntry(t, c, e.id, i.date); }, summarize: (r) => `مسودة عكس للقيد رقم ${r.reverses_number}` },
  { name: 'create_party', write: true, description: 'Create a customer or supplier. VAT number: 15 digits starting and ending with 3.',
    input: z.object({ kind: z.enum(['customer', 'supplier']), name: z.string().min(1), phone: z.string().optional(), vat_number: z.string().optional(), address: z.string().optional() }),
    run: (t, c, i) => M.createParty(t, c, i), summarize: (r) => `${r.kind === 'customer' ? 'عميل' : 'مورد'} جديد: ${r.name}` },
  { name: 'create_item', write: true, description: 'Create an item with units, e.g. base unit متر (factor 1) and رول (factor 50).',
    input: z.object({ code: z.string().optional(), name_ar: z.string().min(1), category: z.string().optional(), vat_rate_pct: z.number().optional(),
      units: z.array(z.object({ name: z.string(), factor: z.number().positive(), price: z.number().min(0), barcode: z.string().optional(), is_default: z.boolean().optional() })).min(1) }),
    run: (t, c, i) => M.saveItem(t, c, i), summarize: (r) => `صنف جديد: ${r.code} - ${r.name_ar}` },
];

export const toolByName = (n: string) => TOOLS.find((t) => t.name === n);
export function jsonSchema(t: Tool) {
  const s = z.toJSONSchema(t.input, { target: 'draft-7' }) as any;
  delete s.$schema;
  return s;
}

// ----- pending confirmations (stored with the company, so any server instance can confirm) -----
const hashInput = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function addPending(t: Tx, c: Ctx, p: { tool: string; input: unknown; summary: string }) {
  const pid = randomBytes(9).toString('base64url');
  await t.query(`delete from ai_pending where company_id = $1 and expires_at < now()`, [c.companyId]);
  await t.query(`insert into ai_pending(id, company_id, user_id, tool, input, input_hash, summary, expires_at) values ($1,$2,$3,$4,$5,$6,$7, now() + interval '15 minutes')`,
    [pid, c.companyId, c.userId, p.tool, JSON.stringify(p.input), hashInput(p.input), p.summary]);
  return pid;
}
// single use: consumed in the same transaction as the write
export async function takePending(t: Tx, c: Ctx, pid: string) {
  const { rows: [p] } = await t.query(`delete from ai_pending where id = $1 and company_id = $2 and user_id = $3 and expires_at > now() returning *`, [pid, c.companyId, c.userId]);
  if (!p) return fail('رمز التأكيد غير صالح أو منتهي — أعد المعاينة');
  return p as { tool: string; input: any; summary: string };
}
