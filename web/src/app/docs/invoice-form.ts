import { Component, ElementRef, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { money, qty as fq, today, hijri, halala, viaLabel } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { PartyPicker, ItemPicker } from './pickers';
import { DocSearch } from './doc-search';
import { ShareDialog } from './share-dialog';

type Kind = 'sale' | 'sale_return' | 'purchase' | 'purchase_return';
type Line = {
  item_id: number | null; code: string; name: string; units: any[]; unit_id: number | null; unit_name: string; factor: number;
  warehouse_id: number | null; qty: number | null; free_qty: number | null; price: number | null; discount_pct: number | null; vat_rate: number;
  // view-mode values from the server
  v?: any;
};
const blank = (): Line => ({ item_id: null, code: '', name: '', units: [], unit_id: null, unit_name: '', factor: 1, warehouse_id: null, qty: null, free_qty: null, price: null, discount_pct: null, vat_rate: 15 });

const TITLES: Record<Kind, string> = { sale: 'فاتورة مبيعات', sale_return: 'فاتورة مرتجع مبيعات', purchase: 'فاتورة مشتريات', purchase_return: 'فاتورة مرتجع مشتريات' };

@Component({
  selector: 'invoice-form',
  imports: [PartyPicker, ItemPicker, DocSearch, ShareDialog],
  styles: [`
    .head { display: grid; grid-template-columns: 1.15fr 1fr; gap: 8px 28px; }
    .col { display: flex; flex-direction: column; gap: 8px; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
    .pair .f { grid-template-columns: 96px 1fr; }
    .lines { min-height: 200px; max-height: 36vh; }
    .lines td.code { width: 96px; } .lines td.name { min-width: 220px; } .lines td.unit { width: 96px; } .lines td.wh { width: 130px; }
    .lines td.q { width: 84px; } .lines td.money { width: 96px; }
    .lines td.del { width: 34px; text-align: center; padding: 0; }
    .lines td.del button { border: 0; background: transparent; color: var(--danger); cursor: pointer; width: 30px; height: 30px; border-radius: 3px; font-size: 16px; }
    .lines td.del button:hover { background: var(--danger-soft); }
    .bottom { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; align-items: start; }
    .tools { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
    .mid { display: flex; flex-direction: column; gap: 10px; align-items: center; }
    .paid { display: grid; grid-template-columns: auto 130px; gap: 6px 10px; align-items: center; }
    .paid label { color: #1f4e79; font-size: 13px; }
    .totals-wrap { justify-self: end; }
    .barcode { width: 190px; }
    .stamp { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    @media (max-width: 1100px) { .head, .bottom { grid-template-columns: 1fr; } .totals-wrap { justify-self: start; } }
  `],
  template: `
  <div class="win">
    <div class="win-body">
      @if (mode() === 'view' && doc(); as d) {
        <div class="stamp">
          <span class="chip ok">مرحّلة</span>
          @if (d.zatca?.type) { <span class="chip">{{ d.zatca.type === 'standard' ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة' }} · عداد {{ d.zatca.icv }}</span> }
          @if (d.via === 'ai' || d.via === 'mcp') { <span class="chip ai">أنشأها {{ via(d.via) }}</span> }
          <span class="muted">أعدّها {{ d.created_by_name }}</span>
        </div>
      }
      <div class="head">
        <div class="col">
          <div class="f"><label>رقم الفاتورة</label><input class="inp req num" readonly [value]="mode() === 'view' ? doc()?.number : 'جديدة'" style="max-width:180px" /></div>
          @if (isReturn()) {
            <div class="f"><label>رقم الفاتورة الأساسية</label>
              <div style="display:flex;gap:6px">
                <input class="inp req num" style="max-width:180px" [readonly]="ro()" [value]="origNo()" (input)="origNo.set($any($event.target).value)" (keydown.enter)="loadOriginal()" />
                @if (!ro()) { <button class="btn sm" (click)="loadOriginal()">جلب الأصناف</button> }
              </div>
            </div>
          }
          <div class="f"><label>{{ isSale() ? 'العميل' : 'المورد' }}</label>
            <party-picker [kind]="isSale() ? 'customer' : 'supplier'" [(value)]="party" [readonly]="ro() || !!origDoc()" (valueChange)="onParty($event)" />
          </div>
          @if (isSale()) {
            <div class="f"><label>اسم العميل</label><input class="inp" [readonly]="ro()" [value]="partyName()" (input)="partyName.set($any($event.target).value)" /></div>
            <div class="pair">
              <div class="f"><label>جوال العميل</label><input class="inp num" [readonly]="ro()" [value]="phone()" (input)="phone.set($any($event.target).value)" /></div>
              <div class="f"><label>الرقم الضريبي للعميل</label><input class="inp num" [readonly]="ro()" [value]="vat()" (input)="vat.set($any($event.target).value)" /></div>
            </div>
            <div class="f"><label>عنوان العميل</label><input class="inp" [readonly]="ro()" [value]="address()" (input)="address.set($any($event.target).value)" /></div>
          } @else {
            <div class="f"><label>الرقم الضريبي للمورد</label><input class="inp num" readonly [value]="vat()" /></div>
          }
          <div class="f"><label>ملاحظات</label><input class="inp" [readonly]="ro()" [value]="notes()" (input)="notes.set($any($event.target).value)" /></div>
        </div>
        <div class="col">
          <div class="pair">
            <div class="f"><label>تاريخ ميلادي</label><input class="inp num" type="date" [readonly]="ro()" [value]="date()" (input)="date.set($any($event.target).value)" /></div>
            <div class="f"><label>تاريخ هجري</label><input class="inp num" readonly [value]="hijri(date())" /></div>
          </div>
          <div class="f"><label>الفرع</label>
            <select class="inp" [disabled]="ro() || !auth.isOwner()" [value]="branchId()" (change)="setBranch(+$any($event.target).value)">
              @for (b of lk.branches(); track b.id) { <option [value]="b.id" [selected]="b.id === branchId()">{{ b.name }}</option> }
            </select>
          </div>
          <div class="f"><label>مركز تكلفة</label>
            <select class="inp" [disabled]="ro()" (change)="costCenterId.set(+$any($event.target).value || null)">
              <option value="">—</option>
              @for (c of lk.costCenters(); track c.id) { <option [value]="c.id" [selected]="c.id === costCenterId()">{{ c.name }}</option> }
            </select>
          </div>
          @if (isSale()) {
            <div class="f"><label>المندوب</label>
              <select class="inp" [disabled]="ro()" (change)="repId.set(+$any($event.target).value || null)">
                <option value="">—</option>
                @for (r of reps(); track r.id) { <option [value]="r.id" [selected]="r.id === repId()">{{ r.name }}</option> }
              </select>
            </div>
          }
          <div class="pair">
            <div class="f"><label>طريقة الدفع</label>
              <select class="inp" [disabled]="ro()" (change)="setMethod($any($event.target).value)">
                <option value="cash" [selected]="method() === 'cash'">نقد</option>
                <option value="credit" [selected]="method() === 'credit'">آجل</option>
              </select>
            </div>
            <div class="f"><label>رقم المرجع</label><input class="inp" [readonly]="ro()" [value]="ref()" (input)="ref.set($any($event.target).value)" /></div>
          </div>
          @if (isSale()) { <div class="f"><label>الرقم الضريبي</label><input class="inp num" readonly [value]="lk.company()?.vat_number ?? ''" /></div> }
        </div>
      </div>

      <div class="grid-wrap lines">
        <table class="grid">
          <thead><tr>
            <th>رقم الصنف</th><th>اسم الصنف</th><th>الوحدة</th><th>المستودع</th><th class="n">الكمية</th><th class="n">كمية مجانية</th>
            <th class="n">السعر</th><th class="n">نسبة الخصم %</th><th class="n">مبلغ الخصم</th><th class="n">الضريبة</th><th class="n">الإجمالي</th><th></th>
          </tr></thead>
          <tbody>
            @for (l of lines(); track $index; let r = $index) {
              <tr [class.sel]="r === cur()" (focusin)="focusRow(r)">
                <td class="c-input code"><input [attr.data-r]="r" data-c="0" [readonly]="ro() || !!origDoc()" [value]="l.code" (input)="l.code = $any($event.target).value" (keydown.enter)="byCode(r, $event)" /></td>
                <td class="c-input name">
                  @if (ro() || origDoc()) { <input readonly [value]="l.name" /> }
                  @else { <item-picker [attr.data-r]="r" data-c="1" [text]="l.name" (picked)="setItem(r, $event)" /> }
                </td>
                <td class="c-input unit">
                  <select [attr.data-r]="r" data-c="2" [disabled]="ro() || !l.units.length || !!origDoc()" (change)="setUnit(r, +$any($event.target).value)" (keydown.enter)="next($event)">
                    @if (!l.units.length) { <option>{{ l.unit_name }}</option> }
                    @for (u of l.units; track u.id) { <option [value]="u.id" [selected]="u.id === l.unit_id">{{ u.name }}</option> }
                  </select>
                </td>
                <td class="c-input wh">
                  <select [attr.data-r]="r" data-c="3" [disabled]="ro()" (change)="l.warehouse_id = +$any($event.target).value; touch()" (keydown.enter)="next($event)">
                    @for (w of whs(); track w.id) { <option [value]="w.id" [selected]="w.id === l.warehouse_id">{{ w.name }}</option> }
                  </select>
                </td>
                <td class="c-input q"><input class="num" [attr.data-r]="r" data-c="4" [readonly]="ro()" [value]="l.qty ?? ''" (input)="l.qty = num($event); touch()" (keydown.enter)="next($event)" /></td>
                <td class="c-input q"><input class="num" [attr.data-r]="r" data-c="5" [readonly]="ro() || !!origDoc()" [value]="l.free_qty ?? ''" (input)="l.free_qty = num($event); touch()" (keydown.enter)="next($event)" /></td>
                <td class="c-input money"><input class="num" [attr.data-r]="r" data-c="6" [readonly]="ro() || !!origDoc()" [value]="l.price ?? ''" (input)="l.price = num($event); touch()" (keydown.enter)="next($event)" /></td>
                <td class="c-input q"><input class="num" [attr.data-r]="r" data-c="7" [readonly]="ro() || !!origDoc()" [value]="l.discount_pct ?? ''" (input)="l.discount_pct = num($event); touch()" (keydown.enter)="next($event, true)" /></td>
                <td class="n">{{ m(calc()[r]?.discount) }}</td>
                <td class="n">{{ m(calc()[r]?.vat) }}</td>
                <td class="n"><b>{{ m(calc()[r]?.total) }}</b></td>
                <td class="del">@if (!ro()) { <button title="حذف السطر" (click)="removeRow(r)">✕</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="bottom">
        <div>
          @if (!ro()) {
            <div class="tools">
              <button class="btn sm" (click)="addRow(true)" [disabled]="!!origDoc()">إدراج صنف <span class="k">F11</span></button>
              <input #barcode class="inp barcode num" placeholder="الباركود F9" (keydown.enter)="scan($event)" [disabled]="!!origDoc()" />
            </div>
          }
          <div class="infobox">
            <span>الكمية الحالية :</span><span>{{ info()?.qtyText ?? '—' }}</span>
            <span>عبوة الصنف :</span><span>{{ info()?.factor ?? '—' }}</span>
            @if (auth.isOwner()) { <span>تكلفة الصنف :</span><span>{{ info()?.cost ?? '—' }}</span> }
            <span>آخر سعر للصنف :</span><span>{{ info()?.last ?? '—' }}</span>
            @if (auth.isOwner() && isSale()) { <span>تكلفة الفاتورة :</span><span>{{ invoiceCost() }}</span> }
          </div>
        </div>
        <div class="mid">
          <div class="paid">
            <label>المدفوع</label><input class="inp num" [class.req]="method() === 'cash'" [readonly]="ro() || method() === 'cash'" [value]="method() === 'cash' ? m(totals().total) : (paid() ?? '')" (input)="paid.set(num($event))" />
            <label>المتبقي</label><input class="inp req num" readonly [value]="m(totals().total - (method() === 'cash' ? totals().total : (paid() ?? 0)))" />
          </div>
          <div class="nav">
            <button title="الأولى" (click)="go('first')" [disabled]="!nav().length">⏮</button>
            <button title="السابقة" (click)="go('prev')" [disabled]="!nav().length">◀</button>
            <div class="pos">{{ navText() }}</div>
            <button title="التالية" (click)="go('next')" [disabled]="!nav().length">▶</button>
            <button title="الأخيرة" (click)="go('last')" [disabled]="!nav().length">⏭</button>
          </div>
        </div>
        <div class="totals-wrap">
          <div class="totals">
            <label>إجمالي الفاتورة</label><input class="inp req num" readonly [value]="m(totals().subtotal)" />
            <label>نسبة الخصم %</label><input class="inp num" [readonly]="ro() || !!origDoc()" [value]="invDisc() ?? ''" (input)="invDisc.set(num($event))" />
            <label>إجمالي الخصم</label><input class="inp num" readonly [value]="m(totals().discount)" />
            <label>القيمة المضافة</label><input class="inp req num" readonly [value]="m(totals().vat)" />
            <label>صافي الفاتورة</label><input class="inp req num" readonly [value]="m(totals().total)" style="font-size:15px" />
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn" (click)="add()">إضافة <span class="k">F2</span></button>
      <button class="btn primary" (click)="save()" [disabled]="ro() || saving()">حفظ <span class="k">F3</span></button>
      <button class="btn" (click)="edit()">تعديل <span class="k">F4</span></button>
      <button class="btn" (click)="searchOpen.set(true)">بحث <span class="k">F5</span></button>
      <button class="btn" (click)="remove()">حذف <span class="k">F6</span></button>
      <button class="btn" (click)="print()" [disabled]="mode() !== 'view'">طباعة <span class="k">F7</span></button>
      @if (mode() === 'view') { <button class="btn" (click)="shareOpen.set(true)">إرسال للعميل</button> }
      <span class="spacer"></span>
      <button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button>
    </div>
  </div>
  @if (searchOpen()) { <doc-search type="invoices" [kind]="kind()" (picked)="openNumber($event)" (closed)="searchOpen.set(false)" /> }
  @if (shareOpen() && doc()) { <share-dialog [doc]="doc()" (closed)="shareOpen.set(false)" /> }
  `,
})
export class InvoiceForm implements OnInit {
  kind = input.required<Kind>();
  tabId = input.required<number>();
  number = input<number | null>(null);

  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); tabs = inject(Tabs);
  m = money; hijri = hijri;
  via = (v: string) => viaLabel[v];
  barcode = viewChild<ElementRef<HTMLInputElement>>('barcode');

  mode = signal<'new' | 'view'>('new');
  doc = signal<any>(null);
  nav = signal<number[]>([]);
  saving = signal(false);
  searchOpen = signal(false);
  shareOpen = signal(false);

  party = signal<any>(null);
  partyName = signal(''); phone = signal(''); vat = signal(''); address = signal('');
  date = signal(today()); branchId = signal<number>(0); costCenterId = signal<number | null>(null); repId = signal<number | null>(null);
  method = signal<'cash' | 'credit'>('cash'); paid = signal<number | null>(null); ref = signal(''); notes = signal('');
  invDisc = signal<number | null>(null);
  origNo = signal(''); origDoc = signal<any>(null);
  lines = signal<Line[]>([]);
  version = signal(0);
  cur = signal(0);
  info = signal<any>(null);
  private itemCache = new Map<number, any>();

  ro = computed(() => this.mode() === 'view');
  isSale = computed(() => this.kind() === 'sale' || this.kind() === 'sale_return');
  isReturn = computed(() => this.kind().endsWith('_return'));
  whs = computed(() => this.lk.warehouses().filter((w) => w.branch_id === this.branchId()));
  reps = computed(() => this.lk.reps().filter((r) => !r.branch_id || r.branch_id === this.branchId()));
  navText = computed(() => {
    const n = this.nav(); if (!n.length) return 'لا توجد فواتير';
    return this.mode() === 'view' ? `${this.doc()?.number} من ${n[n.length - 1]}` : `جديدة · ${n.length} فاتورة`;
  });

  // Client mirror of the server's math (same rounding). The server recomputes on save.
  calc = computed(() => {
    this.version();
    if (this.mode() === 'view') return this.lines().map((l) => l.v);
    const invBp = Math.round((this.invDisc() ?? 0) * 100);
    return this.lines().map((l) => {
      if (!l.item_id || !l.qty || l.price == null) return null;
      const qm = Math.round(l.qty * 1000), ph = halala(l.price);
      const rnd = (a: number, b: number, d: number) => Math.round((a * b) / d);
      const gross = rnd(qm, ph, 1000);
      const ld = rnd(gross, Math.round((l.discount_pct ?? 0) * 100), 10000);
      const id = rnd(gross - ld, invBp, 10000);
      const net = gross - ld - id;
      const vat = rnd(net, Math.round(l.vat_rate * 100), 10000);
      return { gross: gross / 100, discount: (ld + id) / 100, net: net / 100, vat: vat / 100, total: (net + vat) / 100 };
    });
  });
  totals = computed(() => {
    if (this.mode() === 'view' && this.doc()) { const d = this.doc(); return { subtotal: d.subtotal, discount: d.discount, vat: d.vat, total: d.total }; }
    const c = this.calc().filter(Boolean) as any[];
    const s = (k: string) => Math.round(c.reduce((a, x) => a + x[k] * 100, 0)) / 100;
    return { subtotal: s('gross'), discount: s('discount'), vat: s('vat'), total: s('total') };
  });
  invoiceCost = computed(() => (this.mode() === 'view' && this.doc() ? money(this.doc().cost_total) : '—'));

  async ngOnInit() {
    this.tabs.register(this.tabId(), {
      F2: () => this.add(), F3: () => this.save(), F4: () => this.edit(), F5: () => this.searchOpen.set(true),
      F6: () => this.remove(), F7: () => this.print(), F9: () => this.barcode()?.nativeElement.focus(), F11: () => this.addRow(true),
      beforeClose: async () => this.mode() === 'view' || !this.dirty() || this.ui.confirm('إغلاق الفاتورة', 'لم يتم حفظ الفاتورة. هل تريد الإغلاق دون حفظ؟', 'إغلاق دون حفظ', true),
    });
    if (!this.lk.branches().length) await this.lk.load();
    await this.refreshNav();
    if (this.number()) await this.openNumber(this.number()!);
    else this.reset();
  }

  dirty() { return this.lines().some((l) => l.item_id) || !!this.party(); }
  touch() { this.version.update((v) => v + 1); }
  num(e: Event) { const v = ($(e.target as HTMLInputElement)).value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.'); return v === '' ? null : Number(v); }

  async refreshNav() { this.nav.set(await this.api.get(`/invoices/${this.kind()}/nav`)); }

  reset() {
    this.mode.set('new'); this.doc.set(null); this.origDoc.set(null); this.origNo.set('');
    this.date.set(today()); this.ref.set(''); this.notes.set(''); this.invDisc.set(null); this.paid.set(null);
    this.method.set(this.kind() === 'purchase' ? 'credit' : 'cash');
    const b = this.auth.user()?.branch_id ?? this.lk.branches()[0]?.id ?? 0;
    this.branchId.set(b);
    this.costCenterId.set(this.lk.costCenters()[0]?.id ?? null);
    this.repId.set(this.reps()[0]?.id ?? null);
    this.party.set(null); this.partyName.set(''); this.phone.set(''); this.vat.set(''); this.address.set('');
    if (this.isSale() && this.kind() === 'sale') this.api.get('/parties', { kind: 'customer', q: 'عميل عام' }).then((r) => { if (r[0] && !this.party()) this.onParty(r[0]); });
    this.lines.set(Array.from({ length: 6 }, blank));
    this.info.set(null);
    this.tabs.setTitle(this.tabId(), TITLES[this.kind()]);
  }

  setBranch(id: number) { this.branchId.set(id); for (const l of this.lines()) l.warehouse_id = this.whs()[0]?.id ?? null; this.repId.set(this.reps()[0]?.id ?? null); this.touch(); }
  setMethod(v: 'cash' | 'credit') { this.method.set(v); if (v === 'credit') this.paid.set(0); }
  onParty(p: any) {
    this.party.set(p);
    if (!p) return;
    this.partyName.set(p.name); this.phone.set(p.phone ?? ''); this.vat.set(p.vat_number ?? ''); this.address.set(p.address ?? '');
    if (this.kind() === 'sale' && p.name !== 'عميل عام' && this.method() === 'cash' && p.balance !== undefined) { /* keep user's choice */ }
  }

  // ----- lines -----
  addRow(focus = false) {
    let r = this.lines().findIndex((l) => !l.item_id && !l.code);
    if (r < 0) { this.lines.update((ls) => [...ls, blank()]); r = this.lines().length - 1; }
    if (focus) this.focusCell(r, 0);
  }
  removeRow(r: number) { this.lines.update((ls) => { const n = ls.filter((_, i) => i !== r); while (n.length < 6) n.push(blank()); return n; }); this.touch(); }
  focusRow(r: number) { this.cur.set(r); this.loadInfo(this.lines()[r]); }

  async getItem(id: number) {
    if (!this.itemCache.has(id)) this.itemCache.set(id, await this.api.get(`/items/${id}`));
    return this.itemCache.get(id);
  }
  async setItem(r: number, it: any, focusQty = true) {
    const full = await this.getItem(it.id);
    const l = this.lines()[r];
    const u = full.units.find((x: any) => x.is_default) ?? full.units[0];
    Object.assign(l, { item_id: full.id, code: full.code, name: full.name_ar, units: full.units, unit_id: u.id, unit_name: u.name, factor: u.factor,
      warehouse_id: l.warehouse_id ?? this.whs()[0]?.id ?? null, vat_rate: full.vat_rate_pct, price: this.defaultPrice(full, u) });
    this.lines.update((ls) => [...ls]);
    if (r === this.lines().length - 1) this.lines.update((ls) => [...ls, blank()]);
    this.touch(); this.loadInfo(l);
    if (focusQty) this.focusCell(r, 4);
  }
  defaultPrice(item: any, u: any) {
    if (this.isSale()) return u.price;
    return item.avg_cost ? Math.round(item.avg_cost * u.factor * 100) / 100 : null;
  }
  setUnit(r: number, unitId: number) {
    const l = this.lines()[r];
    const u = l.units.find((x) => x.id === unitId);
    if (!u) return;
    l.unit_id = u.id; l.unit_name = u.name; l.factor = u.factor;
    const item = this.itemCache.get(l.item_id!);
    l.price = this.defaultPrice(item, u);
    this.lines.update((ls) => [...ls]); this.touch(); this.loadInfo(l);
  }
  async byCode(r: number, e: Event) {
    e.preventDefault();
    const code = this.lines()[r].code.trim();
    if (!code) { this.focusCell(r, 1); return; }
    const res = await this.api.get('/items', { q: code });
    const hit = res.find((x: any) => x.code === code) ?? (res.length === 1 ? res[0] : null);
    if (hit) await this.setItem(r, hit);
    else { this.ui.toast(`الصنف ${code} غير موجود`, 'bad'); }
  }
  async scan(e: Event) {
    const el = e.target as HTMLInputElement;
    const code = el.value.trim(); el.value = '';
    if (!code) return;
    const res = await this.api.get('/items', { q: code });
    const it = res[0];
    if (!it) { this.ui.toast(`الباركود ${code} غير معروف`, 'bad'); return; }
    const unit = it.units.find((u: any) => u.barcode === code) ?? it.units[0];
    const same = this.lines().findIndex((l) => l.item_id === it.id && l.unit_id === unit.id);
    if (same >= 0) { this.lines()[same].qty = (this.lines()[same].qty ?? 0) + 1; this.lines.update((ls) => [...ls]); this.touch(); return; }
    const r = this.lines().findIndex((l) => !l.item_id);
    const row = r >= 0 ? r : (this.lines.update((ls) => [...ls, blank()]), this.lines().length - 1);
    await this.setItem(row, it, false);
    this.setUnit(row, unit.id);
    this.lines()[row].qty = 1; this.lines.update((ls) => [...ls]); this.touch();
    el.focus();
  }
  async loadInfo(l: Line | undefined) {
    if (!l?.item_id) { this.info.set(null); return; }
    const it = await this.getItem(l.item_id);
    const mine = it.stock.filter((s: any) => this.whs().some((w) => w.id === s.warehouse_id)).reduce((a: number, s: any) => a + s.qty, 0);
    this.info.set({
      qtyText: `${fq(mine)} ${it.base_unit}${l.factor > 1 ? ` (${fq(Math.floor((mine / l.factor) * 10) / 10)} ${l.unit_name})` : ''}`,
      factor: `${fq(l.factor)} ${it.base_unit}`, cost: it.avg_cost ? money(it.avg_cost * l.factor) : '—',
      last: it.last_sale_price != null ? `${money(it.last_sale_price)} / ${it.last_sale_unit}` : '—',
    });
  }

  // Enter moves to the next cell; from the last cell to the next row (desktop-style data entry).
  next(e: Event, endOfRow = false) {
    e.preventDefault();
    const el = e.target as HTMLElement;
    const r = Number(el.getAttribute('data-r')), c = Number(el.getAttribute('data-c'));
    if (endOfRow) { if (r === this.lines().length - 1) this.lines.update((ls) => [...ls, blank()]); setTimeout(() => this.focusCell(r + 1, 0)); return; }
    this.focusCell(r, c + 1);
  }
  focusCell(r: number, c: number) {
    setTimeout(() => {
      const host = document.querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement | null;
      const el = (host?.matches('input,select') ? host : host?.querySelector('input,select')) as HTMLInputElement | null;
      if (el && !el.disabled && !el.readOnly) { el.focus(); el.select?.(); } else if (c < 7) this.focusCell(r, c + 1);
    });
  }

  // ----- returns -----
  async loadOriginal() {
    const n = Number(this.origNo());
    if (!n) return;
    const orig = await this.api.get(`/invoices/${this.kind() === 'sale_return' ? 'sale' : 'purchase'}/${n}`);
    this.origDoc.set(orig);
    this.onParty({ id: orig.party_id, name: orig.party_name, phone: orig.party_phone, vat_number: orig.party_vat, address: orig.party_address });
    this.method.set(orig.payment_method); this.branchId.set(orig.branch_id);
    this.lines.set(orig.lines.map((x: any) => ({ ...blank(), item_id: x.item_id, code: x.item_code, name: x.item_name, units: [], unit_id: null, unit_name: x.unit_name,
      warehouse_id: x.warehouse_id, qty: x.qty, price: x.price, discount_pct: x.discount_pct, vat_rate: x.vat_rate_pct })));
    this.ui.toast('عدّل الكميات المرتجعة واحذف الأصناف غير المرتجعة');
    this.touch();
  }

  // ----- actions -----
  async add() {
    if (this.mode() === 'new' && this.dirty() && !(await this.ui.confirm('فاتورة جديدة', 'سيتم تجاهل البيانات غير المحفوظة. متابعة؟', 'متابعة', true))) return;
    this.reset();
  }
  async save() {
    if (this.ro() || this.saving()) return;
    const party = this.party();
    if (!party?.id) { this.ui.toast(this.isSale() ? 'اختر العميل' : 'اختر المورد', 'bad'); return; }
    const lines = this.lines().filter((l) => l.item_id);
    if (!lines.length) { this.ui.toast('أدخل صنفاً واحداً على الأقل', 'bad'); return; }
    const bad = lines.findIndex((l) => !l.qty);
    if (bad >= 0) { this.ui.toast(`أدخل الكمية للصنف ${lines[bad].name}`, 'bad'); return; }
    const body: any = {
      kind: this.kind(), branch_id: this.branchId(), date: this.date(), party_id: party.id,
      party_name: this.isSale() ? this.partyName() || undefined : undefined, party_phone: this.phone() || undefined, party_vat: this.isSale() ? this.vat() || undefined : undefined,
      party_address: this.address() || undefined, sales_rep_id: this.isSale() ? this.repId() ?? undefined : undefined, cost_center_id: this.costCenterId() ?? undefined,
      payment_method: this.method(), paid: this.method() === 'credit' ? this.paid() ?? 0 : undefined, ref: this.ref() || undefined, notes: this.notes() || undefined,
      discount_pct: this.invDisc() || undefined, original_invoice_number: this.origDoc()?.number,
      lines: lines.map((l) => ({ item_id: l.item_id, unit_id: l.unit_id ?? undefined, unit_name: l.unit_id ? undefined : l.unit_name, warehouse_id: l.warehouse_id ?? undefined,
        qty: l.qty, free_qty: l.free_qty || undefined, price: this.origDoc() ? undefined : l.price ?? undefined, discount_pct: this.origDoc() ? undefined : l.discount_pct || undefined })),
    };
    this.saving.set(true);
    try {
      const d = await this.api.post('/invoices', body);
      this.ui.toast(`تم حفظ ${TITLES[this.kind()]} رقم ${d.number}`, 'ok');
      this.itemCache.clear();
      await this.refreshNav();
      this.show(d);
    } catch { /* toast already shown */ } finally { this.saving.set(false); }
  }
  edit() {
    if (this.mode() === 'new') return;
    this.ui.toast(this.isSale() ? 'الفاتورة المرحّلة لا تُعدّل حفاظاً على سلامة القيود وتسلسل الفواتير الضريبية. للتصحيح أنشئ فاتورة مرتجع.' : 'الفاتورة المرحّلة لا تُعدّل. للتصحيح أنشئ فاتورة مرتجع.');
  }
  remove() {
    if (this.mode() === 'new') { this.removeRow(this.cur()); return; }
    this.ui.toast('الفواتير المرحّلة لا تُحذف. استخدم فاتورة المرتجع لإلغاء أثرها.');
  }
  print() { if (this.doc()) window.open(`/api/invoices/id/${this.doc().id}/pdf?company=${this.api.companyId}`, '_blank'); }

  async openNumber(n: number) {
    this.searchOpen.set(false);
    this.show(await this.api.get(`/invoices/${this.kind()}/${n}`));
  }
  show(d: any) {
    this.doc.set(d); this.mode.set('view');
    this.party.set({ id: d.party_id, name: d.party_name });
    this.partyName.set(d.party_name); this.phone.set(d.party_phone ?? ''); this.vat.set(d.party_vat ?? ''); this.address.set(d.party_address ?? '');
    this.date.set(d.date); this.branchId.set(d.branch_id); this.costCenterId.set(d.cost_center_id); this.repId.set(d.sales_rep_id);
    this.method.set(d.payment_method); this.paid.set(d.paid); this.ref.set(d.ref ?? ''); this.notes.set(d.notes ?? '');
    this.invDisc.set(null); this.origNo.set(d.original_invoice_number ? String(d.original_invoice_number) : ''); this.origDoc.set(null);
    this.lines.set(d.lines.map((x: any) => ({ ...blank(), item_id: x.item_id, code: x.item_code, name: x.item_name, unit_name: x.unit_name,
      warehouse_id: x.warehouse_id, qty: x.qty, free_qty: x.free_qty || null, price: x.price, discount_pct: x.discount_pct || null, vat_rate: x.vat_rate_pct,
      v: { discount: x.discount, vat: x.vat, total: x.total } })));
    this.info.set(null);
    this.tabs.setTitle(this.tabId(), `${TITLES[this.kind()]} ${d.number}`);
  }
  async go(where: 'first' | 'prev' | 'next' | 'last') {
    const n = this.nav(); if (!n.length) return;
    const curNo = this.mode() === 'view' ? this.doc()?.number : null;
    let i = curNo == null ? n.length : n.indexOf(curNo);
    i = where === 'first' ? 0 : where === 'last' ? n.length - 1 : where === 'prev' ? Math.max(i - 1, 0) : Math.min(i + 1, n.length - 1);
    await this.openNumber(n[i]);
  }
}

function $(el: HTMLInputElement) { return el; }
