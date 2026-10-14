import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { Api } from '../core/api';
import { money, monthStart, today, viaLabel } from '../core/fmt';

// F5: find a saved document and open it.
@Component({
  selector: 'doc-search',
  template: `
  <div class="overlay" (click)="closed.emit()">
    <div class="dialog" style="width:min(900px,100%)" (click)="$event.stopPropagation()" (keydown.escape)="closed.emit(); $event.stopPropagation()">
      <header><span>بحث</span><button class="x" (click)="closed.emit()">✕</button></header>
      <div class="body">
        <div class="filters">
          <label>من</label><input class="inp num" type="date" [value]="from()" (change)="from.set($any($event.target).value); load()" />
          <label>إلى</label><input class="inp num" type="date" [value]="to()" (change)="to.set($any($event.target).value); load()" />
          <input class="inp" style="width:220px" placeholder="رقم أو اسم…" [value]="q()" (input)="q.set($any($event.target).value)" autofocus />
        </div>
        <div class="grid-wrap" style="max-height:55vh">
          <table class="grid">
            <thead><tr><th>الرقم</th><th>التاريخ</th><th>{{ type() === 'invoices' ? 'الطرف' : 'البيان' }}</th><th>الفرع</th><th class="n">المبلغ</th><th>أعدّه</th></tr></thead>
            <tbody>
              @for (r of filtered(); track r.id) {
                <tr class="click" (dblclick)="picked.emit(r.number)" (click)="picked.emit(r.number)">
                  <td class="num">{{ r.number }}</td><td class="num">{{ r.date }}</td>
                  <td>{{ r.party_name ?? r.counterparty ?? r.about }} @if (r.status === 'voided') { <span class="chip bad">ملغى</span> }</td>
                  <td>{{ r.branch_name }}</td><td class="n">{{ m(r.total) }}</td>
                  <td>{{ r.created_by_name }} @if (via(r.via)) { <span class="chip ai">{{ via(r.via) }}</span> }</td>
                </tr>
              } @empty { <tr><td colspan="6" class="muted">لا توجد مستندات في هذه الفترة</td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`,
})
export class DocSearch implements OnInit {
  type = input.required<'invoices' | 'vouchers'>();
  kind = input.required<string>();
  picked = output<number>();
  closed = output<void>();
  api = inject(Api);
  m = money;
  via = (v: string) => viaLabel[v];
  from = signal(monthStart()); to = signal(today()); q = signal('');
  rows = signal<any[]>([]);
  filtered = () => {
    const q = this.q().trim();
    return q ? this.rows().filter((r) => String(r.number) === q || (r.party_name ?? r.counterparty ?? r.about ?? '').includes(q)) : this.rows();
  };
  ngOnInit() { this.load(); }
  async load() { this.rows.set(await this.api.get(`/${this.type()}`, { kind: this.kind(), from: this.from(), to: this.to() })); }
}
