// CSV export (§28.4). Text that a spreadsheet could execute (= + - @ tab CR) is neutralised with a
// leading apostrophe; amounts stay plain numbers with all their halalas. UTF-8 BOM for Arabic in Excel.
const TEXT_DANGER = /^[=+\-@\t\r]/;
function cell(v: unknown, numeric = false) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (numeric && /^-?\d+(\.\d+)?$/.test(s)) return s;
  if (TEXT_DANGER.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cols: unknown[], numeric: boolean[] = []) => cols.map((c, i) => cell(c, numeric[i])).join(',');

export function toCsv(type: string, d: any): string {
  const out: string[] = [];
  const N = (k: number, ...ix: number[]) => Array.from({ length: k }, (_, i) => ix.includes(i));
  if (type === 'journal') {
    out.push(row(['الرقم', 'التاريخ', 'الغرض', 'البيان', 'المرجع', 'الإجمالي', 'رحّله', 'وقت الترحيل']));
    for (const e of d) out.push(row([e.number, e.date, e.purpose_label, e.description, e.reference, e.total, e.posted_by_name, e.created_at], N(8, 5)));
  } else if (type === 'trial_balance') {
    out.push(row([`ميزان المراجعة — ${d.mode_label}`, `${d.from} إلى ${d.to}`, 'SAR']));
    out.push(row(['الرمز', 'الحساب', 'تجميعي', 'افتتاحي مدين', 'افتتاحي دائن', 'حركة مدين', 'حركة دائن', 'ختامي مدين', 'ختامي دائن']));
    for (const r of d.rows) out.push(row([r.code, r.name, r.is_group ? 'نعم' : '', r.opening_debit, r.opening_credit, r.debit, r.credit, r.closing_debit, r.closing_credit], N(9, 3, 4, 5, 6, 7, 8)));
    const t = d.totals;
    out.push(row(['', 'الإجمالي من الحسابات النهائية', '', t.opening_debit, t.opening_credit, t.debit, t.credit, t.closing_debit, t.closing_credit], N(9, 3, 4, 5, 6, 7, 8)));
  } else if (type === 'worksheet') {
    out.push(row(['الرمز', 'الحساب', 'قبل مدين', 'قبل دائن', 'تسوية مدين', 'تسوية دائن', 'بعد مدين', 'بعد دائن']));
    for (const r of d.rows) out.push(row([r.code, r.name, r.before.debit, r.before.credit, r.adjustments.debit, r.adjustments.credit, r.after.debit, r.after.credit], N(8, 2, 3, 4, 5, 6, 7)));
  } else if (type === 'ledger') {
    out.push(row([`دفتر الأستاذ — ${d.account.code} ${d.account.name}`, `${d.from} إلى ${d.to}`, d.mode_label]));
    out.push(row(['التاريخ', 'القيد', 'البيان', 'مدين', 'دائن', 'الرصيد', 'الجهة']));
    out.push(row(['', '', 'رصيد قبل المدة', '', '', d.opening, d.opening_side], N(7, 5)));
    for (const l of d.lines) out.push(row([l.date, l.number, l.description, l.debit, l.credit, l.balance, l.balance_side], N(7, 3, 4, 5)));
  } else {
    // statements with optional comparison: both periods, the comparison type and the profile version
    const cur = d.current, cmp = d.comparison;
    out.push(row([type, `${cur.from ?? ''} ${cur.to}`, cur.profile_version]));
    if (cmp) out.push(row(['مقارنة', cmp.label, `${cmp.data.from ?? ''} ${cmp.data.to ?? ''}`, cmp.profile_version, cmp.snapshot_id ?? '']));
    const lines = (st: any) => type === 'equity_changes' ? st.components.map((x: any) => [x.name, x.closing])
      : type === 'balance_sheet' ? [...st.assets, ...st.liabilities, ...st.equity].map((x: any) => [x.name, x.amount]) : st.lines.map((x: any) => [x.name, x.amount]);
    const c1 = lines(cur), c2 = cmp ? lines(cmp.data) : [];
    out.push(row(['البند', 'الفترة الحالية', ...(cmp ? ['المقارنة'] : [])]));
    c1.forEach((l: any, i: number) => out.push(row([l[0], l[1], ...(cmp ? [c2[i]?.[1] ?? ''] : [])], [false, true, true])));
    const tot = cur.totals ?? {};
    for (const [k, v] of Object.entries(tot)) out.push(row([k, v, ...(cmp ? [(cmp.data.totals ?? {})[k] ?? ''] : [])], [false, true, true]));
  }
  return '﻿' + out.join('\r\n') + '\r\n';
}
