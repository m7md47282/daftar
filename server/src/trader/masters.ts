import type { Tx } from '../db/pools.ts';
import type { Ctx } from '../core/types.ts';
import { requireManager } from '../core/types.ts';
import { fail } from '../core/errors.ts';
import { audit } from '../core/audit.ts';
import { toHalala, toMilli, sar, qty } from '../core/money.ts';
import { createAccount } from '../core/accounts.ts';
import { partyBalances } from '../core/books.ts';

// ---------------------------------------------------------------- company profile & structure
export async function getCompany(tx: Tx, c: Ctx) {
  const { rows: [co] } = await tx.query(
    `select id, code, name, name_en, currency, activity, chart_state, template_choice, template_id, chart_start_date, seat_limit, result_account_id,
       book_version, vat_number, cr_number, address, phone, invoice_footer, paper, allow_negative_stock, ai_enabled, is_demo, pack_accounts
     from companies where id = $1`, [c.companyId]);
  return co;
}

export async function updateCompany(tx: Tx, c: Ctx, patch: Record<string, unknown>) {
  requireManager(c);
  const allowed = ['name_en', 'vat_number', 'cr_number', 'address', 'phone', 'invoice_footer', 'paper', 'allow_negative_stock'];
  const before = await getCompany(tx, c);
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    if (k === 'vat_number' && v && !/^3\d{13}3$/.test(String(v))) fail('الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3');
    await tx.query(`update companies set ${k} = $2 where id = $1`, [c.companyId, v]);
  }
  await audit(tx, c, 'company.update', 'company', c.companyId, { before, after: patch });
  return getCompany(tx, c);
}

export async function structure(tx: Tx, c: Ctx) {
  const [b, w, cc, r] = await Promise.all([
    tx.query('select * from branches where company_id = $1 order by id', [c.companyId]),
    tx.query('select * from warehouses where company_id = $1 order by id', [c.companyId]),
    tx.query('select * from cost_centers where company_id = $1 order by id', [c.companyId]),
    tx.query('select * from sales_reps where company_id = $1 order by id', [c.companyId]),
  ]);
  return { branches: b.rows, warehouses: w.rows, cost_centers: cc.rows, sales_reps: r.rows };
}

// A new branch gets a warehouse and its own cash box under the cash group (extension D2).
export async function createBranch(tx: Tx, c: Ctx, input: { name: string; address?: string; phone?: string }) {
  requireManager(c);
  if (!input.name?.trim()) fail('اسم الفرع مطلوب');
  const { rows: [b] } = await tx.query('insert into branches(company_id, name, address, phone) values ($1,$2,$3,$4) returning *', [c.companyId, input.name.trim(), input.address ?? null, input.phone ?? null]);
  await tx.query('insert into warehouses(company_id, branch_id, name) values ($1,$2,$3)', [c.companyId, b.id, `مستودع ${b.name}`]);
  const { rows: [co] } = await tx.query('select pack_accounts, chart_start_date from companies where id = $1', [c.companyId]);
  const groupId = co.pack_accounts?.cash_group;
  if (groupId) {
    const { rows: kids } = await tx.query(
      `select d.code from accounts a join account_definitions d on d.account_id = a.id where a.parent_id = $1`, [groupId]);
    const { rows: [g] } = await tx.query(`select code from account_definitions where account_id = $1 order by valid_from desc limit 1`, [groupId]);
    const max = kids.reduce((m: number, k: any) => Math.max(m, Number(k.code.slice(g.code.length)) || 0), 0);
    const acc = await createAccount(tx, c, { parent_id: groupId, code: g.code + String(max + 1).padStart(2, '0'), name: `صندوق ${b.name}`, is_group: false,
      nature: 'debit', closing: 'permanent', presentation: { type: 'fixed', line: 1 }, branch_id: b.id, start_date: co.chart_start_date ?? undefined });
    await tx.query('update branches set cash_account_id = $2 where id = $1', [b.id, acc.id]);
  }
  await audit(tx, c, 'branch.create', 'branch', b.id, { after: input });
  return b;
}

export async function createSimple(tx: Tx, c: Ctx, table: 'cost_centers' | 'sales_reps' | 'warehouses', input: { name: string; branch_id?: number }) {
  requireManager(c);
  if (!input.name?.trim()) fail('الاسم مطلوب');
  if (table === 'warehouses' && !input.branch_id) fail('حدد الفرع');
  const cols = table === 'cost_centers' ? ['company_id', 'name'] : ['company_id', 'name', 'branch_id'];
  const vals = [c.companyId, input.name.trim(), ...(table === 'cost_centers' ? [] : [input.branch_id ?? null])];
  const { rows: [r] } = await tx.query(`insert into ${table}(${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, vals);
  await audit(tx, c, `${table}.create`, table, r.id, { after: input });
  return r;
}

// ---------------------------------------------------------------- customers & suppliers (subsidiary ledger)
export async function listParties(tx: Tx, c: Ctx, kind: 'customer' | 'supplier', q = '') {
  const s = q.trim();
  const all = await partyBalances(tx, c, kind);
  return all.filter((p: any) => !s || p.name.includes(s) || (p.phone ?? '').includes(s));
}

export async function createParty(tx: Tx, c: Ctx, input: { kind: 'customer' | 'supplier'; name: string; phone?: string; email?: string; vat_number?: string; address?: string; branch_id?: number | null }) {
  let branchId = input.branch_id ?? null;
  if (c.role === 'employee' && c.branchId) branchId = c.branchId;
  if (!input.name?.trim()) fail('الاسم مطلوب');
  if (input.vat_number && !/^3\d{13}3$/.test(input.vat_number)) fail('الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3');
  const { rows: dup } = await tx.query('select id from parties where company_id = $1 and kind = $2 and name = $3', [c.companyId, input.kind, input.name.trim()]);
  if (dup.length) fail(`يوجد ${input.kind === 'customer' ? 'عميل' : 'مورد'} بنفس الاسم (رقم ${dup[0].id})`);
  const { rows: [p] } = await tx.query(
    `insert into parties(company_id, kind, name, phone, email, vat_number, address, branch_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [c.companyId, input.kind, input.name.trim(), input.phone ?? null, input.email ?? null, input.vat_number ?? null, input.address ?? null, branchId]);
  await audit(tx, c, `party.create`, 'party', p.id, { after: input });
  return p;
}

export async function updateParty(tx: Tx, c: Ctx, id: number, patch: { name?: string; phone?: string; email?: string; vat_number?: string; address?: string }) {
  const { rows: [p] } = await tx.query('select * from parties where id = $1 and company_id = $2', [id, c.companyId]);
  if (!p) fail('الطرف غير موجود', 404);
  if (patch.vat_number && !/^3\d{13}3$/.test(patch.vat_number)) fail('الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3');
  const { rows: [u] } = await tx.query(
    `update parties set name = coalesce($2, name), phone = coalesce($3, phone), email = coalesce($4, email), vat_number = coalesce($5, vat_number), address = coalesce($6, address)
     where id = $1 returning *`, [id, patch.name ?? null, patch.phone ?? null, patch.email ?? null, patch.vat_number ?? null, patch.address ?? null]);
  await audit(tx, c, 'party.update', 'party', id, { before: p, after: patch });
  return u;
}

// ---------------------------------------------------------------- items
export async function listItems(tx: Tx, c: Ctx, q = '') {
  const { rows } = await tx.query(
    `select i.id, i.code, i.name_ar, i.name_en, i.category, i.base_unit, i.vat_rate_bp,
       coalesce((select sum(qty_milli) from item_stock s where s.item_id = i.id), 0) as qty_milli,
       case when i.total_qty_milli > 0 then (i.stock_value::numeric / i.total_qty_milli * 1000)::float8 else 0 end as avg_cost_h,
       (select json_agg(json_build_object('id', u.id, 'name', u.name, 'factor', u.factor_milli / 1000.0, 'price', u.price / 100.0, 'barcode', u.barcode, 'is_default', u.is_default) order by u.is_default desc, u.id)
          from item_units u where u.item_id = i.id) as units
     from items i
     where i.company_id = $1 and i.active and ($2 = '' or i.code = $2 or i.name_ar ilike '%' || $2 || '%' or coalesce(i.name_en,'') ilike '%' || $2 || '%'
       or exists (select 1 from item_units u where u.item_id = i.id and u.barcode = $2))
     order by i.code limit 300`, [c.companyId, q.trim()]);
  return rows.map((r) => ({ ...r, vat_rate_pct: r.vat_rate_bp / 100, qty: qty(r.qty_milli), avg_cost: sar(r.avg_cost_h) }));
}

export async function getItem(tx: Tx, c: Ctx, id: number) {
  const { rows: [i] } = await tx.query('select * from items where id = $1 and company_id = $2', [id, c.companyId]);
  if (!i) fail('الصنف غير موجود', 404);
  const { rows: units } = await tx.query('select * from item_units where item_id = $1 order by is_default desc, id', [id]);
  const { rows: stock } = await tx.query(
    `select s.warehouse_id, w.name as warehouse_name, s.qty_milli from item_stock s join warehouses w on w.id = s.warehouse_id where s.item_id = $1 order by w.id`, [id]);
  const { rows: [last] } = await tx.query(
    `select l.price, l.unit_name from invoice_lines l join invoices v on v.id = l.invoice_id where l.item_id = $1 and v.kind = 'sale' order by v.date desc, v.id desc limit 1`, [id]);
  return {
    id: i.id, code: i.code, name_ar: i.name_ar, name_en: i.name_en, category: i.category, base_unit: i.base_unit,
    vat_rate_pct: i.vat_rate_bp / 100, reorder_level: i.reorder_level_milli == null ? null : qty(i.reorder_level_milli),
    avg_cost: i.total_qty_milli > 0 ? Math.round((i.stock_value / i.total_qty_milli) * 1000) / 100 : 0,
    last_sale_price: last ? sar(last.price) : null, last_sale_unit: last?.unit_name ?? null,
    units: units.map((u) => ({ id: u.id, name: u.name, factor: u.factor_milli / 1000, price: sar(u.price), barcode: u.barcode, is_default: u.is_default })),
    stock: stock.map((s) => ({ warehouse_id: s.warehouse_id, warehouse_name: s.warehouse_name, qty: qty(s.qty_milli) })),
    qty: qty(stock.reduce((s, x) => s + x.qty_milli, 0)),
  };
}

export async function saveItem(tx: Tx, c: Ctx, input: any, id?: number) {
  const units: any[] = input.units ?? [];
  if (!input.name_ar?.trim()) fail('أدخل الوصف العربي للصنف');
  if (!units.length) fail('أدخل وحدة واحدة على الأقل');
  const defaults = units.filter((u) => u.is_default).length;
  if (defaults > 1) fail('وحدة افتراضية واحدة فقط');
  let itemId = id;
  const vatBp = Math.round((input.vat_rate_pct ?? 15) * 100);
  const reorder = input.reorder_level == null ? null : toMilli(input.reorder_level);
  if (!itemId) {
    let code = input.code?.trim();
    if (!code) {
      const { rows: [m] } = await tx.query(`select coalesce(max(code::bigint), 1000) + 1 as n from items where company_id = $1 and code ~ '^[0-9]+$'`, [c.companyId]);
      code = String(m.n);
    }
    const { rows: dup } = await tx.query('select 1 from items where company_id = $1 and code = $2', [c.companyId, code]);
    if (dup.length) fail(`رقم الصنف ${code} مستخدم`);
    const { rows: [i] } = await tx.query(
      `insert into items(company_id, code, name_ar, name_en, category, base_unit, vat_rate_bp, reorder_level_milli) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [c.companyId, code, input.name_ar.trim(), input.name_en ?? null, input.category ?? 'عام', input.base_unit ?? units[0].name, vatBp, reorder]);
    itemId = i.id;
  } else {
    const { rowCount } = await tx.query(`update items set name_ar = $2, name_en = $3, category = $4, vat_rate_bp = $5, reorder_level_milli = $6 where id = $1 and company_id = $7`,
      [itemId, input.name_ar.trim(), input.name_en ?? null, input.category ?? 'عام', vatBp, reorder, c.companyId]);
    if (!rowCount) fail('الصنف غير موجود', 404);
  }
  const { rows: existing } = await tx.query('select id, factor_milli from item_units where item_id = $1', [itemId]);
  for (const [idx, u] of units.entries()) {
    const isDefault = defaults ? !!u.is_default : idx === 0;
    if (!u.name?.trim() || !(Number(u.factor) > 0)) fail('لكل وحدة اسم وعبوة موجبة');
    const price = toHalala(u.price ?? 0);
    if (u.id) {
      const ex = existing.find((e) => e.id === u.id);
      if (!ex) fail('وحدة غير موجودة');
      if (ex.factor_milli !== toMilli(u.factor)) {
        const { rows: used } = await tx.query('select 1 from invoice_lines where item_id = $1 limit 1', [itemId]);
        if (used.length) fail(`لا يمكن تغيير عبوة الوحدة ${u.name} بعد استخدام الصنف في فواتير`);
      }
      await tx.query('update item_units set name = $2, factor_milli = $3, price = $4, barcode = $5, is_default = $6 where id = $1',
        [u.id, u.name.trim(), toMilli(u.factor), price, u.barcode || null, isDefault]);
    } else {
      await tx.query('insert into item_units(company_id, item_id, name, factor_milli, price, barcode, is_default) values ($1,$2,$3,$4,$5,$6,$7)',
        [c.companyId, itemId, u.name.trim(), toMilli(u.factor), price, u.barcode || null, isDefault]);
    }
  }
  await audit(tx, c, id ? 'item.update' : 'item.create', 'item', itemId!, { after: { name: input.name_ar } });
  return getItem(tx, c, itemId!);
}
