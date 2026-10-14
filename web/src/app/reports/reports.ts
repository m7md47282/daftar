import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { money, qty, yearStart, monthStart, today, viaLabel } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { ReportFilters } from './filters';
import { PartyStatement } from '../books/books';
import { ItemPicker } from '../docs/pickers';
import { openDoc } from './open-doc';

// تقرير القيمة المضافة
@Component({
  selector: 'vat-report', imports: [ReportFilters],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>تقرير ضريبة القيمة المضافة</h2>
      <report-filters [(from)]="from" [(to)]="to" [(branch)]="branch" (changed)="load()" /></div>
    @if (d(); as d) {
      <div class="kpis">
        <div class="kpi"><div class="l">ضريبة المخرجات (المبيعات)</div><div class="v">{{ m(d.output_vat) }}</div></div>
        <div class="kpi"><div class="l">ضريبة المدخلات (المشتريات)</div><div class="v">{{ m(d.input_vat) }}</div></div>
        <div class="kpi"><div class="l">{{ d.net_vat_due >= 0 ? 'صافي الضريبة المستحقة للهيئة' : 'رصيد دائن لدى الهيئة' }}</div><div class="v">{{ m(d.net_vat_due) }}</div></div>
      </div>
      <div class="grid-wrap"><table class="grid">
        <thead><tr><th>البند</th><th class="n">عدد الفواتير</th><th class="n">المبلغ الخاضع للضريبة</th><th class="n">مبلغ الضريبة</th></tr></thead>
        <tbody>
          <tr><td>المبيعات الخاضعة للنسبة الأساسية</td><td class="n">{{ d.sales.count }}</td><td class="n">{{ m(d.sales.taxable) }}</td><td class="n">{{ m(d.sales.vat) }}</td></tr>
          <tr><td>مردودات المبيعات (إشعارات دائنة)</td><td class="n">{{ d.sales_returns.count }}</td><td class="n">({{ m(d.sales_returns.taxable) }})</td><td class="n">({{ m(d.sales_returns.vat) }})</td></tr>
          <tr><td>المشتريات الخاضعة للنسبة الأساسية</td><td class="n">{{ d.purchases.count }}</td><td class="n">{{ m(d.purchases.taxable) }}</td><td class="n">{{ m(d.purchases.vat) }}</td></tr>
          <tr><td>مردودات المشتريات</td><td class="n">{{ d.purchase_returns.count }}</td><td class="n">({{ m(d.purchase_returns.taxable) }})</td><td class="n">({{ m(d.purchase_returns.vat) }})</td></tr>
        </tbody>
      </table></div>
      <div class="banner info">الأرقام مطابقة لنموذج إقرار ضريبة القيمة المضافة. الربط المباشر مع هيئة الزكاة والضريبة والجمارك (فاتورة) سيُفعّل لاحقاً.</div>
    }
  </div></div>`,
})
export class VatReport implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); m = money;
  from = signal(today().slice(0, 5) + String(Math.floor((+today().slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, '0') + '-01'); to = signal(today()); branch = signal<number | null>(null); d = signal<any>(null);
  ngOnInit() { this.load(); }
  async load() { this.d.set(await this.api.get('/reports/vat', { from: this.from(), to: this.to(), branch_id: this.branch() })); }
}

// أرصدة المخزون
@Component({
  selector: 'stock-report', imports: [ReportFilters],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>أرصدة المخزون</h2>
      <report-filters [showFrom]="false" [(to)]="to" [(branch)]="branch" (changed)="load()">
        <input class="inp" placeholder="بحث صنف" (change)="q.set($any($event.target).value); load()" />
        <label><input type="checkbox" (change)="low.set($any($event.target).checked)" /> تحت حد الطلب فقط</label>
      </report-filters></div>
    @if (d(); as d) {
      <div class="grid-wrap" style="max-height:64vh"><table class="grid">
        <thead><tr><th>رقم الصنف</th><th>الصنف</th><th>التصنيف</th><th>المستودع</th><th class="n">الكمية</th><th>الوحدة</th><th class="n">متوسط التكلفة</th><th class="n">القيمة</th></tr></thead>
        <tbody>
          @for (l of lines(); track $index) {
            <tr><td class="num">{{ l.code }}</td><td>{{ l.name }} @if (l.below_reorder) { <span class="chip bad">تحت حد الطلب</span> }</td><td class="muted">{{ l.category }}</td>
              <td>{{ l.warehouse_name }}</td><td class="n">{{ q2(l.qty) }}</td><td>{{ l.unit }}</td><td class="n">{{ m(l.avg_cost) }}</td><td class="n">{{ m(l.value) }}</td></tr>
          }
        </tbody>
        <tfoot><tr><td colspan="7">إجمالي قيمة المخزون</td><td class="n">{{ m(d.total_value) }}</td></tr></tfoot>
      </table></div>
    }
  </div></div>`,
})
export class StockReport implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); m = money; q2 = qty;
  to = signal(today()); branch = signal<number | null>(null); q = signal(''); low = signal(false); d = signal<any>(null);
  lines = computed(() => (this.d()?.lines ?? []).filter((l: any) => !this.low() || l.below_reorder));
  ngOnInit() { this.load(); }
  async load() { this.d.set(await this.api.get('/reports/stock', { branch_id: this.branch(), q: this.q() })); }
}

// حركة صنف
@Component({
  selector: 'item-movement', imports: [ReportFilters, ItemPicker],
  styles: [`item-picker input { height: 32px; border: 1px solid var(--line); border-radius: 3px; padding: 0 8px; width: 280px; }`],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><div style="display:flex;gap:10px;align-items:center"><h2>حركة صنف</h2><item-picker [text]="item()?.name_ar ?? ''" (picked)="item.set($event); load()" placeholder="اختر الصنف…" /></div>
      <report-filters [(from)]="from" [(to)]="to" [(branch)]="branch" (changed)="load()" /></div>
    <div class="grid-wrap" style="max-height:64vh"><table class="grid">
      <thead><tr><th>التاريخ</th><th>المستند</th><th>الطرف</th><th>المستودع</th><th>الوحدة</th><th class="n">الكمية</th><th class="n">السعر</th><th class="n">وارد ({{ item()?.base_unit ?? 'متر' }})</th><th class="n">صادر</th></tr></thead>
      <tbody>
        @for (r of rows(); track $index) {
          <tr><td class="num">{{ r.date }}</td><td>{{ r.doc }}</td><td>{{ r.party }}</td><td>{{ r.warehouse }}</td><td>{{ r.unit }}</td><td class="n">{{ q2(r.qty) }}</td><td class="n">{{ m(r.price) }}</td>
            <td class="n pos">{{ r.in ? q2(r.in) : '' }}</td><td class="n neg">{{ r.out ? q2(r.out) : '' }}</td></tr>
        } @empty { <tr><td colspan="9" class="muted">اختر صنفاً</td></tr> }
      </tbody>
    </table></div>
  </div></div>`,
})
export class ItemMovement {
  tabId = input.required<number>();
  api = inject(Api); m = money; q2 = qty;
  item = signal<any>(null); from = signal(yearStart()); to = signal(today()); branch = signal<number | null>(null); rows = signal<any[]>([]);
  async load() { if (this.item()) this.rows.set(await this.api.get('/reports/item-movement', { item_id: this.item().id, from: this.from(), to: this.to(), branch_id: this.branch() })); }
}

const DOC_TITLES: Record<string, string> = { sale: 'تقارير المبيعات', sale_return: 'تقارير مردودات المبيعات', purchase: 'تقارير المشتريات', purchase_return: 'تقارير مردودات المشتريات' };
// تقارير المبيعات / المشتريات / المردودات
@Component({
  selector: 'doc-list', imports: [ReportFilters],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>{{ T[kind()] }}</h2><report-filters [(from)]="from" [(to)]="to" [(branch)]="branch" (changed)="load()" /></div>
    <div class="kpis">
      <div class="kpi"><div class="l">عدد الفواتير</div><div class="v">{{ rows().length }}</div></div>
      <div class="kpi"><div class="l">الصافي قبل الضريبة</div><div class="v">{{ m(sum('net')) }}</div></div>
      <div class="kpi"><div class="l">الضريبة</div><div class="v">{{ m(sum('vat')) }}</div></div>
      <div class="kpi"><div class="l">الإجمالي</div><div class="v">{{ m(sum('total')) }}</div></div>
      @if (kind() === 'sale' && sum('cost_total')) { <div class="kpi"><div class="l">مجمل الربح</div><div class="v">{{ m(sum('net') - sum('cost_total')) }}</div></div> }
    </div>
    <div class="grid-wrap" style="max-height:56vh"><table class="grid">
      <thead><tr><th>الرقم</th><th>التاريخ</th><th>الطرف</th><th>الفرع</th><th>الدفع</th><th class="n">الصافي</th><th class="n">الضريبة</th><th class="n">الإجمالي</th><th class="n">المتبقي</th><th>أعدّها</th></tr></thead>
      <tbody>
        @for (r of rows(); track r.id) {
          <tr class="click" (dblclick)="open(r)"><td class="num"><a (click)="open(r)">{{ r.number }}</a></td><td class="num">{{ r.date }}</td><td>{{ r.party_name }}</td><td class="muted">{{ r.branch_name }}</td>
            <td>{{ r.payment_method === 'cash' ? 'نقد' : 'آجل' }}</td><td class="n">{{ m(r.net) }}</td><td class="n">{{ m(r.vat) }}</td><td class="n">{{ m(r.total) }}</td>
            <td class="n">{{ r.remaining ? m(r.remaining) : '' }}</td><td>{{ r.created_by_name }} @if (via(r.via)) { <span class="chip ai">{{ via(r.via) }}</span> }</td></tr>
        }
      </tbody>
    </table></div>
  </div></div>`,
})
export class DocList implements OnInit {
  tabId = input.required<number>(); kind = input.required<string>();
  api = inject(Api); tabs = inject(Tabs); m = money; T = DOC_TITLES;
  via = (v: string) => viaLabel[v];
  from = signal(monthStart()); to = signal(today()); branch = signal<number | null>(null); rows = signal<any[]>([]);
  sum = (k: string) => Math.round(this.rows().reduce((s, r) => s + r[k] * 100, 0)) / 100;
  ngOnInit() { this.load(); }
  async load() { this.rows.set(await this.api.get('/invoices', { kind: this.kind(), from: this.from(), to: this.to(), branch_id: this.branch() })); }
  open(r: any) { openDoc(this.tabs, 'invoice', r.kind, r.number); }
}

// أرصدة العملاء / الموردين
@Component({
  selector: 'party-balances',
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>{{ kind() === 'customer' ? 'أرصدة العملاء' : 'أرصدة الموردين' }}</h2>
      <div class="filters"><label><input type="checkbox" checked (change)="nz.set($any($event.target).checked)" /> إخفاء الأرصدة الصفرية</label><button class="btn sm" onclick="print()">طباعة</button></div></div>
    <div class="grid-wrap" style="max-height:64vh"><table class="grid">
      <thead><tr><th>رقم الحساب</th><th>الاسم</th><th>الجوال</th><th>الرقم الضريبي</th><th class="n">{{ kind() === 'customer' ? 'مستحق لنا' : 'مستحق علينا' }}</th></tr></thead>
      <tbody>
        @for (p of shown(); track p.id) {
          <tr class="click" (dblclick)="stmt(p)"><td class="num">{{ p.id }}</td><td>{{ p.name }}</td><td class="num">{{ p.phone }}</td><td class="num">{{ p.vat_number }}</td>
            <td class="n">{{ m(kind() === 'customer' ? +p.balance : -p.balance) }}</td></tr>
        }
      </tbody>
      <tfoot><tr><td colspan="4">الإجمالي</td><td class="n">{{ m(total()) }}</td></tr></tfoot>
    </table></div>
  </div></div>`,
})
export class PartyBalances implements OnInit {
  tabId = input.required<number>(); kind = input.required<'customer' | 'supplier'>();
  api = inject(Api); tabs = inject(Tabs); m = money;
  rows = signal<any[]>([]); nz = signal(true);
  shown = computed(() => this.rows().filter((p) => !this.nz() || Math.abs(+p.balance) > 0.001));
  total = computed(() => Math.round(this.shown().reduce((s, p) => s + (this.kind() === 'customer' ? +p.balance : -p.balance) * 100, 0)) / 100);
  async ngOnInit() { this.rows.set(await this.api.get('/parties', { kind: this.kind() })); }
  stmt(p: any) { this.tabs.open(`pstmt-${p.id}`, `كشف حساب ${p.name}`, PartyStatement, { kind: this.kind(), partyId: p.id, partyName: p.name }); }
}
