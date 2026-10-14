import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { Api, openBinary } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { Reauth } from '../core/reauth';
import { money, today } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { LedgerView, qs } from './books';

type StType = 'income_statement' | 'balance_sheet' | 'equity_changes';
const TITLE: Record<StType, string> = { income_statement: 'قائمة الدخل', balance_sheet: 'قائمة المركز المالي', equity_changes: 'قائمة التغيرات في حقوق الملكية' };
const CAT: [string, string][] = [['opening', 'الافتتاحي'], ['result', 'نتيجة الفترة'], ['contribution', 'مساهمات'], ['distribution', 'توزيعات/مسحوبات'], ['reserve_transfer', 'تحويل احتياطي'],
  ['prior_adjustment', 'تعديل سابق'], ['other', 'أخرى'], ['unclassified', 'غير مصنف'], ['closing_transfer', 'نقل الإقفال'], ['closing', 'الختامي']];

// §23–24: the three statements, each line drillable to its accounts and then to the ledger.
@Component({
  selector: 'statement-view', imports: [DatePipe],
  styles: [`.cmpbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .acc { padding-inline-start: 34px; color: var(--ink-2); font-size: 13px; cursor: pointer; }
    .acc:hover { background: var(--accent-soft); } .statement { max-width: 900px; } .statement.wide { max-width: none; } .row span.c { min-width: 150px; text-align: left; display: inline-block; }`],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>{{ title() }}</h2>
      <div class="filters">
        @if (type() !== 'balance_sheet') { <label>من</label><input class="inp num" type="date" [value]="from()" (change)="from.set($any($event.target).value); load()" /> }
        <label>{{ type() === 'balance_sheet' ? 'كما في' : 'إلى' }}</label><input class="inp num" type="date" [value]="to()" (change)="to.set($any($event.target).value); load()" />
        <button class="btn sm" (click)="exportCsv()">تصدير CSV</button>
        @if (auth.isOwner()) { <button class="btn sm" (click)="freeze(false)">حفظ نسخة مجمدة</button><button class="btn sm primary" (click)="freeze(true)">اعتماد داخلي</button> }
        <button class="btn sm" onclick="print()">طباعة</button>
      </div></div>
    <div class="cmpbar no-print">
      <label>المقارنة</label>
      <select class="inp" style="width:auto" (change)="cmpType.set($any($event.target).value); load()">
        <option value="">بدون</option><option value="historical">مقارنة تاريخية حية</option><option value="as_issued">كما صدرت (نسخة محفوظة)</option><option value="restated">إعادة عرض بتعريفات حديثة</option>
      </select>
      @if (cmpType() === 'as_issued') {
        <select class="inp" style="width:auto" (change)="snapId.set($any($event.target).value); load()"><option value="">اختر النسخة…</option>
          @for (s of snaps(); track s.id) { <option [value]="s.id">#{{ s.id }} — {{ s.params.from ?? '' }} {{ s.params.to }} — {{ s.status === 'approved' ? 'معتمدة' : 'مجمدة' }}</option> }</select>
      } @else if (cmpType()) {
        @if (type() !== 'balance_sheet') { <input class="inp num" type="date" style="width:auto" [value]="cFrom()" (change)="cFrom.set($any($event.target).value); load()" /> }
        <input class="inp num" type="date" style="width:auto" [value]="cTo()" (change)="cTo.set($any($event.target).value); load()" />
      }
    </div>
    @if (d(); as d) {
      @for (i of d.current.issues; track $index) {
        <div class="banner bad">{{ i.message }} @for (a of i.accounts ?? []; track a.code) { <span class="chip">{{ a.code }} {{ a.name }}: {{ m(+a.amount) }}</span> }</div>
      }
      @if (d.comparison; as c) { <div class="banner info">المقارنة: {{ c.label }}@if (c.snapshot_id) { — النسخة #{{ c.snapshot_id }} الصادرة {{ c.issued_at | date: 'yyyy-MM-dd HH:mm' }} } · إصدار العرض {{ c.profile_version }}
        @if (c.stale_reasons?.length) { <b> — تنبيه: {{ c.stale_reasons.join('؛ ') }}</b> }</div> }
      <div class="statement" [class.wide]="type() !== 'income_statement' && type() !== 'balance_sheet'">
        @if (type() === 'income_statement') {
          @for (l of d.current.lines; track l.id) {
            <div class="row" (click)="toggle(l.id)" style="cursor:pointer"><span>{{ l.name }}</span><span><span class="c">{{ m(+l.amount) }}</span>@if (cmp()) { <span class="c muted">{{ m(+cmpLine(l.id)) }}</span> }</span></div>
            @if (open().has(l.id)) { @for (a of l.accounts; track a.account_id) { <div class="row acc" (click)="ledger(a)"><span>{{ a.code }} — {{ a.name }}</span><span>{{ m(+a.amount) }}</span></div> } }
            @if (l.id === 28) { <div class="row total"><span>مجمل الربح</span><span><span class="c">{{ m(+d.current.totals.gross_profit) }}</span>@if (cmp()) { <span class="c">{{ m(+cmp().totals.gross_profit) }}</span> }</span></div> }
            @if (l.id === 34) { <div class="row total"><span>الربح التشغيلي</span><span><span class="c">{{ m(+d.current.totals.operating_profit) }}</span>@if (cmp()) { <span class="c">{{ m(+cmp().totals.operating_profit) }}</span> }</span></div> }
            @if (l.id === 35) { <div class="row total"><span>الربح قبل الضريبة والزكاة</span><span><span class="c">{{ m(+d.current.totals.profit_before_tax) }}</span>@if (cmp()) { <span class="c">{{ m(+cmp().totals.profit_before_tax) }}</span> }</span></div> }
          }
          <div class="row grand"><span>صافي النتيجة</span><span><span class="c">{{ m(+d.current.totals.net_result) }}</span>@if (cmp()) { <span class="c">{{ m(+cmp().totals.net_result) }}</span> }</span></div>
        } @else if (type() === 'balance_sheet') {
          @for (sec of bsSections; track sec[0]) {
            <h3>{{ sec[1] }}</h3>
            @for (l of d.current[sec[0]]; track l.id) {
              <div class="row sub" (click)="toggle(l.id)" style="cursor:pointer"><span>{{ l.name }}</span><span><span class="c">{{ m(+l.amount) }}</span>@if (cmp()) { <span class="c muted">{{ m(+cmpBs(sec[0], l.id)) }}</span> }</span></div>
              @if (open().has(l.id)) { @for (a of l.accounts; track a.account_id) { <div class="row acc" (click)="ledger(a)"><span>{{ a.code }} — {{ a.name }}</span><span>{{ m(+a.amount) }}</span></div> } }
            }
            <div class="row total"><span>إجمالي {{ sec[1] }}</span><span><span class="c">{{ m(+d.current.totals[sec[2]]) }}</span>@if (cmp()) { <span class="c">{{ m(+cmp().totals[sec[2]]) }}</span> }</span></div>
          }
          <div class="row grand"><span>الالتزامات وحقوق الملكية</span><span><span class="c">{{ m(+d.current.totals.liabilities_and_equity) }}</span></span></div>
        } @else {
          <div class="grid-wrap"><table class="grid">
            <thead><tr><th>المكوّن</th>@for (k of cat; track k[0]) { <th class="n">{{ k[1] }}</th> }</tr></thead>
            <tbody>@for (c of d.current.components; track c.id) { <tr><td>{{ c.name }}</td>@for (k of cat; track k[0]) { <td class="n" [class.neg]="k[0] === 'unclassified' && +c[k[0]]">{{ z(c[k[0]]) }}</td> }</tr> }</tbody>
            <tfoot><tr><td>الإجمالي</td>@for (k of cat; track k[0]) { <td class="n">{{ k[0] === 'closing' ? m(+d.current.totals.closing) : k[0] === 'closing_transfer' ? m(+d.current.totals.closing_transfer) : '' }}</td> }</tr></tfoot>
          </table></div>
          <div class="muted">نقل الإقفال داخل الحقوق مجموعه صفر: يزيد الأرباح المبقاة ويخفض النتيجة غير المحولة بالمبلغ نفسه.</div>
        }
      </div>
    }
  </div></div>`,
})
export class StatementView implements OnInit {
  tabId = input.required<number>(); type = input.required<StType>();
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); reauth = inject(Reauth); tabs = inject(Tabs);
  m = money; z = (s: string) => (+s ? money(+s) : ''); cat = CAT;
  bsSections: [string, string, string][] = [['assets', 'الأصول', 'assets'], ['liabilities', 'الالتزامات', 'liabilities'], ['equity', 'حقوق الملكية', 'equity']];
  title = computed(() => TITLE[this.type()]);
  from = signal(''); to = signal(today()); cmpType = signal(''); cFrom = signal(''); cTo = signal(''); snapId = signal('');
  d = signal<any>(null); snaps = signal<any[]>([]); open = signal(new Set<number | string>());
  cmp = computed(() => this.d()?.comparison?.data ?? null);
  cmpLine = (id: number) => this.cmp()?.lines?.find((l: any) => l.id === id)?.amount ?? 0;
  cmpBs = (sec: string, id: number | string) => this.cmp()?.[sec]?.find((l: any) => l.id === id)?.amount ?? 0;
  async ngOnInit() {
    if (!this.lk.fiscalYears().length) await this.lk.load();
    const y = this.lk.yearFor(today());
    this.from.set(y?.start_date ?? today().slice(0, 4) + '-01-01');
    const py = Number(today().slice(0, 4)) - 1;
    this.cFrom.set(`${py}-01-01`); this.cTo.set(`${py}-12-31`);
    this.snaps.set(await this.api.get('/snapshots', { report_type: this.type() }));
    this.load();
  }
  params() {
    const p: any = { to: this.to(), from: this.type() === 'balance_sheet' ? undefined : this.from() };
    if (this.cmpType() === 'as_issued' && this.snapId()) Object.assign(p, { compare_type: 'as_issued', snapshot_id: this.snapId() });
    else if (this.cmpType() && this.cmpType() !== 'as_issued') Object.assign(p, { compare_type: this.cmpType(), compare_to: this.cTo(), compare_from: this.type() === 'balance_sheet' ? undefined : this.cFrom() });
    return p;
  }
  async load() { this.d.set(await this.api.get(`/statements/${this.type()}`, this.params())); }
  toggle(id: number | string) { const s = new Set(this.open()); s.has(id) ? s.delete(id) : s.add(id); this.open.set(s); }
  ledger(a: any) { this.tabs.open(`led-${a.account_id}`, `أستاذ ${a.name}`, LedgerView, { accountId: a.account_id }); }
  exportCsv() { openBinary(this.api, `/export/${this.type()}?${qs(this.params())}`, `${this.type()}.csv`); }
  async freeze(approve: boolean) {
    const purpose = await this.ui.prompt(approve ? 'اعتماد داخلي' : 'حفظ نسخة مجمدة', approve ? 'الاعتماد الداخلي يحتاج قائمة بلا مشكلات وسنوات سابقة نهائية. لا يعني اعتماد مراجع خارجي.' : 'تحفظ النسخة القيم والتعريفات كما هي الآن.', 'الغرض', 'متابعة');
    if (purpose === null) return;
    let reauth: string | null = null;
    if (approve) { reauth = await this.reauth.token('snapshot.approve', 'اعتماد القائمة داخليًا'); if (!reauth) return; }
    const params = { to: this.to(), ...(this.type() === 'balance_sheet' ? {} : { from: this.from() }) };
    const s = await this.api.post('/snapshots', { report_type: this.type(), params, purpose, approve, reauth });
    this.ui.toast(`${approve ? 'اعتُمدت' : 'حُفظت'} النسخة رقم ${s.id}`, 'ok');
    this.snaps.set(await this.api.get('/snapshots', { report_type: this.type() }));
  }
}

// §24 saved copies: values and names as issued, with integrity and "changed since" warnings
@Component({
  selector: 'snapshots-view', imports: [DatePipe, JsonPipe],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>النسخ المحفوظة</h2></div>
    <div class="grid-wrap" style="max-height:40vh"><table class="grid">
      <thead><tr><th>#</th><th>التقرير</th><th>المدة</th><th>الحالة</th><th>الغرض</th><th>أصدرها</th><th>وقت الإصدار</th></tr></thead>
      <tbody>@for (s of rows(); track s.id) {
        <tr class="click" [class.sel]="cur()?.id === s.id" (click)="show(s.id)"><td class="num">{{ s.id }}</td><td>{{ s.label }}</td><td class="num">{{ s.params.from ?? '' }} {{ s.params.to }}</td>
          <td>@if (s.status === 'approved') { <span class="chip ok">معتمدة داخليًا</span> } @else { <span class="chip">مجمدة</span> }</td><td>{{ s.purpose }}</td><td>{{ s.issued_by_name }}</td><td class="num">{{ s.issued_at | date: 'yyyy-MM-dd HH:mm' }}</td></tr>
      } @empty { <tr><td colspan="7" class="muted">لا نسخ محفوظة بعد</td></tr> }</tbody>
    </table></div>
    @if (cur(); as s) {
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        @if (s.integrity_ok) { <span class="chip ok">سلامة المحتوى مطابقة</span> } @else { <span class="chip bad">المحتوى لا يطابق بصمته!</span> }
        <span class="chip">مرجع الدفتر {{ s.book_version }}</span><span class="chip">{{ s.profile_version }}</span>
      </div>
      @if (s.stale_reasons.length) { <div class="banner warn">النسخة صحيحة كما صدرت، لكنها قد لا تمثل الوضع الحالي: {{ s.stale_reasons.join('؛ ') }}</div> }
      <pre style="max-height:40vh;overflow:auto;background:var(--panel);border:1px solid var(--line);padding:10px;direction:ltr;text-align:left;font-size:12px">{{ s.content | json }}</pre>
    }
  </div></div>`,
})
export class SnapshotsView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api);
  rows = signal<any[]>([]); cur = signal<any>(null);
  async ngOnInit() { this.rows.set(await this.api.get('/snapshots')); }
  async show(id: number) { this.cur.set(await this.api.get(`/snapshots/${id}`)); }
}
