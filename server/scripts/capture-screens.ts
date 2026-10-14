// Screenshots of the core screens for the user manual (docs/manual/screens), taken from a fresh demo company.
// Usage: API and web running locally, then: node server/scripts/capture-screens.ts [http://localhost:8085]
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:8085';
const out = fileURLToPath(new URL('../../docs/manual/screens/', import.meta.url));
mkdirSync(out, { recursive: true });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(page: Page, menu: string, item: string) {
  await page.evaluate(async (menu, item) => {
    const m = [...document.querySelectorAll<HTMLElement>('.mb > button')].find((b) => b.textContent!.trim() === menu);
    if (!m) throw new Error(`menu ${menu}`);
    m.click(); await new Promise((r) => setTimeout(r, 300));
    const it = [...document.querySelectorAll<HTMLElement>('.dd .it')].find((i) => i.textContent!.trim().startsWith(item));
    if (!it) throw new Error(`item ${item}`);
    it.click();
  }, menu, item);
  await wait(1800);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${out}${name}.png` });
  console.log('saved', name);
}

// picks the n-th real option of the last visible select matching a label text (or the last select)
async function choose(page: Page, n = 1, nth = -1) {
  await page.evaluate((n, nth) => {
    const sels = [...document.querySelectorAll<HTMLSelectElement>('select')].filter((s) => s.offsetParent);
    const s = sels.at(nth)!; s.value = s.options[n].value; s.dispatchEvent(new Event('change', { bubbles: true }));
  }, n, nth);
  await wait(1800);
}

async function clickRow(page: Page, text: string) {
  await page.evaluate((text) => [...document.querySelectorAll<HTMLElement>('tr.click')].find((r) => r.innerText.includes(text))?.click(), text);
  await wait(1500);
}

// types into an account picker and takes the first match
async function pickAccount(page: Page, code: string) {
  const box = (await page.$$('input[placeholder="رقم أو اسم الحساب…"]')).at(-1)!;
  await box.click(); await box.type(code); await wait(900);
  await page.keyboard.press('Enter'); await wait(2000);
}

// saves a frozen copy of the statement on screen, so the snapshots list has something to show
async function freeze(page: Page) {
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent!.trim() === 'حفظ نسخة مجمدة')!.click());
  await wait(500);
  const box = (await page.$$('input')).filter(Boolean).at(-1)!;
  await box.type('مراجعة شهرية');
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent!.trim() === 'متابعة')!.click());
  await wait(1500);
}

async function closeTabs(page: Page) {
  await page.evaluate(() => { for (const x of [...document.querySelectorAll<HTMLElement>('button.x[title]')]) x.click(); });
  await wait(300);
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await page.goto(base, { waitUntil: 'networkidle0' });
  await shot(page, '00-login');
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent!.includes('دخول كمالك'))!.click());
  await wait(4000);
  await shot(page, '01-home');

  const screens: [string, string, string, ((p: Page) => Promise<void>)?][] = [
    ['02-chart-setup', 'الملفات', 'تأسيس الدليل من قالب'],
    ['03-accounts', 'الملفات', 'دليل الحسابات', (p) => clickRow(p, '110102')],
    ['04-years', 'إعدادات النظام', 'السنوات والفترات'],
    ['05-journal-entry', 'السندات', 'سند قيد'],
    ['06-drafts', 'السندات', 'المسودات'],
    ['07-journal-list', 'السندات', 'اليومية العامة'],
    ['09-ledger', 'تقارير المحاسبة', 'دفتر الأستاذ العام', (p) => pickAccount(p, '110106')],
    ['10-trial-balance', 'تقارير المحاسبة', 'ميزان مراجعة'],
    ['11-review', 'إعدادات النظام', 'دورات المراجعة'],
    ['12-worksheet', 'تقارير المحاسبة', 'ورقة التسويات'],
    ['13-income', 'تقارير المحاسبة', 'حساب المتاجرة والأرباح والخسائر'],
    ['14-balance-sheet', 'تقارير المحاسبة', 'الميزانية العمومية'],
    ['15-equity', 'تقارير المحاسبة', 'قائمة التغيرات في حقوق الملكية'],
    ['16-snapshots', 'تقارير المحاسبة', 'النسخ المحفوظة والمعتمدة'],
    ['17-closing', 'إعدادات النظام', 'إقفال السنة المالية', (p) => choose(p, 1)],
    ['18-members', 'إعدادات النظام', 'المستخدمون والدعوات'],
    ['19-access-log', 'إعدادات النظام', 'سجل الدخول والإجراءات'],
  ];
  for (const [name, menu, item, after] of screens) {
    await closeTabs(page);
    await open(page, menu, item);
    if (after) await after(page);
    await shot(page, name);
    if (name === '14-balance-sheet') await freeze(page);
    if (name === '07-journal-list') {
      // the entry detail: open the first entry in the list
      await page.evaluate(() => (document.querySelector<HTMLElement>('table tbody tr td a, table tbody tr.click, table tbody tr'))?.click());
      await wait(1800);
      await shot(page, '08-entry-detail');
    }
  }

  // the platform console, signed in as the local super admin
  const admin = await browser.createBrowserContext();
  const ap = await admin.newPage();
  await ap.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await ap.goto(base, { waitUntil: 'networkidle0' });
  const inputs = await ap.$$('form input');
  await inputs[0].type(process.env.SUPERADMIN_USERNAME ?? 'superadmin');
  await inputs[1].type(process.env.SUPERADMIN_PASSWORD ?? 'password123');
  await ap.evaluate(() => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent!.trim() === 'دخول')!.click());
  await wait(3500);
  await shot(ap, '20-admin');
} finally {
  await browser.close();
}
