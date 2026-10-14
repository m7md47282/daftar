export const money = (n: number | null | undefined) =>
  n === null || n === undefined || isNaN(n) ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const qty = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 3 }));
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
export const monthStart = () => today().slice(0, 8) + '01';
export const yearStart = () => today().slice(0, 4) + '-01-01';
export function hijri(d: string | null | undefined) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date(d + 'T12:00:00'));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')}/${get('month')}/${get('year')}`;
  } catch { return ''; }
}
export const r2 = (n: number) => Math.round(n * 100) / 100;
// same rounding as the server: round half away from zero on halalas
export const halala = (n: number) => (n < 0 ? -Math.round(-n * 100) : Math.round(n * 100));
export const viaLabel: Record<string, string> = { web: '', ai: 'المحاسب الذكي', mcp: 'Claude', seed: '' };
