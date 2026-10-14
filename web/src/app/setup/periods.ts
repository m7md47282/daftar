import { Component, OnInit, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { Reauth } from '../core/reauth';
import { money } from '../core/fmt';
import { Tabs } from '../shell/tabs';

// السنوات والفترات (§12–13): years with monthly periods; lock/reopen need the person's own password.
@Component({
  selector: 'years-view', imports: [DatePipe],
  styles: [`.year { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .year h3 { margin: 0; font-size: 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .periods { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
    .p { border: 1px solid var(--line); border-radius: 3px; padding: 6px 8px; font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
    .p.locked { background: var(--danger-soft); } .p.adjustments_only { background: #fff4d6; } .p.open { background: var(--ok-soft); }
    .p .acts { display: flex; gap: 4px; flex-wrap: wrap; } .p button { font-size: 11px; height: 22px; padding: 0 6px; }`],
  template: `
  <div class="win"><div class="win-body">
    <div class="banner info">قفل الفترة يمنع التسجيل فيها، وليس هو إقفال النتيجة. يمكن العمل في سنة جديدة بينما السابقة تحت المراجعة.</div>
    @for (y of years(); track y.id) {
      <div class="year">
        <h3>{{ y.name }} <span class="muted num">{{ y.start_date }} — {{ y.end_date }}</span>
          <span class="chip" [class.ok]="y.status === 'final'" [class.bad]="y.status === 'needs_supplementary'">{{ y.status_label }}</span>
          @if (y.needs_dependency_review) { <span class="chip bad">تحتاج مراجعة لتغير سنة سابقة</span> }</h3>
        @if (y.gap_reason) { <div class="muted">سبب الفجوة: {{ y.gap_reason }}</div> }
        @if (auth.isOwner()) {
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            @if (y.status === 'open') { <button class="btn sm" (click)="review(y)">بدء المراجعة (تسويات فقط)</button> }
            @if (y.status !== 'open') { <button class="btn sm danger" (click)="reopenYear(y)">إعادة فتح السنة</button> }
          </div>
        }
        <div class="periods">
          @for (p of y.periods; track p.id) {
            <div class="p" [class]="'p ' + p.status"><b class="num">{{ p.start_date.slice(0, 7) }}</b><span class="muted num">{{ p.start_date.slice(8) }}–{{ p.end_date.slice(8) }}</span><span>{{ p.status_label }}</span>
              @if (auth.isOwner() && y.status !== 'final') {
                <div class="acts">
                  @if (p.status === 'open') { <button class="btn" (click)="lock(p, 'adjustments_only')">تسويات فقط</button> }
                  @if (p.status !== 'locked') { <button class="btn" (click)="lock(p, 'locked')">قفل</button> }
                  @if (p.status !== 'open') { <button class="btn" (click)="reopen(p)">فتح</button> }
                </div>
              }
            </div>
          }
        </div>
      </div>
    }
    @if (auth.isOwner()) {
      <div class="filters"><label>سنة جديدة من</label><input class="inp num" type="date" #s /><label>إلى</label><input class="inp num" type="date" #e />
        <input class="inp" placeholder="الاسم (اختياري)" #n /><button class="btn sm primary" (click)="create(s.value, e.value, n.value)">فتح السنة</button></div>
    }
    <h3 style="margin:8px 0 0">سجل القفل وإعادة الفتح</h3>
    <div class="grid-wrap" style="max-height:30vh"><table class="grid"><thead><tr><th>الوقت</th><th>الإجراء</th><th>من</th><th>إلى</th><th>السبب</th><th>المستخدم</th></tr></thead>
      <tbody>@for (e of events(); track e.id) { <tr><td class="num">{{ e.at | date: 'yyyy-MM-dd HH:mm' }}</td><td>{{ e.action_label }} — {{ e.target }}</td><td>{{ e.from_label }}</td><td>{{ e.to_label }}</td><td>{{ e.reason }}</td><td>{{ e.user_name }}</td></tr> }</tbody></table></div>
  </div></div>`,
})
export class YearsView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); reauth = inject(Reauth);
  years = signal<any[]>([]); events = signal<any[]>([]);
  async ngOnInit() { await this.load(); }
  async load() { this.years.set(await this.api.get('/years')); this.events.set(await this.api.get('/period-events')); await this.lk.load(); }
  async create(s: string, e: string, name: string) {
    let gap: string | null = null;
    try { await this.api.post('/years', { start_date: s, end_date: e, name: name || undefined }, { quiet: true }); }
    catch (err: any) {
      if (!/فجوة/.test(err.message)) { this.ui.toast(err.message, 'bad'); return; }
      gap = await this.ui.prompt('فجوة زمنية', err.message, 'سبب الفجوة', 'فتح السنة');
      if (!gap) return;
      await this.api.post('/years', { start_date: s, end_date: e, name: name || undefined, gap_reason: gap });
    }
    this.ui.toast('فُتحت السنة وفتراتها الشهرية', 'ok'); await this.load();
  }
  async review(y: any) {
    if (!(await this.ui.confirm('بدء المراجعة', `لن يُقبل في ${y.name} إلا تسويات المراجعة. يمكن الاستمرار في تسجيل عمليات السنة الجديدة.`, 'متابعة'))) return;
    await this.api.post(`/years/${y.id}/review`); await this.load();
  }
  async lock(p: any, to: string) {
    const t = await this.reauth.token('period.lock', `${to === 'locked' ? 'قفل' : 'تخصيص للتسويات'} فترة ${p.start_date.slice(0, 7)}`);
    if (!t) return;
    await this.api.post(`/periods/${p.id}/lock`, { to, reauth: t }); this.ui.toast('تم', 'ok'); await this.load();
  }
  async reopen(p: any) {
    const reason = await this.ui.prompt('إعادة فتح الفترة', 'لا يغيّر الفتح أي قيد مرحّل؛ التصحيح يبقى قيدًا جديدًا.', 'السبب', 'متابعة');
    if (!reason) return;
    const to = p.status === 'locked' && (await this.ui.confirm('إلى أي حالة؟', 'فتح كامل للتسجيل؟ (اختر "رجوع" لتسويات المدير فقط)', 'فتح كامل')) ? 'open' : p.status === 'locked' ? 'adjustments_only' : 'open';
    const t = await this.reauth.token('period.reopen', `إعادة فتح ${p.start_date.slice(0, 7)}`);
    if (!t) return;
    await this.api.post(`/periods/${p.id}/reopen`, { to, reason, reauth: t }); this.ui.toast('أعيد فتح الفترة', 'ok'); await this.load();
  }
  async reopenYear(y: any) {
    const reason = await this.ui.prompt(`إعادة فتح ${y.name}`, 'تبقى النسخ السابقة كما هي وتُوسم، والسنوات اللاحقة المعتمدة توسم بحاجتها للمراجعة. لا يُعدّل أي قيد.', 'السبب', 'متابعة', { danger: true });
    if (!reason) return;
    const t = await this.reauth.token('year.reopen', `إعادة فتح ${y.name}`);
    if (!t) return;
    const r = await this.api.post(`/years/${y.id}/reopen`, { to: 'under_review', periods_to: 'open', reason, reauth: t });
    this.ui.toast(r.flagged_later_years?.length ? `أعيد الفتح؛ وُسمت للمراجعة: ${r.flagged_later_years.map((x: any) => x.name).join('، ')}` : 'أعيد فتح السنة للمراجعة', 'ok');
    await this.load();
  }
}

// دورات المراجعة ودفعات التسويات (§22)
@Component({
  selector: 'review-view',
  template: `
  <div class="win"><div class="win-body">
    <div class="banner info">قيد التسوية يُرحّل بغرض "تسوية مراجعة" ويُربط بدفعة مفتوحة من دورة تغطي تاريخه في السنة نفسها.</div>
    @for (c of cycles(); track c.id) {
      <div style="background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:10px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>{{ c.name }}</b><span class="muted">{{ c.year_name }} · {{ c.start_date }} — {{ c.end_date }}</span>
          <span class="chip" [class.ok]="c.status === 'open'">{{ c.status === 'open' ? 'مفتوحة' : 'مغلقة' }}</span>
          @if (auth.isOwner()) { <button class="btn sm" (click)="toggleCycle(c)">{{ c.status === 'open' ? 'إغلاق الدورة' : 'فتح الدورة' }}</button> }</div>
        <table class="grid"><tbody>@for (b of c.batches; track b.id) { <tr><td>{{ b.name }}</td><td class="muted">{{ b.entries }} قيد</td>
          <td><span class="chip" [class.ok]="b.status === 'open'">{{ b.status === 'open' ? 'مفتوحة' : 'مغلقة' }}</span></td>
          <td>@if (auth.isOwner()) { <button class="btn sm" (click)="toggleBatch(b)">{{ b.status === 'open' ? 'إغلاق' : 'فتح' }}</button> }</td></tr> }</tbody></table>
        @if (auth.isOwner() && c.status === 'open') { <div class="filters"><input class="inp" placeholder="اسم دفعة جديدة" #bn /><button class="btn sm" (click)="batch(c, bn.value); bn.value = ''">إضافة دفعة</button></div> }
      </div>
    } @empty { <div class="muted">لا توجد دورات مراجعة بعد.</div> }
    @if (auth.isOwner()) {
      <h3 style="margin:6px 0 0">دورة مراجعة جديدة</h3>
      <div class="filters">
        <select class="inp" #y>@for (yy of lk.fiscalYears(); track yy.id) { <option [value]="yy.id">{{ yy.name }}</option> }</select>
        <input class="inp" placeholder="اسم الدورة" #n /><label>من</label><input class="inp num" type="date" #s /><label>إلى</label><input class="inp num" type="date" #e />
        <button class="btn sm primary" (click)="cycle(+y.value, n.value, s.value, e.value)">إنشاء</button>
      </div>
    }
  </div></div>`,
})
export class ReviewView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui);
  cycles = signal<any[]>([]);
  async ngOnInit() { await this.lk.load(); await this.load(); }
  async load() { this.cycles.set(await this.api.get('/review')); }
  async cycle(year_id: number, name: string, start_date: string, end_date: string) { await this.api.post('/review/cycles', { year_id, name, start_date, end_date }); await this.load(); }
  async batch(c: any, name: string) { await this.api.post('/review/batches', { cycle_id: c.id, name }); await this.load(); }
  async toggleCycle(c: any) { await this.api.patch(`/review/cycles/${c.id}`, { status: c.status === 'open' ? 'closed' : 'open' }); await this.load(); }
  async toggleBatch(b: any) { await this.api.patch(`/review/batches/${b.id}`, { status: b.status === 'open' ? 'closed' : 'open' }); await this.load(); }
}

// إقفال السنة المالية (§25)
@Component({
  selector: 'closing-view', imports: [DatePipe],
  template: `
  <div class="win"><div class="win-body">
    <div class="filters"><label>السنة</label>
      <select class="inp" (change)="pick(+$any($event.target).value)"><option value="">اختر…</option>
        @for (y of lk.fiscalYears(); track y.id) { <option [value]="y.id">{{ y.name }} — {{ y.status_label }}</option> }</select></div>
    @if (d(); as d) {
      <div class="banner info">ينقل الإقفال متبقي الحسابات المؤقتة لهذه السنة إلى الأرباح المبقاة بتاريخ آخر يوم فيها. إعادة التشغيل لا تنقل إلا الفرق. نجاح الإقفال لا يعني أن كل الاستحقاقات والتسويات سُجّلت — هذا حكم المحاسب.</div>
      <div class="kpis"><div class="kpi"><div class="l">النتيجة المتبقية للتحويل</div><div class="v">{{ m(+d.net_result) }}</div><div class="s">{{ +d.net_result >= 0 ? 'ربح' : 'خسارة' }}</div></div>
        <div class="kpi"><div class="l">حالة السنة</div><div class="v" style="font-size:16px">{{ d.year.status_label }}</div></div></div>
      @if (d.lines.length) {
        <div class="grid-wrap" style="max-height:30vh"><table class="grid"><thead><tr><th>الحساب</th><th class="n">المتبقي (مدين +)</th></tr></thead>
          <tbody>@for (l of d.lines; track l.account_id) { <tr><td>{{ l.code }} — {{ l.name }}</td><td class="n">{{ m(+l.remaining) }}</td></tr> }</tbody></table></div>
      } @else { <div class="muted">لا يوجد متبقٍ في الحسابات المؤقتة — الإقفال يسجل تحققًا بلا قيد.</div> }
      @if (d.blockers.length) { <div class="banner bad"><div><b>شروط الإقفال النهائي غير مكتملة:</b>@for (b of d.blockers; track b) { <div>• {{ b }}</div> }</div></div> }
      @if (auth.isOwner()) {
        <div style="display:flex;gap:8px"><button class="btn" (click)="run('preliminary')">إقفال تمهيدي (تبقى تحت المراجعة)</button>
          <button class="btn primary" (click)="run('final')" [disabled]="d.blockers.length">إقفال واعتماد نهائي</button></div>
      }
      <h3 style="margin:6px 0 0">إجراءات الإقفال السابقة</h3>
      <table class="grid"><thead><tr><th>#</th><th>النوع</th><th>الحالة</th><th class="n">المبلغ</th><th>السبب</th><th>المستخدم</th><th>الوقت</th></tr></thead>
        <tbody>@for (r of d.runs; track r.id) { <tr><td class="num">{{ r.run_no }}</td><td>{{ r.kind === 'verify' ? 'تحقق بلا قيد' : 'تحويل' }}</td><td>{{ r.mode === 'final' ? 'نهائي' : 'تمهيدي' }}</td>
          <td class="n">{{ m(+r.amount) }}</td><td>{{ r.reason }}</td><td>{{ r.user_name }}</td><td class="num">{{ r.at | date: 'yyyy-MM-dd HH:mm' }}</td></tr> }</tbody></table>
    }
  </div></div>`,
})
export class ClosingView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); lk = inject(Lookups); ui = inject(Ui); reauth = inject(Reauth); m = money;
  yearId = signal<number | null>(null); d = signal<any>(null);
  async ngOnInit() { await this.lk.load(); }
  async pick(id: number) { this.yearId.set(id || null); this.d.set(id ? await this.api.get(`/closing/${id}`) : null); }
  async run(mode: 'preliminary' | 'final') {
    const reason = await this.ui.prompt(mode === 'final' ? 'الإقفال والاعتماد النهائي' : 'الإقفال التمهيدي', mode === 'final' ? 'تُقفل فترات السنة وتُحفظ خمس نسخ مرجعية.' : 'تُحوّل النتيجة وتبقى السنة تحت المراجعة.', 'السبب', 'متابعة');
    if (!reason) return;
    const t = await this.reauth.token('year.close', 'إقفال السنة');
    if (!t) return;
    const r = await this.api.post('/closing', { year_id: this.yearId(), mode, reason, reauth: t, request_id: `close-${this.yearId()}-${Date.now()}` });
    this.ui.toast(r.entry ? `سُجّل قيد الإقفال رقم ${r.entry.number} — النتيجة ${money(+r.net_result)}` : 'لا متبقٍ — سُجّل تحقق بلا قيد', 'ok');
    await this.lk.load(); await this.pick(this.yearId()!);
  }
}
