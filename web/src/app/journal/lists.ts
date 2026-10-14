import { Component, OnInit, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api, openBinary } from '../core/api';
import { money, monthStart, today, viaLabel } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { JournalForm } from './journal-form';

const PURPOSE: Record<string, string> = { normal: 'عادي', adjustment: 'تسوية', opening: 'افتتاح', closing: 'إقفال' };

// اليومية العامة (§19): search by number / text / reference, filter by date and purpose, open the entry.
@Component({
  selector: 'entries-list', imports: [DatePipe],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>اليومية العامة</h2>
      <div class="filters">
        <label>من</label><input class="inp num" type="date" [value]="from()" (change)="from.set($any($event.target).value); load()" />
        <label>إلى</label><input class="inp num" type="date" [value]="to()" (change)="to.set($any($event.target).value); load()" />
        <select class="inp" (change)="purpose.set($any($event.target).value); load()"><option value="">كل الأغراض</option>
          @for (k of keys; track k) { <option [value]="k">{{ P[k] }}</option> }</select>
        <input class="inp" placeholder="رقم أو بيان أو مرجع" (keydown.enter)="q.set($any($event.target).value); load()" />
        <button class="btn sm" (click)="exportCsv()">تصدير CSV</button>
      </div></div>
    <div class="grid-wrap" style="max-height:66vh"><table class="grid">
      <thead><tr><th>الرقم</th><th>التاريخ المحاسبي</th><th>الغرض</th><th>البيان</th><th>المرجع</th><th class="n">الإجمالي</th><th>رحّله</th><th>وقت التسجيل الفعلي</th></tr></thead>
      <tbody>@for (e of rows(); track e.id) {
        <tr class="click" (click)="open(e)"><td class="num">{{ e.number }}</td><td class="num">{{ e.date }}</td>
          <td><span class="chip" [class.bad]="e.purpose === 'closing'" [class.ok]="e.purpose === 'adjustment'">{{ P[e.purpose] }}</span></td>
          <td>{{ e.description }} @if (e.reverses_entry_id) { <span class="chip">عكس</span> }</td><td>{{ e.reference }}</td><td class="n">{{ m(+e.total) }}</td>
          <td>{{ e.posted_by_name }} @if (via(e.via)) { <span class="chip ai">{{ via(e.via) }}</span> }</td><td class="num muted">{{ e.created_at | date: 'yyyy-MM-dd HH:mm' }}</td></tr>
      } @empty { <tr><td colspan="8" class="muted">لا قيود في هذه الفترة</td></tr> }</tbody>
    </table></div>
  </div></div>`,
})
export class EntriesList implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); tabs = inject(Tabs);
  m = money; P = PURPOSE; keys = Object.keys(PURPOSE); via = (v: string) => viaLabel[v];
  from = signal(monthStart()); to = signal(today()); purpose = signal(''); q = signal(''); rows = signal<any[]>([]);
  ngOnInit() { this.load(); }
  async load() { this.rows.set(await this.api.get('/entries', { from: this.from(), to: this.to(), purpose: this.purpose(), q: this.q(), limit: 1000 })); }
  open(e: any) { this.tabs.open(`je-${e.number}`, `قيد ${e.number}`, JournalForm, { number: e.number }); }
  exportCsv() { openBinary(this.api, `/export/journal?${new URLSearchParams({ from: this.from(), to: this.to(), purpose: this.purpose(), q: this.q() })}`, 'journal.csv'); }
}

// المسودات (§16): work in progress with no financial effect.
@Component({
  selector: 'drafts-list', imports: [DatePipe],
  template: `
  <div class="win"><div class="win-body">
    <div class="report-head"><h2>المسودات</h2>
      <div class="filters"><select class="inp" (change)="status.set($any($event.target).value); load()">
        <option value="draft">قيد العمل</option><option value="deferred">مؤجلة</option><option value="cancelled">ملغاة</option><option value="posted">مرحّلة</option><option value="all">الكل</option></select>
        <button class="btn sm primary" (click)="newOne()">مسودة جديدة</button></div></div>
    <div class="banner info">المسودة لا تدخل الأستاذ أو الموازين أو القوائم حتى ترحيلها، ولو كانت متوازنة.</div>
    <div class="grid-wrap"><table class="grid">
      <thead><tr><th>#</th><th>التاريخ</th><th>الغرض</th><th>البيان</th><th>الحالة</th><th>آخر تعديل</th><th>القيد</th></tr></thead>
      <tbody>@for (d of rows(); track d.id) {
        <tr class="click" (click)="open(d)"><td class="num">{{ d.id }}</td><td class="num">{{ d.date ?? '—' }}</td><td>{{ P[d.purpose] }}</td><td>{{ d.description ?? '' }}</td>
          <td>{{ S[d.status] }} @if (d.status_reason) { <span class="muted">— {{ d.status_reason }}</span> }</td>
          <td class="muted">{{ d.updated_by_name }} {{ d.updated_at | date: 'MM-dd HH:mm' }}</td><td class="num">{{ d.entry_number ?? '' }}</td></tr>
      } @empty { <tr><td colspan="7" class="muted">لا مسودات</td></tr> }</tbody>
    </table></div>
  </div></div>`,
})
export class DraftsList implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); tabs = inject(Tabs);
  P = PURPOSE; S: Record<string, string> = { draft: 'قيد العمل', deferred: 'مؤجلة', cancelled: 'ملغاة', posted: 'مرحّلة' };
  status = signal('draft'); rows = signal<any[]>([]);
  ngOnInit() { this.load(); }
  async load() { this.rows.set(await this.api.get('/drafts', { status: this.status() })); }
  open(d: any) { this.tabs.open(`dr-${d.id}`, `مسودة ${d.id}`, JournalForm, { draftId: d.id }); }
  newOne() { this.tabs.open(`je-new-${Date.now()}`, 'سند قيد', JournalForm, {}); }
}
