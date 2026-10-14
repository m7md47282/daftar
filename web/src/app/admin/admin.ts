import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Ui } from '../core/ui';

// Platform console: companies, seats, manager invitations, templates, keys. Opening a company's books is an explicit, logged support action.
@Component({
  selector: 'admin-console', imports: [DatePipe, JsonPipe],
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; }
    .top { display: flex; align-items: center; justify-content: space-between; padding: 0 16px; height: 46px; background: #2a2f3a; color: #fff; }
    .top b { font-size: 15px; } .top .btn { height: 30px; color: var(--ink); }
    .adm-nav { display: flex; gap: 2px; padding: 0 12px; background: #eceef2; border-bottom: 1px solid var(--line); }
    .adm-nav button { border: 0; background: transparent; padding: 10px 14px; cursor: pointer; border-bottom: 2px solid transparent; }
    .adm-nav button.on { border-bottom-color: var(--accent); color: var(--accent); font-weight: 600; }
    main { padding: 16px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 14px; max-width: 1200px; width: 100%; margin: 0 auto; }
    .group { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .group h3 { margin: 0; font-size: 15px; }
    .set { display: grid; grid-template-columns: 220px 1fr auto; gap: 10px; align-items: center; }
    @media (max-width: 800px) { .set { grid-template-columns: 1fr; } }
  `],
  template: `
  <div class="top"><b>دفتر — لوحة إدارة المنصة</b><div style="display:flex;gap:10px;align-items:center"><span>{{ auth.user()?.full_name }}</span><button class="btn sm" (click)="auth.logout()">خروج</button></div></div>
  <div class="adm-nav">
    <button [class.on]="tab() === 'tenants'" (click)="tab.set('tenants')">المنشآت المشتركة</button>
    <button [class.on]="tab() === 'templates'" (click)="tab.set('templates'); loadTemplates()">قوالب الدليل</button>
    <button [class.on]="tab() === 'keys'" (click)="tab.set('keys')">المفاتيح والتكاملات</button>
    <button [class.on]="tab() === 'audit'" (click)="tab.set('audit'); loadAudit()">سجل المنصة</button>
  </div>
  <main>
    @switch (tab()) {
      @case ('tenants') {
        <div class="banner info">تدير اللوحة الشركات والمقاعد والقوالب والمفاتيح. الدخول إلى دفاتر شركة يكون صريحًا للدعم الفني، ويُسجَّل في سجل دخول الشركة وسجل المنصة باسمك.</div>
        <div class="kpis"><div class="kpi"><div class="l">شركات</div><div class="v">{{ tenants().length }}</div></div><div class="kpi"><div class="l">نسخ تجريبية نشطة</div><div class="v">{{ demos() }}</div></div></div>
        @if (link()) { <div class="banner warn"><div>رابط دعوة المدير (يظهر مرة واحدة، صالح 24 ساعة) — أرسله له بنفسك:<br /><input class="inp num" readonly [value]="link()" (focus)="$any($event.target).select()" /></div></div> }
        <div class="grid-wrap"><table class="grid">
          <thead><tr><th>الرمز</th><th>الشركة</th><th>النشاط</th><th>المدير</th><th>الدليل</th><th class="n">المقاعد</th><th class="n">رصيد الذكاء</th><th>الحالة</th><th></th></tr></thead>
          <tbody>@for (t of tenants(); track t.id) {
            <tr><td class="num">{{ t.code }}</td><td>{{ t.name }}</td><td>{{ t.activity }}</td><td>{{ t.manager_name ?? '— (بانتظار قبول الدعوة)' }}</td>
              <td>{{ CH[t.chart_state] }} <span class="muted">({{ t.template_choice === 'manager' ? 'يختاره المدير' : 'تختاره المنصة' }})</span></td>
              <td class="n"><button class="btn sm" (click)="seats(t)">{{ t.employees + t.pending_invites }} / {{ t.seat_limit }}</button></td>
              <td class="n"><button class="btn sm" (click)="openCredits(t)">{{ fmt(+t.ai_credits) }}</button></td>
              <td>@if (t.status === 'active') { <span class="chip ok">فعّال</span> } @else { <span class="chip bad">موقوف</span> }</td>
              <td style="display:flex;gap:4px">
                <button class="btn sm" (click)="enter(t)">دخول دعم فني</button>
                <button class="btn sm" (click)="inviteManager(t)">دعوة مدير</button>
                <button class="btn sm" (click)="setStatus(t, t.status === 'active' ? 'suspended' : 'active')">{{ t.status === 'active' ? 'إيقاف' : 'تفعيل' }}</button></td></tr>
          } @empty { <tr><td colspan="9" class="muted">لا توجد شركات بعد</td></tr> }</tbody>
        </table></div>
        @if (sel(); as t) {
          <div class="group">
            <div style="display:flex;justify-content:space-between;align-items:center"><h3>رصيد المحاسب الذكي — {{ t.name }}</h3><button class="x" (click)="sel.set(null)">✕</button></div>
            <div class="kpis"><div class="kpi"><div class="l">الرصيد الحالي</div><div class="v">{{ fmt(credit()?.balance) }}</div>
              <div class="s">الرصيد الواحد = {{ creditUsd() }} دولار من تكلفة Claude الفعلية</div></div></div>
            <div class="filters">
              <input class="inp num" #amt type="number" step="1" placeholder="عدد الأرصدة (سالب للتصحيح)" style="width:220px" />
              <input class="inp" #note placeholder="ملاحظة، مثل: تحويل بنكي 500 ر.س" style="width:280px" />
              <button class="btn sm primary" (click)="addCredits(t, +amt.value, note.value); amt.value = ''; note.value = ''">إضافة للرصيد</button>
            </div>
            <div class="grid-wrap" style="max-height:45vh"><table class="grid">
              <thead><tr><th>الوقت</th><th>العملية</th><th>المستخدم</th><th>البيان</th><th>النموذج</th><th class="n">التوكنز (دخل/خرج)</th><th class="n">التكلفة $</th><th class="n">الرصيد</th><th class="n">بعدها</th></tr></thead>
              <tbody>@for (l of credit()?.ledger ?? []; track l.id) {
                <tr><td class="num">{{ l.at | date: 'yyyy-MM-dd HH:mm' }}</td><td>{{ KIND[l.kind] }}</td><td>{{ l.user_name }}</td><td>{{ l.note }}</td>
                  <td class="num muted">{{ l.model ?? '' }}</td><td class="n">{{ l.input_tokens != null ? (l.input_tokens + l.cache_read_tokens + l.cache_write_tokens) + ' / ' + l.output_tokens : '' }}</td>
                  <td class="n">{{ l.cost_usd != null ? l.cost_usd.toFixed(4) : '' }}</td>
                  <td class="n" [style.color]="l.credits < 0 ? 'var(--danger)' : 'var(--ok)'">{{ fmt(l.credits) }}</td><td class="n">{{ fmt(l.balance_after) }}</td></tr>
              } @empty { <tr><td colspan="9" class="muted">لا توجد حركات</td></tr> }</tbody>
            </table></div>
          </div>
        }
        <div class="group"><h3>إنشاء شركة</h3>
          <div class="fields" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">
            <div class="f"><label>رمز الشركة</label><input class="inp req num" #c /></div>
            <div class="f"><label>اسم الشركة</label><input class="inp req" #n /></div>
            <div class="f"><label>النشاط</label><input class="inp" value="تجارة الأقمشة" #ac /></div>
            <div class="f"><label>الرقم الضريبي</label><input class="inp num" #v /></div>
            <div class="f"><label>اسم المدير</label><input class="inp req" #mn /></div>
            <div class="f"><label>بريد المدير</label><input class="inp req num" #me /></div>
            <div class="f"><label>مقاعد الموظفين</label><input class="inp num" type="number" value="2" #st /></div>
            <div class="f"><label>اختيار القالب</label><select class="inp" #tc><option value="platform">تختاره المنصة</option><option value="manager">يُفوَّض لمدير الشركة</option></select></div>
          </div>
          <div><button class="btn primary" (click)="create(c.value, n.value, ac.value, v.value, mn.value, me.value, +st.value, tc.value)">إنشاء الشركة ودعوة مديرها</button></div>
        </div>
      }
      @case ('templates') {
        <div class="banner info">القالب المنشور ثابت؛ التحسين يُنشر إصدارًا جديدًا ولا يحدّث الشركات القائمة تلقائيًا. النشر إجراء صريح (pnpm db:setup ينشر قالب الأقمشة 1.0.0).</div>
        <table class="grid"><thead><tr><th>القالب</th><th>الإصدار</th><th>النشاط</th><th class="n">الحسابات</th><th>تاريخ النشر</th></tr></thead>
          <tbody>@for (t of templates(); track t.id) { <tr><td>{{ t.name }}</td><td class="num">{{ t.version }}</td><td>{{ t.activity }}</td><td class="n">{{ t.accounts }}</td><td class="num">{{ t.published_at | date: 'yyyy-MM-dd' }}</td></tr> }</tbody></table>
      }
      @case ('keys') {
        <div class="banner warn">المفاتيح السرية تُشفّر قبل حفظها ولا تُعرض مرة أخرى (يظهر آخر 4 أحرف فقط). اتركها فارغة واضغط حفظ لحذفها.</div>
        @for (g of groups(); track g) {
          <div class="group"><h3>{{ g }}</h3>
            @for (s of byGroup(g); track s.key) {
              <div class="set">
                <label>{{ s.label }} @if (s.set) { <span class="chip ok">مضبوط</span> }</label>
                <input class="inp num" [type]="s.secret ? 'password' : 'text'" [placeholder]="s.secret ? (s.masked ?? 'غير مضبوط') : (s.hint ?? '')" [value]="s.secret ? '' : (s.value ?? '')" #inp autocomplete="off" />
                <button class="btn sm primary" (click)="save(s.key, inp.value); s.secret && (inp.value = '')">حفظ</button>
              </div>
            }
          </div>
        }
      }
      @case ('audit') {
        <div class="grid-wrap"><table class="grid">
          <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>الشركة</th><th>التفاصيل</th></tr></thead>
          <tbody>@for (a of audit(); track a.id) { <tr><td class="num">{{ a.at | date: 'yyyy-MM-dd HH:mm' }}</td><td class="num">{{ a.username }}</td><td>{{ a.action }}</td><td>{{ a.company_name }}</td><td class="num muted">{{ a.detail | json }}</td></tr> }</tbody>
        </table></div>
      }
    }
  </main>`,
})
export class AdminConsole implements OnInit {
  api = inject(Api); auth = inject(Auth); ui = inject(Ui);
  tab = signal<'tenants' | 'keys' | 'audit' | 'templates'>('tenants');
  templates = signal<any[]>([]); link = signal('');
  tenants = signal<any[]>([]); demos = signal(0); settings = signal<any[]>([]); audit = signal<any[]>([]);
  sel = signal<any>(null); credit = signal<any>(null);
  KIND: Record<string, string> = { topup: 'شحن رصيد', usage: 'استخدام', adjust: 'تصحيح' };
  creditUsd = computed(() => this.settings().find((s) => s.key === 'ai_credit_usd')?.value ?? '0.01');
  fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
  groups = computed(() => [...new Set(this.settings().map((s) => s.group))]);
  byGroup = (g: string) => this.settings().filter((s) => s.group === g);
  async ngOnInit() { await this.load(); this.settings.set(await this.api.get('/admin/settings')); }
  CH: Record<string, string> = { pending_template: 'بانتظار التأسيس', manual: 'يدوي', inherited: 'موروث', from_template: 'من قالب' };
  async load() { const r = await this.api.get('/admin/companies'); this.tenants.set(r.companies); this.demos.set(r.active_demos); }
  async loadTemplates() { this.templates.set(await this.api.get('/admin/templates')); }
  async seats(t: any) {
    const v = await this.ui.prompt('حد المقاعد', `${t.name}: المستخدم حاليًا ${t.employees} موظف + ${t.pending_invites} دعوة. لا يقل الحد عن ذلك.`, 'عدد مقاعد الموظفين', 'حفظ');
    if (v === null) return;
    await this.api.post(`/admin/companies/${t.id}/seats`, { limit: Number(v) }); await this.load();
  }
  async inviteManager(t: any) {
    const name = await this.ui.prompt('دعوة مدير', 'عند القبول يصبح المدعو المدير الفعال الوحيد، ويتوقف المدير السابق دون فقد نسبة قيوده.', 'اسم المدير', 'التالي');
    if (!name) return;
    const email = await this.ui.prompt('دعوة مدير', name, 'البريد الإلكتروني', 'إنشاء الدعوة');
    if (!email) return;
    this.link.set((await this.api.post(`/admin/companies/${t.id}/manager-invite`, { name, email })).link);
  }
  async enter(t: any) {
    const reason = await this.ui.prompt('دخول الدعم الفني', `سيظهر دخولك في سجل دخول "${t.name}" باسمك، وتُنسب إليك كل إجراءاتك.`, 'سبب الدخول (مثل رقم البلاغ)', 'دخول');
    if (!reason) return;
    await this.api.post(`/admin/companies/${t.id}/enter`, { reason });
    await this.auth.enter(t.id);
  }
  async loadAudit() { this.audit.set(await this.api.get('/admin/audit')); }
  async setStatus(t: any, status: string) {
    if (status === 'suspended' && !(await this.ui.confirm('إيقاف المنشأة', `سيتم منع جميع مستخدمي "${t.name}" من الدخول. البيانات لا تُحذف.`, 'إيقاف', true))) return;
    await this.api.patch(`/admin/companies/${t.id}`, { status }); await this.load();
  }
  async create(code: string, name: string, activity: string, vat_number: string, manager_name: string, manager_email: string, seat_limit: number, template_choice: string) {
    const r = await this.api.post('/admin/companies', { code, name, activity, vat_number: vat_number || undefined, manager_name, manager_email, seat_limit, template_choice });
    this.link.set(r.manager_invite_link ?? ''); this.ui.toast('أُنشئت الشركة', 'ok'); await this.load();
  }
  async openCredits(t: any) { this.sel.set(t); this.credit.set(await this.api.get(`/admin/companies/${t.id}/credits`)); }
  async addCredits(t: any, credits: number, note: string) {
    if (!credits) { this.ui.toast('أدخل عدد الأرصدة', 'bad'); return; }
    await this.api.post(`/admin/companies/${t.id}/credits`, { credits, note: note.trim() || undefined });
    this.ui.toast('تم تحديث الرصيد', 'ok');
    await this.openCredits(t); await this.load();
  }
  async save(key: string, value: string) {
    this.settings.set(await this.api.put(`/admin/settings/${key}`, { value: value.trim() || null }));
    this.ui.toast('تم الحفظ', 'ok');
  }
}
