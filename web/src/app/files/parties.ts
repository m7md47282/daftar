import { Component, OnInit, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { Lookups } from '../core/lookups';
import { Auth } from '../core/auth';
import { money } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { PartyStatement } from '../books/books';

// العملاء / الموردين
@Component({
  selector: 'parties-form',
  styles: [`.layout { display: grid; grid-template-columns: 1fr 380px; gap: 16px; } .fields { grid-template-columns: 1fr; max-width: 560px; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }`],
  template: `
  <div class="win">
    <div class="win-body">
      <div class="layout">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="fields">
            <div class="f"><label>رقم الطرف</label><input class="inp req num" readonly [value]="cur()?.id ?? 'تلقائي'" style="max-width:180px" /></div>
            <div class="f"><label>الاسم</label><input class="inp req" [value]="f.name" (input)="f.name = $any($event.target).value" /></div>
            <div class="f"><label>الجوال</label><input class="inp num" [value]="f.phone" (input)="f.phone = $any($event.target).value" /></div>
            <div class="f"><label>البريد الإلكتروني</label><input class="inp num" [value]="f.email" (input)="f.email = $any($event.target).value" /></div>
            <div class="f"><label>الرقم الضريبي</label><input class="inp num" [value]="f.vat_number" (input)="f.vat_number = $any($event.target).value" placeholder="15 رقماً يبدأ وينتهي بـ 3" /></div>
            <div class="f"><label>العنوان</label><input class="inp" [value]="f.address" (input)="f.address = $any($event.target).value" /></div>
            @if (auth.isOwner() && !cur()) {
              <div class="f"><label>الفرع</label>
                <select class="inp" (change)="f.branch_id = +$any($event.target).value || null">
                  <option value="">مشترك بين جميع الفروع</option>
                  @for (b of lk.branches(); track b.id) { <option [value]="b.id">{{ b.name }}</option> }
                </select>
              </div>
            }
            @if (cur()) {
              <div class="f"><label>الرصيد</label><input class="inp req num" readonly [value]="m(+cur().balance)" style="max-width:180px" /></div>
              <div class="f"><label></label><div><button class="btn sm" (click)="statement()">كشف حساب</button></div></div>
            }
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <input class="inp" placeholder="بحث بالاسم أو الجوال" (input)="search($any($event.target).value)" />
          <div class="grid-wrap" style="max-height:62vh">
            <table class="grid">
              <thead><tr><th>#</th><th>الاسم</th><th class="n">الرصيد</th></tr></thead>
              <tbody>
                @for (p of list(); track p.id) {
                  <tr class="click" [class.sel]="p.id === cur()?.id" (click)="open(p)"><td class="num">{{ p.id }}</td><td>{{ p.name }}</td><td class="n">{{ m(+p.balance) }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" (click)="reset()">إضافة <span class="k">F2</span></button>
      <button class="btn primary" (click)="save()">حفظ <span class="k">F3</span></button>
      <span class="spacer"></span>
      <button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button>
    </div>
  </div>`,
})
export class PartiesForm implements OnInit {
  kind = input.required<'customer' | 'supplier'>();
  tabId = input.required<number>();
  api = inject(Api); ui = inject(Ui); lk = inject(Lookups); auth = inject(Auth); tabs = inject(Tabs);
  m = money;
  list = signal<any[]>([]); cur = signal<any>(null);
  f: any = {};
  private t: any; private q = '';
  async ngOnInit() {
    this.tabs.register(this.tabId(), { F2: () => this.reset(), F3: () => this.save() });
    if (!this.lk.branches().length) await this.lk.load();
    this.reset(); await this.load();
  }
  async load() { this.list.set(await this.api.get('/parties', { kind: this.kind(), q: this.q })); }
  search(q: string) { this.q = q; clearTimeout(this.t); this.t = setTimeout(() => this.load(), 200); }
  reset() { this.cur.set(null); this.f = { name: '', phone: '', email: '', vat_number: '', address: '', branch_id: null }; }
  open(p: any) { this.cur.set(p); this.f = { name: p.name, phone: p.phone ?? '', email: p.email ?? '', vat_number: p.vat_number ?? '', address: p.address ?? '' }; }
  async save() {
    if (!this.f.name?.trim()) { this.ui.toast('أدخل الاسم', 'bad'); return; }
    const body = { kind: this.kind(), name: this.f.name, phone: this.f.phone || undefined, email: this.f.email || undefined, vat_number: this.f.vat_number || undefined,
      address: this.f.address || undefined, branch_id: this.f.branch_id ?? undefined };
    const p = this.cur() ? await this.api.patch(`/parties/${this.cur().id}`, body) : await this.api.post('/parties', body);
    this.ui.toast('تم الحفظ', 'ok');
    await this.load();
    this.open(this.list().find((x) => x.id === p.id) ?? p);
  }
  statement() {
    const p = this.cur();
    this.tabs.open(`pstmt-${p.id}`, `كشف حساب ${p.name}`, PartyStatement, { kind: this.kind(), partyId: p.id, partyName: p.name });
  }
}
