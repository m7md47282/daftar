import { randomBytes, createHash, scryptSync } from 'node:crypto';
import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { requireManager } from './types.ts';
import { fail } from './errors.ts';
import { audit } from './audit.ts';
import { INITIAL_PIH } from './zatca.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
const INVITE_HOURS = 24;

// ---------- companies (platform) ----------
export type NewCompany = { code: string; name: string; activity?: string; seat_limit?: number; template_choice?: 'platform' | 'manager';
  vat_number?: string; manager_email: string; manager_name: string };

// Runs on the platform path. Returns the manager's one-time invitation link token.
export async function createCompany(tx: Tx, platformUserId: number, input: NewCompany, opts: { isDemo?: boolean } = {}) {
  const code = input.code?.trim(), name = input.name?.trim();
  if (!code || !name) fail('رمز الشركة واسمها مطلوبان');
  const { rows: dup } = await tx.query('select 1 from companies where lower(code) = lower($1)', [code]);
  if (dup.length) fail('رمز الشركة مستخدم');
  const { rows: [co] } = await tx.query(
    `insert into companies(code, name, activity, seat_limit, template_choice, vat_number, created_by, is_demo, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, case when $8 then now() + interval '24 hours' end) returning *`,
    [code, name, input.activity ?? 'تجارة الأقمشة', input.seat_limit ?? 2, input.template_choice ?? 'platform', input.vat_number ?? null, platformUserId, !!opts.isDemo]);
  await tx.query(`select set_config('app.company_id', $1, true)`, [String(co.id)]);
  const { rows: [b] } = await tx.query(`insert into branches(company_id, name) values ($1, 'المركز الرئيسي') returning id`, [co.id]);
  await tx.query(`insert into warehouses(company_id, branch_id, name) values ($1,$2,'المستودع الرئيسي')`, [co.id, b.id]);
  await tx.query(`insert into cost_centers(company_id, name) values ($1, 'مركز تكلفة عام')`, [co.id]);
  await tx.query('insert into zatca_state(company_id, icv, last_hash) values ($1, 0, $2)', [co.id, INITIAL_PIH]);
  await tx.query('insert into entry_sequences(company_id) values ($1)', [co.id]);
  let token: string | null = null;
  if (input.manager_email) token = await createInvitation(tx, co.id, platformUserId, { role: 'manager', email: input.manager_email, display_name: input.manager_name });
  await tx.query('insert into platform_audit(user_id, company_id, action, detail) values ($1,$2,$3,$4)', [platformUserId, co.id, 'company.create', JSON.stringify({ code, name })]);
  return { company: co, manager_invite_token: token };
}

export async function updateCompanyPlatform(tx: Tx, platformUserId: number, companyId: number, patch: { name?: string; code?: string; activity?: string; status?: string; template_choice?: string }) {
  const { rows: [before] } = await tx.query('select * from companies where id = $1', [companyId]);
  if (!before) fail('الشركة غير موجودة', 404);
  await tx.query(`update companies set name = coalesce($2, name), code = coalesce($3, code), activity = coalesce($4, activity),
    status = coalesce($5, status), template_choice = coalesce($6, template_choice) where id = $1`,
    [companyId, patch.name ?? null, patch.code ?? null, patch.activity ?? null, patch.status ?? null, patch.template_choice ?? null]);
  await tx.query('insert into platform_audit(user_id, company_id, action, detail) values ($1,$2,$3,$4)', [platformUserId, companyId, 'company.update', JSON.stringify(patch)]);
}

// ---------- seats (§6.1) ----------
export async function seatUsage(tx: Tx, companyId: number) {
  const { rows: [r] } = await tx.query(
    `select c.seat_limit,
       (select count(*) from memberships m join users u on u.id = m.user_id where m.company_id = c.id and m.role = 'employee' and m.status = 'active' and u.active)::int as active_employees,
       (select count(*) from invitations i where i.company_id = c.id and i.role = 'employee' and i.status = 'pending' and i.expires_at > now())::int as pending_invites
     from companies c where c.id = $1`, [companyId]);
  return { limit: r.seat_limit, used: r.active_employees + r.pending_invites, active_employees: r.active_employees, pending_invites: r.pending_invites };
}

// Serializes seat decisions per company so two requests can't take the last seat (§6.1, TEN-06).
async function lockSeats(tx: Tx, companyId: number) {
  await tx.query('select id from companies where id = $1 for update', [companyId]);
  const s = await seatUsage(tx, companyId);
  if (s.used >= s.limit) fail(`لا يوجد مقعد متاح (${s.used} من ${s.limit}) — زيادة الحد من إدارة المنصة`);
}

export async function setSeatLimit(tx: Tx, platformUserId: number, companyId: number, limit: number) {
  await tx.query('select id from companies where id = $1 for update', [companyId]);
  const s = await seatUsage(tx, companyId);
  if (!Number.isInteger(limit) || limit < 0) fail('حد المقاعد غير صالح');
  if (limit < s.used) fail(`لا يقل الحد عن المشغول والمحجوز (${s.used})`);
  await tx.query('update companies set seat_limit = $2 where id = $1', [companyId, limit]);
  await tx.query('insert into platform_audit(user_id, company_id, action, detail) values ($1,$2,$3,$4)', [platformUserId, companyId, 'seats', JSON.stringify({ from: s.limit, to: limit })]);
}

// ---------- invitations (§6.2) ----------
export async function createInvitation(tx: Tx, companyId: number, byUserId: number, input: { role: 'manager' | 'employee'; email: string; display_name: string; branch_id?: number | null }) {
  const email = input.email?.trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) fail('البريد الإلكتروني غير صالح');
  if (!input.display_name?.trim()) fail('الاسم مطلوب');
  if (input.role === 'employee') await lockSeats(tx, companyId);
  if (input.branch_id) {
    const { rows } = await tx.query('select 1 from branches where id = $1 and company_id = $2', [input.branch_id, companyId]);
    if (!rows.length) fail('الفرع غير موجود');
  }
  const token = randomBytes(24).toString('base64url');
  await tx.query(
    `insert into invitations(company_id, role, email, display_name, branch_id, token_hash, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + interval '${INVITE_HOURS} hours')`,
    [companyId, input.role, email, input.display_name.trim(), input.role === 'employee' ? input.branch_id ?? null : null, sha(token), byUserId]);
  return token;
}

export async function inviteMember(tx: Tx, c: Ctx, input: { role: 'manager' | 'employee'; email: string; display_name: string; branch_id?: number | null }) {
  if (input.role === 'manager' && c.role !== 'platform') fail('تعيين مدير الشركة من صلاحية إدارة المنصة', 403);
  requireManager(c);
  const token = await createInvitation(tx, c.companyId, c.userId, input);
  await audit(tx, c, 'invitation.create', 'invitation', null, { after: { role: input.role, email: input.email } });
  return { token, expires_in_hours: INVITE_HOURS };
}

export async function cancelInvitation(tx: Tx, c: Ctx, id: number) {
  requireManager(c);
  const { rowCount } = await tx.query(`update invitations set status = 'cancelled' where id = $1 and company_id = $2 and status = 'pending'`, [id, c.companyId]);
  if (!rowCount) fail('الدعوة غير موجودة أو ليست معلقة');
  await audit(tx, c, 'invitation.cancel', 'invitation', id);
}

export async function invitationInfo(tx: Tx, token: string) {
  const { rows: [i] } = await tx.query(
    `select i.id, i.role, i.email, i.display_name, i.status, i.expires_at, c.name as company_name
     from invitations i join companies c on c.id = i.company_id where i.token_hash = $1`, [sha(token)]);
  if (!i || i.status !== 'pending' || new Date(i.expires_at) < new Date()) fail('الدعوة غير صالحة أو منتهية أو مستخدمة', 404);
  const { rows: [u] } = await tx.query('select 1 from users where lower(email) = lower($1)', [i.email]);
  return { role: i.role, display_name: i.display_name, company_name: i.company_name, email_hint: i.email.replace(/(.).+(@.+)/, '$1***$2'), has_account: !!u };
}

// New person: choose username + password. Existing person: must be logged in as the invited identity.
export async function acceptInvitation(tx: Tx, token: string, by: { userId?: number; username?: string; password?: string; full_name?: string }) {
  const { rows: [i] } = await tx.query('select * from invitations where token_hash = $1 for update', [sha(token)]);
  if (!i || i.status !== 'pending' || new Date(i.expires_at) < new Date()) fail('الدعوة غير صالحة أو منتهية أو مستخدمة', 404);
  let userId = by.userId;
  if (userId) {
    const { rows: [u] } = await tx.query('select * from users where id = $1 and active', [userId]);
    if (!u || (u.email ?? '').toLowerCase() !== i.email) fail('هذه الدعوة لهوية أخرى — ادخل بالحساب المطابق للبريد المدعو', 403);
  } else {
    const { rows: [exists] } = await tx.query('select 1 from users where lower(email) = lower($1)', [i.email]);
    if (exists) fail('لهذا البريد حساب قائم — ادخل به أولًا ثم اقبل الدعوة', 409);
    if (!by.username?.trim() || (by.password ?? '').length < 8) fail('اختر اسم دخول وكلمة مرور (8 أحرف على الأقل)');
    const { rows: [dup] } = await tx.query('select 1 from users where lower(username) = lower($1)', [by.username!.trim()]);
    if (dup) fail('اسم الدخول مستخدم');
    const { rows: [u] } = await tx.query('insert into users(username, email, password_hash, full_name) values ($1,$2,$3,$4) returning id',
      [by.username!.trim(), i.email, hashPassword(by.password!), by.full_name?.trim() || i.display_name]);
    userId = u.id;
  }
  if (i.role === 'manager') {
    // keep exactly one active manager: the previous one steps down (keeps authorship of their entries)
    await tx.query(`update memberships set status = 'inactive', ended_at = now() where company_id = $1 and role = 'manager' and status = 'active' and user_id <> $2`, [i.company_id, userId]);
  }
  await tx.query(
    `insert into memberships(company_id, user_id, role, branch_id, status) values ($1,$2,$3,$4,'active')
     on conflict (company_id, user_id) do update set role = $3, branch_id = $4, status = 'active', ended_at = null`,
    [i.company_id, userId, i.role, i.branch_id]);
  await tx.query(`update invitations set status = 'accepted', accepted_by = $2, accepted_at = now() where id = $1`, [i.id, userId]);
  await tx.query(`insert into audit_log(company_id, user_id, user_name, via, action, entity, entity_id) values ($1,$2,(select full_name from users where id = $2),'web','invitation.accept','invitation',$3)`, [i.company_id, userId, i.id]);
  return { user_id: userId, company_id: i.company_id };
}

// ---------- members ----------
export async function listMembers(tx: Tx, c: Ctx) {
  const { rows: members } = await tx.query(
    `select m.id, m.user_id, m.role, m.branch_id, m.status, m.created_at, m.ended_at, u.full_name, u.username, u.active as identity_active
     from memberships m join users u on u.id = m.user_id where m.company_id = $1 order by m.role, m.id`, [c.companyId]);
  const { rows: invites } = await tx.query(
    `select id, role, email, display_name, branch_id, status, created_at, expires_at, (expires_at < now()) as expired
     from invitations where company_id = $1 order by id desc limit 100`, [c.companyId]);
  return { members, invitations: invites.map((x) => ({ ...x, status: x.status === 'pending' && x.expired ? 'expired' : x.status })), seats: await seatUsage(tx, c.companyId) };
}

// Stopping a membership frees its seat and keeps authorship; it never touches the person's identity or other companies.
export async function setMemberStatus(tx: Tx, c: Ctx, membershipId: number, status: 'active' | 'inactive', reason?: string) {
  requireManager(c);
  const { rows: [m] } = await tx.query('select m.*, u.active as identity_active from memberships m join users u on u.id = m.user_id where m.id = $1 and m.company_id = $2', [membershipId, c.companyId]);
  if (!m) fail('العضوية غير موجودة', 404);
  if (m.role === 'manager') fail('لا يوقف مدير الشركة من هنا — تستبدله إدارة المنصة بدعوة مدير جديد');
  if (status === 'active') {
    if (!m.identity_active) fail('الهوية العامة لهذا الشخص معطلة');
    if (m.status !== 'active') await lockSeats(tx, c.companyId);
  }
  await tx.query(`update memberships set status = $2, ended_at = case when $2 = 'inactive' then now() end where id = $1`, [membershipId, status]);
  await audit(tx, c, status === 'active' ? 'member.reactivate' : 'member.stop', 'membership', membershipId, { reason, before: m.status, after: status });
}

export async function setMemberBranch(tx: Tx, c: Ctx, membershipId: number, branchId: number | null) {
  requireManager(c);
  const { rowCount } = await tx.query(`update memberships set branch_id = $2 where id = $1 and company_id = $3 and role = 'employee'`, [membershipId, branchId, c.companyId]);
  if (!rowCount) fail('العضوية غير موجودة', 404);
  await audit(tx, c, 'member.branch', 'membership', membershipId, { after: { branch_id: branchId } });
}
