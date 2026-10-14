import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { money, today, hijri, viaLabel } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { AccountPicker, PartyPicker } from './pickers';
import { DocSearch } from './doc-search';

type Kind = 'receipt' | 'payment' | 'journal';
type Line = { account: any; party: any; description: string; amount: number | null; debit: number | null; credit: number | null };
const blank = (): Line => ({ account: null, party: null, description: '', amount: null, debit: null, credit: null });
const TITLES: Record<Kind, string> = { receipt: 'سند قبض', payment: 'سند صرف', journal: 'سند قيد' };

@Component({
  selector: 'voucher-form',
  imports: [AccountPicker, PartyPicker, DocSearch],
  styles: [`
    .head { display: grid; grid-template-columns: 1.3fr 1fr; gap: 8px 28px; }
    .col { display: flex; flex-direction: column; gap: 8px; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
    .pair .f { grid-template-columns: 96px 1fr; }
    .lines { min-height: 220px; max-height: 40vh; }
    .lines td.acc { width: 300px; } .lines td.amt { width: 140px; }
    .lines td.del { width: 34px; text-align: center; padding: 0; }
    .lines td.del button { border: 0; background: transparent; color: var(--danger); cursor: pointer; width: 30px; height: 30px; }
    .bottom { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; align-items: start; }
    .sum { display: grid; grid-template-columns: auto 150px; gap: 6px 10px; align-items: center; justify-self: end; }
    .sum label { color: var(--ink-2); font-size: 13px; }
    .bal { border: 1px solid var(--ink-2); padding: 8px 10px; display: grid; grid-template-columns: auto 130px; gap: 6px 10px; align-items: center; background: var(--panel); width: fit-content; }
    @media (max-width: 1100px) { .head, .bottom { grid-template-columns: 1fr; } }
  `],
  template: `
  <div class="win">
    <div class="win-body">
      @if (mode() === 'view' && doc(); as d) {
        <div style="display:flex;gap:8px;align-items:center">
          @if (d.status === 'voided') { <span class="chip bad">ملغى — صدر له قيد عكسي</span> } @else { <span class="chip ok">مرحّل</span> }
          @if (via(d.via)) { <span class="chip ai">أنشأه {{ via(d.via) }}</span> }
          <span class="muted">أعدّه {{ d.created_by_name }}</span>
        </div>
      }
      <div class="head">
        <div class="col">
          <div class="f"><label>رقم السند</label><input class="inp req num" readonly [value]="mode() === 'view' ? doc()?.number : 'جديد'" style="max-width:180px" /></div>
          <div class="f"><label>رقم المرجع</label><input class="inp" [readonly]="ro()" [value]="ref()" (input)="ref.set($any($event.target).value)" /></div>
          @if (kind() !== 'journal') {
            <div class="f"><label>{{ kind() === 'receipt' ? 'استلمنا من' : 'اصرفوا لـ' }}</label><input class="inp" [readonly]="ro()" [value]="counterparty()" (input)="counterparty.set($any($event.target).value)" /></div>
            <div class="f"><label></label>
              <div class="radio-row">
                <label><input type="radio" name="m{{tabId()}}" [disabled]="ro()" [checked]="method() === 'cash'" (change)="method.set('cash')" /> نقداً</label>
                <label><input type="radio" name="m{{tabId()}}" [disabled]="ro()" [checked]="method() === 'cheque'" (change)="method.set('cheque')" /> شيك</label>
                @if (method() === 'cheque') {
                  <input class="inp num" style="width:140px" placeholder="رقم الشيك" [readonly]="ro()" [value]="chequeNo()" (input)="chequeNo.set($any($event.target).value)" />
                  <input class="inp num" style="width:150px" type="date" [readonly]="ro()" [value]="chequeDate()" (input)="chequeDate.set($any($event.target).value)" />
                }
              </div>
            </div>
            <div class="f"><label>وذلك عبارة عن</label><input class="inp" [readonly]="ro()" [value]="about()" (input)="about.set($any($event.target).value)" /></div>
            <div class="f"><label>{{ kind() === 'receipt' ? 'الطرف المدين' : 'الطرف الدائن' }}</label>
              <select class="inp req" [disabled]="ro()" (change)="cashId.set(+$any($event.target).value)">
                @for (a of cashAccounts(); track a.id) { <option [value]="a.id" [selected]="a.id === cashId()">{{ a.code }} - {{ a.name }}</option> }
              </select>
            </div>
            <div class="f"><label>{{ kind() === 'receipt' ? 'بيان الطرف المدين' : 'بيان الطرف الدائن' }}</label><input class="inp" [readonly]="ro()" [value]="cashMemo()" (input)="cashMemo.set($any($event.target).value)" /></div>
          }
          <div class="f"><label>ملاحظات</label><input class="inp" [readonly]="ro()" [value]="notes()" (input)="notes.set($any($event.target).value)" /></div>
        </div>
        <div class="col">
          <div class="pair">
            <div class="f"><label>تاريخ ميلادي</label><input class="inp num" type="date" [readonly]="ro()" [value]="date()" (input)="date.set($any($event.target).value)" /></div>
            <div class="f"><label>تاريخ هجري</label><input class="inp num" readonly [value]="hijri(date())" /></div>
          </div>
          <div class="f"><label>الفرع</label>
            <select class="inp" [disabled]="ro() || !auth.isOwner()" (change)="setBranch(+$any($event.target).value)">
              @for (b of lk.branches(); track b.id) { <option [value]="b.id" [selected]="b.id === branchId()">{{ b.name }}</option> }
            </select>
          </div>
          <div class="f"><label>المندوب</label>
            <select class="inp" [disabled]="ro()" (change)="repId.set(+$any($event.target).value || null)">
              <option value="">—</option>
              @for (r of lk.reps(); track r.id) { <option [value]="r.id" [selected]="r.id === repId()">{{ r.name }}</option> }
            </select>
          </div>
          <div class="f"><label>مركز تكلفة</label>
            <select class="inp" [disabled]="ro()" (change)="costCenterId.set(+$any($event.target).value || null)">
              <option value="">—</option>
              @for (c of lk.costCenters(); track c.id) { <option [value]="c.id" [selected]="c.id === costCenterId()">{{ c.name }}</option> }
            </select>
          </div>
        </div>
      </div>

      <div class="grid-wrap lines">
        <table class="grid">
          <thead><tr>
            <th>{{ kind() === 'receipt' ? 'العميل' : 'المورد' }} (اختياري)</th><th>رقم الحساب / إسم الحساب</th><th>البيان</th>
            @if (kind() === 'journal') { <th class="n">مدين</th><th class="n">دائن</th> }
            @else { <th class="n">{{ kind() === 'receipt' ? 'المبلغ الدائن' : 'المبلغ المدين' }}</th> }
            <th></th>
          </tr></thead>
          <tbody>
            @for (l of lines(); track $index; let r = $index) {
              <tr (focusin)="focusRow(r)" [class.sel]="r === cur()">
                <td class="c-input" style="width:220px"><party-picker [kind]="kind() === 'receipt' ? 'customer' : 'supplier'" [required]="false" [readonly]="ro()" [value]="l.party" (valueChange)="l.party = $event; l.account = null; touch(); focusRow(r)" /></td>
                <td class="c-input acc">@if (l.party) { <input readonly [value]="l.account?.name ?? (kind() === 'receipt' ? 'ذمم العملاء — ' : 'ذمم الموردين — ') + l.party.name" /> }
                  @else { <account-picker [value]="l.account" [readonly]="ro()" (picked)="l.account = $event; touch(); focusRow(r)" /> }</td>
                <td class="c-input"><input [readonly]="ro()" [value]="l.description" (input)="l.description = $any($event.target).value" /></td>
                @if (kind() === 'journal') {
                  <td class="c-input amt"><input class="num" [readonly]="ro()" [value]="l.debit ?? ''" (input)="l.debit = num($event); touch()" /></td>
                  <td class="c-input amt"><input class="num" [readonly]="ro()" [value]="l.credit ?? ''" (input)="l.credit = num($event); touch()" /></td>
                } @else {
                  <td class="c-input amt"><input class="num" [readonly]="ro()" [value]="l.amount ?? ''" (input)="l.amount = num($event); touch()" /></td>
                }
                <td class="del">@if (!ro()) { <button title="حذف السطر" (click)="removeRow(r)">✕</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="bottom">
        <div style="display:flex;flex-direction:column;gap:8px">
          @if (!ro()) { <button class="btn sm" style="width:fit-content" (click)="addRow()">إدراج حساب <span class="k">F11</span></button> }
          <div class="bal">
            <label>رصيد مدين :</label><input class="inp num" readonly [value]="balance() > 0 ? m(balance()) : ''" />
            <label>رصيد دائن :</label><input class="inp num" readonly [value]="balance() < 0 ? m(-balance()) : ''" />
          </div>
        </div>
        <div class="nav" style="align-self:center">
          <button (click)="go('first')" [disabled]="!nav().length">⏮</button><button (click)="go('prev')" [disabled]="!nav().length">◀</button>
          <div class="pos">{{ navText() }}</div>
          <button (click)="go('next')" [disabled]="!nav().length">▶</button><button (click)="go('last')" [disabled]="!nav().length">⏭</button>
        </div>
        <div class="sum">
          @if (kind() === 'journal') {
            <label>مجموع مدين</label><input class="inp req num" readonly [value]="m(sumD())" />
            <label>مجموع دائن</label><input class="inp req num" readonly [value]="m(sumC())" [class.bad]="sumD() !== sumC()" />
          } @else {
            <label>{{ kind() === 'receipt' ? 'مجموع دائن' : 'مجموع مدين' }}</label><input class="inp req num" readonly [value]="m(sumA())" />
          }
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" (click)="add()">إضافة <span class="k">F2</span></button>
      <button class="btn primary" (click)="save()" [disabled]="ro() || saving()">حفظ <span class="k">F3</span></button>
      <button class="btn" (click)="edit()">تعديل <span class="k">F4</span></button>
      <button class="btn" (click)="searchOpen.set(true)">بحث <span class="k">F5</span></button>
      <button class="btn danger" (click)="remove()">حذف <span class="k">F6</span></button>
      <button class="btn" (click)="print()" [disabled]="mode() !== 'view'">طباعة <span class="k">F7</span></button>
      <span class="spacer"></span>
      <button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button>
    </div>
  </div>
  @if (searchOpen()) { <doc-search type="vouchers" [kind]="kind()" (picked)="openNumber($event)" (closed)="searchOpen.set(false)" /> }
  `,
})
export class VoucherForm implements OnInit {
  kind = input.required<Kind>();
  tabId = input.required<number>();
  number = input<number | null>(null);
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); tabs = inject(Tabs);
  m = money; hijri = hijri;
  via = (v: string) => viaLabel[v];

  mode = signal<'new' | 'view'>('new'); doc = signal<any>(null); nav = signal<number[]>([]); saving = signal(false); searchOpen = signal(false);
  date = signal(today()); branchId = signal(0); repId = signal<number | null>(null); costCenterId = signal<number | null>(null);
  ref = signal(''); counterparty = signal(''); method = signal<'cash' | 'cheque'>('cash'); chequeNo = signal(''); chequeDate = signal(today());
  about = signal(''); cashId = signal<number>(0); cashMemo = signal(''); notes = signal('');
  allAccounts = signal<any[]>([]);
  lines = signal<Line[]>([]); version = signal(0); cur = signal(0); balance = signal(0);

  ro = computed(() => this.mode() === 'view');
  cashAccounts = computed(() => { const g = this.lk.company()?.pack_accounts?.cash_group; return this.allAccounts().filter((a) => !a.is_group && a.parent_id === g && (!a.branch_id || a.branch_id === this.branchId())); });
  sumA = computed(() => { this.version(); return Math.round(this.lines().reduce((s, l) => s + (l.amount ?? 0) * 100, 0)) / 100; });
  sumD = computed(() => { this.version(); return Math.round(this.lines().reduce((s, l) => s + (l.debit ?? 0) * 100, 0)) / 100; });
  sumC = computed(() => { this.version(); return Math.round(this.lines().reduce((s, l) => s + (l.credit ?? 0) * 100, 0)) / 100; });
  navText = computed(() => { const n = this.nav(); if (!n.length) return 'لا توجد سندات'; return this.mode() === 'view' ? `${this.doc()?.number} من ${n[n.length - 1]}` : `جديد · ${n.length} سند`; });

  async ngOnInit() {
    this.tabs.register(this.tabId(), {
      F2: () => this.add(), F3: () => this.save(), F4: () => this.edit(), F5: () => this.searchOpen.set(true), F6: () => this.remove(), F7: () => this.print(), F11: () => this.addRow(),
      beforeClose: async () => this.mode() === 'view' || !this.lines().some((l) => l.account || l.party) || this.ui.confirm('إغلاق السند', 'لم يتم حفظ السند. الإغلاق دون حفظ؟', 'إغلاق دون حفظ', true),
    });
    if (!this.lk.branches().length) await this.lk.load();
    this.allAccounts.set(await this.api.get('/accounts'));
    this.nav.set(await this.api.get(`/vouchers/${this.kind()}/nav`));
    if (this.number()) await this.openNumber(this.number()!); else this.reset();
  }

  touch() { this.version.update((v) => v + 1); }
  num(e: Event) { const v = (e.target as HTMLInputElement).value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))); return v === '' ? null : Number(v); }
  setBranch(id: number) { this.branchId.set(id); this.cashId.set(this.cashAccounts()[0]?.id ?? 0); }

  reset() {
    this.mode.set('new'); this.doc.set(null);
    this.date.set(today()); this.ref.set(''); this.counterparty.set(''); this.method.set('cash'); this.chequeNo.set(''); this.about.set(''); this.cashMemo.set(''); this.notes.set('');
    this.branchId.set(this.auth.user()?.branch_id ?? this.lk.branches()[0]?.id ?? 0);
    const bc = this.lk.branches().find((b) => b.id === this.branchId())?.cash_account_id;
    this.cashId.set(bc ?? this.cashAccounts()[0]?.id ?? 0);
    this.costCenterId.set(null); this.repId.set(null);
    this.lines.set(Array.from({ length: 6 }, blank)); this.balance.set(0);
    this.tabs.setTitle(this.tabId(), TITLES[this.kind()]);
  }
  addRow() { if (!this.lines().some((l) => !l.account && !l.party)) this.lines.update((ls) => [...ls, blank()]); }
  removeRow(r: number) { this.lines.update((ls) => { const n = ls.filter((_, i) => i !== r); while (n.length < 6) n.push(blank()); return n; }); this.touch(); }
  async focusRow(r: number) {
    this.cur.set(r);
    const l = this.lines()[r];
    if (l?.party) { const st = await this.api.get('/books/party-statement', { party_id: l.party.id, from: '2000-01-01', to: '2999-12-31' }, { quiet: true }).catch(() => null); this.balance.set(+(st?.closing ?? 0)); return; }
    const a = l?.account;
    if (!a) { this.balance.set(0); return; }
    const st = await this.api.get('/books/ledger', { account_id: a.id, from: '2000-01-01', to: '2999-12-31' }, { quiet: true }).catch(() => null);
    this.balance.set(st ? (st.closing_side === 'دائن' ? -st.closing : +st.closing) : 0);
  }

  async add() {
    if (this.mode() === 'new' && this.lines().some((l) => l.account) && !(await this.ui.confirm('سند جديد', 'سيتم تجاهل البيانات غير المحفوظة. متابعة؟', 'متابعة', true))) return;
    this.reset();
  }
  async save() {
    if (this.ro() || this.saving()) return;
    const lines = this.lines().filter((l) => l.account || l.party);
    if (!lines.length) { this.ui.toast('أدخل حساباً واحداً على الأقل', 'bad'); return; }
    if (this.kind() === 'journal' && this.sumD() !== this.sumC()) { this.ui.toast(`السند غير متوازن: المدين ${money(this.sumD())} والدائن ${money(this.sumC())}`, 'bad'); return; }
    const body: any = {
      kind: this.kind(), branch_id: this.branchId(), date: this.date(), ref: this.ref() || undefined, sales_rep_id: this.repId() ?? undefined,
      cost_center_id: this.costCenterId() ?? undefined, notes: this.notes() || undefined,
      lines: lines.map((l) => ({ ...(l.party ? { party_id: l.party.id } : { account_id: l.account.id }), description: l.description || undefined,
        ...(this.kind() === 'journal' ? { debit: l.debit ?? 0, credit: l.credit ?? 0 } : { amount: l.amount ?? 0 }) })),
    };
    if (this.kind() !== 'journal') Object.assign(body, {
      counterparty: this.counterparty() || undefined, method: this.method(), cheque_no: this.method() === 'cheque' ? this.chequeNo() : undefined,
      cheque_date: this.method() === 'cheque' ? this.chequeDate() : undefined, about: this.about() || undefined, cash_account_id: this.cashId() || undefined, cash_memo: this.cashMemo() || undefined,
    });
    this.saving.set(true);
    try {
      const d = await this.api.post('/vouchers', body);
      this.ui.toast(`تم حفظ ${TITLES[this.kind()]} رقم ${d.number}`, 'ok');
      this.nav.set(await this.api.get(`/vouchers/${this.kind()}/nav`));
      this.show(d);
    } catch { } finally { this.saving.set(false); }
  }
  edit() { if (this.mode() === 'view') this.ui.toast('السند المرحّل لا يُعدّل. ألغِه (F6) ثم أنشئ سنداً صحيحاً.'); }
  async remove() {
    if (this.mode() === 'new') { this.removeRow(this.cur()); return; }
    const d = this.doc();
    if (d.status === 'voided') { this.ui.toast('السند ملغى مسبقاً'); return; }
    if (!(await this.ui.confirm(`إلغاء ${TITLES[this.kind()]} رقم ${d.number}`, 'سيتم إلغاء السند بقيد عكسي بتاريخ اليوم. يبقى السند ظاهراً بحالة "ملغى" للمراجعة. متابعة؟', 'إلغاء السند', true))) return;
    this.show(await this.api.post(`/vouchers/id/${d.id}/void`, {}));
    this.ui.toast('تم إلغاء السند', 'ok');
  }
  print() { if (this.doc()) window.open(`/api/vouchers/id/${this.doc().id}/pdf?company=${this.api.companyId}`, '_blank'); }
  async openNumber(n: number) { this.searchOpen.set(false); this.show(await this.api.get(`/vouchers/${this.kind()}/${n}`)); }
  show(d: any) {
    this.doc.set(d); this.mode.set('view');
    this.date.set(d.date); this.branchId.set(d.branch_id); this.repId.set(d.sales_rep_id); this.costCenterId.set(d.cost_center_id); this.ref.set(d.ref ?? '');
    this.counterparty.set(d.counterparty ?? ''); this.method.set(d.method ?? 'cash'); this.chequeNo.set(d.cheque_no ?? ''); this.chequeDate.set(d.cheque_date ?? '');
    this.about.set(d.about ?? ''); this.cashId.set(d.cash_account_id ?? 0); this.cashMemo.set(d.cash_memo ?? ''); this.notes.set(d.notes ?? '');
    this.lines.set(d.lines.map((l: any) => ({ account: { id: l.account_id, code: l.account_code, name: l.account_name }, party: l.party_id ? { id: l.party_id, name: l.party_name } : null, description: l.description ?? '',
      amount: l.amount, debit: l.debit || null, credit: l.credit || null })));
    this.touch();
    this.tabs.setTitle(this.tabId(), `${TITLES[this.kind()]} ${d.number}`);
  }
  async go(where: 'first' | 'prev' | 'next' | 'last') {
    const n = this.nav(); if (!n.length) return;
    let i = this.mode() === 'view' ? n.indexOf(this.doc()?.number) : n.length;
    i = where === 'first' ? 0 : where === 'last' ? n.length - 1 : where === 'prev' ? Math.max(i - 1, 0) : Math.min(i + 1, n.length - 1);
    await this.openNumber(n[i]);
  }
}
