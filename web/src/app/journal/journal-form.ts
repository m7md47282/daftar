import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api, ApiError, openBinary } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { money, today, hijri, viaLabel } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { AccountPicker } from '../docs/pickers';

type Line = { account: any; description: string; debit: string; credit: string };
const blank = (): Line => ({ account: null, description: '', debit: '', credit: '' });
const PURPOSE: Record<string, string> = { normal: 'قيد عادي', adjustment: 'تسوية مراجعة', opening: 'افتتاح التأسيس', closing: 'إقفال نظامي' };
const EQ: Record<string, string> = { contribution: 'مساهمات', distribution: 'توزيعات أو مسحوبات', reserve_transfer: 'تحويل احتياطي', prior_adjustment: 'تعديل مباشر سابق', other: 'حركات أخرى' };
// exact decimal sum of typed amounts (in halalas) for the on-screen totals
const toH = (s: string) => { const t = (s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٬,]/g, '').replace('٫', '.'); if (!/^\d+(\.\d{1,2})?$/.test(t)) return 0; const [i, f = ''] = t.split('.'); return Number(i) * 100 + Number((f + '00').slice(0, 2)); };

// سند قيد — the manual journal entry of the core (§14–18): drafts, posting, copy, reversal, attachments.
@Component({
  selector: 'journal-form',
  imports: [AccountPicker, DatePipe],
  styles: [`
    .head { display: grid; grid-template-columns: 1.3fr 1fr; gap: 8px 28px; }
    .col { display: flex; flex-direction: column; gap: 8px; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; } .pair .f { grid-template-columns: 96px 1fr; }
    .lines { min-height: 220px; max-height: 40vh; } .lines td.acc { width: 320px; } .lines td.amt { width: 140px; }
    .lines td.del { width: 34px; text-align: center; padding: 0; } .lines td.del button { border: 0; background: transparent; color: var(--danger); cursor: pointer; width: 30px; height: 30px; }
    .bottom { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; align-items: start; }
    .sum { display: grid; grid-template-columns: auto 160px; gap: 6px 10px; align-items: center; justify-self: end; } .sum label { color: var(--ink-2); font-size: 13px; }
    .att { border: 1px solid var(--line); border-radius: 3px; background: var(--panel); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
    .att .r { display: flex; gap: 8px; align-items: center; } .att .r.ex { opacity: .55; text-decoration: line-through; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    @media (max-width: 1100px) { .head, .bottom { grid-template-columns: 1fr; } }
  `],
  template: `
  <div class="win">
    <div class="win-body">
      <div class="links">
        @if (entry(); as e) {
          <span class="chip ok">مرحّل — {{ purpose(e.purpose) }}</span>
          <span class="muted">أنشأه {{ e.created_by_name }} · رحّله {{ e.posted_by_name }} في {{ e.posted_at | date: 'yyyy-MM-dd HH:mm' }}</span>
          @if (via(e.via)) { <span class="chip ai">{{ via(e.via) }}</span> }
          @if (e.origin !== 'journal') { <span class="chip">مصدره: {{ origin(e.origin) }}</span> }
          @if (e.source_number) { <a (click)="openNumber(e.source_number)">منسوخ من القيد {{ e.source_number }}</a> }
          @if (e.reverses_number) { <a (click)="openNumber(e.reverses_number)">يعكس القيد {{ e.reverses_number }}</a> }
          @if (e.reversed_by_number) { <a (click)="openNumber(e.reversed_by_number)"><span class="chip bad">معكوس بالقيد {{ e.reversed_by_number }}</span></a> }
        } @else if (draft(); as d) {
          <span class="chip">{{ d.status === 'draft' ? 'مسودة — لا أثر مالي' : d.status === 'cancelled' ? 'مسودة ملغاة' : d.status === 'deferred' ? 'مسودة مؤجلة' : 'مسودة مرحّلة' }}</span>
          <span class="muted">نسخة {{ d.version }} · آخر تعديل {{ d.updated_by_name }} {{ d.updated_at | date: 'yyyy-MM-dd HH:mm' }}</span>
          @if (d.status_reason) { <span class="muted">السبب: {{ d.status_reason }}</span> }
          @if (d.reverses_number) { <span class="chip">عكس للقيد {{ d.reverses_number }}</span> }
          @if (d.source_number) { <span class="chip">نسخة من القيد {{ d.source_number }}</span> }
        } @else { <span class="chip">قيد جديد</span> }
      </div>
      <div class="head">
        <div class="col">
          <div class="f"><label>رقم القيد</label><input class="inp req num" readonly style="max-width:200px" [value]="entry()?.number ?? (draft() ? 'مسودة ' + draft().id : 'جديد')" /></div>
          <div class="f"><label>البيان</label><input class="inp req" [readonly]="ro()" maxlength="500" [value]="description()" (input)="description.set($any($event.target).value)" /></div>
          <div class="f"><label>رقم المرجع</label><input class="inp" [readonly]="ro()" maxlength="200" [value]="reference()" (input)="reference.set($any($event.target).value)" /></div>
          <div class="f"><label>تصنيف حركة الحقوق</label>
            <select class="inp" [disabled]="ro()" (change)="equityClass.set($any($event.target).value || null)">
              <option value="">— (عند وجود حركة مباشرة على حقوق الملكية)</option>
              @for (k of eqKeys; track k) { <option [value]="k" [selected]="k === equityClass()">{{ EQ[k] }}</option> }
            </select></div>
        </div>
        <div class="col">
          <div class="pair">
            <div class="f"><label>التاريخ المحاسبي</label><input class="inp num" type="date" [readonly]="ro()" [value]="date()" (input)="date.set($any($event.target).value)" /></div>
            <div class="f"><label>تاريخ هجري</label><input class="inp num" readonly [value]="hijri(date())" /></div>
          </div>
          <div class="f"><label>السنة المالية</label><input class="inp" readonly [value]="yearLabel()" [class.bad]="!year() && !!date()" /></div>
          <div class="f"><label>الغرض</label>
            <select class="inp" [disabled]="ro()" (change)="purposeV.set($any($event.target).value)">
              <option value="normal" [selected]="purposeV() === 'normal'">قيد عادي</option>
              <option value="adjustment" [selected]="purposeV() === 'adjustment'">تسوية مراجعة</option>
              <option value="opening" [selected]="purposeV() === 'opening'">افتتاح التأسيس (مرة واحدة)</option>
            </select></div>
          @if (purposeV() === 'adjustment') {
            <div class="f"><label>دفعة التسويات</label>
              <select class="inp req" [disabled]="ro()" (change)="batchId.set(+$any($event.target).value || null)">
                <option value="">اختر الدفعة…</option>
                @for (b of batches(); track b.id) { <option [value]="b.id" [selected]="b.id === batchId()">{{ b.cycle }} — {{ b.name }}</option> }
              </select></div>
          }
          @if (auth.isOwner() && lk.branches().length > 1) {
            <div class="f"><label>الفرع</label>
              <select class="inp" [disabled]="ro()" (change)="branchId.set(+$any($event.target).value || null)">
                <option value="">على مستوى الشركة</option>
                @for (b of lk.branches(); track b.id) { <option [value]="b.id" [selected]="b.id === branchId()">{{ b.name }}</option> }
              </select></div>
          }
        </div>
      </div>

      <div class="grid-wrap lines">
        <table class="grid">
          <thead><tr><th>رقم الحساب / إسم الحساب</th><th>البيان</th><th class="n">مدين</th><th class="n">دائن</th><th></th></tr></thead>
          <tbody>
            @for (l of lines(); track $index; let r = $index) {
              <tr>
                <td class="c-input acc">
                  @if (ro()) { <input readonly [value]="l.account ? l.account.code + ' - ' + l.account.name : ''" /> }
                  @else { <account-picker [value]="l.account" (picked)="l.account = $event; touch()" /> }
                </td>
                <td class="c-input"><input [readonly]="ro()" maxlength="500" [value]="l.description" (input)="l.description = $any($event.target).value" (keydown.enter)="$event.preventDefault()" /></td>
                <td class="c-input amt"><input class="num" [readonly]="ro()" [value]="l.debit" (input)="l.debit = $any($event.target).value; touch()" (keydown.enter)="$event.preventDefault()" /></td>
                <td class="c-input amt"><input class="num" [readonly]="ro()" [value]="l.credit" (input)="l.credit = $any($event.target).value; touch()" (keydown.enter)="$event.preventDefault(); addRowIfLast(r)" /></td>
                <td class="del">@if (!ro()) { <button title="حذف السطر" (click)="removeRow(r)">✕</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="bottom">
        <div style="display:flex;flex-direction:column;gap:8px">
          @if (!ro()) { <div style="display:flex;gap:6px"><button class="btn sm" (click)="addRow()">إدراج سطر <span class="k">F11</span></button>
            <button class="btn sm" (click)="copyLast()">نسخ السطر الأخير</button></div> }
          <div class="att">
            <b>المرفقات ({{ activeAtts() }} من 5) — PDF أو JPEG أو PNG حتى 10 ميغابايت</b>
            @for (a of attachments(); track a.id) {
              <div class="r" [class.ex]="a.excluded_at"><a (click)="download(a)">{{ a.filename }}</a><span class="muted">{{ (a.size / 1024).toFixed(0) }} ك.ب</span>
                @if (!a.excluded_at) { <button class="btn sm" (click)="exclude(a)">استبعاد</button> } @else { <span class="muted">مستبعد: {{ a.exclusion_reason }}</span> }</div>
            } @empty { <span class="muted">لا مرفقات</span> }
            @if (entry() || draft()) { <label class="btn sm" style="width:fit-content">إرفاق ملف<input type="file" accept="application/pdf,image/jpeg,image/png" hidden (change)="upload($event)" /></label> }
            @else { <span class="muted">احفظ المسودة أولًا لإرفاق المستندات</span> }
          </div>
        </div>
        <div class="nav" style="align-self:center">
          <button (click)="go('first')" [disabled]="!nav().length">⏮</button><button (click)="go('prev')" [disabled]="!nav().length">◀</button>
          <div class="pos">{{ navText() }}</div>
          <button (click)="go('next')" [disabled]="!nav().length">▶</button><button (click)="go('last')" [disabled]="!nav().length">⏭</button>
        </div>
        <div class="sum">
          <label>مجموع مدين</label><input class="inp req num" readonly [value]="m(totD() / 100)" />
          <label>مجموع دائن</label><input class="inp req num" readonly [value]="m(totC() / 100)" />
          <label>الفرق</label><input class="inp num" readonly [value]="m(Math.abs(totD() - totC()) / 100)" [class.bad]="totD() !== totC()" />
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" (click)="newDraft()">إضافة <span class="k">F2</span></button>
      <button class="btn" (click)="saveDraft()" [disabled]="ro() || busy()">حفظ مسودة <span class="k">F3</span></button>
      <button class="btn primary" (click)="post()" [disabled]="ro() || busy()">ترحيل <span class="k">F10</span></button>
      <button class="btn" (click)="searchByNumber()">بحث <span class="k">F5</span></button>
      @if (entry()) {
        <button class="btn" (click)="copy()">نسخ إلى مسودة</button>
        @if (entry().purpose !== 'closing' && !entry().reversed_by_number) { <button class="btn" (click)="reverse()">عكس القيد</button> }
        <button class="btn" (click)="print()">طباعة <span class="k">F7</span></button>
      }
      @if (draft()?.status === 'draft') {
        <button class="btn danger" (click)="setStatus('cancel')">إلغاء المسودة</button>
        <button class="btn" (click)="setStatus('defer')">تأجيل بسبب</button>
      }
      <span class="spacer"></span>
      <button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button>
    </div>
  </div>`,
})
export class JournalForm implements OnInit {
  tabId = input.required<number>();
  number = input<number | null>(null);
  draftId = input<number | null>(null);
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); tabs = inject(Tabs);
  m = money; hijri = hijri; Math = Math; EQ = EQ; eqKeys = Object.keys(EQ);
  purpose = (p: string) => PURPOSE[p]; via = (v: string) => viaLabel[v];
  origin = (o: string) => ({ invoice: 'فاتورة', voucher: 'سند قبض/صرف', closing: 'إقفال السنة', import: 'بيانات منقولة' } as any)[o] ?? o;

  entry = signal<any>(null); draft = signal<any>(null); nav = signal<number[]>([]); busy = signal(false); review = signal<any[]>([]);
  date = signal(today()); description = signal(''); reference = signal(''); purposeV = signal<'normal' | 'adjustment' | 'opening'>('normal');
  batchId = signal<number | null>(null); equityClass = signal<string | null>(null); branchId = signal<number | null>(null);
  lines = signal<Line[]>([]); version = signal(0);
  attachments = signal<any[]>([]);

  ro = computed(() => !!this.entry() || (!!this.draft() && this.draft().status !== 'draft'));
  year = computed(() => this.lk.yearFor(this.date()));
  yearLabel = computed(() => { const y = this.year(); return y ? `${y.name} — ${y.status_label}` : 'لا توجد سنة مالية لهذا التاريخ'; });
  batches = computed(() => this.review().filter((cy) => cy.status === 'open' && cy.year_id === this.year()?.id && cy.start_date <= this.date() && cy.end_date >= this.date())
    .flatMap((cy) => cy.batches.filter((b: any) => b.status === 'open').map((b: any) => ({ ...b, cycle: cy.name }))));
  totD = computed(() => { this.version(); return this.lines().reduce((s, l) => s + toH(l.debit), 0); });
  totC = computed(() => { this.version(); return this.lines().reduce((s, l) => s + toH(l.credit), 0); });
  activeAtts = computed(() => this.attachments().filter((a) => !a.excluded_at).length);
  navText = computed(() => { const n = this.nav(); if (!n.length) return 'لا توجد قيود'; return this.entry() ? `${this.entry().number} من ${n[n.length - 1]}` : `جديد · ${n.length} قيد`; });

  async ngOnInit() {
    this.tabs.register(this.tabId(), { F2: () => this.newDraft(), F3: () => this.saveDraft(), F10: () => this.post(), F5: () => this.searchByNumber(), F7: () => this.print(), F11: () => this.addRow(),
      beforeClose: async () => this.ro() || !this.dirty() || this.ui.confirm('إغلاق', 'توجد تعديلات غير محفوظة. الإغلاق دون حفظ؟', 'إغلاق', true) } as any);
    if (!this.lk.branches().length) await this.lk.load();
    this.review.set(await this.api.get('/review'));
    await this.loadNav();
    if (this.number()) await this.openNumber(this.number()!);
    else if (this.draftId()) await this.openDraft(this.draftId()!);
    else this.reset();
  }
  dirty() { return this.lines().some((l) => l.account || l.debit || l.credit) || !!this.description(); }
  touch() { this.version.update((v) => v + 1); }
  async loadNav() { this.nav.set((await this.api.get('/entries', { limit: 1000 })).map((e: any) => e.number).sort((a: number, b: number) => a - b)); }

  reset() {
    this.entry.set(null); this.draft.set(null); this.attachments.set([]);
    this.date.set(today()); this.description.set(''); this.reference.set(''); this.purposeV.set('normal'); this.batchId.set(null); this.equityClass.set(null); this.branchId.set(null);
    this.lines.set(Array.from({ length: 5 }, blank)); this.touch();
    this.tabs.setTitle(this.tabId(), 'سند قيد');
  }
  async newDraft() {
    if (!this.ro() && this.dirty() && !(await this.ui.confirm('قيد جديد', 'سيتم تجاهل التعديلات غير المحفوظة. متابعة؟', 'متابعة', true))) return;
    this.reset();
  }
  addRow() { this.lines.update((ls) => (ls.length >= 200 ? ls : [...ls, blank()])); }
  addRowIfLast(r: number) { if (r === this.lines().length - 1) this.addRow(); }
  copyLast() { const ls = this.lines().filter((l) => l.account); const last = ls[ls.length - 1]; if (last) this.lines.update((x) => [...x, { ...last }]); this.touch(); }
  removeRow(r: number) { this.lines.update((ls) => { const n = ls.filter((_, i) => i !== r); while (n.length < 5) n.push(blank()); return n; }); this.touch(); }

  body() {
    return { date: this.date() || null, description: this.description() || null, reference: this.reference() || null, purpose: this.purposeV(),
      batch_id: this.purposeV() === 'adjustment' ? this.batchId() : null, equity_class: this.equityClass(), branch_id: this.branchId(),
      lines: this.lines().filter((l) => l.account || l.debit || l.credit).map((l) => ({ account_id: l.account?.id ?? null, description: l.description || null, debit: l.debit || null, credit: l.credit || null })) };
  }
  async saveDraft(): Promise<any> {
    if (this.ro()) return null;
    this.busy.set(true);
    try {
      const d = this.draft() ? await this.api.put(`/drafts/${this.draft().id}`, { ...this.body(), version: this.draft().version }) : await this.api.post('/drafts', this.body());
      this.showDraft(d);
      this.ui.toast(`حُفظت المسودة رقم ${d.id} — لا أثر مالي حتى الترحيل`, 'ok');
      return d;
    } catch (e) { if (e instanceof ApiError && e.status === 409) await this.offerReload(); return null; } finally { this.busy.set(false); }
  }
  async offerReload() {
    if (await this.ui.confirm('تعارض', 'عدّل شخص آخر هذه المسودة. إعادة تحميل آخر نسخة؟ (ستفقد تعديلاتك الحالية)', 'إعادة التحميل')) await this.openDraft(this.draft().id);
  }
  async post() {
    if (this.ro() || this.busy()) return;
    if (this.totD() !== this.totC()) { this.ui.toast(`القيد غير متوازن — الفرق ${money(Math.abs(this.totD() - this.totC()) / 100)}`, 'bad'); return; }
    if (!(await this.ui.confirm('ترحيل القيد', `سيُرحّل القيد بتاريخ ${this.date()} بإجمالي ${money(this.totD() / 100)} ولن يُعدّل بعد ذلك (التصحيح بقيد جديد). متابعة؟`, 'ترحيل'))) return;
    const d = await this.saveDraft();
    if (!d) return;
    this.busy.set(true);
    try {
      const e = await this.api.post(`/drafts/${d.id}/post`, { version: d.version });
      this.ui.toast(`رُحّل القيد رقم ${e.number}`, 'ok');
      await this.loadNav();
      this.showEntry(e);
    } catch (e) { if (e instanceof ApiError && e.status === 409) await this.offerReload(); } finally { this.busy.set(false); }
  }
  async setStatus(kind: 'cancel' | 'defer') {
    const reason = await this.ui.prompt(kind === 'cancel' ? 'إلغاء المسودة' : 'تأجيل المسودة', 'تبقى المسودة محفوظة بلا أثر مالي مع سببها.', 'السبب', kind === 'cancel' ? 'إلغاء المسودة' : 'تأجيل', { danger: kind === 'cancel' });
    if (!reason) return;
    await this.api.post(`/drafts/${this.draft().id}/${kind}`, { reason });
    await this.openDraft(this.draft().id);
  }
  async copy() { const d = await this.api.post(`/entries/${this.entry().id}/copy`); this.ui.toast('أُنشئت مسودة مستقلة من القيد — راجعها ثم رحّلها', 'ok'); this.showDraft(d); }
  async reverse() {
    const date = await this.ui.prompt('عكس القيد', 'يبقى القيد الأصلي في الدفاتر، ويُنشأ قيد معاكس مرتبط به بالتاريخ الذي تختاره (مسودة للمراجعة).', 'تاريخ العكس (YYYY-MM-DD)', 'إنشاء مسودة العكس');
    if (!date) return;
    const d = await this.api.post(`/entries/${this.entry().id}/reverse`, { date });
    this.showDraft(d);
  }
  async print() { if (this.entry()) await openBinary(this.api, `/entries/${this.entry().id}/pdf`); }

  async searchByNumber() {
    const n = await this.ui.prompt('بحث', 'رقم القيد المرحّل', 'رقم القيد', 'فتح');
    if (n) await this.openNumber(Number(n));
  }
  async openNumber(n: number) { this.showEntry(await this.api.get(`/entries/number/${n}`)); }
  async openDraft(id: number) { this.showDraft(await this.api.get(`/drafts/${id}`)); }

  private accountsCache: any[] | null = null;
  async accountsById() { this.accountsCache ??= await this.api.get('/accounts'); return new Map(this.accountsCache!.map((a: any) => [a.id, a])); }
  showEntry(e: any) {
    this.draft.set(null); this.entry.set(e); this.attachments.set(e.attachments);
    this.date.set(e.date); this.description.set(e.description); this.reference.set(e.reference ?? ''); this.purposeV.set(e.purpose); this.batchId.set(e.batch_id);
    this.equityClass.set(e.equity_class); this.branchId.set(e.branch_id);
    this.lines.set(e.lines.map((l: any) => ({ account: { id: l.account_id, code: l.account_code, name: l.account_name }, description: l.description ?? '', debit: Number(l.debit) ? l.debit : '', credit: Number(l.credit) ? l.credit : '' })));
    this.touch(); this.tabs.setTitle(this.tabId(), `قيد ${e.number}`);
  }
  async showDraft(d: any) {
    const accs = await this.accountsById();
    this.entry.set(null); this.draft.set(d); this.attachments.set(d.attachments ?? []);
    this.date.set(d.date ?? today()); this.description.set(d.description ?? ''); this.reference.set(d.reference ?? ''); this.purposeV.set(d.purpose); this.batchId.set(d.batch_id);
    this.equityClass.set(d.equity_class); this.branchId.set(d.branch_id);
    const ls = (d.lines ?? []).map((l: any) => ({ account: l.account_id ? accs.get(l.account_id) ?? { id: l.account_id, code: '?', name: '' } : null, description: l.description ?? '', debit: l.debit ?? '', credit: l.credit ?? '' }));
    while (ls.length < 5) ls.push(blank());
    this.lines.set(ls); this.touch(); this.tabs.setTitle(this.tabId(), `مسودة ${d.id}`);
  }
  async go(where: 'first' | 'prev' | 'next' | 'last') {
    const n = this.nav(); if (!n.length) return;
    let i = this.entry() ? n.indexOf(this.entry().number) : n.length;
    i = where === 'first' ? 0 : where === 'last' ? n.length - 1 : where === 'prev' ? Math.max(i - 1, 0) : Math.min(i + 1, n.length - 1);
    await this.openNumber(n[i]);
  }

  async upload(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { this.ui.toast('حجم الملف يتجاوز 10 ميغابايت', 'bad'); return; }
    const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); });
    await this.api.post('/attachments', { filename: f.name, data, ...(this.entry() ? { entry_id: this.entry().id } : { draft_id: this.draft().id }) });
    this.ui.toast('أُرفق الملف', 'ok');
    if (this.entry()) await this.openNumber(this.entry().number); else await this.openDraft(this.draft().id);
  }
  async download(a: any) { await openBinary(this.api, `/attachments/${a.id}`); }
  async exclude(a: any) {
    const reason = await this.ui.prompt('استبعاد مرفق', 'لا يُحذف المرفق؛ يبقى أصله محفوظًا ويظهر مستبعدًا مع السبب.', 'سبب الاستبعاد', 'استبعاد', { danger: true });
    if (!reason) return;
    await this.api.post(`/attachments/${a.id}/exclude`, { reason });
    if (this.entry()) await this.openNumber(this.entry().number); else await this.openDraft(this.draft().id);
  }
}
