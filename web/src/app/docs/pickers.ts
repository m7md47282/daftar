import { Component, effect, inject, input, model, output, signal } from '@angular/core';
import { Api } from '../core/api';
import { money } from '../core/fmt';

// Type-to-search dropdown. Arrow keys + Enter, like a desktop combo box.
abstract class SearchBox<T> {
  protected api = inject(Api);
  q = signal('');
  open = signal(false);
  results = signal<T[]>([]);
  hi = signal(0);
  private timer: any;

  abstract fetch(q: string): Promise<T[]>;
  abstract choose(x: T): void;

  onInput(v: string) {
    this.q.set(v); this.open.set(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => { this.results.set(await this.fetch(v)); this.hi.set(0); }, 160);
  }
  async onFocus() { if (!this.results().length) this.results.set(await this.fetch('')); }
  onKey(e: KeyboardEvent) {
    const n = this.results().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.open.set(true); this.hi.set(Math.min(this.hi() + 1, n - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.hi.set(Math.max(this.hi() - 1, 0)); }
    else if (e.key === 'Enter' && this.open() && n) { e.preventDefault(); e.stopPropagation(); this.pick(this.results()[this.hi()]); }
    else if (e.key === 'Escape' && this.open()) { e.stopPropagation(); this.open.set(false); }
  }
  pick(x: T) { this.choose(x); this.open.set(false); }
  blur() { setTimeout(() => this.open.set(false), 150); }
}

@Component({
  selector: 'party-picker',
  template: `
  <div class="picker">
    <input #box class="inp" [class.req]="required()" [readonly]="readonly()" [value]="label()" placeholder="ابحث بالاسم أو الجوال…"
      (input)="onInput($any($event.target).value)" (focus)="onFocus()" (keydown)="onKey($event)" (blur)="blur()" />
    @if (open() && !readonly()) {
      <div class="list">
        @for (p of results(); track p.id; let i = $index) {
          <div [class.on]="i === hi()" (mousedown)="pick(p)"><span>{{ p.name }}</span><small>{{ p.phone ?? '' }} · الرصيد {{ fmt(+p.balance) }}</small></div>
        } @empty { <div class="muted">لا نتائج</div> }
      </div>
    }
  </div>`,
})
export class PartyPicker extends SearchBox<any> {
  kind = input<'customer' | 'supplier'>('customer');
  value = model<any>(null);
  required = input(true);
  readonly = input(false);
  label = signal('');
  fmt = money;
  constructor() {
    super();
    effect(() => { const v = this.value(); this.label.set(v?.name ?? ''); });
  }
  fetch(q: string) { return this.api.get('/parties', { kind: this.kind(), q }); }
  choose(p: any) { this.value.set(p); this.label.set(p.name); }
  override onInput(v: string) { this.label.set(v); super.onInput(v); }
}

@Component({
  selector: 'account-picker',
  template: `
  <div class="picker">
    <input #box class="inp" [class.req]="required()" [readonly]="readonly()" [value]="label()" placeholder="رقم أو اسم الحساب…"
      (input)="onInput($any($event.target).value)" (focus)="onFocus()" (keydown)="onKey($event)" (blur)="blur()" />
    @if (open() && !readonly()) {
      <div class="list">
        @for (a of results(); track a.id; let i = $index) {
          <div [class.on]="i === hi()" (mousedown)="pick(a)"><span>{{ a.name }}</span><small>{{ a.code }}</small></div>
        } @empty { <div class="muted">لا نتائج</div> }
      </div>
    }
  </div>`,
})
export class AccountPicker extends SearchBox<any> {
  value = model<any>(null);
  required = input(false);
  readonly = input(false);
  groups = input(false);
  picked = output<any>();
  label = signal('');
  constructor() {
    super();
    effect(() => { const v = this.value(); this.label.set(v ? `${v.code} - ${v.name}` : ''); });
  }
  fetch(q: string) { return this.api.get('/accounts/search', { q, all: this.groups() ? '1' : undefined }); }
  choose(a: any) { this.value.set(a); this.picked.emit(a); }
  override onInput(v: string) { this.label.set(v); super.onInput(v); }
}

@Component({
  selector: 'item-picker',
  template: `
  <div class="picker">
    <input #box [value]="text()" [readonly]="readonly()" placeholder="{{ placeholder() }}"
      (input)="text.set($any($event.target).value); onInput($any($event.target).value)" (focus)="onFocus()" (keydown)="onKey($event)" (blur)="blur()" />
    @if (open() && !readonly()) {
      <div class="list" style="min-width: 380px">
        @for (it of results(); track it.id; let i = $index) {
          <div [class.on]="i === hi()" (mousedown)="pick(it)"><span>{{ it.name_ar }}</span><small>{{ it.code }} · متوفر {{ it.qty }}</small></div>
        } @empty { <div class="muted">لا نتائج</div> }
      </div>
    }
  </div>`,
})
export class ItemPicker extends SearchBox<any> {
  text = model('');
  readonly = input(false);
  placeholder = input('اسم الصنف…');
  picked = output<any>();
  fetch(q: string) { return this.api.get('/items', { q }); }
  choose(it: any) { this.picked.emit(it); }
}
