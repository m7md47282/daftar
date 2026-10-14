import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { z, ZodError } from 'zod';
import { env } from '../env.ts';
import { tx, platformTx, pool, type Tx } from '../db/pools.ts';
import { DomainError, fail } from '../core/errors.ts';
import type { Ctx, InvoiceKind, VoucherKind } from '../core/types.ts';
import { branchScope, isManager } from '../core/types.ts';
import * as P from '../platform.ts';
import * as CO from '../core/companies.ts';
import * as TP from '../core/templates.ts';
import * as A from '../core/accounts.ts';
import * as F from '../core/fiscal.ts';
import * as RV from '../core/review.ts';
import * as J from '../core/journal.ts';
import * as AT from '../core/attachments.ts';
import * as B from '../core/books.ts';
import * as S from '../core/statements.ts';
import * as SN from '../core/snapshots.ts';
import * as CL from '../core/closing.ts';
import { issueReauth } from '../core/reauth.ts';
import * as M from '../trader/masters.ts';
import * as inv from '../trader/invoices.ts';
import * as vch from '../trader/vouchers.ts';
import * as TR from '../trader/reports.ts';
import { htmlToPdf, invoiceHtml, voucherHtml, entryHtml } from '../pdf/render.ts';
import { chat, aiConfigured, noteOutcome } from '../ai/chat.ts';
import { confirmTool, rejectTool } from '../ai/layer.ts';
import * as credits from '../ai/credits.ts';
import { toCsv } from './export.ts';
import { seedDemo } from '../demo.ts';

const COOKIE = 'daftar_session';
type Req = FastifyRequest & { user?: P.SessionUser };
const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
const b = (req: FastifyRequest) => (req.body ?? {}) as any;
const n = (v: unknown) => (v === undefined || v === '' || v === null ? undefined : Number(v));
const INV_KINDS = ['sale', 'sale_return', 'purchase', 'purchase_return'];

export function buildApp() {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 16 * 1024 * 1024, trustProxy: true });
  app.register(cookie);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'بيانات غير صحيحة: ' + err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('، ') });
    if (err?.code === 'P0001') return reply.status(400).send({ error: err.message });                 // rules raised by the database
    if (err?.code === '23505') return reply.status(409).send({ error: 'القيمة مستخدمة مسبقاً' });
    if (err?.code === '23P01') return reply.status(400).send({ error: 'تتداخل المدد الزمنية' });
    if (err?.code === '40001' || err?.code === '40P01') return reply.status(409).send({ error: 'تعارض مع عملية متزامنة — أعد المحاولة' });
    app.log.error(err);
    return reply.status(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : 'حدث خطأ غير متوقع' });
  });

  app.addHook('preHandler', async (req: Req) => {
    if (req.url.startsWith('/api/') && req.cookies[COOKIE]) req.user = (await P.sessionUser(req.cookies[COOKIE])) ?? undefined;
  });
  const need = (req: Req) => { if (!req.user) fail('سجّل الدخول أولاً', 401); return req.user!; };
  const needPlatform = (req: Req) => { const u = need(req); if (!u.is_platform_admin) fail('هذا الإجراء لإدارة المنصة', 403); return u; };

  // The company of every request is explicit (header), re-checked against the live membership each time (§5.4).
  // header for API calls; ?company= for plain links (PDF in a new tab). The session cookie is still required.
  const ctxOf = async (req: Req, via: Ctx['via'] = 'web') => P.resolveCtx(need(req), Number(req.headers['x-company-id'] ?? q(req).company), via);
  async function T<X>(req: Req, fn: (t: Tx, c: Ctx) => Promise<X>, opts?: { rollback?: boolean; serializable?: boolean }) {
    const c = await ctxOf(req);
    return tx({ companyId: c.companyId, branchScope: branchScope(c), userId: c.userId }, (t) => fn(t, c), opts);
  }
  const mgr = (c: Ctx) => { if (!isManager(c)) fail('هذا الإجراء لمدير الشركة', 403); };

  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 24 * 3600 });

  // ================================================================ identity
  app.post('/api/auth/login', async (req, reply) => {
    const { token, userId } = await P.login(b(req).username, b(req).password);
    setSession(reply, token);
    const u = (await P.sessionUser(token))!;
    const companies = await P.myCompanies(u);
    for (const c of companies) await P.logAccess({ userId, userName: u.full_name, companyId: c.id, role: c.role, branchId: c.branch_id, via: 'web' }, 'تسجيل دخول', req.ip);
    return { user: u, companies };
  });
  app.post('/api/auth/logout', async (req: Req, reply) => {
    if (req.cookies[COOKIE]) await P.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async (req: Req) => {
    const u = need(req);
    return { user: { ...u, ai_ready: await aiConfigured() }, companies: await P.myCompanies(u) };
  });
  app.post('/api/auth/password', async (req: Req) => { const u = need(req); await P.changePassword(u.id, b(req).current, b(req).next); return { ok: true }; });
  app.patch('/api/auth/mode', async (req: Req) => {
    const u = need(req);
    const m = z.enum(['system', 'ai']).parse(b(req).mode);
    await pool.query('update users set ui_mode = $2 where id = $1', [u.id, m]);
    return { mode: m };
  });
  app.post('/api/auth/demo', async (req, reply) => {
    const as = b(req).as === 'employee' ? 'employee' : 'manager';
    const { token, companyId } = await P.createDemoSession(as, (c) => seedDemo(c));
    const u = await P.sessionUser(token);
    if (u) await P.logAccess(await P.resolveCtx(u, companyId), 'تسجيل دخول (نسخة تجريبية)', req.ip);
    setSession(reply, token);
    return { company_id: companyId };
  });
  // invitations: public preview + acceptance (new person sets credentials; existing person must be logged in as themself)
  app.get('/api/invitations/:token', async (req) => platformTx((t) => CO.invitationInfo(t, p(req).token)));
  app.post('/api/invitations/:token/accept', async (req: Req, reply) => {
    const r = await platformTx((t) => CO.acceptInvitation(t, p(req).token, req.user ? { userId: req.user.id } : b(req)));
    if (!req.user) { const { token } = await P.login(b(req).username, b(req).password); setSession(reply, token); }
    return r;
  });
  // §13.3 personal re-confirmation for sensitive actions
  app.post('/api/reauth', async (req: Req) => {
    const c = await ctxOf(req);
    const token = await tx({ companyId: c.companyId }, (t) => issueReauth(t, c.userId, c.companyId, b(req).action, b(req).password));
    if (!token) fail('كلمة المرور غير صحيحة', 401);
    return { token, expires_in_seconds: 300 };
  });

  // ================================================================ company, members, setup
  app.get('/api/company', (req: Req) => T(req, async (t, c) => {
    const co = await M.getCompany(t, c);
    const { rows: [tpl] } = co.template_id ? await t.query('select slug, version, name from chart_templates where id = $1', [co.template_id]) : { rows: [null] };
    return { ...co, role: c.role, branch_id: c.branchId, template: tpl, seats: await CO.seatUsage(t, c.companyId) };
  }));
  app.patch('/api/company', (req: Req) => T(req, (t, c) => M.updateCompany(t, c, b(req))));
  app.get('/api/structure', (req: Req) => T(req, (t, c) => M.structure(t, c)));
  app.post('/api/branches', (req: Req) => T(req, (t, c) => M.createBranch(t, c, b(req))));
  app.post('/api/cost-centers', (req: Req) => T(req, (t, c) => M.createSimple(t, c, 'cost_centers', b(req))));
  app.post('/api/sales-reps', (req: Req) => T(req, (t, c) => M.createSimple(t, c, 'sales_reps', b(req))));
  app.post('/api/warehouses', (req: Req) => T(req, (t, c) => M.createSimple(t, c, 'warehouses', b(req))));

  app.get('/api/members', (req: Req) => T(req, async (t, c) => { mgr(c); return CO.listMembers(t, c); }));
  app.post('/api/members/invite', (req: Req) => T(req, async (t, c) => {
    const r = await CO.inviteMember(t, c, b(req));
    return { ...r, link: `${env.webOrigin}/invite/${r.token}` };
  }));
  app.post('/api/invitations/id/:id/cancel', (req: Req) => T(req, (t, c) => CO.cancelInvitation(t, c, Number(p(req).id))));
  app.patch('/api/members/:id', (req: Req) => T(req, async (t, c) => {
    if (b(req).status) await CO.setMemberStatus(t, c, Number(p(req).id), b(req).status, b(req).reason);
    if ('branch_id' in b(req)) await CO.setMemberBranch(t, c, Number(p(req).id), b(req).branch_id ?? null);
    return { ok: true };
  }));

  app.get('/api/templates', (req: Req) => T(req, (t) => TP.listTemplates(t)));
  app.get('/api/templates/:id', (req: Req) => T(req, (t) => TP.templatePreview(t, Number(p(req).id))));
  app.post('/api/company/template', (req: Req) => T(req, (t, c) => TP.applyTemplate(t, c, Number(b(req).template_id), b(req).start_date, !!b(req).accept_policy)));
  app.post('/api/company/manual-chart', (req: Req) => T(req, (t, c) => TP.setManualChart(t, c)));
  app.post('/api/company/result-account', (req: Req) => T(req, (t, c) => A.setResultAccount(t, c, Number(b(req).account_id))));

  // ================================================================ chart of accounts
  app.get('/api/accounts', (req: Req) => T(req, (t, c) => A.listAccounts(t, c, q(req).as_of || undefined)));
  app.get('/api/accounts/search', (req: Req) => T(req, (t, c) => A.searchAccounts(t, c, q(req).q ?? '', { postable: q(req).all !== '1', date: q(req).date || undefined })));
  app.get('/api/accounts/:id', (req: Req) => T(req, (t, c) => A.getAccount(t, c, Number(p(req).id))));
  app.post('/api/accounts', (req: Req) => T(req, (t, c) => A.createAccount(t, c, b(req))));
  app.post('/api/accounts/:id/definitions', (req: Req) => T(req, (t, c) => A.addDefinition(t, c, Number(p(req).id), b(req))));
  app.patch('/api/accounts/:id/structure', (req: Req) => T(req, (t, c) => A.updateStructure(t, c, Number(p(req).id), b(req))));
  app.post('/api/accounts/:id/stop', (req: Req) => T(req, (t, c) => A.setStopDate(t, c, Number(p(req).id), b(req).date ?? null, b(req).reason)));
  app.delete('/api/accounts/:id', (req: Req) => T(req, (t, c) => A.deleteAccount(t, c, Number(p(req).id))));

  // ================================================================ years, periods, review
  app.get('/api/years', (req: Req) => T(req, (t, c) => F.listYears(t, c)));
  app.post('/api/years', (req: Req) => T(req, (t, c) => F.createYear(t, c, b(req))));
  app.post('/api/years/:id/review', (req: Req) => T(req, (t, c) => F.startReview(t, c, Number(p(req).id))));
  app.post('/api/years/:id/reopen', (req: Req) => T(req, (t, c) => F.reopenYear(t, c, Number(p(req).id), b(req).to, b(req).periods_to, b(req).reason, b(req).reauth)));
  app.post('/api/periods/:id/lock', (req: Req) => T(req, (t, c) => F.lockPeriod(t, c, Number(p(req).id), b(req).to, b(req).reauth)));
  app.post('/api/periods/:id/reopen', (req: Req) => T(req, (t, c) => F.reopenPeriod(t, c, Number(p(req).id), b(req).to, b(req).reason, b(req).reauth)));
  app.get('/api/period-events', (req: Req) => T(req, (t, c) => F.listEvents(t, c)));
  app.get('/api/review', (req: Req) => T(req, (t, c) => RV.listReview(t, c)));
  app.post('/api/review/cycles', (req: Req) => T(req, (t, c) => RV.createCycle(t, c, b(req))));
  app.post('/api/review/batches', (req: Req) => T(req, (t, c) => RV.createBatch(t, c, b(req))));
  app.patch('/api/review/cycles/:id', (req: Req) => T(req, (t, c) => RV.setCycleStatus(t, c, Number(p(req).id), b(req).status)));
  app.patch('/api/review/batches/:id', (req: Req) => T(req, (t, c) => RV.setBatchStatus(t, c, Number(p(req).id), b(req).status)));

  // ================================================================ journal & drafts
  app.get('/api/entries', (req: Req) => T(req, (t, c) => J.listEntries(t, c, { from: q(req).from, to: q(req).to, purpose: q(req).purpose, q: q(req).q, limit: n(q(req).limit) })));
  app.get('/api/entries/number/:n', (req: Req) => T(req, (t, c) => J.findEntry(t, c, Number(p(req).n))));
  app.get('/api/entries/:id', (req: Req) => T(req, (t, c) => J.getEntry(t, c, Number(p(req).id))));
  app.post('/api/entries/:id/copy', (req: Req) => T(req, (t, c) => J.copyEntry(t, c, Number(p(req).id))));
  app.post('/api/entries/:id/reverse', (req: Req) => T(req, (t, c) => J.reverseEntry(t, c, Number(p(req).id), b(req).date)));
  app.get('/api/entries/:id/pdf', async (req: Req, reply) => {
    const { pdf, name } = await T(req, async (t, c) => {
      const e = await J.getEntry(t, c, Number(p(req).id));
      const co = await M.getCompany(t, c);
      return { pdf: await htmlToPdf(entryHtml(e, co), 'A4'), name: `entry-${e.number}.pdf` };
    });
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}"`).send(pdf);
  });
  app.get('/api/drafts', (req: Req) => T(req, (t, c) => J.listDrafts(t, c, q(req).status ?? 'draft')));
  app.get('/api/drafts/:id', (req: Req) => T(req, (t, c) => J.getDraft(t, c, Number(p(req).id))));
  app.post('/api/drafts', (req: Req) => T(req, (t, c) => J.saveDraft(t, c, b(req))));
  app.put('/api/drafts/:id', (req: Req) => T(req, (t, c) => J.saveDraft(t, c, b(req), Number(p(req).id), n(b(req).version))));
  app.post('/api/drafts/:id/post', (req: Req) => T(req, (t, c) => J.postDraft(t, c, Number(p(req).id), n(b(req).version))));
  app.post('/api/drafts/:id/cancel', (req: Req) => T(req, (t, c) => J.setDraftStatus(t, c, Number(p(req).id), 'cancelled', b(req).reason)));
  app.post('/api/drafts/:id/defer', (req: Req) => T(req, (t, c) => J.setDraftStatus(t, c, Number(p(req).id), 'deferred', b(req).reason)));
  // direct posting (screens use drafts; this keeps the idempotent request id path)
  app.post('/api/entries', (req: Req) => T(req, (t, c) => J.postEntry(t, c, { ...b(req), purpose: b(req).purpose ?? 'normal' })));

  // attachments: JSON body {draft_id|entry_id, filename, data(base64)}
  app.post('/api/attachments', (req: Req) => T(req, (t, c) => AT.addAttachment(t, c, { draft_id: n(b(req).draft_id), entry_id: n(b(req).entry_id) },
    { filename: b(req).filename, data: Buffer.from(String(b(req).data ?? ''), 'base64') })));
  app.get('/api/attachments/:id', async (req: Req, reply) => {
    const f = await T(req, (t, c) => AT.readAttachment(t, c, Number(p(req).id)));
    return reply.type(f.mime).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`).header('x-content-type-options', 'nosniff').send(f.data);
  });
  app.post('/api/attachments/:id/exclude', (req: Req) => T(req, (t, c) => AT.excludeAttachment(t, c, Number(p(req).id), b(req).reason)));

  // ================================================================ books, statements, snapshots, closing
  const range = (req: FastifyRequest) => ({ from: q(req).from!, to: q(req).to!, mode: (q(req).mode || 'raw') as B.Mode, cycle_id: n(q(req).cycle_id), branch_id: n(q(req).branch_id) });
  app.get('/api/books/ledger', (req: Req) => T(req, (t, c) => B.ledger(t, c, Number(q(req).account_id), range(req))));
  app.get('/api/books/trial-balance', (req: Req) => T(req, (t, c) => B.trialBalance(t, c, { ...range(req), include_zero: q(req).include_zero === '1' })));
  app.get('/api/books/worksheet', (req: Req) => T(req, (t, c) => B.worksheet(t, c, range(req))));
  app.get('/api/books/party-statement', (req: Req) => T(req, (t, c) => B.partyStatement(t, c, Number(q(req).party_id), { from: q(req).from!, to: q(req).to! })));
  app.get('/api/statements/:type', (req: Req) => T(req, async (t, c) => {
    const type = z.enum(['income_statement', 'balance_sheet', 'equity_changes']).parse(p(req).type);
    const params = { from: q(req).from, to: q(req).to!, branch_id: n(q(req).branch_id), definitions_date: q(req).definitions_date || undefined };
    const ct = q(req).compare_type;
    const compare = ct ? { type: ct, from: q(req).compare_from, to: q(req).compare_to, snapshot_id: q(req).snapshot_id } : undefined;
    return SN.withComparison(t, c, type, params, compare);
  }));
  app.get('/api/snapshots', (req: Req) => T(req, (t, c) => SN.listSnapshots(t, c, { report_type: q(req).report_type, year_id: n(q(req).year_id) })));
  app.get('/api/snapshots/:id', (req: Req) => T(req, (t, c) => SN.getSnapshot(t, c, Number(p(req).id))));
  app.post('/api/snapshots', (req: Req) => T(req, (t, c) => SN.freeze(t, c, b(req)), { serializable: true }));
  app.get('/api/closing/:yearId', (req: Req) => T(req, (t, c) => CL.closingPreview(t, c, Number(p(req).yearId))));
  app.post('/api/closing', (req: Req) => T(req, (t, c) => CL.closeYear(t, c, b(req)), { serializable: true }));

  // ================================================================ trader pack
  app.get('/api/parties', (req: Req) => T(req, (t, c) => M.listParties(t, c, q(req).kind === 'supplier' ? 'supplier' : 'customer', q(req).q ?? '')));
  app.post('/api/parties', (req: Req) => T(req, (t, c) => M.createParty(t, c, b(req))));
  app.patch('/api/parties/:id', (req: Req) => T(req, (t, c) => M.updateParty(t, c, Number(p(req).id), b(req))));
  app.get('/api/items', (req: Req) => T(req, (t, c) => M.listItems(t, c, q(req).q ?? '')));
  app.get('/api/items/:id', (req: Req) => T(req, (t, c) => M.getItem(t, c, Number(p(req).id))));
  app.post('/api/items', (req: Req) => T(req, (t, c) => M.saveItem(t, c, b(req))));
  app.put('/api/items/:id', (req: Req) => T(req, (t, c) => M.saveItem(t, c, b(req), Number(p(req).id))));

  app.post('/api/invoices', (req: Req) => T(req, (t, c) => inv.createInvoice(t, c, b(req)), { rollback: q(req).dry_run === '1' }));
  app.get('/api/invoices', (req: Req) => T(req, (t, c) => inv.listInvoices(t, c, { kind: INV_KINDS.includes(q(req).kind ?? '') ? q(req).kind as InvoiceKind : undefined,
    from: q(req).from, to: q(req).to, party_id: n(q(req).party_id), branch_id: n(q(req).branch_id) })));
  app.get('/api/invoices/:kind/nav', (req: Req) => T(req, (t, c) => inv.invoiceNav(t, c, p(req).kind as InvoiceKind)));
  app.get('/api/invoices/:kind/:number', (req: Req) => T(req, (t, c) => inv.findInvoice(t, c, p(req).kind as InvoiceKind, Number(p(req).number))));
  const invoicePdf = async (t: Tx, c: Ctx, id: number) => {
    const i = await inv.getInvoice(t, c, id);
    const co = await M.getCompany(t, c);
    return { pdf: await htmlToPdf(await invoiceHtml(i, co), co.paper), name: `${i.kind}-${i.number}.pdf` };
  };
  app.get('/api/invoices/id/:id/pdf', async (req: Req, reply) => {
    const { pdf, name } = await T(req, (t, c) => invoicePdf(t, c, Number(p(req).id)));
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}"`).send(pdf);
  });
  app.post('/api/invoices/id/:id/share', (req: Req) => T(req, async (t, c) => {
    const token = P.newToken('s_');
    const i = await inv.getInvoice(t, c, Number(p(req).id));
    await t.query(`insert into invoice_shares(token_hash, company_id, invoice_id, branch_id, expires_at) values ($1,$2,$3,$4, now() + interval '30 days')`, [P.sha256(token), c.companyId, i.id, i.branch_id]);
    await t.query(`insert into send_log(company_id, invoice_id, branch_id, channel, recipient, status, user_name) values ($1,$2,$3,'link','-','created',$4)`, [c.companyId, i.id, i.branch_id, c.userName]);
    return { url: `${env.webOrigin}/s/${c.companyId}.${token}` };
  }));
  // public: only the holder of the link sees this one invoice
  app.get('/s/:token', async (req, reply) => {
    const [cid, token] = String(p(req).token).split('.');
    const companyId = Number(cid);
    if (!companyId || !token) return reply.status(404).send('الرابط غير صالح');
    const out = await tx({ companyId, branchScope: 'all' }, async (t) => {
      const { rows: [s] } = await t.query('select invoice_id from invoice_shares where token_hash = $1 and expires_at > now()', [P.sha256(token)]);
      if (!s) return null;
      const c: Ctx = { userId: 0, userName: 'رابط مشاركة', companyId, role: 'manager', branchId: null, via: 'system' };
      return invoicePdf(t, c, s.invoice_id);
    });
    if (!out) return reply.status(404).send('الرابط غير صالح أو منتهي');
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${out.name}"`).send(out.pdf);
  });

  app.post('/api/vouchers', (req: Req) => T(req, (t, c) => vch.createVoucher(t, c, b(req)), { rollback: q(req).dry_run === '1' }));
  app.get('/api/vouchers', (req: Req) => T(req, (t, c) => vch.listVouchers(t, c, { kind: (q(req).kind || undefined) as VoucherKind, from: q(req).from, to: q(req).to, branch_id: n(q(req).branch_id) })));
  app.get('/api/vouchers/:kind/nav', (req: Req) => T(req, (t, c) => vch.voucherNav(t, c, p(req).kind as VoucherKind)));
  app.get('/api/vouchers/:kind/:number', (req: Req) => T(req, (t, c) => vch.findVoucher(t, c, p(req).kind as VoucherKind, Number(p(req).number))));
  app.post('/api/vouchers/id/:id/void', (req: Req) => T(req, (t, c) => vch.voidVoucher(t, c, Number(p(req).id), b(req).reason, b(req).date)));
  app.get('/api/vouchers/id/:id/pdf', async (req: Req, reply) => {
    const { pdf, name } = await T(req, async (t, c) => {
      const v = await vch.getVoucher(t, c, Number(p(req).id));
      const co = await M.getCompany(t, c);
      return { pdf: await htmlToPdf(voucherHtml(v, co), 'A4'), name: `${v.kind}-${v.number}.pdf` };
    });
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}"`).send(pdf);
  });
  const tr = (req: FastifyRequest) => ({ from: q(req).from, to: q(req).to, branch_id: n(q(req).branch_id) ?? null });
  app.get('/api/reports/dashboard', (req: Req) => T(req, (t, c) => TR.dashboard(t, c, tr(req))));
  app.get('/api/reports/vat', (req: Req) => T(req, (t, c) => TR.vatReport(t, c, tr(req))));
  app.get('/api/reports/stock', (req: Req) => T(req, (t, c) => TR.stockReport(t, c, { branch_id: n(q(req).branch_id), warehouse_id: n(q(req).warehouse_id), q: q(req).q })));
  app.get('/api/reports/item-movement', (req: Req) => T(req, (t, c) => TR.itemMovement(t, c, Number(q(req).item_id), tr(req))));

  // ================================================================ exports (§28.4): CSV, safe against spreadsheet formulas
  app.get('/api/export/:type', async (req: Req, reply) => {
    const type = p(req).type;
    const data = await T(req, async (t, c) => {
      if (type === 'journal') return J.listEntries(t, c, { from: q(req).from, to: q(req).to, purpose: q(req).purpose, q: q(req).q, limit: 1000 });
      if (type === 'trial_balance') return B.trialBalance(t, c, range(req));
      if (type === 'worksheet') return B.worksheet(t, c, range(req));
      if (type === 'ledger') return B.ledger(t, c, Number(q(req).account_id), range(req));
      if (['income_statement', 'balance_sheet', 'equity_changes'].includes(type)) {
        const ct = q(req).compare_type;
        return SN.withComparison(t, c, type as any, { from: q(req).from, to: q(req).to!, branch_id: n(q(req).branch_id) },
          ct ? { type: ct, from: q(req).compare_from, to: q(req).compare_to, snapshot_id: q(req).snapshot_id } : undefined);
      }
      return fail('نوع تصدير غير معروف');
    });
    const c = await ctxOf(req);
    await P.logAccess(c, `تصدير ${type}`, req.ip);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${type}.csv"`).send(toCsv(type, data));
  });

  // ================================================================ logs (manager)
  app.get('/api/access-log', (req: Req) => T(req, async (t, c) => { mgr(c); return (await t.query('select * from access_log where company_id = $1 order by id desc limit 300', [c.companyId])).rows; }));
  app.get('/api/audit-log', (req: Req) => T(req, async (t, c) => { mgr(c); return (await t.query('select * from audit_log where company_id = $1 order by id desc limit 300', [c.companyId])).rows; }));

  // ================================================================ AI accountant (company manager, opt-in)
  const chatting = new Set<number>();
  const aiCtx = async (req: Req) => {
    const c = await ctxOf(req, 'ai');
    if (!isManager(c)) fail('المحاسب الذكي لمدير الشركة', 403);
    const { rows: [co] } = await tx({ companyId: c.companyId }, (t) => t.query('select ai_enabled, is_demo from companies where id = $1', [c.companyId]));
    if (!co.ai_enabled) fail('المحاسب الذكي غير مفعّل للشركة — فعّله من الإعدادات');
    return { c, isDemo: co.is_demo as boolean };
  };
  app.get('/api/ai/status', (req: Req) => T(req, async (t, c) => {
    const { rows: [co] } = await t.query('select ai_enabled, is_demo from companies where id = $1', [c.companyId]);
    return { enabled: co.ai_enabled, platform_ready: await aiConfigured(), is_demo: co.is_demo, available: isManager(c) && co.ai_enabled && (await aiConfigured()),
      credits: co.is_demo ? null : (await credits.balanceMilli(c.companyId)) / 1000 };
  }));
  app.patch('/api/ai/settings', (req: Req) => T(req, async (t, c) => {
    mgr(c);
    const enabled = !!b(req).enabled;
    await t.query('update companies set ai_enabled = $2 where id = $1', [c.companyId, enabled]);
    await t.query('insert into access_log(company_id, user_id, user_name, role, via, action, ip) values ($1,$2,$3,$4,$5,$6,$7)',
      [c.companyId, c.userId, c.userName, c.role, 'web', enabled ? 'تفعيل المحاسب الذكي' : 'إيقاف المحاسب الذكي', req.ip]);
    return { enabled };
  }));
  app.post('/api/ai/chat', async (req: Req) => {
    const ctx = await aiCtx(req);
    const body = z.object({ conversation_id: z.string().optional(), message: z.string().min(1).max(4000) }).parse(req.body);
    if (chatting.has(ctx.c.userId)) fail('المحاسب الذكي ما زال يعمل على طلبك السابق', 429);
    chatting.add(ctx.c.userId);
    try { return await chat(ctx, body.conversation_id, body.message); } finally { chatting.delete(ctx.c.userId); }
  });
  app.get('/api/ai/credits', async (req: Req) => {
    const { c, isDemo } = await aiCtx(req);
    if (isDemo) return { balance: null, ledger: [] };
    return { balance: (await credits.balanceMilli(c.companyId)) / 1000, ledger: await credits.ledger(c.companyId, 100) };
  });
  app.post('/api/ai/confirm/:id', async (req: Req) => {
    const { c } = await aiCtx(req);
    const conv = b(req).conversation_id;
    const { tool, result, summary } = await confirmTool(c, p(req).id, (t, r) =>
      noteOutcome(t, conv, c.userId, `أكّد المستخدم العملية وتم حفظها: ${r.summary}${r.result?.number ? ` (رقم ${r.result.number})` : ''}`));
    await P.logAccess(c, `المحاسب الذكي: ${summary}`, req.ip);
    const pdf = tool === 'create_invoice' ? `/api/invoices/id/${result.id}/pdf` : tool === 'create_voucher' || tool === 'void_voucher' ? `/api/vouchers/id/${result.id}/pdf`
      : tool === 'create_journal_entry' || tool === 'post_draft' ? `/api/entries/${result.id}/pdf` : null;
    return { result, pdf_url: pdf };
  });
  app.post('/api/ai/reject/:id', async (req: Req) => {
    const { c } = await aiCtx(req);
    const r = await rejectTool(c, p(req).id);
    if (r) await tx({ companyId: c.companyId, branchScope: 'all' }, (t) => noteOutcome(t, b(req).conversation_id, c.userId, `ألغى المستخدم العملية: ${r.summary}`));
    return { ok: true };
  });

  // ================================================================ platform console
  app.get('/api/admin/companies', async (req: Req) => {
    needPlatform(req);
    return platformTx(async (t) => {
      const { rows } = await t.query(
        `select c.id, c.code, c.name, c.activity, c.status, c.chart_state, c.template_choice, c.seat_limit, c.ai_enabled, c.created_at,
           c.ai_credits_milli / 1000.0 as ai_credits,
           (select u.full_name from memberships m join users u on u.id = m.user_id where m.company_id = c.id and m.role = 'manager' and m.status = 'active' limit 1) as manager_name,
           (select count(*) from memberships m where m.company_id = c.id and m.role = 'employee' and m.status = 'active')::int as employees,
           (select count(*) from invitations i where i.company_id = c.id and i.status = 'pending' and i.expires_at > now())::int as pending_invites
         from companies c where not c.is_demo order by c.id`);
      const { rows: [d] } = await t.query('select count(*)::int as n from companies where is_demo');
      return { companies: rows, active_demos: d.n };
    });
  });
  app.post('/api/admin/companies', async (req: Req) => {
    const u = needPlatform(req);
    const r = await platformTx((t) => CO.createCompany(t, u.id, b(req)));
    return { company: r.company, manager_invite_link: r.manager_invite_token ? `${env.webOrigin}/invite/${r.manager_invite_token}` : null };
  });
  app.patch('/api/admin/companies/:id', async (req: Req) => {
    const u = needPlatform(req);
    await platformTx((t) => CO.updateCompanyPlatform(t, u.id, Number(p(req).id), b(req)));
    return { ok: true };
  });
  app.post('/api/admin/companies/:id/seats', async (req: Req) => {
    const u = needPlatform(req);
    await platformTx((t) => CO.setSeatLimit(t, u.id, Number(p(req).id), Number(b(req).limit)));
    return { ok: true };
  });
  app.post('/api/admin/companies/:id/manager-invite', async (req: Req) => {
    const u = needPlatform(req);
    const id = Number(p(req).id);
    const token = await tx({ companyId: id, platform: true }, (t) => CO.createInvitation(t, id, u.id, { role: 'manager', email: b(req).email, display_name: b(req).name }));
    await pool.query('insert into platform_audit(user_id, company_id, action, detail) values ($1,$2,$3,$4)', [u.id, id, 'manager.invite', JSON.stringify({ email: b(req).email })]);
    return { link: `${env.webOrigin}/invite/${token}` };
  });
  // explicit support access (attributed to the platform admin's own identity)
  app.post('/api/admin/companies/:id/enter', async (req: Req) => {
    const u = needPlatform(req);
    const c = await P.resolveCtx(u, Number(p(req).id));
    await P.logAccess(c, b(req).reason ? `دخول دعم فني: ${b(req).reason}` : 'دخول دعم فني', req.ip);
    return { company_id: c.companyId, role: c.role };
  });
  app.get('/api/admin/companies/:id/credits', async (req: Req) => {
    needPlatform(req);
    const id = Number(p(req).id);
    return { balance: (await credits.balanceMilli(id)) / 1000, ledger: await credits.ledger(id) };
  });
  app.post('/api/admin/companies/:id/credits', async (req: Req) => {
    const u = needPlatform(req);
    const body = z.object({ credits: z.number().refine((x) => x !== 0), note: z.string().max(200).optional() }).parse(req.body);
    return { balance: (await credits.adjust(Number(p(req).id), u.id, body.credits, body.note ?? '')) / 1000 };
  });
  app.get('/api/admin/templates', async (req: Req) => { needPlatform(req); return platformTx((t) => TP.listTemplates(t)); });
  app.get('/api/admin/settings', async (req: Req) => { needPlatform(req); return P.listSettings(); });
  app.put('/api/admin/settings/:key', async (req: Req) => {
    const u = needPlatform(req);
    await P.putSetting(u.id, p(req).key, b(req).value ?? null);
    return P.listSettings();
  });
  app.get('/api/admin/audit', async (req: Req) => {
    needPlatform(req);
    const { rows } = await pool.query(`select a.*, u.username, c.name as company_name from platform_audit a left join users u on u.id = a.user_id left join companies c on c.id = a.company_id order by a.id desc limit 300`);
    return rows;
  });

  // Cloud Scheduler calls this hourly (Cloud Run may pause timers between requests).
  app.post('/internal/purge-demos', async (req, reply) => {
    if (!process.env.CRON_SECRET || req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return reply.status(404).send();
    return { purged: await P.purgeExpiredDemos() };
  });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
