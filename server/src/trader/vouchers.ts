import type { Tx } from '../db/pools.ts';
import type { Ctx, VoucherKind } from '../core/types.ts';
import { VOUCHER_LABEL } from '../core/types.ts';
import { fail } from '../core/errors.ts';
import { audit, today, isDate } from '../core/audit.ts';
import { sar, strictHalala } from '../core/money.ts';
import { postEntry, reverseAndPost, getEntry } from '../core/journal.ts';
import { resolveBranch, branchCash, packAccounts } from './invoices.ts';

// سند قبض: cash/bank debited, lines credited.  سند صرف: lines debited, cash/bank credited.
// A line may name a customer/supplier: its control account is used with the party on the line (subsidiary ledger).
export async function createVoucher(tx: Tx, c: Ctx, input: any) {
  const kind: VoucherKind = input.kind;
  if (kind !== 'receipt' && kind !== 'payment') fail('نوع السند: قبض أو صرف (للقيود العامة استخدم سند القيد)');
  if (input.request_id) {
    const { rows: [ex] } = await tx.query('select id from vouchers where company_id = $1 and request_id = $2', [c.companyId, input.request_id]);
    if (ex) return getVoucher(tx, c, ex.id);
  }
  const branchId = await resolveBranch(tx, c, input.branch_id);
  const date = input.date ?? today();
  if (!isDate(date)) fail('التاريخ غير صالح');
  if (input.method === 'cheque' && !input.cheque_no) fail('أدخل رقم الشيك');
  const pack = await packAccounts(tx, c);
  const lines: { account_id: number; party_id: number | null; amount: number; description: string | null; cost_center_id: number | null }[] = [];
  for (const [i, l] of (input.lines ?? []).entries()) {
    const amount = strictHalala(l.amount, `السطر ${i + 1}`);
    if (!l.account_id && !l.party_id && !amount) continue;
    if (amount <= 0) fail(`السطر ${i + 1}: أدخل المبلغ`);
    let accountId = l.account_id ?? null, partyId = l.party_id ?? null;
    if (partyId) {
      const { rows: [p] } = await tx.query('select kind from parties where id = $1 and company_id = $2', [partyId, c.companyId]);
      if (!p) fail(`السطر ${i + 1}: الطرف غير موجود`);
      accountId = p.kind === 'customer' ? pack.customers : pack.suppliers;
    }
    if (!accountId) fail(`السطر ${i + 1}: اختر الحساب أو العميل/المورد`);
    lines.push({ account_id: accountId, party_id: partyId, amount, description: l.description ?? null, cost_center_id: l.cost_center_id ?? input.cost_center_id ?? null });
  }
  if (!lines.length) fail('أدخل سطرًا واحدًا على الأقل');
  const cashId = input.cash_account_id ?? await branchCash(tx, c, branchId);
  if (lines.some((l) => l.account_id === cashId && !l.party_id)) fail('لا يمكن أن يكون الطرف النقدي هو نفس حساب السطر');
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const { rows: [{ n: number }] } = await tx.query(
    `insert into doc_sequences(company_id, kind, next) values ($1,$2,2) on conflict (company_id, kind) do update set next = doc_sequences.next + 1 returning next - 1 as n`, [c.companyId, `v_${kind}`]);
  const { rows: [v] } = await tx.query(
    `insert into vouchers(company_id, kind, number, branch_id, date, ref, sales_rep_id, cost_center_id, counterparty, method, cheque_no, cheque_date, about, cash_account_id, cash_memo, notes, total,
       created_by, created_by_name, via, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
    [c.companyId, kind, number, branchId, date, input.ref ?? null, input.sales_rep_id ?? null, input.cost_center_id ?? null, input.counterparty ?? null,
      input.method ?? 'cash', input.cheque_no ?? null, input.cheque_date ?? null, input.about ?? null, cashId, input.cash_memo ?? null, input.notes ?? null, total,
      c.userId, c.userName, c.via === 'ai' ? 'ai' : c.via === 'seed' ? 'seed' : 'web', input.request_id ?? null]);
  for (const l of lines)
    await tx.query(`insert into voucher_lines(company_id, voucher_id, branch_id, account_id, party_id, description, amount, cost_center_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.companyId, v.id, branchId, l.account_id, l.party_id, l.description, l.amount, l.cost_center_id]);
  const amt = (h: number) => sar(h).toFixed(2);
  const J: any[] = lines.map((l) => ({ account_id: l.account_id, party_id: l.party_id, cost_center_id: l.cost_center_id, description: l.description,
    debit: kind === 'payment' ? amt(l.amount) : null, credit: kind === 'receipt' ? amt(l.amount) : null }));
  const cashLine = { account_id: cashId, description: input.cash_memo ?? null, debit: kind === 'receipt' ? amt(total) : null, credit: kind === 'payment' ? amt(total) : null };
  if (kind === 'receipt') J.unshift(cashLine); else J.push(cashLine);
  const entry = await postEntry(tx, c, {
    date, description: `${VOUCHER_LABEL[kind]} رقم ${number}${input.about ? ' - ' + input.about : input.counterparty ? ' - ' + input.counterparty : ''}`.slice(0, 500),
    purpose: 'normal', reference: input.ref ?? null, branch_id: branchId, origin: 'voucher', lines: J,
  });
  await tx.query('update vouchers set entry_id = $2 where id = $1', [v.id, entry.id]);
  await audit(tx, c, 'voucher.create', `voucher:${kind}`, v.id, { after: { number, total: sar(total), entry: entry.number } });
  return getVoucher(tx, c, v.id);
}

// Vouchers are never deleted: voiding posts a linked full reversal (§17.2) and marks the voucher.
export async function voidVoucher(tx: Tx, c: Ctx, id: number, reason?: string, date?: string) {
  const { rows: [v] } = await tx.query('select * from vouchers where id = $1 and company_id = $2 for update', [id, c.companyId]);
  if (!v) fail('السند غير موجود', 404);
  if (c.role === 'employee' && c.branchId && v.branch_id !== c.branchId) fail('لا تملك صلاحية على هذا الفرع', 403);
  if (v.status === 'voided') fail('السند ملغى مسبقًا');
  const rev = await reverseAndPost(tx, c, v.entry_id, date ?? today(), `إلغاء ${VOUCHER_LABEL[v.kind as VoucherKind]} رقم ${v.number}${reason ? ' - ' + reason : ''}`.slice(0, 500));
  await tx.query(`update vouchers set status = 'voided', void_entry_id = $2 where id = $1`, [id, rev.id]);
  await audit(tx, c, 'voucher.void', `voucher:${v.kind}`, id, { reason });
  return getVoucher(tx, c, id);
}

export async function getVoucher(tx: Tx, c: Ctx, id: number) {
  const { rows: [v] } = await tx.query(
    `select v.*, b.name as branch_name, r.name as sales_rep_name, cc.name as cost_center_name, e.number as entry_number, ve.number as void_entry_number
     from vouchers v join branches b on b.id = v.branch_id left join sales_reps r on r.id = v.sales_rep_id left join cost_centers cc on cc.id = v.cost_center_id
     left join journal_entries e on e.id = v.entry_id left join journal_entries ve on ve.id = v.void_entry_id where v.id = $1 and v.company_id = $2`, [id, c.companyId]);
  if (!v) return fail('السند غير موجود', 404);
  const entry = await getEntry(tx, c, v.entry_id);
  const { rows: lines } = await tx.query(
    `select l.*, p.name as party_name from voucher_lines l left join parties p on p.id = l.party_id where l.voucher_id = $1 order by l.id`, [id]);
  const cashLine = entry.lines.find((l) => l.account_id === v.cash_account_id && !l.party_id);
  return {
    id: v.id, kind: v.kind, label: VOUCHER_LABEL[v.kind as VoucherKind], number: v.number, date: v.date, status: v.status, branch_id: v.branch_id, branch_name: v.branch_name,
    ref: v.ref, sales_rep_id: v.sales_rep_id, sales_rep_name: v.sales_rep_name, cost_center_id: v.cost_center_id, cost_center_name: v.cost_center_name,
    counterparty: v.counterparty, method: v.method, cheque_no: v.cheque_no, cheque_date: v.cheque_date, about: v.about,
    cash_account_id: v.cash_account_id, cash_account_code: cashLine?.account_code, cash_account_name: cashLine?.account_name, cash_memo: v.cash_memo,
    notes: v.notes, total: sar(v.total), created_by_name: v.created_by_name, via: v.via, created_at: v.created_at,
    entry_id: v.entry_id, entry_number: v.entry_number, void_entry_number: v.void_entry_number,
    lines: lines.map((l) => {
      const el = entry.lines.find((x) => x.account_id === l.account_id && (x.party_id ?? null) === (l.party_id ?? null));
      return { account_id: l.account_id, account_code: el?.account_code, account_name: el?.account_name, party_id: l.party_id, party_name: l.party_name, description: l.description, amount: sar(l.amount) };
    }),
    journal: entry.lines.map((l) => ({ account_code: l.account_code, account_name: l.account_name, debit: Number(l.debit), credit: Number(l.credit), party_name: l.party_name })),
  };
}

export async function findVoucher(tx: Tx, c: Ctx, kind: VoucherKind, number: number) {
  const { rows } = await tx.query('select id from vouchers where company_id = $1 and kind = $2 and number = $3', [c.companyId, kind, number]);
  if (!rows.length) fail(`${VOUCHER_LABEL[kind]} رقم ${number} غير موجود`, 404);
  return getVoucher(tx, c, rows[0].id);
}

export async function voucherNav(tx: Tx, c: Ctx, kind: VoucherKind) {
  const { rows } = await tx.query('select number from vouchers where company_id = $1 and kind = $2 order by number', [c.companyId, kind]);
  return rows.map((r) => r.number as number);
}

export async function listVouchers(tx: Tx, c: Ctx, f: { kind?: VoucherKind; from?: string; to?: string; branch_id?: number }) {
  const { rows } = await tx.query(
    `select v.id, v.kind, v.number, v.date, v.counterparty, v.about, v.total, v.status, b.name as branch_name, v.created_by_name, v.via
     from vouchers v join branches b on b.id = v.branch_id
     where v.company_id = $1 and ($2::text is null or kind = $2) and ($3::date is null or date >= $3) and ($4::date is null or date <= $4) and ($5::int is null or v.branch_id = $5)
     order by date desc, number desc limit 500`, [c.companyId, f.kind ?? null, f.from ?? null, f.to ?? null, f.branch_id ?? null]);
  return rows.map((r) => ({ ...r, label: VOUCHER_LABEL[r.kind as VoucherKind], total: sar(r.total) }));
}
