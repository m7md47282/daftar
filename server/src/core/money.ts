import { fail } from './errors.ts';

// ---------------------------------------------------------------- accounting core: exact money
// The core never uses floating point. Amounts are BigInt halalas internally and decimal strings
// ("1234.56") on the wire and in Postgres numeric(20,2).

export const LINE_MAX = 999999999999999999n; // 9,999,999,999,999,999.99 SAR in halalas (§15.1)

const AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';

// Parses what a person types. Accepts "1234.56", "1,234.56", "١٬٢٣٤٫٥٦", "1234.5".
// Rejects: more than 2 decimals (no silent rounding), negatives, non-numbers, and ambiguous
// separators such as "1,234" (could be 1.234) or "1.234,56". Returns halalas, or null for blank.
export function parseAmount(input: unknown, field = 'المبلغ'): bigint | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) fail(`${field}: قيمة غير صالحة`);
    input = String(input);
    if (/e/i.test(input as string)) fail(`${field}: قيمة غير صالحة`);
  }
  if (typeof input !== 'string') return fail(`${field}: قيمة غير صالحة`);
  let s = input.trim().replace(/[‎‏ \s]/g, '');
  if (s === '') return null;
  s = s.replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));
  if (s.startsWith('-')) fail(`${field}: لا تُقبل المبالغ السالبة`);
  // Arabic separators are unambiguous: ٬ thousands, ٫ decimal
  if (/[٬٫]/.test(s)) {
    if (/[.,]/.test(s)) fail(`${field}: صيغة ملتبسة تجمع فواصل عربية ولاتينية`);
    if (!/^\d{1,3}(٬\d{3})*(٫\d+)?$|^\d+(٫\d+)?$/.test(s)) fail(`${field}: صيغة غير واضحة`);
    s = s.replace(/٬/g, '').replace('٫', '.');
  } else if (s.includes(',')) {
    // a Latin comma is only accepted as a thousands separator when a decimal point makes it unambiguous
    if (!/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) fail(`${field}: الفاصلة ملتبسة — اكتب الرقم بدون فواصل (مثل 1234.56)`);
    s = s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) fail(`${field}: قيمة غير رقمية`);
  const [int, frac = ''] = s.split('.');
  if (frac.length > 2) fail(`${field}: الحد الأقصى منزلتان عشريتان (لا يتم التقريب تلقائيًا)`);
  const h = BigInt(int) * 100n + BigInt((frac + '00').slice(0, 2));
  if (h > LINE_MAX) fail(`${field}: يتجاوز الحد الأقصى للسطر 9,999,999,999,999,999.99`);
  return h;
}

// Postgres numeric text ("123.40", "-5.00") → halalas
export function fromDb(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  const s = String(v);
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const h = BigInt(int || '0') * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -h : h;
}

// halalas → "1234.56" (no grouping; the UI formats)
export function toStr(h: bigint): string {
  const neg = h < 0n;
  const a = neg ? -h : h;
  const s = `${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
  return neg ? '-' + s : s;
}
export const absB = (h: bigint) => (h < 0n ? -h : h);
export const sumB = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);

// ---------------------------------------------------------------- trader pack: integer halalas/milli
// Invoices and vouchers store integer halalas in bigint columns (well below 2^53).
export const toHalala = (sar: number) => Math.round(Number(sar) * 100);
export const toMilli = (q: number) => Math.round(Number(q) * 1000);
export const sar = (h: number) => Math.round(h) / 100;
export const qty = (m: number) => m / 1000;
export const mulDiv = (a: number, b: number, d: number) => {
  const v = (a * b) / d;
  return v < 0 ? -Math.round(-v) : Math.round(v);
};
// trader pack amount (number SAR) → exact halalas, rejecting >2 decimals like the core
export const strictHalala = (v: unknown, field?: string) => Number(parseAmount(v as any, field) ?? 0n);
