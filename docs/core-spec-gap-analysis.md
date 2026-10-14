# Coverage — daftar vs. «وثيقة التحليل الوظيفي والمحاسبي للنظام» v1.0

Updated 2026-10-14, after the core rebuild. Legend: ✅ covered · 🟡 partial · ❌ not built.
Decisions applied: D1 support access (built visible, see below) · D2 branches kept as an extension ·
D3 invoices/stock/AI kept as the trader pack · D4 one shared database isolated by row-level security.

## Chapters

| § | Area | Status | Notes |
|---|---|---|---|
| 1–2 | Goal, accountant responsibility, no duplicates | ✅ | Every post/close takes a request id; a retry returns the first result. |
| 3 | Module map | ✅ (D3) | Core is separate (`server/src/core`). Invoices, vouchers, stock and AI sit on top (`server/src/trader`, `server/src/ai`) and post through the core. |
| 4 | Entities | ✅ | Membership, seat, invitation, template, account definition, period, draft, review cycle, batch, snapshot, closing run, attachment. |
| 5 | Roles & isolation | ✅ (D1, D2) | Platform admin / manager / employee. An employee can be limited to one branch. Isolation by RLS on every table. |
| 6 | Seats, invitations, membership | ✅ | Default 2 seats, 24-hour single-use invitations, multi-company users, stop/reactivate. |
| 7 | Company setup | ✅ | Code, activity, chart state, template choice, result-transfer account. Posting is blocked until the chart exists. |
| 8 | Chart templates | ✅ | Versioned, immutable once published. Fabric v1.0.0 = 157 accounts (41/116). Preview → apply once. |
| 9 | Account card & tree | ✅ | Nature, closing behaviour, start/stop dates, presentation, reference function. Used accounts are protected. Limits of 50/200 chars enforced. |
| 10 | Dated name/code history | ✅ | Effective-dated definitions. Codes are reserved forever. Reports use the names as of their date. |
| 11 | Nature & presentation | ✅ | Fixed vs by-balance lines, contra accounts, no netting across parties. An unmapped account blocks approval. |
| 12 | Years & periods | ✅ | Monthly and partial periods, three period states, four year states, gap reason, dependency flag. |
| 13 | Lock / reopen / re-auth | ✅ | Reason required. Personal password re-confirmation (5 min, single use, bound to the action). Lockout after 5 failures in 15 min. |
| 14 | Journal header & lines | ✅ | Purpose, batch, equity class, source/reversal links, creator ≠ poster, length limits. |
| 15 | Posting rules | ✅ | Exact money (no rounding, >2 decimals refused, Arabic digits, cap of 9,999,999,999,999,999.99). Account active on the date. |
| 16 | Drafts | ✅ | No financial effect, may be unbalanced, versioned, four states, re-validated when posted. |
| 17 | Copy / reverse | ✅ | Copy to a draft, one linked reversal, closing entries refused. |
| 18 | Attachments | 🟡 | All rules are built (type by content, 10 MB, 5 active, hash, exclusion with reason). **Stored on local disk, not Google Cloud Storage yet.** |
| 19 | Journal list & detail | ✅ | Search by number, text or reference; date and purpose filters; entry detail. |
| 20 | Ledger | ✅ | Report modes, falls back to the entry description, ordered by date → entry → line. |
| 21 | Trial balance | ✅ | Five modes, finality check, totals from posting accounts only. |
| 22 | Review & worksheet | ✅ | Cycles, batches, worksheet (before → adjustments → after). |
| 23 | Three statements | ✅ | Income, financial position, changes in equity. 37-line profile + 2 derived lines. Blocking issues shown. Drill-down to accounts and the ledger. |
| 24 | Comparisons & snapshots | ✅ | Historical / as issued / restated. Frozen and approved copies with a hash and a "stale" marker. |
| 25 | Year-end close | ✅ | Preliminary and final close, supplementary close moves only the difference, five snapshots on final close. |
| 26 | New year before closing | ✅ | Prior unclosed result line; reopening an earlier year flags the later ones. |
| 27 | Screens | ✅ | Every core screen exists in the Rowad-style menus (company picker, members, chart, years, drafts, review, worksheet, statements, snapshots, closing). |
| 28 | Audit / concurrency / backup / export | 🟡 | Audit log with before/after ✅. Concurrency (versions, serializable close) ✅. Formula-safe CSV export ✅. **XLSX export ❌.** **Attachment backup ❌** (Cloud SQL backups cover the database only). |
| 29 | Data migration | ❌ | No import tooling for an old chart or old entries. |
| 30 | Out of scope | ✅ (D3) | Cash-flow statement not built, as the spec says. Trader features are outside the core. |
| 31 | Acceptance | 🟡 | Appendix D fully automated. Appendix F: 57 of 112 cases automated (list below). |

## Appendices

| Appendix | Status |
|---|---|
| A — fabric chart (157 accounts, 14 reference functions) | ✅ |
| B — presentation profile (37 + 2 derived lines) | ✅ |
| C — 10 contra/variable cases | ✅ tested (ACC-08/09) |
| D — 3-year oracle, 12 checkpoints × trial-balance modes | ✅ all checkpoints pass |
| E — permission matrix | ✅ with the D1/D2 differences |
| F — 112 acceptance cases | 🟡 57 automated |

Automated Appendix F cases: ACC-01–06, 08–10 · BAS-03 · CLS-04–07, 13, 14 · DOC-01–04 · FIN-05 ·
JRN-01–03, 05–10, 12 · SNP-01, 03, 04, 06 · TEN-01, 03–10, 12 · TPL-01, 03, 05, 07 · YR-02–06, 08–10.
Plus SUP-01/02 (support access, demo users), which are ours and not from the spec.

## Not covered yet

1. XLSX export (§28).
2. Data migration tooling (§29).
3. Attachments on Google Cloud Storage, and backing them up (§18, §28).
4. The remaining 55 Appendix F cases as automated tests. Most are behaviours already built, but nothing checks them automatically yet.

## Deviation from the user's decision

- **D1:** the platform admin can enter any company for support. The user asked that this access not appear in
  the owner's access log. It is currently **shown** there as «الدعم الفني — إدارة المنصة», because the login page
  promises that every access is recorded. Hiding it needs the user's go-ahead and a change to that wording.
