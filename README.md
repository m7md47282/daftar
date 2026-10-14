# دفتر (Daftar)

Arabic-first accounting SaaS for Saudi traders (fabric traders first). Keeps the screens, menus and
function keys of the desktop system the traders already use, on a modern, privacy-first core, with an
AI accountant that can only do what the system allows.

## Layout

```
db/schema.sql     the whole database: platform tables + company tables (company_id + row-level security)
server/           Node 24 + TypeScript (run directly, no build) — Fastify API
  src/core/       the accounting core (spec v1.0): accounts & templates, fiscal years/periods, journal & drafts,
                  review/adjustments, books, statements, snapshots, year-end closing, attachments, re-auth
  src/trader/     the trader pack on top of the core: invoices, vouchers, parties, items, VAT/stock reports
  src/ai/         tool registry + tool layer + Claude chat loop + credits
  src/pdf/        Arabic invoice/voucher PDF (headless Chromium), tafqit, ZATCA QR
  src/http/       routes, auth, branch scoping
  scripts/setup.ts  creates the database + schema, the super admin, publishes the fabric template
  test/           oracle.test.ts (Appendix D) · acceptance.test.ts (Appendix F cases)
web/              Angular 22 (standalone, signals, RTL)
mcp/              (unused) former external MCP bridge — the API no longer accepts token access
deploy/gcp.md     Cloud Run + Cloud SQL (me-central2) deployment
docs/manual/      Arabic user manual (one file per area, front-matter ids) — also the source for the AI's help
```

## Run locally

```bash
pnpm install
pnpm db:up            # Postgres 16 on :5438
pnpm db:setup         # database, schema, super admin (from .env), fabric template — never creates companies
pnpm db:setup -- --fresh   # local only: drop and rebuild the database
pnpm dev:api          # API on :8094
cd web && npx ng serve   # web on :8085 (proxies /api to :8094)
pnpm test             # oracle + acceptance tests, each against its own throwaway database (run in sequence)
```

Logins: **superadmin / password123** (local `.env` only), or "دخول كمالك / كمحاسب فرع" on the login page for a
private 24-hour demo copy. Companies are created by the super admin (لوحة الإدارة ← المنشآت المشتركة), which sends the
manager a single-use invitation link. Inside a demo, password confirmations (lock, close, approve) use `demo1234`;
demo users can't sign in through the login form.

## Design rules that matter

- **One shared database, isolated by row-level security.** Every company row carries `company_id`; each
  transaction sets `app.company_id` / `app.branch_scope`, and the app role owns no tables, so RLS always applies.
- **Support access is explicit and visible.** The super admin can open a company (لوحة الإدارة ← المنشآت المشتركة ← «دخول دعم فني»)
  with a reason; every action is attributed to them, recorded in `platform_audit`, and shown in the company's
  own access log as «الدعم الفني — إدارة المنصة».
- **Branch scoping is enforced twice:** in the API (`resolveBranch`) and by RLS (`branch_ok()`).
- **Periods and years:** monthly periods (open / adjustments only / locked); locking, reopening, closing and
  approving need the person's own password again (single-use 5-minute token).
- **The ledger is append-only.** Balance is checked at commit by a deferred trigger; journal rows cannot be
  updated or deleted. Corrections are returns or voids (reversing entries).
- **Money is numeric(20,2) in the database and BigInt halalas in code;** parsing (Arabic digits, no rounding)
  happens only in `core/money.ts`.
- **The AI is just another user.** Tools in `server/src/ai/tools.ts` call the same core functions as the
  screens. Writes always produce a preview (the real posting run inside a rolled-back transaction) and need
  a human confirmation: the "تأكيد وحفظ" button in the app (a single-use pending id bound to the exact input).
- **ZATCA-ready, not connected:** sales and credit notes carry UUID, invoice counter, previous-hash chain and
  the Phase 1 TLV QR. Connecting = generate signed UBL XML from these fields + onboarding (CSID).

## AI accountant: modes and credits

- **Two modes per user** (`users.ui_mode`): `system` = the classic screens; `ai` = the assistant is the main workspace.
  Toggle in the title bar or in إعدادات النظام ← المحاسب الذكي.
- **Credits** (`companies.ai_credits_milli`, history in `ai_credit_ledger`): each chat request is charged by its real token
  usage × model price (`server/src/ai/credits.ts`). One credit = `ai_credit_usd` dollars of API cost (default 0.01, set in
  لوحة الإدارة ← المفاتيح والتكاملات). The super admin tops up per business in لوحة الإدارة ← المنشآت المشتركة. Demos are not charged.
- **One tool layer, internal only** (`server/src/ai/layer.ts`): the in-app assistant lists/calls tools and confirms writes
  through it. There is no external MCP or token access; `mcp/` is no longer used by the API.

## Not built yet (menu items show "قريباً" in their final place)

Point of sale, quotations, purchase orders, opening quantities, stock adjustment/count, warehouse
transfers, automatic-entries settings, direct WhatsApp/e-mail sending through the integration keys
(today: share link opened in the user's own WhatsApp/e-mail), ZATCA Phase 2 submission.

Core-spec gaps still open (see `docs/core-spec-gap-analysis.md`): XLSX export (CSV is there), data
migration/import tooling, attachments on Cloud Storage (local disk today), and the full 112 acceptance cases
(31 automated so far plus the 12 Appendix D oracle checkpoints).
