import { tx, type Tx } from './db/pools.ts';
import type { Ctx } from './core/types.ts';
import { today, addDays } from './core/audit.ts';
import { applyTemplate } from './core/templates.ts';
import { createYear } from './core/fiscal.ts';
import { postEntry, saveDraft } from './core/journal.ts';
import { createCycle, createBatch } from './core/review.ts';
import * as M from './trader/masters.ts';
import { createInvoice } from './trader/invoices.ts';
import { createVoucher } from './trader/vouchers.ts';

// Fills one demo company: a fictional fabric trader with three branches and ~3 months of activity.
// Everything goes through the same core functions as real work.
let seed = 20261014;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const FABRICS: [string, string, number, number, number][] = [
  // name, category, roll length (m), cost/m, sale/m
  ['قماش ثياب ياباني أبيض', 'أقمشة ثياب', 50, 21, 32], ['قماش ثياب كوري أبيض', 'أقمشة ثياب', 50, 14, 22],
  ['قماش ثياب صيني اقتصادي', 'أقمشة ثياب', 60, 7.5, 12], ['قماش ثياب شتوي صوف رمادي', 'أقمشة ثياب', 40, 26, 39],
  ['قطن مصري سادة', 'قطن', 50, 16, 25], ['قطن مطبوع ورود', 'قطن', 50, 12, 19], ['كتان طبيعي بيج', 'كتان', 40, 28, 44],
  ['حرير طبيعي سادة', 'حرير', 30, 55, 85], ['ساتان لامع', 'حرير', 50, 11, 18], ['شيفون سادة', 'شيفون', 50, 8, 14],
  ['كريب عبايات أسود', 'أقمشة عبايات', 50, 13, 21], ['نده عبايات ملكي', 'أقمشة عبايات', 50, 19, 30],
  ['دانتيل فرنسي', 'دانتيل', 20, 45, 72], ['مخمل ناعم', 'مخمل', 30, 24, 38], ['بطانة بوليستر', 'بطانات', 100, 3.5, 6],
];
const CUSTOMERS: [string, string | null, string, 'all' | 0 | 1 | 2][] = [
  ['خياطة الأناقة الرجالية', '310987654300003', '0551234567', 'all'], ['مشغل لمسة للخياطة النسائية', null, '0559876543', 0],
  ['مؤسسة الثوب الأبيض للخياطة', '311223344500003', '0503344556', 1], ['محلات الراقي للأقمشة', '310556677800003', '0565566778', 1],
  ['عبايات الفخامة', null, '0547788990', 2], ['مؤسسة الذوق الرفيع للتجارة', '310111222300003', '0574455667', 'all'],
];
const SUPPLIERS: [string, string][] = [['شركة الشرق للمنسوجات', '300111222300003'], ['مؤسسة النسيج الآسيوي للاستيراد', '300444555600003'], ['شركة الحرير الذهبي للاستيراد', '300777888900003']];

async function quiet(t: Tx, fn: () => Promise<unknown>) {
  await t.query('savepoint ev');
  try { await fn(); await t.query('release savepoint ev'); }
  catch (e: any) { await t.query('rollback to savepoint ev'); if (!/الكمية غير كافية/.test(e.message)) throw e; }
}

export async function seedDemo(c: Ctx) {
  const year = Number(today().slice(0, 4));
  // about ten weeks of history, never before the start of the year
  const back = addDays(today(), -70);
  const start = back.slice(0, 4) === String(year) ? back.slice(0, 8) + '01' : `${year}-01-01`;
  await tx({ companyId: c.companyId, branchScope: 'all', userId: c.userId }, async (t) => {
    const { rows: [tpl] } = await t.query(`select id from chart_templates where slug = 'fabric-trading' and status = 'published' order by published_at desc limit 1`);
    await applyTemplate(t, { ...c, role: 'platform' }, tpl.id, `${year}-01-01`, true);
    await createYear(t, c, { start_date: `${year}-01-01`, end_date: `${year}-12-31` });
    await M.updateCompany(t, c, { vat_number: '310123456700003', cr_number: '1010654321', address: 'الرياض - طريق الملك فهد', phone: '0112345678',
      invoice_footer: 'البضاعة المباعة لا ترد بعد القص — شكراً لتعاملكم معنا', name_en: 'Golden Textile Fabrics Est.' });
    await t.query(`update branches set name = 'المركز الرئيسي - الرياض' where company_id = $1`, [c.companyId]);
    await t.query(`update warehouses set name = 'مستودع الرياض' where company_id = $1`, [c.companyId]);
    await M.createBranch(t, c, { name: 'فرع جدة' });
    await M.createBranch(t, c, { name: 'فرع الدمام' });
    const st = await M.structure(t, c);
    const branches = st.branches.map((b: any) => b.id);
    for (const n of ['مبيعات الجملة', 'مبيعات التجزئة']) await M.createSimple(t, c, 'cost_centers', { name: n });
    for (const [i, n] of ['أحمد السالم', 'خالد العمري', 'فهد القحطاني'].entries()) await M.createSimple(t, c, 'sales_reps', { name: n, branch_id: branches[i] });
    const reps = (await M.structure(t, c)).sales_reps.map((r: any) => r.id);
    const ccs = (await M.structure(t, c)).cost_centers.map((r: any) => r.id);

    const items: any[] = [];
    for (const [i, [name, cat, roll, , sale]] of FABRICS.entries())
      items.push(await M.saveItem(t, c, { code: String(1001 + i), name_ar: name, category: cat, base_unit: 'متر', reorder_level: roll * 2,
        units: [{ name: 'متر', factor: 1, price: sale, barcode: `62810000${1001 + i}1`, is_default: true }, { name: 'رول', factor: roll, price: Math.round(sale * roll * 0.92), barcode: `62810000${1001 + i}2` }] }));
    const customers: any[] = [];
    for (const [name, vat, phone, br] of CUSTOMERS) customers.push({ ...(await M.createParty(t, c, { kind: 'customer', name, vat_number: vat ?? undefined, phone, branch_id: br === 'all' ? null : branches[br] })), br });
    const suppliers: any[] = [];
    for (const [name, vat] of SUPPLIERS) suppliers.push(await M.createParty(t, c, { kind: 'supplier', name, vat_number: vat }));
    const { rows: [general] } = await t.query(`insert into parties(company_id, kind, name) values ($1,'customer','عميل نقدي') returning id`, [c.companyId]);
    const acct = async (code: string) => (await t.query(`select account_id from account_definitions where company_id = $1 and code = $2`, [c.companyId, code])).rows[0].account_id;

    // owner's capital: the one-time setup opening, classified as a contribution
    await postEntry(t, c, { date: start, description: 'قيد افتتاح التأسيس — رأس المال', purpose: 'opening', equity_class: 'contribution',
      lines: [{ account_id: await acct('110101'), debit: '400000' }, { account_id: await acct('310101'), credit: '400000' }] });
    const cashOf = async (b: number) => (await t.query('select cash_account_id from branches where id = $1', [b])).rows[0].cash_account_id;
    for (const b of branches) await postEntry(t, c, { date: start, description: 'تغذية صندوق الفرع من البنك', purpose: 'normal', branch_id: b,
      lines: [{ account_id: await cashOf(b), debit: '25000' }, { account_id: await acct('110101'), credit: '25000' }] });

    // stock: purchases per branch on credit
    for (const [bi, b] of branches.entries()) for (let k = 0; k < 3; k++) {
      const date = addDays(start, k * 25 + bi + 1);
      await createInvoice(t, c, { kind: 'purchase', branch_id: b, date, party_id: suppliers[(bi + k) % 3].id, payment_method: 'credit', paid: 0, ref: `PO-${bi}${k}`,
        lines: items.filter((_, i) => (i + bi + k) % 2 === 0).map((it) => { const f = FABRICS[items.indexOf(it)]; return { item_id: it.id, unit_name: 'رول', qty: between(5, 9), price: f[3] * f[2] }; }) });
    }
    // daily sales and collections
    const end = today();
    for (let d = addDays(start, 6); d <= end; d = addDays(d, 1)) {
      if (new Date(d + 'T12:00:00Z').getUTCDay() === 5) continue;
      for (const [bi, b] of branches.entries()) {
        for (let s = 0; s < between(2, 3); s++) {
          const walkIn = rnd() < 0.5;
          const cust = walkIn ? null : pick(customers.filter((x) => x.br === 'all' || x.br === bi));
          const credit = !walkIn && rnd() < 0.6;
          await quiet(t, () => createInvoice(t, c, { kind: 'sale', branch_id: b, date: d, party_id: cust ? cust.id : general.id, sales_rep_id: reps[bi],
            cost_center_id: walkIn ? ccs[2] : ccs[1], payment_method: credit ? 'credit' : 'cash', paid: credit ? 0 : undefined,
            lines: Array.from({ length: between(1, 3) }, () => { const it = pick(items); const roll = !walkIn && rnd() < 0.3; return { item_id: it.id, unit_name: roll ? 'رول' : 'متر', qty: roll ? 1 : between(3, 30) }; }) }));
        }
      }
      if (Number(d.slice(8)) % 6 === 0) for (const cu of customers.filter(() => rnd() < 0.5)) {
        const { rows: [{ v }] } = await t.query('select coalesce(sum(debit - credit),0)::float8 as v from journal_lines where party_id = $1', [cu.id]);
        if (v < 300) continue;
        const b = cu.br === 'all' ? branches[0] : branches[cu.br];
        await createVoucher(t, c, { kind: 'receipt', branch_id: b, date: d, counterparty: cu.name, about: 'دفعة من الحساب', lines: [{ party_id: cu.id, amount: Math.round(v * 0.5), description: 'سداد فواتير' }] });
      }
      if (d.slice(8) === '01') for (const [bi, b] of branches.entries())
        await createVoucher(t, c, { kind: 'payment', branch_id: b, date: d, counterparty: 'مصروفات شهرية', about: 'مصروفات تشغيل الفرع', lines: [
          { account_id: await acct('520101'), amount: bi === 0 ? 3500 : 2500, description: 'إيجار المعرض' },
          { account_id: await acct('520102'), amount: bi === 0 ? 5000 : 3500, description: 'رواتب فريق المبيعات' },
          { account_id: await acct('530104'), amount: between(800, 1500), description: 'كهرباء ومياه' }] });
      if (d.slice(8) === '15') for (const s of suppliers) {
        const { rows: [{ v }] } = await t.query('select coalesce(sum(credit - debit),0)::float8 as v from journal_lines where party_id = $1', [s.id]);
        if (v > 0) await createVoucher(t, c, { kind: 'payment', branch_id: branches[0], date: d, counterparty: s.name, method: 'cheque', cheque_no: String(between(100000, 999999)),
          cash_account_id: await acct('110101'), about: 'دفعة للمورد', lines: [{ party_id: s.id, amount: Math.round(v / 2), description: 'سداد جزء من الرصيد' }] });
      }
    }
    // a review cycle for the quarter with one accrual, and a draft waiting for approval
    const { rows: [y] } = await t.query('select id from fiscal_years where company_id = $1', [c.companyId]);
    const qEnd = addDays(end, -10);
    const cy = await createCycle(t, c, { year_id: y.id, name: `مراجعة الفترة حتى ${qEnd}`, start_date: start, end_date: qEnd });
    const bt = await createBatch(t, c, { cycle_id: cy.id, name: 'تسويات نهاية الربع' });
    await postEntry(t, c, { date: qEnd, description: 'استحقاق أتعاب مراجعة الفترة', purpose: 'adjustment', batch_id: bt.id,
      lines: [{ account_id: await acct('530110'), debit: '4500' }, { account_id: await acct('210205'), credit: '4500' }] });
    await saveDraft(t, c, { purpose: 'normal', date: end, description: 'إهلاك أثاث المعرض — مسودة للمراجعة', lines: [
      { account_id: await acct('530113'), debit: '1250' }, { account_id: await acct('120203'), credit: '1250' }] });
  });
}
