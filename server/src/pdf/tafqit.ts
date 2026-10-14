// تفقيط: amount in Arabic words, e.g. 1250.5 → "ألف ومائتان وخمسون ريالاً وخمسون هللة فقط لا غير"
const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function under1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) parts.push(hundreds[h]);
  if (r) {
    if (r < 20) parts.push(ones[r]);
    else {
      const o = r % 10, t = Math.floor(r / 10);
      parts.push(o ? `${ones[o]} و${tens[t]}` : tens[t]);
    }
  }
  return parts.join(' و');
}

const scales: [number, string, string, string][] = [
  // value, singular, dual, plural(3-10)
  [1e9, 'مليار', 'ملياران', 'مليارات'],
  [1e6, 'مليون', 'مليونان', 'ملايين'],
  [1e3, 'ألف', 'ألفان', 'آلاف'],
];

function words(n: number): string {
  if (n === 0) return 'صفر';
  const parts: string[] = [];
  let rest = n;
  for (const [v, one, two, many] of scales) {
    const k = Math.floor(rest / v);
    rest %= v;
    if (!k) continue;
    if (k === 1) parts.push(one);
    else if (k === 2) parts.push(two);
    else if (k <= 10) parts.push(`${under1000(k)} ${many}`);
    else parts.push(`${under1000(k)} ${one}اً`.replace('ألفاً', 'ألفاً'));
  }
  if (rest) parts.push(under1000(rest));
  return parts.join(' و');
}

export function tafqit(amount: number): string {
  const riyals = Math.floor(Math.round(amount * 100) / 100);
  const halalas = Math.round(amount * 100) % 100;
  let s = `${words(riyals)} ريالاً`;
  if (riyals > 0 && riyals <= 2) s = riyals === 1 ? 'ريال واحد' : 'ريالان';
  if (halalas) s += ` و${words(halalas)} هللة`;
  return `${s} فقط لا غير`;
}
