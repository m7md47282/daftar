import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Ui } from '../core/ui';
import { money, qty } from '../core/fmt';
import { Tabs } from '../shell/tabs';

type Unit = { id?: number; name: string; factor: number | null; price: number | null; barcode: string; is_default: boolean };

// الأصناف — same layout as the original: basic data on top, units grid below, stock panel.
@Component({
  selector: 'items-form',
  styles: [`
    .layout { display: grid; grid-template-columns: 1fr 300px; gap: 16px; }
    .fields { grid-template-columns: 1fr 1fr; }
    .units { min-height: 150px; }
    .box { border: 1px solid var(--line); border-radius: 3px; padding: 10px 12px; background: var(--panel); }
    .box h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink-2); font-weight: 600; }
    .list { max-height: 60vh; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } .fields { grid-template-columns: 1fr; } }
  `],
  template: `
  <div class="win">
    <div class="win-body">
      <div class="layout">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="fields">
            <div class="f"><label>رقم الصنف</label><input class="inp req num" [value]="code()" [readonly]="!!id()" (input)="code.set($any($event.target).value)" placeholder="تلقائي" /></div>
            <div class="f"><label>التصنيف</label><input class="inp" list="cats" [value]="category()" (input)="category.set($any($event.target).value)" />
              <datalist id="cats">@for (c of categories(); track c) { <option [value]="c"></option> }</datalist></div>
            <div class="f wide"><label>وصف عربي</label><input class="inp req" [value]="nameAr()" (input)="nameAr.set($any($event.target).value)" /></div>
            <div class="f wide"><label>وصف إنجليزي</label><input class="inp" [value]="nameEn()" (input)="nameEn.set($any($event.target).value)" /></div>
            <div class="f"><label>نسبة الضريبة %</label><input class="inp num" [value]="vat()" (input)="vat.set(+$any($event.target).value)" /></div>
            <div class="f"><label>حد الطلب</label><input class="inp num" [value]="reorder() ?? ''" (input)="reorder.set($any($event.target).value === '' ? null : +$any($event.target).value)" /></div>
          </div>
          <div class="grid-wrap units">
            <table class="grid">
              <thead><tr><th>الوحدات</th><th class="n">العبوة (بالوحدة الأساسية)</th><th>الباركود</th><th class="n">سعر البيع</th><th>الوحدة الافتراضية</th><th></th></tr></thead>
              <tbody>
                @for (u of units(); track $index; let i = $index) {
                  <tr>
                    <td class="c-input"><input [value]="u.name" (input)="u.name = $any($event.target).value" [placeholder]="i === 0 ? 'متر' : 'رول'" /></td>
                    <td class="c-input"><input class="num" [value]="u.factor ?? ''" [readonly]="i === 0" (input)="u.factor = +$any($event.target).value" /></td>
                    <td class="c-input"><input class="num" [value]="u.barcode" (input)="u.barcode = $any($event.target).value" /></td>
                    <td class="c-input"><input class="num" [value]="u.price ?? ''" (input)="u.price = +$any($event.target).value" /></td>
                    <td style="text-align:center"><input type="radio" name="def" [checked]="u.is_default" (change)="setDefault(i)" /></td>
                    <td style="text-align:center">@if (i > 0 && !u.id) { <button class="x" (click)="removeUnit(i)">✕</button> }</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div><button class="btn sm" (click)="addUnit()">إدراج وحدة صنف <span class="k">F12</span></button>
            <span class="muted" style="margin-inline-start:10px">الوحدة الأولى هي الأساسية (مثل المتر). الرول = عدد الأمتار فيه.</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="box">
            <h4>الكمية الحالية</h4>
            @if (stock(); as s) {
              @for (w of s.stock; track w.warehouse_id) { <div style="display:flex;justify-content:space-between"><span>{{ w.warehouse_name }}</span><b class="num">{{ q(w.qty) }}</b></div> }
              <div style="display:flex;justify-content:space-between;border-top:1px solid var(--line-soft);margin-top:6px;padding-top:6px"><span>الإجمالي</span><b class="num">{{ q(s.qty) }} {{ s.base_unit }}</b></div>
              @if (auth.isOwner()) { <div style="display:flex;justify-content:space-between" class="muted"><span>متوسط التكلفة</span><span class="num">{{ m(s.avg_cost) }}</span></div> }
            } @else { <span class="muted">صنف جديد</span> }
          </div>
          <div class="box" style="flex:1;display:flex;flex-direction:column;gap:8px">
            <h4>الأصناف</h4>
            <input class="inp" placeholder="بحث بالاسم أو الرقم أو الباركود" (input)="search($any($event.target).value)" />
            <div class="grid-wrap list">
              <table class="grid"><tbody>
                @for (it of list(); track it.id) {
                  <tr class="click" [class.sel]="it.id === id()" (click)="open(it.id)"><td class="num">{{ it.code }}</td><td>{{ it.name_ar }}</td><td class="n">{{ q(it.qty) }}</td></tr>
                }
              </tbody></table>
            </div>
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
export class ItemsForm implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); ui = inject(Ui); tabs = inject(Tabs);
  m = money; q = qty;
  id = signal<number | null>(null); code = signal(''); category = signal('عام'); nameAr = signal(''); nameEn = signal(''); vat = signal(15); reorder = signal<number | null>(null);
  units = signal<Unit[]>([]); stock = signal<any>(null); list = signal<any[]>([]);
  categories = computed(() => [...new Set(this.list().map((i) => i.category))]);
  private t: any;

  async ngOnInit() {
    this.tabs.register(this.tabId(), { F2: () => this.reset(), F3: () => this.save(), F12: () => this.addUnit() });
    this.reset();
    this.list.set(await this.api.get('/items'));
  }
  search(q: string) { clearTimeout(this.t); this.t = setTimeout(async () => this.list.set(await this.api.get('/items', { q })), 200); }
  reset() {
    this.id.set(null); this.code.set(''); this.category.set('عام'); this.nameAr.set(''); this.nameEn.set(''); this.vat.set(15); this.reorder.set(null); this.stock.set(null);
    this.units.set([{ name: 'متر', factor: 1, price: null, barcode: '', is_default: true }, { name: 'رول', factor: null, price: null, barcode: '', is_default: false }]);
  }
  addUnit() { this.units.update((u) => [...u, { name: '', factor: null, price: null, barcode: '', is_default: false }]); }
  removeUnit(i: number) { this.units.update((u) => u.filter((_, j) => j !== i)); }
  setDefault(i: number) { this.units.update((u) => u.map((x, j) => ({ ...x, is_default: j === i }))); }
  async open(id: number) {
    const it = await this.api.get(`/items/${id}`);
    this.id.set(it.id); this.code.set(it.code); this.category.set(it.category); this.nameAr.set(it.name_ar); this.nameEn.set(it.name_en ?? '');
    this.vat.set(it.vat_rate_pct); this.reorder.set(it.reorder_level); this.stock.set(it);
    this.units.set(it.units.map((u: any) => ({ id: u.id, name: u.name, factor: u.factor, price: u.price, barcode: u.barcode ?? '', is_default: u.is_default })));
  }
  async save() {
    const units = this.units().filter((u) => u.name.trim());
    if (!this.nameAr().trim()) { this.ui.toast('أدخل الوصف العربي للصنف', 'bad'); return; }
    if (units.some((u) => !u.factor)) { this.ui.toast('أدخل العبوة لكل وحدة', 'bad'); return; }
    const body = { code: this.code() || undefined, name_ar: this.nameAr(), name_en: this.nameEn() || undefined, category: this.category(), base_unit: units[0]?.name,
      vat_rate_pct: this.vat(), reorder_level: this.reorder() ?? undefined, units: units.map((u) => ({ ...u, factor: u.factor!, price: u.price ?? 0, barcode: u.barcode || undefined })) };
    const it = this.id() ? await this.api.put(`/items/${this.id()}`, body) : await this.api.post('/items', body);
    this.ui.toast(`تم حفظ الصنف ${it.code}`, 'ok');
    await this.open(it.id);
    this.list.set(await this.api.get('/items'));
  }
}
