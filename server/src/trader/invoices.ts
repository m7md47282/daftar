import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import type { Ctx, InvoiceKind } from '../core/types.ts';
import { INVOICE_LABEL } from '../core/types.ts';
import { fail } from '../core/errors.ts';
import { audit, today } from '../core/audit.ts';
import { toMilli, mulDiv, sar, qty, strictHalala } from '../core/money.ts';
import { postEntry, getEntry } from '../core/journal.ts';
import { tlvQr, invoiceHash } from '../core/zatca.ts';

const isSaleSide = (k: InvoiceKind) => k === 'sale' || k === 'sale_return';
const stockOut = (k: InvoiceKind) => k === 'sale' || k === 'purchase_return';

export async function resolveBranch(tx: Tx, c: Ctx, requested?: number | null): Promise<number> {
  if (c.role === 'employee' && c.branchId) {
    if (requested && requested !== c.branchId) fail('لا تملك صلاحية على هذا الفرع', 403);
    return c.branchId;
  }
  if (requested) {
    const { rows } = await tx.query('select id from branches where id = $1 and company_id = $2 and active', [requested, c.companyId]);
    if (!rows.length) fail('الفرع غير موجود');
    return requested;
  }
  const { rows } = await tx.query('select id from branches where company_id = $1 and active order by id limit 2', [c.companyId]);
  if (rows.length === 1) return rows[0].id;
  return fail('حدد الفرع');
}

export async function packAccounts(tx: Tx, c: Ctx) {
  const { rows: [co] } = await tx.query('select pack_accounts from companies where id = $1', [c.companyId]);
  const p = co.pack_accounts ?? {};
  for (const k of ['sales', 'sales_returns', 'cogs', 'inventory', 'input_vat', 'output_vat', 'customers', 'suppliers', 'cash'])
    if (!p[k]) fail('إعداد حسابات الفواتير غير مكتمل — أسس الدليل من قالب الأقمشة أو اربط الحسابات');
  return p as Record<string, number>;
}

export async function branchCash(tx: Tx, c: Ctx, branchId: number) {
  const { rows: [b] } = await tx.query('select cash_account_id from branches where id = $1 and company_id = $2', [branchId, c.companyId]);
  if (b?.cash_account_id) return b.cash_account_id as number;
  return (await packAccounts(tx, c)).cash;
}

async function findItem(tx: Tx, c: Ctx, l: any) {
  let r;
  if (l.item_id) r = await tx.query('select * from items where id = $1 and company_id = $2', [l.item_id, c.companyId]);
  else if (l.item_code) r = await tx.query('select * from items where code = $1 and company_id = $2', [l.item_code, c.companyId]);
  else if (l.barcode) r = await tx.query('select i.* from items i join item_units u on u.item_id = i.id where u.barcode = $1 and i.company_id = $2', [l.barcode, c.companyId]);
  else return fail('حدد الصنف (رقم الصنف أو الباركود)');
  const item = r.rows[0];
  if (!item) return fail(`الصنف ${l.item_code ?? l.barcode ?? l.item_id} غير موجود`);
  if (!item.active) fail(`الصنف ${item.name_ar} موقوف`);
  const { rows: units } = await tx.query('select * from item_units where item_id = $1 order by is_default desc, id', [item.id]);
  let unit = units[0];
  if (l.unit_id) unit = units.find((u) => u.id === l.unit_id);
  else if (l.unit_name) { const name = String(l.unit_name).trim(); unit = units.find((u) => u.name === name); }
  else if (l.barcode) unit = units.find((u) => u.barcode === l.barcode) ?? unit;
  if (!unit) fail(`الوحدة "${l.unit_name ?? l.unit_id}" غير معرفة للصنف ${item.name_ar}. الوحدات المتاحة: ${units.map((u) => u.name).join('، ')}`);
  return { item, unit };
}

async function lockItem(tx: Tx, itemId: number) {
  const { rows } = await tx.query('select total_qty_milli, stock_value from items where id = $1 for update', [itemId]);
  return rows[0] as { total_qty_milli: number; stock_value: number };
}

const qtyMilli = (v: unknown, field: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`${field}: كمية غير صالحة`);
  const m = Math.round(n * 1000);
  if (Math.abs(m - n * 1000) > 1e-6) fail(`${field}: الحد الأقصى ثلاث منازل عشرية`);
  return m;
};

export async function createInvoice(tx: Tx, c: Ctx, input: any) {
  const kind: InvoiceKind = input.kind;
  if (!['sale', 'sale_return', 'purchase', 'purchase_return'].includes(kind)) fail('نوع الفاتورة غير صالح');
  if (input.request_id) {
    const { rows: [ex] } = await tx.query('select id from invoices where company_id = $1 and request_id = $2', [c.companyId, input.request_id]);
    if (ex) return getInvoice(tx, c, ex.id);
  }
  const branchId = await resolveBranch(tx, c, input.branch_id);
  const date = input.date ?? today();
  const pack = await packAccounts(tx, c);

  const { rows: [company] } = await tx.query('select * from companies where id = $1', [c.companyId]);
  const { rows: [party] } = await tx.query('select * from parties where id = $1 and company_id = $2', [input.party_id, c.companyId]);
  const wantKind = isSaleSide(kind) ? 'customer' : 'supplier';
  if (!party) fail(wantKind === 'customer' ? 'العميل غير موجود' : 'المورد غير موجود');
  if (party.kind !== wantKind) fail(wantKind === 'customer' ? 'الطرف المختار ليس عميلاً' : 'الطرف المختار ليس مورداً');
  if (!['cash', 'credit'].includes(input.payment_method)) fail('طريقة الدفع: نقد أو آجل');

  let original: any = null;
  if (kind === 'sale_return' || kind === 'purchase_return') {
    if (input.original_invoice_number) {
      const origKind = kind === 'sale_return' ? 'sale' : 'purchase';
      ({ rows: [original] } = await tx.query('select * from invoices where company_id = $1 and kind = $2 and number = $3', [c.companyId, origKind, input.original_invoice_number]));
      if (!original) fail(`الفاتورة الأساسية رقم ${input.original_invoice_number} غير موجودة`);
      if (original.party_id !== party.id) fail('الفاتورة الأساسية تخص طرفاً آخر');
      if (original.branch_id !== branchId) fail('الفاتورة الأساسية تخص فرعاً آخر');
    } else if (kind === 'sale_return') fail('مرتجع المبيعات يحتاج رقم الفاتورة الأساسية');
  }

  const { rows: whs } = await tx.query('select id from warehouses where branch_id = $1 order by id', [branchId]);
  if (!whs.length) fail('لا يوجد مستودع لهذا الفرع');
  const invDiscBp = Math.round(Number(input.discount_pct ?? 0) * 100);
  if (invDiscBp < 0 || invDiscBp > 10000) fail('نسبة الخصم بين 0 و100');
  if (!Array.isArray(input.lines) || !input.lines.length) fail('أدخل صنفاً واحداً على الأقل');

  type L = { item: any; unit: any; whId: number; qtyM: number; freeM: number; baseM: number; price: number; discBp: number; gross: number; discount: number; net: number; vatBp: number; vat: number; cost: number };
  const lines: L[] = [];
  for (const [i, raw] of input.lines.entries()) {
    const { item, unit } = await findItem(tx, c, raw);
    const whId = raw.warehouse_id ?? whs[0].id;
    if (!whs.some((w) => w.id === whId)) fail('المستودع لا يتبع هذا الفرع');
    const qtyM = qtyMilli(raw.qty, `السطر ${i + 1}`);
    if (qtyM <= 0) fail(`السطر ${i + 1}: أدخل الكمية`);
    const freeM = qtyMilli(raw.free_qty ?? 0, `السطر ${i + 1}`);
    const baseM = mulDiv(qtyM + freeM, unit.factor_milli, 1000);
    let price: number;
    let origLine: any = null;
    if (original) {
      ({ rows: [origLine] } = await tx.query(`select * from invoice_lines where invoice_id = $1 and item_id = $2 and factor_milli = $3 order by line_no limit 1`, [original.id, item.id, unit.factor_milli]));
      if (!origLine) fail(`الصنف ${item.name_ar} (${unit.name}) غير موجود في الفاتورة الأساسية`);
      const { rows: [{ returned }] } = await tx.query(
        `select coalesce(sum(l.qty_milli),0) as returned from invoice_lines l join invoices i on i.id = l.invoice_id
         where i.original_invoice_id = $1 and l.item_id = $2 and l.factor_milli = $3`, [original.id, item.id, unit.factor_milli]);
      const left = origLine.qty_milli - Number(returned) - lines.filter((x) => x.item.id === item.id && x.unit.factor_milli === unit.factor_milli).reduce((s, x) => s + x.qtyM, 0);
      if (qtyM > left) fail(`الكمية المرتجعة من ${item.name_ar} (${qty(qtyM)}) أكبر من المتبقي في الفاتورة الأساسية (${qty(left)})`);
    }
    if (raw.price !== undefined && raw.price !== null && raw.price !== '') price = strictHalala(raw.price, `السطر ${i + 1} السعر`);
    else if (origLine) price = origLine.price;
    else if (isSaleSide(kind)) price = unit.price;
    else { const s = await lockItem(tx, item.id); price = s.total_qty_milli > 0 ? mulDiv(s.stock_value, unit.factor_milli, s.total_qty_milli) : 0; }
    if (price <= 0) fail(`حدد سعر الصنف ${item.name_ar}`);
    const discBp = origLine ? origLine.discount_bp : Math.round(Number(raw.discount_pct ?? 0) * 100);
    const gross = mulDiv(qtyM, price, 1000);
    const lineDisc = mulDiv(gross, discBp, 10000);
    const invDisc = mulDiv(gross - lineDisc, invDiscBp, 10000);
    const discount = lineDisc + invDisc;
    const net = gross - discount;
    const vatBp = item.vat_rate_bp;
    lines.push({ item, unit, whId, qtyM, freeM, baseM, price, discBp, gross, discount, net, vatBp, vat: mulDiv(net, vatBp, 10000), cost: 0 });
  }
  const subtotal = lines.reduce((s, l) => s + l.gross, 0);
  const discount = lines.reduce((s, l) => s + l.discount, 0);
  const netTotal = lines.reduce((s, l) => s + l.net, 0);
  const vatTotal = lines.reduce((s, l) => s + l.vat, 0);
  const total = netTotal + vatTotal;
  const paid = input.paid !== undefined && input.paid !== null && input.paid !== '' ? strictHalala(input.paid, 'المدفوع') : input.payment_method === 'cash' ? total : 0;
  if (paid > total) fail(`المدفوع (${sar(paid)}) أكبر من صافي الفاتورة (${sar(total)})`);
  if (input.payment_method === 'cash' && paid !== total) fail('الفاتورة النقدية يجب أن تُدفع بالكامل، أو اختر طريقة الدفع آجل');

  // stock + moving average cost
  for (const l of lines) {
    const s = await lockItem(tx, l.item.id);
    let { total_qty_milli: tq, stock_value: tv } = s;
    if (stockOut(kind)) {
      const { rows: [st] } = await tx.query('select qty_milli from item_stock where item_id = $1 and warehouse_id = $2', [l.item.id, l.whId]);
      const avail = st?.qty_milli ?? 0;
      if (avail < l.baseM && !company.allow_negative_stock)
        fail(`الكمية غير كافية من ${l.item.name_ar}: المتاح ${qty(avail)} ${l.item.base_unit} والمطلوب ${qty(l.baseM)} ${l.item.base_unit}`);
      l.cost = kind === 'purchase_return' ? l.net : (tq > 0 ? mulDiv(tv, l.baseM, tq) : 0);
      tq -= l.baseM; tv -= l.cost;
    } else {
      if (kind === 'purchase') l.cost = l.net;
      else {
        const ol = original ? (await tx.query('select cost, qty_milli, free_qty_milli from invoice_lines where invoice_id = $1 and item_id = $2 and factor_milli = $3 order by line_no limit 1', [original.id, l.item.id, l.unit.factor_milli])).rows[0] : null;
        l.cost = ol ? mulDiv(ol.cost, l.qtyM + l.freeM, ol.qty_milli + ol.free_qty_milli) : (tq > 0 ? mulDiv(tv, l.baseM, tq) : 0);
      }
      tq += l.baseM; tv += l.cost;
    }
    if (tq === 0) tv = 0;
    await tx.query('update items set total_qty_milli = $2, stock_value = $3 where id = $1', [l.item.id, tq, tv]);
    await tx.query(
      `insert into item_stock(company_id, item_id, warehouse_id, branch_id, qty_milli) values ($1,$2,$3,$4,$5)
       on conflict (item_id, warehouse_id) do update set qty_milli = item_stock.qty_milli + $5`,
      [c.companyId, l.item.id, l.whId, branchId, stockOut(kind) ? -l.baseM : l.baseM]);
  }
  const costTotal = lines.reduce((s, l) => s + l.cost, 0);

  const { rows: [{ n: number }] } = await tx.query(
    `insert into doc_sequences(company_id, kind, next) values ($1,$2,2) on conflict (company_id, kind) do update set next = doc_sequences.next + 1 returning next - 1 as n`,
    [c.companyId, `inv_${kind}`]);
  const partyName = input.party_name?.trim() || party.name;
  const { rows: [inv] } = await tx.query(
    `insert into invoices(company_id, kind, number, branch_id, date, party_id, party_name, party_phone, party_vat, party_address, sales_rep_id, cost_center_id,
       payment_method, paid, ref, notes, original_invoice_id, subtotal, discount, vat, total, cost_total, created_by, created_by_name, via, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) returning *`,
    [c.companyId, kind, number, branchId, date, party.id, partyName, input.party_phone ?? party.phone, input.party_vat ?? party.vat_number,
      input.party_address ?? party.address, input.sales_rep_id ?? null, input.cost_center_id ?? null, input.payment_method, paid,
      input.ref ?? null, input.notes ?? null, original?.id ?? null, subtotal, discount, vatTotal, total, costTotal,
      c.userId, c.userName, c.via === 'ai' ? 'ai' : c.via === 'seed' ? 'seed' : 'web', input.request_id ?? null]);
  let ln = 0;
  for (const l of lines) {
    await tx.query(
      `insert into invoice_lines(company_id, invoice_id, branch_id, line_no, item_id, item_code, item_name, unit_name, factor_milli, warehouse_id,
         qty_milli, free_qty_milli, price, discount_bp, discount, net, vat_rate_bp, vat, total, cost)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [c.companyId, inv.id, branchId, ++ln, l.item.id, l.item.code, l.item.name_ar, l.unit.name, l.unit.factor_milli, l.whId,
        l.qtyM, l.freeM, l.price, l.discBp, l.discount, l.net, l.vatBp, l.vat, l.net + l.vat, l.cost]);
  }

  // posting rules → one core journal entry (subject to periods, locks, review, closing)
  const cc = input.cost_center_id ?? null;
  const cash = paid > 0 ? await branchCash(tx, c, branchId) : 0;
  const ctl = isSaleSide(kind) ? pack.customers : pack.suppliers;
  const P = (accountId: number, debit: number, credit: number, extra: any = {}) => ({ account_id: accountId, debit: debit ? sar(debit).toFixed(2) : null, credit: credit ? sar(credit).toFixed(2) : null, ...extra });
  const pl = { party_id: party.id };
  const J: any[] = [];
  if (kind === 'sale') {
    J.push(P(ctl, total, 0, pl), P(pack.sales, 0, netTotal, { cost_center_id: cc }), P(pack.output_vat, 0, vatTotal));
    if (paid) J.push(P(cash, paid, 0), P(ctl, 0, paid, pl));
    if (costTotal) J.push(P(pack.cogs, costTotal, 0, { cost_center_id: cc }), P(pack.inventory, 0, costTotal));
  } else if (kind === 'sale_return') {
    J.push(P(pack.sales_returns, netTotal, 0, { cost_center_id: cc }), P(pack.output_vat, vatTotal, 0), P(ctl, 0, total, pl));
    if (paid) J.push(P(ctl, paid, 0, pl), P(cash, 0, paid));
    if (costTotal) J.push(P(pack.inventory, costTotal, 0), P(pack.cogs, 0, costTotal, { cost_center_id: cc }));
  } else if (kind === 'purchase') {
    J.push(P(pack.inventory, netTotal, 0), P(pack.input_vat, vatTotal, 0), P(ctl, 0, total, pl));
    if (paid) J.push(P(ctl, paid, 0, pl), P(cash, 0, paid));
  } else {
    J.push(P(ctl, total, 0, pl), P(pack.inventory, 0, netTotal), P(pack.input_vat, 0, vatTotal));
    if (paid) J.push(P(cash, paid, 0), P(ctl, 0, paid, pl));
  }
  const entry = await postEntry(tx, c, {
    date, description: `${INVOICE_LABEL[kind]} رقم ${number} - ${partyName}`.slice(0, 500), purpose: 'normal', reference: input.ref ?? null,
    branch_id: branchId, origin: 'invoice', lines: J.filter((l) => l.debit || l.credit),
  });
  await tx.query('update invoices set entry_id = $2 where id = $1', [inv.id, entry.id]);

  if (isSaleSide(kind)) {
    const { rows: [zs] } = await tx.query('select * from zatca_state where company_id = $1 for update', [c.companyId]);
    const icv = zs.icv + 1, uuid = randomUUID(), issuedAt = new Date().toISOString().slice(0, 19) + 'Z';
    const hash = invoiceHash({ uuid, icv, pih: zs.last_hash, kind, number, date, total, vat: vatTotal, seller_vat: company.vat_number });
    const qr = tlvQr({ seller: company.name, vatNumber: company.vat_number ?? '', timestamp: issuedAt, total: sar(total).toFixed(2), vat: sar(vatTotal).toFixed(2) });
    await tx.query('update zatca_state set icv = $2, last_hash = $3 where company_id = $1', [c.companyId, icv, hash]);
    await tx.query(`update invoices set zatca_uuid = $2, zatca_icv = $3, zatca_pih = $4, zatca_hash = $5, zatca_type = $6, qr = $7 where id = $1`,
      [inv.id, uuid, icv, zs.last_hash, hash, inv.party_vat ? 'standard' : 'simplified', qr]);
  }
  await audit(tx, c, 'invoice.create', `invoice:${kind}`, inv.id, { after: { number, total: sar(total), entry: entry.number } });
  return getInvoice(tx, c, inv.id);
}

export async function getInvoice(tx: Tx, c: Ctx, id: number) {
  const { rows: [inv] } = await tx.query(
    `select i.*, b.name as branch_name, r.name as sales_rep_name, cc.name as cost_center_name, o.number as original_number, e.number as entry_number
     from invoices i join branches b on b.id = i.branch_id left join sales_reps r on r.id = i.sales_rep_id left join cost_centers cc on cc.id = i.cost_center_id
     left join invoices o on o.id = i.original_invoice_id left join journal_entries e on e.id = i.entry_id where i.id = $1 and i.company_id = $2`, [id, c.companyId]);
  if (!inv) return fail('الفاتورة غير موجودة', 404);
  const { rows: lines } = await tx.query(`select l.*, w.name as warehouse_name from invoice_lines l join warehouses w on w.id = l.warehouse_id where invoice_id = $1 order by line_no`, [id]);
  const entry = inv.entry_id ? await getEntry(tx, c, inv.entry_id) : null;
  return {
    id: inv.id, kind: inv.kind, label: INVOICE_LABEL[inv.kind as InvoiceKind], number: inv.number, date: inv.date, branch_id: inv.branch_id, branch_name: inv.branch_name,
    party_id: inv.party_id, party_name: inv.party_name, party_phone: inv.party_phone, party_vat: inv.party_vat, party_address: inv.party_address,
    sales_rep_id: inv.sales_rep_id, sales_rep_name: inv.sales_rep_name, cost_center_id: inv.cost_center_id, cost_center_name: inv.cost_center_name,
    payment_method: inv.payment_method, ref: inv.ref, notes: inv.notes, original_invoice_number: inv.original_number,
    subtotal: sar(inv.subtotal), discount: sar(inv.discount), net: sar(inv.subtotal - inv.discount), vat: sar(inv.vat), total: sar(inv.total),
    paid: sar(inv.paid), remaining: sar(inv.total - inv.paid), cost_total: sar(inv.cost_total),
    created_by_name: inv.created_by_name, via: inv.via, created_at: inv.created_at, entry_id: inv.entry_id, entry_number: inv.entry_number,
    zatca: { uuid: inv.zatca_uuid, icv: inv.zatca_icv, type: inv.zatca_type, status: inv.zatca_status, hash: inv.zatca_hash }, qr: inv.qr,
    lines: lines.map((l) => ({ line_no: l.line_no, item_id: l.item_id, item_code: l.item_code, item_name: l.item_name, unit_name: l.unit_name,
      warehouse_id: l.warehouse_id, warehouse_name: l.warehouse_name, qty: qty(l.qty_milli), free_qty: qty(l.free_qty_milli),
      price: sar(l.price), discount_pct: l.discount_bp / 100, discount: sar(l.discount), net: sar(l.net), vat_rate_pct: l.vat_rate_bp / 100, vat: sar(l.vat), total: sar(l.total) })),
    journal: entry ? entry.lines.map((l) => ({ account_code: l.account_code, account_name: l.account_name, debit: Number(l.debit), credit: Number(l.credit), party_name: l.party_name })) : [],
  };
}

export async function findInvoice(tx: Tx, c: Ctx, kind: InvoiceKind, number: number) {
  const { rows } = await tx.query('select id from invoices where company_id = $1 and kind = $2 and number = $3', [c.companyId, kind, number]);
  if (!rows.length) fail(`${INVOICE_LABEL[kind]} رقم ${number} غير موجودة`, 404);
  return getInvoice(tx, c, rows[0].id);
}

export async function invoiceNav(tx: Tx, c: Ctx, kind: InvoiceKind) {
  const { rows } = await tx.query('select number from invoices where company_id = $1 and kind = $2 order by number', [c.companyId, kind]);
  return rows.map((r) => r.number as number);
}

export async function listInvoices(tx: Tx, c: Ctx, f: { kind?: InvoiceKind; from?: string; to?: string; party_id?: number; branch_id?: number; limit?: number }) {
  const { rows } = await tx.query(
    `select i.id, i.kind, i.number, i.date, i.party_name, i.payment_method, i.total, i.vat, i.paid, i.subtotal - i.discount as net, i.cost_total,
       b.name as branch_name, i.created_by_name, i.via
     from invoices i join branches b on b.id = i.branch_id
     where i.company_id = $1 and ($2::text is null or kind = $2) and ($3::date is null or date >= $3) and ($4::date is null or date <= $4)
       and ($5::int is null or party_id = $5) and ($6::int is null or i.branch_id = $6)
     order by date desc, number desc limit $7`,
    [c.companyId, f.kind ?? null, f.from ?? null, f.to ?? null, f.party_id ?? null, f.branch_id ?? null, f.limit ?? 500]);
  return rows.map((r) => ({ ...r, label: INVOICE_LABEL[r.kind as InvoiceKind], total: sar(r.total), vat: sar(r.vat), paid: sar(r.paid), net: sar(r.net), cost_total: sar(r.cost_total), remaining: sar(r.total - r.paid) }));
}
