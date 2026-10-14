import { Component, inject, input, model, output } from '@angular/core';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';

// Shared period/branch filter bar. The branch filter only shows for the owner;
// an accountant's reports are limited to their branch by the server.
@Component({
  selector: 'report-filters',
  template: `
  <div class="filters">
    @if (showFrom()) { <label>من</label><input class="inp num" type="date" [value]="from()" (change)="from.set($any($event.target).value); changed.emit()" /> }
    <label>{{ showFrom() ? 'إلى' : 'حتى تاريخ' }}</label><input class="inp num" type="date" [value]="to()" (change)="to.set($any($event.target).value); changed.emit()" />
    @if (auth.isOwner()) {
      <label>الفرع</label>
      <select class="inp" (change)="branch.set($any($event.target).value ? +$any($event.target).value : null); changed.emit()">
        <option value="">جميع الفروع</option>
        @for (b of lk.branches(); track b.id) { <option [value]="b.id" [selected]="b.id === branch()">{{ b.name }}</option> }
      </select>
    }
    <ng-content />
    <button class="btn sm" (click)="print()">طباعة</button>
  </div>`,
})
export class ReportFilters {
  auth = inject(Auth); lk = inject(Lookups);
  from = model(''); to = model(''); branch = model<number | null>(null);
  showFrom = input(true);
  changed = output<void>();
  constructor() { if (!this.lk.branches().length) this.lk.load(); }
  print() { window.print(); }
}
