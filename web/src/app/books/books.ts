import { Component, OnInit, computed, inject, input, model, output, signal } from '@angular/core';
import { Api, openBinary } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { money, today } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { AccountPicker, PartyPicker } from '../docs/pickers';
import { JournalForm } from '../journal/journal-form';

export const MODES: [string, string][] = [['raw', 'الدفتر الخام'], ['before_adjustments', 'قبل التسويات'], ['adjustments_only', 'التسويات فقط'], ['after_adjustments', 'بعد التسويات وقبل الإقفال'], ['after_close', 'بعد الإقفال']];
const yStart = (lk: Lookups) => lk.yearFor(today())?.start_date ?? today().slice(0, 4) + '-01-01';

// Shared filter bar: period, mode (§21.3), review cycle, branch (owner), and actions.
@Component({
  selector: 'book-filters',
  template: `
  <div class="filters">
    <label>من</label><input class="inp num" type="date" [value]="from()" (change)="from.set($any($event.target).value); changed.emit()" />
    <label>إلى</label><input class="inp num" type="date" [value]="to()" (change)="to.set($any($event.target).value); changed.emit()" />
    @if (showMode()) {
      <select class="inp" (change)="mode.set($any($event.target).value); changed.emit()">
        @for (m of modes; track m[0]) { <option [value]="m[0]" [selected]="m[0] === mode()">{{ m[1] }}</option> }
      </select>
    }
    @if (showCycle()) {
      <select class="inp" (change)="cycle.set(+$any($event.target).value || null); changed.emit()">
        <option value="">كل دورات المراجعة</option>
        @for (c of cycles(); track c.id) { <option [value]="c.id" [selected]="c.id === cycle()">{{ c.name }}</option> }
      </select>
    }
    @if (auth.isOwner() && lk.branches().length > 1) {
      <select class="inp" (change)="branch.set(+$any($event.target).value || null); changed.emit()">
        <option value="">جميع الفروع</option>
        @for (b of lk.branches(); track b.id) { <option [value]="b.id" [selected]="b.id === branch()">{{ b.name }}</option> }
      </select>
    }
    <ng-content />
    <button class="btn sm" (click)="print()">طباعة</button>
  </div>`,
})
export class BookFilters implements OnInit {
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups);
  from = model(''); to = model(''); mode = model('raw'); cycle = model<number | null>(null); branch = model<number | null>(null);
  showMode = input(true); showCycle = input(true);
  changed = output<void>();
  modes = MODES; cycles = signal<any[]>([]);
  async ngOnInit() { if (!this.lk.branches().length) await this.lk.load(); if (this.showCycle()) this.cycles.set(await this.api.get('/review')); }
  print() { window.print(); }
}

function qs(o: Record<string, unknown>) { return new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString(); }

// دفتر الأستاذ / كشف حساب (§20)
@Component({
  selector: 'ledger-view', imports: [AccountPicker, BookFilters],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head">
      <div style="display:flex;gap:10px;align-items:center"><h2>دفتر الأستاذ</h2><div style="width:340px"><account-picker [value]="account()" (picked)="account.set($event); load()" /></div></div>
      <book-filters [(from)]="from" [(to)]="to" [(mode)]="mode" [(cycle)]="cycle" [(branch)]="branch" (changed)="load()">
        <button class="btn sm" (click)="exportCsv()" [disabled]="!d()">تصدير CSV</button></book-filters>
    </div>
    @if (d(); as d) {
      @if (d.finality?.warning) { <div class="banner warn">{{ d.finality.warning }}</div> }
      <div class="kpis">
        <div class="kpi"><div class="l">رصيد قبل المدة</div><div class="v">{{ m(+d.opening) }}</div><div class="s">{{ d.opening_side }}</div></div>
        <div class="kpi"><div class="l">حركة المدين</div><div class="v">{{ m(+d.total_debit) }}</div></div>
        <div class="kpi"><div class="l">حركة الدائن</div><div class="v">{{ m(+d.total_credit) }}</div></div>
        <div class="kpi"><div class="l">رصيد النهاية</div><div class="v">{{ m(+d.closing) }}</div><div class="s">{{ d.closing_side }}</div></div>
      </div>
      <div class="grid-wrap" style="max-height:54vh"><table class="grid">
        <thead><tr><th>التاريخ</th><th>رقم القيد</th><th>البيان</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">الرصيد</th><th></th></tr></thead>
        <tbody>
          <tr><td></td><td></td><td class="muted">رصيد قبل المدة</td><td></td><td></td><td class="n">{{ m(+d.opening) }}</td><td>{{ d.opening_side }}</td></tr>
          @for (l of d.lines; track $index) {
            <tr class="click" (click)="open(l.number)"><td class="num">{{ l.date }}</td><td class="num"><a>{{ l.number }}</a></td><td>{{ l.description }} @if (l.party_name) { <span class="muted">— {{ l.party_name }}</span> }</td>
              <td class="n">{{ +l.debit ? m(+l.debit) : '' }}</td><td class="n">{{ +l.credit ? m(+l.credit) : '' }}</td><td class="n">{{ m(+l.balance) }}</td><td>{{ l.balance_side }}</td></tr>
          }
        </tbody>
        <tfoot><tr><td colspan="3">الإجمالي</td><td class="n">{{ m(+d.total_debit) }}</td><td class="n">{{ m(+d.total_credit) }}</td><td class="n">{{ m(+d.closing) }}</td><td>{{ d.closing_side }}</td></tr></tfoot>
      </table></div>
    } @else { <div class="banner info">اختر حسابًا قابلًا للترحيل لعرض حركته. تجميعات الحسابات تظهر في ميزان المراجعة.</div> }
  </div></div>`,
})
export class LedgerView implements OnInit {
  tabId = input.required<number>(); accountId = input<number | null>(null);
  api = inject(Api); lk = inject(Lookups); tabs = inject(Tabs); m = money;
  account = signal<any>(null); from = signal(''); to = signal(today()); mode = signal('raw'); cycle = signal<number | null>(null); branch = signal<number | null>(null);
  d = signal<any>(null);
  async ngOnInit() { if (!this.lk.fiscalYears().length) await this.lk.load(); this.from.set(yStart(this.lk)); if (this.accountId()) this.load(this.accountId()!); }
  params(id?: number) { return { account_id: id ?? this.account()?.id, from: this.from(), to: this.to(), mode: this.mode(), cycle_id: this.cycle(), branch_id: this.branch() }; }
  async load(id?: number) {
    if (!(id ?? this.account()?.id)) return;
    const d = await this.api.get('/books/ledger', this.params(id)); this.d.set(d); this.account.set(d.account);
  }
  open(n: number) { this.tabs.open(`je-${n}`, `قيد ${n}`, JournalForm, { number: n }); }
  exportCsv() { openBinary(this.api, `/export/ledger?${qs(this.params())}`, 'ledger.csv'); }
}

// كشف حساب عميل أو مورد (subsidiary ledger)
@Component({
  selector: 'party-statement', imports: [PartyPicker],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head">
      <div style="display:flex;gap:10px;align-items:center"><h2>كشف حساب {{ kind() === 'supplier' ? 'مورد' : 'عميل' }}</h2>
        <div style="width:300px"><party-picker [kind]="kind()" [value]="party()" (valueChange)="party.set($event); load()" /></div></div>
      <div class="filters"><label>من</label><input class="inp num" type="date" [value]="from()" (change)="from.set($any($event.target).value); load()" />
        <label>إلى</label><input class="inp num" type="date" [value]="to()" (change)="to.set($any($event.target).value); load()" /><button class="btn sm" onclick="print()">طباعة</button></div>
    </div>
    @if (d(); as d) {
      <div class="kpis"><div class="kpi"><div class="l">الرصيد الافتتاحي</div><div class="v">{{ m(+d.opening) }}</div></div><div class="kpi"><div class="l">مدين</div><div class="v">{{ m(+d.total_debit) }}</div></div>
        <div class="kpi"><div class="l">دائن</div><div class="v">{{ m(+d.total_credit) }}</div></div><div class="kpi"><div class="l">الرصيد الختامي</div><div class="v">{{ m(+d.closing) }}</div></div></div>
      <div class="grid-wrap" style="max-height:56vh"><table class="grid">
        <thead><tr><th>التاريخ</th><th>القيد</th><th>البيان</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">الرصيد</th></tr></thead>
        <tbody>@for (l of d.lines; track $index) {
          <tr class="click" (click)="open(l.number)"><td class="num">{{ l.date }}</td><td class="num">{{ l.number }}</td><td>{{ l.description }}</td>
            <td class="n">{{ +l.debit ? m(+l.debit) : '' }}</td><td class="n">{{ +l.credit ? m(+l.credit) : '' }}</td><td class="n">{{ m(+l.balance) }}</td></tr>
        }</tbody>
      </table></div>
    } @else { <div class="banner info">اختر {{ kind() === 'supplier' ? 'المورد' : 'العميل' }}.</div> }
  </div></div>`,
})
export class PartyStatement implements OnInit {
  tabId = input.required<number>(); kind = input<'customer' | 'supplier'>('customer'); partyId = input<number | null>(null); partyName = input('');
  api = inject(Api); lk = inject(Lookups); tabs = inject(Tabs); m = money;
  party = signal<any>(null); from = signal(''); to = signal(today()); d = signal<any>(null);
  async ngOnInit() {
    if (!this.lk.fiscalYears().length) await this.lk.load();
    this.from.set(yStart(this.lk));
    if (this.partyId()) { this.party.set({ id: this.partyId(), name: this.partyName() }); this.load(); }
  }
  async load() { if (this.party()?.id) this.d.set(await this.api.get('/books/party-statement', { party_id: this.party().id, from: this.from(), to: this.to() })); }
  open(n: number) { this.tabs.open(`je-${n}`, `قيد ${n}`, JournalForm, { number: n }); }
}

// ميزان المراجعة (§21)
@Component({
  selector: 'tb-view', imports: [BookFilters],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>ميزان المراجعة</h2>
      <book-filters [(from)]="from" [(to)]="to" [(mode)]="mode" [(cycle)]="cycle" [(branch)]="branch" (changed)="load()">
        <label><input type="checkbox" [checked]="leaves()" (change)="leaves.set($any($event.target).checked)" /> الحسابات الفرعية فقط</label>
        <button class="btn sm" (click)="exportCsv()">تصدير CSV</button>
        @if (auth.isOwner()) { <button class="btn sm" (click)="freeze()">حفظ نسخة مجمدة</button> }
      </book-filters></div>
    @if (d(); as d) {
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span class="chip">{{ d.mode_label }}</span>@if (d.year) { <span class="chip">{{ d.year.name }}</span> }
        @if (d.balanced) { <span class="chip ok">متوازن</span> } @else { <span class="chip bad">غير متوازن</span> }
      </div>
      @if (d.finality?.warning) { <div class="banner warn">{{ d.finality.warning }}</div> }
      <div class="grid-wrap" style="max-height:62vh"><table class="grid">
        <thead>
          <tr><th rowspan="2">رقم الحساب</th><th rowspan="2">اسم الحساب</th><th colspan="2" style="text-align:center">افتتاحي</th><th colspan="2" style="text-align:center">حركة الفترة</th><th colspan="2" style="text-align:center">ختامي</th></tr>
          <tr><th class="n">مدين</th><th class="n">دائن</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">مدين</th><th class="n">دائن</th></tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.account_id) {
            <tr [class.group]="r.is_group" [class.lvl0]="r.level === 0" [class.click]="!r.is_group" (dblclick)="!r.is_group && ledger(r)">
              <td class="num">{{ r.code }}</td><td [style.padding-inline-start.px]="8 + r.level * 14">{{ r.name }}</td>
              <td class="n">{{ z(r.opening_debit) }}</td><td class="n">{{ z(r.opening_credit) }}</td><td class="n">{{ z(r.debit) }}</td><td class="n">{{ z(r.credit) }}</td>
              <td class="n">{{ z(r.closing_debit) }}</td><td class="n">{{ z(r.closing_credit) }}</td></tr>
          }
        </tbody>
        <tfoot><tr><td colspan="2">الإجمالي من الحسابات النهائية</td>
          <td class="n">{{ m(+d.totals.opening_debit) }}</td><td class="n">{{ m(+d.totals.opening_credit) }}</td><td class="n">{{ m(+d.totals.debit) }}</td><td class="n">{{ m(+d.totals.credit) }}</td>
          <td class="n">{{ m(+d.totals.closing_debit) }}</td><td class="n">{{ m(+d.totals.closing_credit) }}</td></tr></tfoot>
      </table></div>
    }
  </div></div>`,
})
export class TrialBalanceView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); tabs = inject(Tabs); m = money;
  z = (s: string) => (+s ? money(+s) : '');
  from = signal(''); to = signal(today()); mode = signal('after_adjustments'); cycle = signal<number | null>(null); branch = signal<number | null>(null); leaves = signal(false);
  d = signal<any>(null);
  rows = computed(() => (this.d()?.rows ?? []).filter((r: any) => !this.leaves() || !r.is_group));
  async ngOnInit() { if (!this.lk.fiscalYears().length) await this.lk.load(); this.from.set(yStart(this.lk)); this.load(); }
  params() { return { from: this.from(), to: this.to(), mode: this.mode(), cycle_id: this.cycle(), branch_id: this.branch() }; }
  async load() { this.d.set(await this.api.get('/books/trial-balance', this.params())); }
  ledger(r: any) { this.tabs.open(`led-${r.account_id}`, `أستاذ ${r.name}`, LedgerView, { accountId: r.account_id }); }
  exportCsv() { openBinary(this.api, `/export/trial_balance?${qs(this.params())}`, 'trial-balance.csv'); }
  async freeze() {
    const purpose = await this.ui.prompt('حفظ نسخة مجمدة', 'تحفظ النسخة القيم والأسماء كما هي الآن، ولا تتغير بصمت عند تسجيل تسوية لاحقة.', 'الغرض (مثل: تسليم للمراجع)', 'حفظ');
    if (purpose === null) return;
    const s = await this.api.post('/snapshots', { report_type: 'trial_balance', params: this.params(), purpose });
    this.ui.toast(`حُفظت النسخة رقم ${s.id}`, 'ok');
  }
}

// ورقة التسويات (§22.3)
@Component({
  selector: 'worksheet-view', imports: [BookFilters],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>ورقة التسويات</h2>
      <book-filters [showMode]="false" [(from)]="from" [(to)]="to" [(cycle)]="cycle" [(branch)]="branch" (changed)="load()">
        <button class="btn sm" (click)="exportCsv()">تصدير CSV</button></book-filters></div>
    <div class="banner info">الرصيد بعد التسوية = الرصيد قبلها + مدين التسويات − دائنها، مع انتقال جهة الرصيد عند الحاجة. تسويات ما قبل بداية المدة تبقى في الرصيد قبل التسوية.</div>
    @if (d(); as d) {
      <div class="grid-wrap" style="max-height:60vh"><table class="grid">
        <thead><tr><th rowspan="2">الرمز</th><th rowspan="2">الحساب</th><th colspan="2" style="text-align:center">قبل التسوية</th><th colspan="2" style="text-align:center">التسويات</th><th colspan="2" style="text-align:center">بعد التسوية</th></tr>
          <tr><th class="n">مدين</th><th class="n">دائن</th><th class="n">مدين</th><th class="n">دائن</th><th class="n">مدين</th><th class="n">دائن</th></tr></thead>
        <tbody>@for (r of d.rows; track r.account_id) {
          <tr [class.sel]="r.changed"><td class="num">{{ r.code }}</td><td>{{ r.name }}</td><td class="n">{{ z(r.before.debit) }}</td><td class="n">{{ z(r.before.credit) }}</td>
            <td class="n">{{ z(r.adjustments.debit) }}</td><td class="n">{{ z(r.adjustments.credit) }}</td><td class="n">{{ z(r.after.debit) }}</td><td class="n">{{ z(r.after.credit) }}</td></tr>
        }</tbody>
        <tfoot><tr><td colspan="2">الإجمالي</td><td class="n">{{ m(+d.totals.before.debit) }}</td><td class="n">{{ m(+d.totals.before.credit) }}</td><td class="n">{{ m(+d.totals.adjustments.debit) }}</td>
          <td class="n">{{ m(+d.totals.adjustments.credit) }}</td><td class="n">{{ m(+d.totals.after.debit) }}</td><td class="n">{{ m(+d.totals.after.credit) }}</td></tr></tfoot>
      </table></div>
    }
  </div></div>`,
})
export class WorksheetView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); lk = inject(Lookups); m = money; z = (s: string) => (+s ? money(+s) : '');
  from = signal(''); to = signal(today()); cycle = signal<number | null>(null); branch = signal<number | null>(null); d = signal<any>(null);
  async ngOnInit() { if (!this.lk.fiscalYears().length) await this.lk.load(); this.from.set(yStart(this.lk)); this.load(); }
  params() { return { from: this.from(), to: this.to(), cycle_id: this.cycle(), branch_id: this.branch() }; }
  async load() { this.d.set(await this.api.get('/books/worksheet', this.params())); }
  exportCsv() { openBinary(this.api, `/export/worksheet?${qs(this.params())}`, 'worksheet.csv'); }
}
export { qs };
