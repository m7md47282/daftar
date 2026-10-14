import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from './env.ts';
import { pool, adminPool, platformTx, tx } from './db/pools.ts';
import { fail } from './core/errors.ts';
import { verifyPassword } from './core/reauth.ts';
import { hashPassword, createCompany } from './core/companies.ts';
import type { Ctx, Via } from './core/types.ts';

export { hashPassword, verifyPassword };
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = (prefix = '') => prefix + randomBytes(32).toString('base64url');

// ---------------------------------------------------------------- secrets (platform settings)
const key = Buffer.from(env.masterKey, 'hex');
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(blob: string) {
  const [, iv, tag, data] = blob.split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const SETTINGS: { key: string; label: string; group: string; secret: boolean; hint?: string }[] = [
  { key: 'anthropic_api_key', label: 'مفتاح Anthropic API', group: 'الذكاء الاصطناعي', secret: true },
  { key: 'ai_model', label: 'النموذج', group: 'الذكاء الاصطناعي', secret: false, hint: 'claude-opus-5-5' },
  { key: 'ai_credit_usd', label: 'قيمة الرصيد الواحد بالدولار من تكلفة Claude', group: 'الذكاء الاصطناعي', secret: false, hint: '0.01' },
  { key: 'ai_daily_limit_demo', label: 'حد الرسائل اليومي للنسخة التجريبية', group: 'الذكاء الاصطناعي', secret: false, hint: '20' },
  { key: 'email_provider', label: 'مزود البريد', group: 'البريد الإلكتروني', secret: false, hint: 'resend' },
  { key: 'email_api_key', label: 'مفتاح البريد', group: 'البريد الإلكتروني', secret: true },
  { key: 'email_from', label: 'عنوان المرسل', group: 'البريد الإلكتروني', secret: false, hint: 'invoices@example.com' },
  { key: 'whatsapp_phone_id', label: 'WhatsApp Phone Number ID', group: 'واتساب', secret: false },
  { key: 'whatsapp_token', label: 'WhatsApp Access Token', group: 'واتساب', secret: true },
  { key: 'sms_provider', label: 'مزود الرسائل', group: 'الرسائل النصية', secret: false, hint: 'unifonic' },
  { key: 'sms_app_sid', label: 'App SID', group: 'الرسائل النصية', secret: true },
  { key: 'sms_sender', label: 'اسم المرسل', group: 'الرسائل النصية', secret: false },
  { key: 'zatca_environment', label: 'بيئة زاتكا', group: 'زاتكا (غير مفعّل بعد)', secret: false, hint: 'sandbox | simulation | production' },
  { key: 'zatca_client_id', label: 'Client ID', group: 'زاتكا (غير مفعّل بعد)', secret: false },
  { key: 'zatca_client_secret', label: 'Client Secret', group: 'زاتكا (غير مفعّل بعد)', secret: true },
];

export async function getSetting(k: string): Promise<string | null> {
  const { rows } = await pool.query('select value, is_secret from platform_settings where key = $1', [k]);
  if (!rows.length) return null;
  return rows[0].is_secret ? decrypt(rows[0].value) : rows[0].value;
}

export async function listSettings() {
  const { rows } = await pool.query('select key, value, is_secret, updated_at from platform_settings');
  return SETTINGS.map((s) => {
    const r = rows.find((x) => x.key === s.key);
    let display: string | null = null;
    if (r) display = s.secret ? '••••' + decrypt(r.value).slice(-4) : r.value;
    return { ...s, set: !!r, value: s.secret ? null : display, masked: s.secret ? display : null, updated_at: r?.updated_at ?? null };
  });
}

export async function putSetting(userId: number, k: string, value: string | null) {
  const def = SETTINGS.find((s) => s.key === k);
  if (!def) fail('إعداد غير معروف');
  if (value === null || value === '') await pool.query('delete from platform_settings where key = $1', [k]);
  else await pool.query(
    `insert into platform_settings(key, value, is_secret, updated_at) values ($1,$2,$3,now())
     on conflict (key) do update set value = $2, is_secret = $3, updated_at = now()`, [k, def!.secret ? encrypt(value) : value, def!.secret]);
  await pool.query('insert into platform_audit(user_id, action, detail) values ($1, $2, $3)', [userId, 'setting', JSON.stringify({ key: k, cleared: !value })]);
}

// ---------------------------------------------------------------- sessions
export type SessionUser = { id: number; username: string; full_name: string; email: string | null; is_platform_admin: boolean; ui_mode: 'system' | 'ai' };

export async function login(username: string, password: string) {
  const { rows: [u] } = await pool.query('select * from users where lower(username) = lower($1)', [String(username ?? '').trim()]);
  // Demo users share a known password, so they can only enter through the demo session link, never this form.
  if (!u || !u.active || /^demo-(mgr|emp)-/.test(u.username) || !verifyPassword(String(password ?? ''), u.password_hash)) fail('اسم المستخدم أو كلمة المرور غير صحيحة', 401);
  const token = newToken();
  await pool.query(`insert into sessions(token_hash, user_id, expires_at) values ($1, $2, now() + interval '12 hours')`, [sha256(token), u.id]);
  return { token, userId: u.id as number };
}

export async function sessionUser(token: string): Promise<SessionUser | null> {
  const { rows: [u] } = await pool.query(
    `select u.id, u.username, u.full_name, u.email, u.is_platform_admin, u.ui_mode from users u join sessions s on s.user_id = u.id
     where s.token_hash = $1 and s.expires_at > now() and u.active`, [sha256(token)]);
  return u ?? null;
}

export async function logout(token: string) { await pool.query('delete from sessions where token_hash = $1', [sha256(token)]); }

export async function changePassword(userId: number, current: string, next: string) {
  const { rows: [u] } = await pool.query('select password_hash from users where id = $1', [userId]);
  if (!verifyPassword(current ?? '', u.password_hash)) fail('كلمة المرور الحالية غير صحيحة', 401);
  if ((next ?? '').length < 8) fail('كلمة المرور الجديدة 8 أحرف على الأقل');
  await pool.query('update users set password_hash = $2 where id = $1', [userId, hashPassword(next)]);
}

// Companies this person can open: active membership in an active company (§5.4).
export async function myCompanies(u: SessionUser) {
  return platformTx(async (t) => {
    const { rows } = await t.query(
      `select c.id, c.code, c.name, c.is_demo, c.chart_state, m.role, m.branch_id, b.name as branch_name
       from memberships m join companies c on c.id = m.company_id left join branches b on b.id = m.branch_id
       where m.user_id = $1 and m.status = 'active' and c.status = 'active' and (c.expires_at is null or c.expires_at > now()) order by c.name`, [u.id]);
    return rows;
  });
}

// Built per request from the database: a stopped membership or suspended company is refused immediately.
export async function resolveCtx(u: SessionUser, companyId: number, via: Via = 'web'): Promise<Ctx> {
  if (!Number.isInteger(companyId) || companyId <= 0) fail('اختر الشركة', 400);
  return platformTx(async (t) => {
    const { rows: [co] } = await t.query('select id, status, expires_at from companies where id = $1', [companyId]);
    const live = co && co.status === 'active' && (!co.expires_at || new Date(co.expires_at) > new Date());
    const { rows: [m] } = await t.query(`select role, branch_id from memberships where company_id = $1 and user_id = $2 and status = 'active'`, [companyId, u.id]);
    if (m && live) return { userId: u.id, userName: u.full_name, companyId, role: m.role, branchId: m.role === 'employee' ? m.branch_id : null, via };
    // the platform admin may open a company explicitly for support; every action is attributed to them
    if (u.is_platform_admin && co) return { userId: u.id, userName: u.full_name, companyId, role: 'platform', branchId: null, via };
    return fail('لا تملك صلاحية على هذه الشركة', 403);
  });
}

export async function logAccess(c: Ctx, action: string, ip: string) {
  await tx({ companyId: c.companyId }, (t) => t.query('insert into access_log(company_id, user_id, user_name, role, via, action, ip) values ($1,$2,$3,$4,$5,$6,$7)',
    [c.companyId, c.userId, c.role === 'platform' ? `${c.userName} (الدعم الفني — إدارة المنصة)` : c.userName, c.role, c.via, action, ip]));
  if (c.role === 'platform') await pool.query('insert into platform_audit(user_id, company_id, action, detail) values ($1,$2,$3,$4)', [c.userId, c.companyId, 'support.access', JSON.stringify({ action, ip })]);
}

// ---------------------------------------------------------------- demo companies
// A demo is a private, fictional company per visitor, deleted after 24 hours. Nothing is created at start-up;
// after the first visitor, one pre-built demo waits (expires_at null) so the next visitor doesn't wait.
let refilling = false;
async function refillPool(seed: (managerCtx: Ctx) => Promise<void>) {
  if (refilling) return;
  refilling = true;
  try {
    const { rows: [r] } = await platformTx((t) => t.query('select count(*)::int as n from companies where is_demo and expires_at is null'));
    if (r.n === 0) await buildDemo(seed);
  } catch (e) { console.error('demo pool refill failed', e); } finally { refilling = false; }
}

export async function createDemoSession(as: 'manager' | 'employee', seed: (managerCtx: Ctx) => Promise<void>) {
  const { rows: [claimed] } = await platformTx((t) => t.query(
    `update companies set expires_at = now() + interval '24 hours'
     where id = (select id from companies where is_demo and expires_at is null order by id limit 1 for update skip locked) returning id`));
  const companyId: number = claimed?.id ?? (await buildDemo(seed, true));
  const { rows: [u] } = await platformTx((t) => t.query(`select user_id from memberships where company_id = $1 and role = $2 order by id limit 1`, [companyId, as]));
  const token = newToken();
  await pool.query(`insert into sessions(token_hash, user_id, expires_at) values ($1, $2, now() + interval '24 hours')`, [sha256(token), u.user_id]);
  setTimeout(() => refillPool(seed), 50);
  return { token, companyId };
}

async function buildDemo(seed: (managerCtx: Ctx) => Promise<void>, claim = false): Promise<number> {
  const suffix = randomBytes(5).toString('hex');
  const { company } = await platformTx((t) => createCompany(t, null as any, { code: `DEMO-${suffix}`, name: 'مؤسسة النسيج الذهبي للأقمشة (تجريبي)', manager_email: '', manager_name: '', seat_limit: 2 }, { isDemo: true }));
  if (!claim) await platformTx((t) => t.query('update companies set expires_at = null where id = $1', [company.id]));
  // Demo usernames are random and never shown, so this password only serves §13.3 re-confirmation inside the demo.
  const pw = hashPassword('demo1234');
  const { rows: [mgr] } = await pool.query(`insert into users(username, password_hash, full_name) values ($1,$2,'المالك (تجريبي)') returning id`, [`demo-mgr-${suffix}`, pw]);
  const { rows: [emp] } = await pool.query(`insert into users(username, password_hash, full_name) values ($1,$2,'محاسب فرع جدة (تجريبي)') returning id`, [`demo-emp-${suffix}`, pw]);
  const managerCtx: Ctx = { userId: mgr.id, userName: 'المالك (تجريبي)', companyId: company.id, role: 'manager', branchId: null, via: 'seed' };
  await platformTx((t) => t.query(`insert into memberships(company_id, user_id, role) values ($1,$2,'manager')`, [company.id, mgr.id]));
  await tx({ companyId: company.id }, (t) => t.query(`update companies set ai_enabled = true where id = $1`, [company.id]));
  await seed(managerCtx);
  const { rows: [jeddah] } = await tx({ companyId: company.id }, (t) => t.query(`select id from branches where company_id = $1 order by id offset 1 limit 1`, [company.id]));
  await platformTx((t) => t.query(`insert into memberships(company_id, user_id, role, branch_id) values ($1,$2,'employee',$3)`, [company.id, emp.id, jeddah?.id ?? null]));
  return company.id as number;
}

// Demo data is the only data ever removed; the ledger's own delete protection is bypassed on the admin path, demo rows only.
export async function purgeExpiredDemos() {
  const { rows } = await platformTx((t) => t.query(`select id from companies where is_demo and expires_at < now()`));
  if (!rows.length) return 0;
  const admin = adminPool(env.dbName);
  const tables = ['ai_pending', 'ai_conversations', 'access_log', 'audit_log', 'send_log', 'invoice_shares', 'voucher_lines', 'invoice_lines', 'attachments', 'drafts',
    'report_snapshots', 'journal_lines', 'vouchers', 'invoices', 'closing_runs', 'journal_entries', 'item_stock', 'item_units', 'items', 'parties', 'adjustment_batches',
    'review_cycles', 'period_events', 'periods', 'fiscal_years', 'account_codes', 'account_definitions', 'doc_sequences', 'entry_sequences', 'zatca_state',
    'ai_credit_ledger', 'invitations', 'memberships', 'sales_reps', 'cost_centers', 'warehouses'];
  try {
    for (const { id } of rows) {
      const c = await admin.connect();
      try {
        await c.query('begin');
        await c.query(`set local session_replication_role = replica`);
        const { rows: [ok] } = await c.query('select is_demo from companies where id = $1', [id]);
        if (!ok?.is_demo) { await c.query('rollback'); continue; }
        const { rows: users } = await c.query(`select user_id from memberships where company_id = $1`, [id]);
        for (const t of tables) await c.query(`delete from ${t} where company_id = $1`, [id]);
        await c.query('update companies set result_account_id = null where id = $1', [id]);
        await c.query('update branches set cash_account_id = null where company_id = $1', [id]);
        await c.query('delete from accounts where company_id = $1', [id]);
        await c.query('delete from branches where company_id = $1', [id]);
        await c.query('delete from companies where id = $1', [id]);
        await c.query(`delete from sessions where user_id = any($1)`, [users.map((u) => u.user_id)]);
        await c.query(`delete from users where id = any($1) and username like 'demo-%'`, [users.map((u) => u.user_id)]);
        await c.query('commit');
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    }
  } finally { await admin.end(); }
  return rows.length;
}
