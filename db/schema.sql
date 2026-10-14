-- دفتر — one shared database for all companies (decision D4, 2026-10-14).
-- Every business row carries company_id and is protected by row-level security:
-- the app connects as a role that owns nothing and sets app.company_id per transaction.
-- Unset context ⇒ nothing visible (fail closed).
-- Money in the accounting core is numeric(20,2) end to end (no floats anywhere).

create extension if not exists btree_gist;

-- ============================================================ context helpers
create function ctx_company() returns int language sql stable as $$
  select nullif(current_setting('app.company_id', true), '')::int
$$;
-- 'all' for company-wide access, or a branch id for a branch-limited employee (extension D2)
create function branch_ok(b int) returns boolean language sql stable as $$
  select coalesce(current_setting('app.branch_scope', true), '') = 'all'
      or (b is not null and b::text = current_setting('app.branch_scope', true))
$$;

-- ============================================================ platform & identity
create table users (
  id            serial primary key,
  username      text not null unique,
  email         text,
  password_hash text not null,
  full_name     text not null,
  is_platform_admin boolean not null default false,
  active        boolean not null default true,       -- the person's global identity
  ui_mode       text not null default 'system' check (ui_mode in ('system','ai')),
  created_at    timestamptz not null default now()
);
create unique index users_email on users (lower(email)) where email is not null;

create table sessions (
  token_hash text primary key,
  user_id    int not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- §13.3 personal re-confirmation: 5 minutes, one user+company+action, single use
create table reauth_tokens (
  token_hash text primary key,
  user_id    int not null references users(id),
  company_id int not null,
  action     text not null,
  expires_at timestamptz not null,
  used_at    timestamptz
);
create table reauth_failures (
  id      bigserial primary key,
  user_id int not null references users(id),
  at      timestamptz not null default now()
);

create table platform_settings (
  key        text primary key,
  value      text not null,
  is_secret  boolean not null default false,
  updated_at timestamptz not null default now()
);

create table platform_audit (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  user_id int,
  company_id int,
  action  text not null,
  detail  jsonb
);

-- §8 published, versioned chart templates (immutable once published)
create table chart_templates (
  id           serial primary key,
  slug         text not null,
  version      text not null,
  name         text not null,
  activity     text not null,
  currency     text not null default 'SAR',
  description  text,
  content      jsonb not null,           -- accounts, reference functions, presentation profile
  content_hash text not null,
  status       text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  published_by int references users(id),
  unique (slug, version)
);
create function forbid_published_template_change() returns trigger language plpgsql as $$
begin
  if old.status = 'published' then raise exception 'القالب المنشور ثابت؛ انشر إصداراً جديداً بدل التعديل'; end if;
  return new;
end $$;
create trigger chart_templates_immutable before update or delete on chart_templates
  for each row execute function forbid_published_template_change();

-- ============================================================ companies
create table companies (
  id            serial primary key,
  code          text not null unique,
  name          text not null,
  name_en       text,
  currency      text not null default 'SAR' check (currency = 'SAR'),
  activity      text not null default 'تجارة الأقمشة',
  chart_state   text not null default 'pending_template'
                check (chart_state in ('pending_template','manual','inherited','from_template')),
  template_choice text not null default 'platform' check (template_choice in ('platform','manager')),
  template_id   int references chart_templates(id),
  template_applied_at timestamptz,
  template_applied_by int references users(id),
  chart_start_date date,
  seat_limit    int not null default 2 check (seat_limit >= 0),
  result_account_id int,                  -- FK added after accounts
  book_version  bigint not null default 0, -- bumps on every posting / definition change (§7.1)
  pack_accounts jsonb not null default '{}', -- trader pack: {sales, sales_returns, cogs, inventory, ...} → account ids
  status        text not null default 'active' check (status in ('active','suspended')),
  is_demo       boolean not null default false,
  expires_at    timestamptz,
  -- trader-pack / invoice settings
  vat_number    text,
  cr_number     text,
  address       text,
  phone         text,
  invoice_footer text,
  paper         text not null default 'A4' check (paper in ('A4','80mm')),
  allow_negative_stock boolean not null default false,
  -- AI accountant (billing data)
  ai_enabled    boolean not null default false,
  ai_credits_milli bigint not null default 0,
  created_at    timestamptz not null default now(),
  created_by    int references users(id)
);

-- §5–6 membership is separate from the person's identity
create table memberships (
  id         serial primary key,
  company_id int not null references companies(id),
  user_id    int not null references users(id),
  role       text not null check (role in ('manager','employee')),
  branch_id  int,                                   -- optional branch restriction (D2 extension)
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  ended_at   timestamptz,
  unique (company_id, user_id)
);
create unique index one_active_manager on memberships(company_id) where role = 'manager' and status = 'active';

create table invitations (
  id           serial primary key,
  company_id   int not null references companies(id),
  role         text not null check (role in ('manager','employee')),
  email        text not null,
  display_name text not null,
  branch_id    int,
  token_hash   text not null unique,
  created_by   int not null references users(id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  status       text not null default 'pending' check (status in ('pending','accepted','cancelled')),
  accepted_by  int references users(id),
  accepted_at  timestamptz
);

create table ai_credit_ledger (
  id                  bigserial primary key,
  company_id          int not null references companies(id),
  at                  timestamptz not null default now(),
  kind                text not null check (kind in ('topup','usage','adjust')),
  delta_milli         bigint not null,
  balance_after_milli bigint not null,
  note                text,
  user_id             int,
  model               text,
  input_tokens        int,
  output_tokens       int,
  cache_write_tokens  int,
  cache_read_tokens   int,
  cost_usd_micros     bigint
);

-- ============================================================ trader-pack structure (branches etc.)
create table branches (
  id         serial primary key,
  company_id int not null references companies(id),
  name       text not null,
  address    text,
  phone      text,
  cash_account_id int,
  active     boolean not null default true
);
create table warehouses (
  id serial primary key, company_id int not null references companies(id),
  branch_id int not null references branches(id), name text not null
);
create table cost_centers (id serial primary key, company_id int not null references companies(id), name text not null);
create table sales_reps (id serial primary key, company_id int not null references companies(id), name text not null, branch_id int references branches(id));

-- ============================================================ chart of accounts (§9–11)
create table accounts (
  id             serial primary key,
  company_id     int not null references companies(id),
  parent_id      int references accounts(id),
  classification text not null check (classification in ('asset','liability','equity','revenue','expense')),
  is_group       boolean not null,
  nature         text check (nature in ('debit','credit','variable')),          -- descriptive only
  closing        text check (closing in ('permanent','temporary')),
  start_date     date not null,                                                  -- first date accepting entries
  stop_date      date,                                                           -- no new everyday entries after it
  ref_function   text,                                                           -- e.g. 'retained_earnings'
  template_origin text,                                                          -- 'fabric-trading@1.0.0:110101'
  branch_id      int references branches(id),                                    -- branch cash boxes (extension)
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  check (is_group or (nature is not null and closing is not null)),
  check (stop_date is null or stop_date >= start_date)
);
create unique index account_ref_function on accounts(company_id, ref_function) where ref_function is not null and deleted_at is null;
alter table companies add constraint companies_result_account foreign key (result_account_id) references accounts(id);
alter table branches add constraint branches_cash_account foreign key (cash_account_id) references accounts(id);

-- §10 dated name/code/presentation; identity never changes
create table account_definitions (
  id           serial primary key,
  company_id   int not null references companies(id),
  account_id   int not null references accounts(id),
  code         text not null check (length(code) between 1 and 50),
  name         text not null check (length(name) between 1 and 200),
  -- {"type":"fixed","line":1} | {"type":"by_balance","debit_line":7,"credit_line":15} | null (incomplete)
  presentation jsonb,
  valid_from   date not null,
  valid_to     date,
  created_at   timestamptz not null default now(),
  created_by   int,
  exclude using gist (account_id with =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&)
);
-- a code, once used, belongs to one account identity forever (even after delete)
create table account_codes (
  company_id int not null references companies(id),
  code       text not null,
  account_id int not null references accounts(id),
  primary key (company_id, code)
);

-- ============================================================ fiscal years & periods (§12–13)
create table fiscal_years (
  id          serial primary key,
  company_id  int not null references companies(id),
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open','under_review','needs_supplementary','final')),
  gap_reason  text,
  needs_dependency_review boolean not null default false,
  last_closing_run_id int,
  created_at  timestamptz not null default now(),
  check (end_date >= start_date),
  exclude using gist (company_id with =, daterange(start_date, end_date, '[]') with &&)
);
create table periods (
  id         serial primary key,
  company_id int not null references companies(id),
  year_id    int not null references fiscal_years(id),
  start_date date not null,
  end_date   date not null,
  status     text not null default 'open' check (status in ('open','adjustments_only','locked'))
);
create table period_events (
  id         bigserial primary key,
  company_id int not null references companies(id),
  year_id    int references fiscal_years(id),
  period_id  int references periods(id),
  action     text not null,
  from_status text,
  to_status  text,
  reason     text,
  user_id    int not null,
  at         timestamptz not null default now()
);

-- ============================================================ review (§22)
create table review_cycles (
  id         serial primary key,
  company_id int not null references companies(id),
  year_id    int not null references fiscal_years(id),
  name       text not null,
  start_date date not null,
  end_date   date not null,
  status     text not null default 'open' check (status in ('open','closed')),
  created_by int, created_at timestamptz not null default now()
);
create table adjustment_batches (
  id         serial primary key,
  company_id int not null references companies(id),
  cycle_id   int not null references review_cycles(id),
  name       text not null,
  status     text not null default 'open' check (status in ('open','closed')),
  created_by int, created_at timestamptz not null default now()
);

-- ============================================================ journal (§14–17)
create table parties (
  id         serial primary key,
  company_id int not null references companies(id),
  kind       text not null check (kind in ('customer','supplier')),
  name       text not null,
  phone      text, email text, vat_number text, address text,
  branch_id  int references branches(id),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table journal_entries (
  id            serial primary key,
  company_id    int not null references companies(id),
  number        int not null,
  date          date not null,
  year_id       int not null references fiscal_years(id),
  description   text not null check (length(description) between 1 and 500),
  purpose       text not null check (purpose in ('normal','adjustment','opening','closing')),
  batch_id      int references adjustment_batches(id),
  reference     text check (reference is null or length(reference) <= 200),
  equity_class  text check (equity_class in ('contribution','distribution','reserve_transfer','prior_adjustment','other')),
  source_entry_id   int references journal_entries(id),
  reverses_entry_id int references journal_entries(id),
  branch_id     int references branches(id),
  origin        text not null default 'journal' check (origin in ('journal','invoice','voucher','closing','import')),
  closing_run_id int,
  request_id    text,
  request_hash  text,
  draft_id      int,
  created_by    int,             -- null only for migrated legacy entries with unknown author
  created_by_name text,
  posted_by     int not null,
  posted_by_name text not null,
  via           text not null default 'web' check (via in ('web','ai','seed','system')),
  created_at    timestamptz not null default now(),
  posted_at     timestamptz not null default now(),
  unique (company_id, number),
  unique (company_id, request_id),
  check ((purpose = 'adjustment') = (batch_id is not null))
);
create unique index one_linked_reversal on journal_entries(reverses_entry_id) where reverses_entry_id is not null;

create table journal_lines (
  id           bigserial primary key,
  company_id   int not null references companies(id),
  entry_id     int not null references journal_entries(id),
  line_no      int not null,
  account_id   int not null references accounts(id),
  account_code text not null,       -- definition in force on the entry date (§14.2)
  account_name text not null,
  description  text check (description is null or length(description) <= 500),
  debit        numeric(20,2) not null default 0 check (debit >= 0 and debit <= 9999999999999999.99),
  credit       numeric(20,2) not null default 0 check (credit >= 0 and credit <= 9999999999999999.99),
  date         date not null,       -- copy of entry date, for fast period sums
  purpose      text not null,       -- copy of entry purpose
  batch_id     int,
  branch_id    int references branches(id),
  party_id     int references parties(id),       -- subsidiary ledger (trader extension)
  cost_center_id int references cost_centers(id),
  check ((debit = 0) <> (credit = 0)),
  unique (entry_id, line_no)
);
create index on journal_lines(company_id, account_id, date);
create index on journal_lines(entry_id);
create index on journal_lines(company_id, party_id) where party_id is not null;

create function check_entry_balanced() returns trigger language plpgsql as $$
declare d numeric; c numeric; n int;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n from journal_lines where entry_id = new.entry_id;
  if d <> c then raise exception 'القيد غير متوازن: المدين % لا يساوي الدائن %', d, c; end if;
  if n < 2 then raise exception 'القيد يحتاج سطرين مؤثرين على الأقل'; end if;
  return null;
end $$;
create constraint trigger entry_balanced after insert or update on journal_lines
  deferrable initially deferred for each row execute function check_entry_balanced();

create function forbid_change() returns trigger language plpgsql as $$
begin raise exception 'القيود المرحّلة لا تُعدّل ولا تُحذف — التصحيح بقيد جديد'; end $$;
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function forbid_change();
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function forbid_change();

create table entry_sequences (company_id int primary key references companies(id), next int not null default 1);

create table drafts (
  id           serial primary key,
  company_id   int not null references companies(id),
  purpose      text not null default 'normal' check (purpose in ('normal','adjustment','opening')),
  date         date,
  description  text,
  reference    text,
  batch_id     int references adjustment_batches(id),
  equity_class text,
  source_entry_id   int references journal_entries(id),
  reverses_entry_id int references journal_entries(id),
  branch_id    int references branches(id),
  lines        jsonb not null default '[]',   -- [{account_id, description, debit:"1.00", credit:"0"}]
  status       text not null default 'draft' check (status in ('draft','posted','cancelled','deferred')),
  status_reason text,
  entry_id     int references journal_entries(id),
  version      int not null default 1,
  created_by   int not null, created_at timestamptz not null default now(),
  updated_by   int not null, updated_at timestamptz not null default now()
);

-- §18 attachments
create table attachments (
  id          serial primary key,
  company_id  int not null references companies(id),
  draft_id    int references drafts(id),
  entry_id    int references journal_entries(id),
  filename    text not null,
  mime        text not null check (mime in ('application/pdf','image/jpeg','image/png')),
  size        int not null check (size > 0 and size <= 10485760),
  sha256      text not null,
  storage_key text not null,
  uploaded_by int not null,
  uploaded_at timestamptz not null default now(),
  excluded_at timestamptz, excluded_by int, exclusion_reason text,
  check (draft_id is not null or entry_id is not null)
);

-- ============================================================ snapshots & closing (§24–25)
create table report_snapshots (
  id           serial primary key,
  company_id   int not null references companies(id),
  report_type  text not null check (report_type in ('trial_balance','income_statement','balance_sheet','equity_changes','worksheet','ledger')),
  params       jsonb not null,
  status       text not null check (status in ('frozen','approved')),
  year_id      int references fiscal_years(id),
  closing_run_id int,
  purpose      text,
  book_version bigint not null,
  last_entry_id int,
  profile_version text not null,
  content      jsonb not null,
  content_hash text not null,
  issued_by    int not null,
  issued_by_name text not null,
  issued_at    timestamptz not null default now()
);
create trigger report_snapshots_immutable before update or delete on report_snapshots for each row execute function forbid_change();

create table closing_runs (
  id           serial primary key,
  company_id   int not null references companies(id),
  year_id      int not null references fiscal_years(id),
  run_no       int not null,
  mode         text not null check (mode in ('preliminary','final')),
  kind         text not null check (kind in ('transfer','verify')),   -- verify = nothing to transfer
  book_version bigint not null,
  result_account_id int not null references accounts(id),
  entry_id     int references journal_entries(id),
  amount       numeric(20,2) not null default 0,
  reason       text not null,
  user_id      int not null,
  user_name    text not null,
  request_id   text,
  at           timestamptz not null default now(),
  unique (year_id, run_no),
  unique (company_id, request_id)
);

-- ============================================================ trader pack documents
create table items (
  id serial primary key, company_id int not null references companies(id),
  code text not null, name_ar text not null, name_en text, category text not null default 'عام',
  base_unit text not null default 'متر', vat_rate_bp int not null default 1500, reorder_level_milli bigint,
  total_qty_milli bigint not null default 0, stock_value bigint not null default 0,
  active boolean not null default true, created_at timestamptz not null default now(),
  unique (company_id, code)
);
create table item_units (
  id serial primary key, company_id int not null references companies(id),
  item_id int not null references items(id) on delete cascade, name text not null,
  factor_milli bigint not null check (factor_milli > 0), price bigint not null default 0,
  barcode text, is_default boolean not null default false, show_in_pos boolean not null default false,
  unique (company_id, barcode)
);
create table item_stock (
  company_id int not null references companies(id),
  item_id int not null references items(id), warehouse_id int not null references warehouses(id),
  branch_id int not null references branches(id), qty_milli bigint not null default 0,
  primary key (item_id, warehouse_id)
);
create table doc_sequences (company_id int not null references companies(id), kind text not null, next int not null default 1, primary key (company_id, kind));

create table invoices (
  id serial primary key, company_id int not null references companies(id),
  kind text not null check (kind in ('sale','sale_return','purchase','purchase_return')),
  number int not null, branch_id int not null references branches(id), date date not null,
  party_id int not null references parties(id), party_name text not null, party_phone text, party_vat text, party_address text,
  sales_rep_id int references sales_reps(id), cost_center_id int references cost_centers(id),
  payment_method text not null check (payment_method in ('cash','credit')), paid bigint not null default 0,
  ref text, notes text, original_invoice_id int references invoices(id),
  subtotal bigint not null, discount bigint not null, vat bigint not null, total bigint not null, cost_total bigint not null default 0,
  entry_id int references journal_entries(id),
  zatca_uuid uuid, zatca_icv int, zatca_pih text, zatca_hash text,
  zatca_type text check (zatca_type in ('simplified','standard')), zatca_status text not null default 'not_submitted', qr text,
  created_by int not null, created_by_name text not null,
  via text not null default 'web' check (via in ('web','ai','seed')),
  request_id text,
  created_at timestamptz not null default now(),
  unique (company_id, kind, number), unique (company_id, request_id)
);
create table invoice_lines (
  id bigserial primary key, company_id int not null references companies(id),
  invoice_id int not null references invoices(id), branch_id int not null references branches(id), line_no int not null,
  item_id int not null references items(id), item_code text not null, item_name text not null, unit_name text not null,
  factor_milli bigint not null, warehouse_id int not null references warehouses(id),
  qty_milli bigint not null check (qty_milli > 0), free_qty_milli bigint not null default 0,
  price bigint not null, discount_bp int not null default 0, discount bigint not null default 0, net bigint not null,
  vat_rate_bp int not null, vat bigint not null, total bigint not null, cost bigint not null default 0
);
create table vouchers (
  id serial primary key, company_id int not null references companies(id),
  kind text not null check (kind in ('receipt','payment')),
  number int not null, branch_id int not null references branches(id), date date not null,
  ref text, sales_rep_id int references sales_reps(id), cost_center_id int references cost_centers(id),
  counterparty text, method text check (method in ('cash','cheque')), cheque_no text, cheque_date date,
  about text, cash_account_id int references accounts(id), cash_memo text, notes text,
  total bigint not null, status text not null default 'posted' check (status in ('posted','voided')),
  entry_id int references journal_entries(id), void_entry_id int references journal_entries(id),
  created_by int not null, created_by_name text not null,
  via text not null default 'web' check (via in ('web','ai','seed')),
  request_id text,
  created_at timestamptz not null default now(),
  unique (company_id, kind, number), unique (company_id, request_id)
);
create table voucher_lines (
  id bigserial primary key, company_id int not null references companies(id),
  voucher_id int not null references vouchers(id), branch_id int not null references branches(id),
  account_id int not null references accounts(id), party_id int references parties(id),
  description text, amount bigint not null, cost_center_id int references cost_centers(id)
);
create table zatca_state (company_id int primary key references companies(id), icv int not null default 0, last_hash text not null);
create table invoice_shares (
  token_hash text primary key, company_id int not null references companies(id),
  invoice_id int not null references invoices(id), branch_id int not null references branches(id),
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table send_log (
  id bigserial primary key, company_id int not null references companies(id),
  invoice_id int not null references invoices(id), branch_id int not null references branches(id),
  channel text not null, recipient text not null, status text not null, user_name text not null, at timestamptz not null default now()
);

-- ============================================================ audit & AI state
create table audit_log (
  id         bigserial primary key,
  company_id int,
  at         timestamptz not null default now(),
  user_id    int,
  user_name  text not null,
  via        text not null,
  action     text not null,
  entity     text,
  entity_id  int,
  reason     text,
  before     jsonb,
  after      jsonb
);
create table access_log (
  id bigserial primary key, company_id int not null references companies(id), at timestamptz not null default now(),
  user_id int, user_name text, role text, via text, action text not null, ip text
);
create table ai_conversations (id text primary key, company_id int not null references companies(id), user_id int not null, messages jsonb not null default '[]', updated_at timestamptz not null default now());
create table ai_pending (id text primary key, company_id int not null references companies(id), user_id int not null, tool text not null, input jsonb not null, input_hash text not null, summary text not null, expires_at timestamptz not null);

-- ============================================================ row-level security
do $$
declare t text;
begin
  -- company-scoped tables: only the company in context is visible
  foreach t in array array['memberships','invitations','branches','cost_centers','sales_reps','accounts',
    'account_definitions','account_codes','fiscal_years','periods','period_events','review_cycles','adjustment_batches',
    'entry_sequences','drafts','attachments','report_snapshots','closing_runs','items','item_units',
    'doc_sequences','zatca_state','access_log','ai_conversations','ai_pending','ai_credit_ledger'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy company_only on %I using (company_id = ctx_company()) with check (company_id = ctx_company())', t);
  end loop;
  -- company + branch scoped tables
  foreach t in array array['journal_entries','journal_lines','warehouses','item_stock','invoices','invoice_lines','vouchers','voucher_lines','invoice_shares','send_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy company_branch on %I using (company_id = ctx_company() and branch_ok(branch_id)) with check (company_id = ctx_company() and branch_ok(branch_id))', t);
  end loop;
end $$;

-- customers/suppliers: shared ones (no branch) are visible to every member of the company
alter table parties enable row level security; alter table parties force row level security;
create policy company_party on parties using (company_id = ctx_company() and (branch_id is null or branch_ok(branch_id)))
  with check (company_id = ctx_company() and (branch_id is null or branch_ok(branch_id)));

-- companies: a session sees only the company in context (platform listings use a separate privileged path)
alter table companies enable row level security; alter table companies force row level security;
create policy company_self on companies using (id = ctx_company() or current_setting('app.platform', true) = 'on')
  with check (id = ctx_company() or current_setting('app.platform', true) = 'on');
-- memberships/invitations also need a platform view (company lists, invitation acceptance)
create policy platform_view on memberships using (current_setting('app.platform', true) = 'on') with check (current_setting('app.platform', true) = 'on');
create policy platform_view on invitations using (current_setting('app.platform', true) = 'on') with check (current_setting('app.platform', true) = 'on');
create policy platform_view on ai_credit_ledger using (current_setting('app.platform', true) = 'on') with check (current_setting('app.platform', true) = 'on');

-- audit log: a company sees its own rows; platform events (company_id null) only on the platform path
alter table audit_log enable row level security; alter table audit_log force row level security;
create policy company_audit on audit_log using (company_id = ctx_company() or current_setting('app.platform', true) = 'on')
  with check (company_id = ctx_company() or (company_id is null and current_setting('app.platform', true) = 'on') or current_setting('app.platform', true) = 'on');
-- branch names are shown in a person's company list (cross-company path)
create policy platform_view on branches using (current_setting('app.platform', true) = 'on');
