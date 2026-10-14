import { Component, OnInit, inject, input, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Ui } from '../core/ui';
import { Lookups } from '../core/lookups';
import { Tabs } from '../shell/tabs';

// إعدادات الشركة وإعدادات الطباعة
@Component({
  selector: 'company-settings',
  styles: [`.fields { grid-template-columns: 1fr 1fr; max-width: 900px; } @media (max-width: 900px) { .fields { grid-template-columns: 1fr; } }`],
  template: `
  <div class="win"><div class="win-body">
    <h3 style="margin:0">بيانات المنشأة (تظهر على الفواتير)</h3>
    <div class="fields">
      <div class="f"><label>اسم المنشأة</label><input class="inp req" readonly [value]="(c.name ?? '') + ' — ' + (c.code ?? '')" title="الاسم والرمز تعدلهما إدارة المنصة" /></div>
      <div class="f"><label>الاسم بالإنجليزي</label><input class="inp" [value]="c.name_en ?? ''" (input)="c.name_en = $any($event.target).value" /></div>
      <div class="f"><label>الرقم الضريبي</label><input class="inp num" [value]="c.vat_number ?? ''" (input)="c.vat_number = $any($event.target).value" /></div>
      <div class="f"><label>السجل التجاري</label><input class="inp num" [value]="c.cr_number ?? ''" (input)="c.cr_number = $any($event.target).value" /></div>
      <div class="f"><label>العنوان</label><input class="inp" [value]="c.address ?? ''" (input)="c.address = $any($event.target).value" /></div>
      <div class="f"><label>الهاتف</label><input class="inp num" [value]="c.phone ?? ''" (input)="c.phone = $any($event.target).value" /></div>
    </div>
    <h3 style="margin:8px 0 0">إعدادات الطباعة</h3>
    <div class="fields">
      <div class="f"><label>حجم الورق</label>
        <select class="inp" (change)="c.paper = $any($event.target).value">
          <option value="A4" [selected]="c.paper === 'A4'">A4</option><option value="80mm" [selected]="c.paper === '80mm'">إيصال حراري 80 مم</option>
        </select></div>
      <div class="f wide"><label>تذييل الفاتورة</label><input class="inp" [value]="c.invoice_footer ?? ''" (input)="c.invoice_footer = $any($event.target).value" /></div>
      <div class="f wide"><label></label><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" [checked]="c.allow_negative_stock" (change)="c.allow_negative_stock = $any($event.target).checked" /> السماح بالبيع بكمية أكبر من المتوفر في المستودع</label></div>
    </div>
  </div>
  <div class="actions"><button class="btn primary" (click)="save()">حفظ <span class="k">F3</span></button><span class="spacer"></span><button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button></div></div>`,
})
export class CompanySettings implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); ui = inject(Ui); lk = inject(Lookups); tabs = inject(Tabs);
  c: any = {};
  async ngOnInit() { this.tabs.register(this.tabId(), { F3: () => this.save() }); await this.lk.load(); this.c = { ...this.lk.company() }; }
  async save() { await this.api.patch('/company', this.c); await this.lk.load(); this.ui.toast('تم حفظ الإعدادات', 'ok'); }
}

@Component({
  selector: 'access-log', imports: [DatePipe, JsonPipe],
  template: `
  <div class="win"><div class="win-body">
    <div class="banner info">بيانات منشأتك معزولة عن أي منشأة أخرى. هذا السجل يعرض كل دخول إلى حساب الشركة وكل عملية للمحاسب الذكي، ويُظهر أي دخول دعم فني من إدارة المنصة باسم صاحبه.</div>
    <div class="filters"><button class="btn sm" [class.primary]="tab() === 'access'" (click)="tab.set('access')">سجل الدخول</button>
      <button class="btn sm" [class.primary]="tab() === 'audit'" (click)="tab.set('audit')">سجل الإجراءات</button></div>
    @if (tab() === 'access') {
      <div class="grid-wrap" style="max-height:62vh"><table class="grid">
        <thead><tr><th>الوقت</th><th>المستخدم</th><th>الصفة</th><th>عبر</th><th>العملية</th><th>عنوان IP</th></tr></thead>
        <tbody>@for (r of rows(); track r.id) {
          <tr><td class="num">{{ r.at | date: 'yyyy-MM-dd HH:mm' }}</td><td>{{ r.user_name }}</td><td>{{ ROLE[r.role] ?? r.role }}</td>
            <td>{{ r.via === 'ai' ? 'المحاسب الذكي' : 'المتصفح' }}</td><td>{{ r.action }}</td><td class="num muted">{{ r.ip }}</td></tr>
        }</tbody>
      </table></div>
    } @else {
      <div class="grid-wrap" style="max-height:62vh"><table class="grid">
        <thead><tr><th>الوقت</th><th>الفاعل</th><th>عبر</th><th>الإجراء</th><th>العنصر</th><th>السبب</th><th>قبل / بعد</th></tr></thead>
        <tbody>@for (r of audit(); track r.id) {
          <tr><td class="num">{{ r.at | date: 'yyyy-MM-dd HH:mm' }}</td><td>{{ r.user_name }}</td><td>{{ r.via }}</td><td class="num">{{ r.action }}</td><td class="num">{{ r.entity }} {{ r.entity_id }}</td>
            <td>{{ r.reason }}</td><td class="num muted" style="white-space:normal;max-width:420px;font-size:11px">{{ r.before ? (r.before | json) : '' }} → {{ r.after ? (r.after | json) : '' }}</td></tr>
        }</tbody>
      </table></div>
    }
  </div>
  <div class="actions"><span class="spacer"></span><button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button></div></div>`,
})
export class AccessLog implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); tabs = inject(Tabs);
  ROLE: Record<string, string> = { manager: 'مدير الشركة', employee: 'موظف', platform: 'دعم فني — إدارة المنصة' };
  tab = signal<'access' | 'audit'>('access'); rows = signal<any[]>([]); audit = signal<any[]>([]);
  async ngOnInit() { this.rows.set(await this.api.get('/access-log')); this.audit.set(await this.api.get('/audit-log')); }
}
// المحاسب الذكي — opt in, and connect Claude (MCP) with a personal key.
@Component({
  selector: 'ai-settings', imports: [DatePipe],
  styles: [`pre { background: #10151d; color: #e6edf3; padding: 12px; border-radius: 4px; direction: ltr; text-align: left; overflow: auto; font-size: 12px; }`],
  template: `
  <div class="win"><div class="win-body" style="max-width:900px">
    <h3 style="margin:0">المحاسب الذكي</h3>
    <div class="banner warn">عند استخدام المحاسب الذكي تُرسل البيانات التي تسأل عنها إلى خدمة Claude من شركة Anthropic لمعالجتها والرد عليك. لا يحفظ المحاسب أي عملية إلا بعد ضغطك على "تأكيد". يمكنك إيقافه في أي وقت.</div>
    @if (!status()?.platform_ready) { <div class="banner bad">الخدمة غير مهيأة على المنصة بعد. تواصل مع الدعم.</div> }
    <label style="display:flex;gap:10px;align-items:center;font-weight:600">
      <input type="checkbox" [checked]="status()?.enabled" (change)="toggle($any($event.target).checked)" /> تفعيل المحاسب الذكي لحسابي
    </label>
    @if (status()?.enabled && status()?.platform_ready) {
      <div class="filters"><label style="font-weight:600">طريقة العمل الافتراضية</label>
        <div class="radio-row">
          <label><input type="radio" name="uimode" [checked]="!auth.aiMode()" (change)="auth.setMode('system')" /> النظام (الشاشات)</label>
          <label><input type="radio" name="uimode" [checked]="auth.aiMode()" (change)="auth.setMode('ai')" /> المحاسب الذكي (المحادثة هي الشاشة الرئيسية)</label>
        </div>
      </div>
    }
    @if (!status()?.is_demo) {
      <h3 style="margin:10px 0 0">رصيد المحاسب الذكي</h3>
      <div class="kpis"><div class="kpi"><div class="l">الرصيد المتبقي</div><div class="v">{{ fmt(credits()?.balance) }}</div><div class="s">يُخصم حسب حجم كل طلب. للشحن تواصل مع إدارة المنصة.</div></div></div>
      @if ((credits()?.balance ?? 0) <= 0) { <div class="banner bad">الرصيد منتهٍ — المحاسب الذكي متوقف حتى يُشحن الرصيد.</div> }
      <div class="grid-wrap" style="max-height:40vh"><table class="grid">
        <thead><tr><th>الوقت</th><th>العملية</th><th>المستخدم</th><th>البيان</th><th class="n">الرصيد</th><th class="n">بعدها</th></tr></thead>
        <tbody>@for (l of credits()?.ledger ?? []; track l.id) {
          <tr><td class="num">{{ l.at | date: 'yyyy-MM-dd HH:mm' }}</td><td>{{ KIND[l.kind] }}</td><td>{{ l.user_name }}</td><td>{{ l.note }}</td>
            <td class="n" [style.color]="l.credits < 0 ? 'var(--danger)' : 'var(--ok)'">{{ fmt(l.credits) }}</td><td class="n">{{ fmt(l.balance_after) }}</td></tr>
        } @empty { <tr><td colspan="6" class="muted">لا توجد حركات بعد</td></tr> }</tbody>
      </table></div>
    }
  </div>
  <div class="actions"><span class="spacer"></span><button class="btn" (click)="tabs.close(tabId())">خروج <span class="k">Esc</span></button></div></div>`,
})
export class AiSettings implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); ui = inject(Ui); auth = inject(Auth); tabs = inject(Tabs);
  status = signal<any>(null); credits = signal<any>(null);
  KIND: Record<string, string> = { topup: 'شحن رصيد', usage: 'استخدام', adjust: 'تصحيح' };
  fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
  async ngOnInit() { await this.load(); }
  async load() {
    this.status.set(await this.api.get('/ai/status'));
    this.credits.set(this.status().enabled ? await this.api.get('/ai/credits', undefined, { quiet: true }).catch(() => null) : null);
  }
  async toggle(enabled: boolean) {
    if (enabled && !(await this.ui.confirm('تفعيل المحاسب الذكي', 'البيانات التي تسأل عنها ستُعالج لدى Anthropic (Claude) للرد عليك. هل توافق؟', 'موافق، فعّل'))) { await this.load(); return; }
    await this.api.patch('/ai/settings', { enabled });
    await this.auth.refreshAi(); await this.load();
  }
}

// تغيير كلمة المرور الشخصية (§6.3): only the person changes their own password.
@Component({
  selector: 'password-settings',
  template: `
  <div class="win"><div class="win-body" style="max-width:480px">
    <div class="f"><label>كلمة المرور الحالية</label><input class="inp" type="password" #a /></div>
    <div class="f"><label>كلمة المرور الجديدة</label><input class="inp" type="password" #b /></div>
    <div><button class="btn primary" (click)="save(a.value, b.value); a.value = ''; b.value = ''">تغيير كلمة المرور</button></div>
  </div></div>`,
})
export class PasswordSettings {
  tabId = input.required<number>();
  api = inject(Api); ui = inject(Ui);
  async save(current: string, next: string) { await this.api.post('/auth/password', { current, next }); this.ui.toast('تم تغيير كلمة المرور', 'ok'); }
}
