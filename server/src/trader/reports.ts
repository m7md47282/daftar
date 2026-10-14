import type { Tx } from '../db/pools.ts';
import type { Ctx } from '../core/types.ts';
import { INVOICE_LABEL } from '../core/types.ts';
import { today } from '../core/audit.ts';
import { sar, qty, fromDb, toStr } from '../core/money.ts';

type R = { from?: string; to?: string; branch_id?: number | null };
const yearStart = () => today().slice(0, 4) + '-01-01';

// تقرير القيمة المضافة — from the tax documents themselves
export async function vatReport(tx: Tx, c: Ctx, r: R) {
  const from = r.from ?? yearStart(), to = r.to ?? today();
  const { rows } = await tx.query(
    `select kind, count(*) as n, coalesce(sum(subtotal - discount),0) as net, coalesce(sum(vat),0) as vat from invoices
     where company_id = $1 and date between $2 and $3 and ($4::int is null or branch_id = $4) group by kind`, [c.companyId, from, to, r.branch_id ?? null]);
  const g = (k: string) => rows.find((x) => x.kind === k) ?? { n: 0, net: 0, vat: 0 };
  const s = g('sale'), sr = g('sale_return'), p = g('purchase'), pr = g('purchase_return');
  const outVat = s.vat - sr.vat, inVat = p.vat - pr.vat;
  return { from, to,
    sales: { count: Number(s.n), taxable: sar(s.net), vat: sar(s.vat) }, sales_returns: { count: Number(sr.n), taxable: sar(sr.net), vat: sar(sr.vat) },
    purchases: { count: Number(p.n), taxable: sar(p.net), vat: sar(p.vat) }, purchase_returns: { count: Number(pr.n), taxable: sar(pr.net), vat: sar(pr.vat) },
    output_vat: sar(outVat), input_vat: sar(inVat), net_vat_due: sar(outVat - inVat) };
}

export async function stockReport(tx: Tx, c: Ctx, r: { branch_id?: number; warehouse_id?: number; q?: string }) {
  const { rows } = await tx.query(
    `select i.id, i.code, i.name_ar, i.category, i.base_unit, w.name as warehouse_name, b.name as branch_name, s.qty_milli,
       (case when i.total_qty_milli > 0 then i.stock_value::numeric / i.total_qty_milli else 0 end)::float8 as unit_cost_per_milli, i.reorder_level_milli
     from item_stock s join items i on i.id = s.item_id join warehouses w on w.id = s.warehouse_id join branches b on b.id = s.branch_id
     where s.company_id = $1 and ($2::int is null or s.branch_id = $2) and ($3::int is null or s.warehouse_id = $3) and ($4 = '' or i.code = $4 or i.name_ar ilike '%' || $4 || '%')
     order by i.code, w.id`, [c.companyId, r.branch_id ?? null, r.warehouse_id ?? null, (r.q ?? '').trim()]);
  const lines = rows.map((x) => {
    const value = Math.round(x.qty_milli * x.unit_cost_per_milli);
    return { item_id: x.id, code: x.code, name: x.name_ar, category: x.category, unit: x.base_unit, branch_name: x.branch_name, warehouse_name: x.warehouse_name,
      qty: qty(x.qty_milli), avg_cost: sar(x.unit_cost_per_milli * 1000), value: sar(value), below_reorder: x.reorder_level_milli != null && x.qty_milli <= x.reorder_level_milli };
  });
  return { lines, total_value: Math.round(lines.reduce((s, l) => s + l.value * 100, 0)) / 100 };
}

export async function itemMovement(tx: Tx, c: Ctx, itemId: number, r: R) {
  const from = r.from ?? yearStart(), to = r.to ?? today();
  const { rows } = await tx.query(
    `select v.date, v.kind, v.number, v.party_name, l.unit_name, l.qty_milli, l.free_qty_milli, l.factor_milli, l.price, w.name as warehouse_name
     from invoice_lines l join invoices v on v.id = l.invoice_id join warehouses w on w.id = l.warehouse_id
     where l.company_id = $1 and l.item_id = $2 and v.date between $3 and $4 and ($5::int is null or v.branch_id = $5) order by v.date, v.id`, [c.companyId, itemId, from, to, r.branch_id ?? null]);
  return rows.map((x) => {
    const base = ((x.qty_milli + x.free_qty_milli) * x.factor_milli) / 1e6;
    const out = x.kind === 'sale' || x.kind === 'purchase_return';
    return { date: x.date, doc: `${INVOICE_LABEL[x.kind as keyof typeof INVOICE_LABEL]} ${x.number}`, party: x.party_name, warehouse: x.warehouse_name,
      unit: x.unit_name, qty: qty(x.qty_milli), price: sar(x.price), in: out ? 0 : base, out: out ? base : 0 };
  });
}

export async function dashboard(tx: Tx, c: Ctx, r: { branch_id?: number | null }) {
  const t = today(), m = t.slice(0, 8) + '01';
  const q = async (from: string) => {
    const { rows } = await tx.query(
      `select kind, coalesce(sum(total),0) as total, coalesce(sum(subtotal - discount - cost_total),0) as margin, count(*) as n from invoices
       where company_id = $1 and date between $2 and $3 and ($4::int is null or branch_id = $4) group by kind`, [c.companyId, from, t, r.branch_id ?? null]);
    const g = (k: string) => rows.find((x) => x.kind === k) ?? { total: 0, margin: 0, n: 0 };
    return { sales: sar(g('sale').total - g('sale_return').total), purchases: sar(g('purchase').total - g('purchase_return').total),
      gross_margin: sar(g('sale').margin - g('sale_return').margin), invoices: Number(g('sale').n) };
  };
  const { rows: [co] } = await tx.query('select pack_accounts from companies where id = $1', [c.companyId]);
  const p = co.pack_accounts ?? {};
  const bal = async (sql: string, params: unknown[]) => fromDb((await tx.query(sql, params)).rows[0].v);
  const cash = p.cash_group ? await bal(
    `select coalesce(sum(jl.debit - jl.credit),0)::text as v from journal_lines jl join accounts a on a.id = jl.account_id
     where jl.company_id = $1 and a.parent_id = $2 and ($3::int is null or jl.branch_id = $3)`, [c.companyId, p.cash_group, r.branch_id ?? null]) : 0n;
  const recv = p.customers ? await bal(
    `select coalesce(sum(debit - credit),0)::text as v from journal_lines where company_id = $1 and account_id = $2 and ($3::int is null or branch_id = $3)`, [c.companyId, p.customers, r.branch_id ?? null]) : 0n;
  return { today: await q(t), month: await q(m), cash: Number(toStr(cash)), receivables: Number(toStr(recv)) };
}
