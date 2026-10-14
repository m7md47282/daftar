import puppeteer, { type Browser } from 'puppeteer-core';
import QRCode from 'qrcode';
import { env } from '../env.ts';
import { tafqit } from './tafqit.ts';

let browser: Promise<Browser> | null = null;
function getBrowser() {
  if (!browser) {
    if (!env.chromePath) throw new Error('CHROME_PATH not set');
    browser = puppeteer.launch({ executablePath: env.chromePath, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--no-sandbox', '--font-render-hinting=none'] });
    // a failed launch or a crashed browser must not stay cached forever
    browser.then((b) => b.on('disconnected', () => { browser = null; }), () => { browser = null; });
  }
  return browser;
}

export async function closeBrowser() {
  const b = browser; browser = null;
  if (b) await (await b.catch(() => null))?.close().catch(() => {});
}

export async function htmlToPdf(html: string, paper: string): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    // web fonts load after 'load'; cap the wait so an offline font host can't block printing
    await Promise.race([page.evaluate(() => document.fonts.ready.then(() => true)), new Promise((r) => setTimeout(r, 5_000))]);
    const opts = paper === '80mm'
      ? { width: '80mm', printBackground: true, margin: { top: '4mm', bottom: '4mm', left: '3mm', right: '3mm' } }
      : { format: 'A4' as const, printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' } };
    return Buffer.from(await page.pdf(opts));
  } finally { await page.close(); }
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
export const hijri = (d: string) => new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d + 'T12:00:00'));

const css = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;700&display=swap');
*{box-sizing:border-box} body{font-family:'IBM Plex Sans Arabic','Geeza Pro','Noto Naskh Arabic',Arial,sans-serif;direction:rtl;color:#1d2433;font-size:11px;margin:0}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1d2433;padding-bottom:10px;margin-bottom:12px}
.co h1{font-size:18px;margin:0 0 4px} .co div{color:#4a5468;line-height:1.6}
.title{text-align:left} .title h2{margin:0;font-size:17px} .title .en{color:#4a5468;font-size:11px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-bottom:12px;padding:8px 10px;background:#f4f5f7;border-radius:4px}
.meta div{display:flex;gap:8px} .meta b{min-width:92px;color:#4a5468;font-weight:500}
table{width:100%;border-collapse:collapse;margin-bottom:10px} th{background:#1d2433;color:#fff;font-weight:500;padding:6px 5px;font-size:10px}
td{padding:6px 5px;border-bottom:1px solid #e3e6ec;text-align:center} td.l{text-align:right}
.bottom{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.totals{min-width:260px} .totals div{display:flex;justify-content:space-between;padding:4px 8px;border-bottom:1px solid #e3e6ec}
.totals .grand{background:#1d2433;color:#fff;font-weight:700;font-size:13px;border:0}
.words{margin-top:8px;padding:6px 8px;background:#fff8dc;border-radius:4px}
.foot{margin-top:18px;color:#4a5468;font-size:10px;border-top:1px solid #e3e6ec;padding-top:6px;display:flex;justify-content:space-between}
.sign{display:flex;justify-content:space-around;margin-top:36px} .sign div{border-top:1px solid #1d2433;padding-top:4px;min-width:140px;text-align:center}
.qr img{width:110px;height:110px}
@media print { .compact .meta{grid-template-columns:1fr} }`;

export async function invoiceHtml(inv: any, company: any) {
  const qr = inv.qr ? await QRCode.toDataURL(inv.qr, { margin: 0, width: 220 }) : null;
  const isSale = inv.kind === 'sale' || inv.kind === 'sale_return';
  const titles: Record<string, [string, string]> = {
    sale: [inv.zatca?.type === 'standard' ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة', inv.zatca?.type === 'standard' ? 'Tax Invoice' : 'Simplified Tax Invoice'],
    sale_return: ['إشعار دائن (مرتجع مبيعات)', 'Credit Note'],
    purchase: ['فاتورة مشتريات', 'Purchase Invoice'],
    purchase_return: ['مرتجع مشتريات', 'Purchase Return'],
  };
  const [t, te] = titles[inv.kind];
  const rows = inv.lines.map((l: any) => `<tr><td>${l.line_no}</td><td>${esc(l.item_code)}</td><td class="l">${esc(l.item_name)}</td><td>${esc(l.unit_name)}</td>
    <td>${num(l.qty)}${l.free_qty ? ` <small>+${num(l.free_qty)} مجاني</small>` : ''}</td><td>${money(l.price)}</td><td>${l.discount ? money(l.discount) : '-'}</td>
    <td>${money(l.net)}</td><td>${l.vat_rate_pct}%</td><td>${money(l.vat)}</td><td><b>${money(l.total)}</b></td></tr>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="head">
    <div class="co"><h1>${esc(company.name)}</h1><div>${esc(inv.branch_name)}</div>${company.address ? `<div>${esc(company.address)}</div>` : ''}
      <div>${company.vat_number ? 'الرقم الضريبي: ' + esc(company.vat_number) : ''}${company.cr_number ? ' &nbsp;|&nbsp; السجل التجاري: ' + esc(company.cr_number) : ''}</div>
      ${company.phone ? `<div>هاتف: ${esc(company.phone)}</div>` : ''}</div>
    <div class="title"><h2>${t}</h2><div class="en">${te}</div><div style="margin-top:6px;font-size:14px"><b>رقم ${inv.number}</b></div></div>
  </div>
  <div class="meta">
    <div><b>التاريخ</b>${inv.date} م — ${hijri(inv.date)}</div>
    <div><b>طريقة الدفع</b>${inv.payment_method === 'cash' ? 'نقداً' : 'آجل'}</div>
    <div><b>${isSale ? 'العميل' : 'المورد'}</b>${esc(inv.party_name)}</div>
    <div><b>الرقم الضريبي</b>${esc(inv.party_vat || '-')}</div>
    ${inv.party_phone ? `<div><b>الجوال</b>${esc(inv.party_phone)}</div>` : ''}
    ${inv.party_address ? `<div><b>العنوان</b>${esc(inv.party_address)}</div>` : ''}
    ${inv.original_invoice_number ? `<div><b>الفاتورة الأساسية</b>${inv.original_invoice_number}</div>` : ''}
    ${inv.sales_rep_name ? `<div><b>المندوب</b>${esc(inv.sales_rep_name)}</div>` : ''}
    ${inv.ref ? `<div><b>رقم المرجع</b>${esc(inv.ref)}</div>` : ''}
  </div>
  <table><thead><tr><th>#</th><th>رقم الصنف</th><th>اسم الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>المبلغ قبل الضريبة</th><th>نسبة الضريبة</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="bottom">
    <div>${qr ? `<div class="qr"><img src="${qr}"></div>` : ''}${inv.notes ? `<div style="margin-top:8px"><b>ملاحظات:</b> ${esc(inv.notes)}</div>` : ''}</div>
    <div class="totals">
      <div><span>الإجمالي قبل الخصم</span><span>${money(inv.subtotal)}</span></div>
      <div><span>الخصم</span><span>${money(inv.discount)}</span></div>
      <div><span>الإجمالي الخاضع للضريبة</span><span>${money(inv.net)}</span></div>
      <div><span>ضريبة القيمة المضافة</span><span>${money(inv.vat)}</span></div>
      <div class="grand"><span>صافي الفاتورة (ر.س)</span><span>${money(inv.total)}</span></div>
      ${inv.payment_method === 'credit' ? `<div><span>المدفوع</span><span>${money(inv.paid)}</span></div><div><span>المتبقي</span><span>${money(inv.remaining)}</span></div>` : ''}
      <div class="words">${tafqit(inv.total)}</div>
    </div>
  </div>
  <div class="sign"><div>المستلم</div><div>المحاسب</div></div>
  <div class="foot"><span>${esc(company.invoice_footer || 'شكراً لتعاملكم معنا')}</span><span>أعدّها: ${esc(inv.created_by_name)}</span></div>
  </body></html>`;
}

export function voucherHtml(v: any, company: any) {
  const rows = v.lines.map((l: any) => `<tr><td>${esc(l.account_code)}</td><td class="l">${esc(l.account_name)}</td><td class="l">${esc(l.description || '')}</td>
    ${v.kind === 'journal' ? `<td>${l.debit ? money(l.debit) : ''}</td><td>${l.credit ? money(l.credit) : ''}</td>` : `<td>${money(l.amount)}</td>`}</tr>`).join('');
  const who = v.kind === 'receipt' ? 'استلمنا من' : v.kind === 'payment' ? 'اصرفوا لـ' : '';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="head">
    <div class="co"><h1>${esc(company.name)}</h1><div>${esc(v.branch_name)}</div></div>
    <div class="title"><h2>${v.label}${v.status === 'voided' ? ' — ملغى' : ''}</h2><div style="margin-top:6px;font-size:14px"><b>رقم ${v.number}</b></div></div>
  </div>
  <div class="meta">
    <div><b>التاريخ</b>${v.date} م — ${hijri(v.date)}</div>
    ${v.kind !== 'journal' ? `<div><b>طريقة الدفع</b>${v.method === 'cheque' ? `شيك رقم ${esc(v.cheque_no)}` : 'نقداً'}</div>` : '<div></div>'}
    ${who ? `<div><b>${who}</b>${esc(v.counterparty || '')}</div>` : ''}
    ${v.about ? `<div><b>وذلك عبارة عن</b>${esc(v.about)}</div>` : ''}
    ${v.kind !== 'journal' ? `<div><b>${v.kind === 'receipt' ? 'الطرف المدين' : 'الطرف الدائن'}</b>${esc(v.cash_account_code)} - ${esc(v.cash_account_name)}</div>` : ''}
  </div>
  <table><thead><tr><th>رقم الحساب</th><th>اسم الحساب</th><th>البيان</th>${v.kind === 'journal' ? '<th>مدين</th><th>دائن</th>' : '<th>المبلغ</th>'}</tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom"><div></div><div class="totals"><div class="grand"><span>المجموع (ر.س)</span><span>${money(v.total)}</span></div><div class="words">${tafqit(v.total)}</div></div></div>
  <div class="sign"><div>المستلم</div><div>المحاسب</div><div>المدير</div></div>
  <div class="foot"><span>${esc(v.notes || '')}</span><span>أعدّه: ${esc(v.created_by_name)}</span></div>
  </body></html>`;
}

const PURPOSE: Record<string, string> = { normal: 'قيد عادي', adjustment: 'تسوية مراجعة', opening: 'افتتاح التأسيس', closing: 'إقفال نظامي' };
export function entryHtml(e: any, company: any) {
  const rows = e.lines.map((l: any) => `<tr><td>${esc(l.account_code)}</td><td class="l">${esc(l.account_name)}${l.party_name ? ` — ${esc(l.party_name)}` : ''}</td>
    <td class="l">${esc(l.description || '')}</td><td>${Number(l.debit) ? money(Number(l.debit)) : ''}</td><td>${Number(l.credit) ? money(Number(l.credit)) : ''}</td></tr>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="head"><div class="co"><h1>${esc(company.name)}</h1></div>
    <div class="title"><h2>قيد يومية — ${PURPOSE[e.purpose] ?? ''}</h2><div style="margin-top:6px;font-size:14px"><b>رقم ${e.number}</b></div></div></div>
  <div class="meta">
    <div><b>التاريخ المحاسبي</b>${e.date} م — ${hijri(e.date)}</div><div><b>السنة</b>${esc(e.year_name)}</div>
    <div><b>البيان</b>${esc(e.description)}</div><div><b>المرجع</b>${esc(e.reference || '-')}</div>
    ${e.batch_name ? `<div><b>دفعة التسويات</b>${esc(e.batch_name)}</div>` : ''}${e.reverses_number ? `<div><b>يعكس القيد</b>${e.reverses_number}</div>` : ''}
  </div>
  <table><thead><tr><th>رقم الحساب</th><th>اسم الحساب</th><th>البيان</th><th>مدين</th><th>دائن</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom"><div></div><div class="totals"><div class="grand"><span>الإجمالي (ر.س)</span><span>${money(Number(e.total))}</span></div><div class="words">${tafqit(Number(e.total))}</div></div></div>
  <div class="foot"><span>أنشأه: ${esc(e.created_by_name)} · رحّله: ${esc(e.posted_by_name)}</span><span>وقت الترحيل: ${new Date(e.posted_at).toISOString().slice(0, 16).replace('T', ' ')}</span></div>
  </body></html>`;
}
