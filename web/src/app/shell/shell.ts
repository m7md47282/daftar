import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { Auth } from '../core/auth';
import { Api } from '../core/api';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { money, today, hijri } from '../core/fmt';
import { Tabs } from './tabs';
import { MENUS, type Menu, type MenuItem, type Screen } from './menus';
import { AiPanel } from '../ai/ai-panel';

@Component({
  selector: 'app-shell',
  imports: [NgComponentOutlet, AiPanel],
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; }
    .titlebar { display: flex; align-items: center; gap: 14px; height: 40px; padding: 0 14px; background: #fff; border-bottom: 1px solid var(--line); font-size: 13px; }
    .brand { font-weight: 700; color: var(--brand); font-size: 16px; }
    .co { font-weight: 600; }
    .titlebar .sp { flex: 1; }
    .who { color: var(--ink-2); display: flex; gap: 10px; align-items: center; }
    .demo { background: #fff4d6; color: #7a5400; padding: 2px 8px; border-radius: 99px; font-size: 12px; }
    .menubar { display: flex; background: #f3f4f6; border-bottom: 1px solid var(--line); padding: 0 6px; user-select: none; flex-wrap: wrap; }
    .mb { position: relative; }
    .mb > button { border: 0; background: transparent; padding: 0 12px; height: 30px; cursor: default; font-size: 14px; }
    .mb > button:hover, .mb.open > button { background: var(--accent-soft); }
    .mb.ai > button { color: #5b2bb5; font-weight: 600; }
    .dd { position: absolute; top: 100%; right: 0; min-width: 260px; background: #f9fafb; border: 1px solid #a9b1bd; box-shadow: 2px 4px 14px rgba(0,0,0,.18); padding: 3px 0; z-index: 35; }
    .dd .it { position: relative; display: flex; justify-content: space-between; align-items: center; padding: 0 26px 0 18px; height: 30px; cursor: default; white-space: nowrap; gap: 16px; }
    .dd .it:hover { background: var(--accent); color: #fff; }
    .dd .it.soon { color: var(--ink-3); } .dd .it.soon:hover { background: var(--ro); color: var(--ink-3); }
    .dd .it small { font-size: 11px; opacity: .8; }
    .dd .sep { height: 1px; background: var(--line); margin: 3px 10px; }
    .dd .sub { position: absolute; top: -4px; right: 100%; min-width: 220px; color: var(--ink); }
    .tabs { display: flex; gap: 2px; padding: 6px 8px 0; background: var(--bg); overflow-x: auto; border-bottom: 1px solid var(--line); min-height: 36px; }
    .tab { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 12px; border: 1px solid var(--line); border-bottom: 0; border-radius: 4px 4px 0 0; background: #dfe3e9; cursor: pointer; white-space: nowrap; font-size: 13px; }
    .tab.on { background: var(--surface); font-weight: 600; position: relative; top: 1px; }
    .tab .x { width: 22px; height: 22px; font-size: 13px; }
    .tab-home { padding: 0 12px; }
    .workspace { flex: 1; overflow: auto; padding: 10px; position: relative; }
    .pane { display: none; min-height: 100%; } .pane.on { display: block; }
    .statusbar { height: 28px; display: flex; align-items: center; gap: 16px; padding: 0 12px; background: #2a2f3a; color: #cfd6df; font-size: 12px; }
    .statusbar .k b { color: #fff; font-weight: 600; margin-inline-end: 3px; }
    .statusbar .sp { flex: 1; }
    .home { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; padding: 10px 0; }
    .home h1 { margin: 0; font-size: 22px; } .home .sub { color: var(--ink-2); }
    .quick { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
    .quick button { height: 64px; border: 1px solid var(--line); background: var(--panel); border-radius: 4px; cursor: pointer; font-size: 15px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
    .quick button:hover { border-color: var(--accent); background: var(--accent-soft); }
    .quick small { color: var(--ink-3); font-size: 12px; }
    .watermark { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; font-size: 160px; font-weight: 700; color: rgba(31, 78, 121, .04); }
    .ai-fab { position: fixed; left: 18px; bottom: 44px; z-index: 30; height: 44px; padding: 0 18px; border-radius: 22px; border: 0; background: #5b2bb5; color: #fff; font-weight: 600; box-shadow: 0 6px 18px rgba(91,43,181,.35); cursor: pointer; }
    .ai-fab:hover { background: #4a2196; }
    .keys td { padding: 6px 10px; }
    .mode { display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    .mode button { border: 0; background: var(--panel); padding: 0 12px; height: 28px; cursor: pointer; font-size: 13px; color: var(--ink-2); }
    .mode button.on { background: var(--accent); color: #fff; font-weight: 600; }
    .mode button.on.ai { background: #5b2bb5; }
    .ai-home { height: 100%; display: flex; flex-direction: column; }
  `],
  template: `
  <div class="titlebar">
    <span class="brand">دفتر</span>
    <span class="co">{{ auth.user()?.tenant_name }}</span>
    @if (auth.companies().length > 1 || auth.user()?.is_platform_admin) { <button class="btn sm" (click)="switchCompany()" title="لكل نافذة شركتها">تبديل الشركة</button> }
    @if (auth.user()?.is_demo) { <span class="demo">نسخة تجريبية — تُحذف خلال 24 ساعة</span> }
    @if (auth.user()?.support_mode) { <span class="demo" style="background:#fde2e1;color:#8a1c1c">وضع الدعم الفني — كل إجراء يُسجل باسمك</span> }
    <span class="sp"></span>
    @if (auth.user()?.ai_available) {
      <div class="mode" title="طريقة العمل">
        <button [class.on]="!auth.aiMode()" (click)="setMode('system')">النظام</button>
        <button class="ai" [class.on]="auth.aiMode()" (click)="setMode('ai')">المحاسب الذكي</button>
      </div>
    }
    <span class="who">
      <span>{{ auth.user()?.full_name }}</span>
      <span class="chip">{{ auth.user()?.support_mode ? 'إدارة المنصة' : auth.isOwner() ? 'مدير الشركة' : 'موظف' + (auth.user()?.branch_name ? ' — ' + auth.user()?.branch_name : '') }}</span>
      <span class="num">{{ today }} م · {{ hijriToday }} هـ</span>
      <button class="btn sm" (click)="logout()">خروج</button>
    </span>
  </div>

  @if (auth.user()?.chart_state === 'pending_template') {
    <div class="banner warn" style="border-radius:0">دليل الحسابات لم يُؤسس بعد — لا يمكن ترحيل قيود قبل ذلك. <a (click)="openSetup()">تأسيس الدليل</a></div>
  }
  <nav class="menubar">
    @for (m of menus(); track m.label; let i = $index) {
      <div class="mb" [class.open]="openMenu() === i" [class.ai]="m.action === 'ai'" (mouseenter)="openMenu() !== null && openMenu.set(i)">
        <button (click)="menuClick(m, i)">{{ m.label }}</button>
        @if (openMenu() === i && m.items.length) {
          <div class="dd">
            @for (it of visible(m.items); track $index) {
              @if (isSep(it)) { <div class="sep"></div> }
              @else {
                <div class="it" [class.soon]="it.soon" (click)="pick(it); $event.stopPropagation()" (mouseenter)="sub.set(it.children ? it.label : null)">
                  <span>{{ it.label }}</span>
                  @if (it.soon) { <small>قريباً</small> } @if (it.children) { <small>‹</small> }
                  @if (it.children && sub() === it.label) {
                    <div class="dd sub">@for (c of visible(it.children); track $index) { @if (!isSep(c)) { <div class="it" (click)="pick(c); $event.stopPropagation()"><span>{{ c.label }}</span></div> } }</div>
                  }
                </div>
              }
            }
          </div>
        }
      </div>
    }
  </nav>

  <div class="tabs no-print">
    <div class="tab tab-home" [class.on]="tabs.activeId() === null" (click)="tabs.activeId.set(null)">{{ auth.aiMode() ? 'المحاسب الذكي' : 'الرئيسية' }}</div>
    @for (t of tabs.tabs(); track t.id) {
      <div class="tab" [class.on]="t.id === tabs.activeId()" (click)="tabs.activeId.set(t.id)" (auxclick)="tabs.close(t.id)">
        {{ t.title }}<button class="x" (click)="tabs.close(t.id); $event.stopPropagation()" title="إغلاق (Esc)">✕</button>
      </div>
    }
  </div>

  <div class="workspace" (click)="openMenu.set(null)">
    @if (tabs.activeId() === null && auth.aiMode()) {
      <div class="ai-home"><ai-panel [embedded]="true" /></div>
    } @else if (tabs.activeId() === null) {
      <div class="watermark">دفتر</div>
      <div class="home">
        <div><h1>أهلاً {{ auth.user()?.full_name }}</h1><div class="sub">{{ auth.isOwner() ? 'ملخص جميع الفروع' : 'ملخص ' + (auth.user()?.branch_name ?? '') }}</div></div>
        @if (dash(); as d) {
          <div class="kpis">
            <div class="kpi"><div class="l">مبيعات اليوم</div><div class="v">{{ m(d.today.sales) }}</div><div class="s">{{ d.today.invoices }} فاتورة</div></div>
            @if (auth.isOwner()) { <div class="kpi"><div class="l">مجمل ربح اليوم</div><div class="v">{{ m(d.today.gross_margin) }}</div></div> }
            <div class="kpi"><div class="l">مبيعات الشهر</div><div class="v">{{ m(d.month.sales) }}</div><div class="s">{{ d.month.invoices }} فاتورة</div></div>
            @if (auth.isOwner()) { <div class="kpi"><div class="l">مجمل ربح الشهر</div><div class="v">{{ m(d.month.gross_margin) }}</div></div> }
            <div class="kpi"><div class="l">النقدية بالصناديق</div><div class="v">{{ m(d.cash) }}</div></div>
            <div class="kpi"><div class="l">مستحق من العملاء</div><div class="v">{{ m(d.receivables) }}</div></div>
          </div>
        }
        <div class="quick">
          @for (q of quick; track q.label) { <button (click)="openScreen(q.screen)">{{ q.label }}<small>{{ q.hint }}</small></button> }
        </div>
        @if (auth.user()?.is_demo) {
          <div class="banner info">هذه نسخة تجريبية خاصة بك فقط ببيانات وهمية لتاجر أقمشة بثلاثة فروع. جرّب إنشاء فاتورة، أو طباعتها، أو اسأل المحاسب الذكي. كل ما تفعله يُحذف تلقائياً.</div>
        }
      </div>
    }
    @for (t of tabs.tabs(); track t.id) {
      <div class="pane" [class.on]="t.id === tabs.activeId()"><ng-container *ngComponentOutlet="t.component; inputs: t.inputs" /></div>
    }
  </div>

  <div class="statusbar no-print">
    <span class="k"><b>F2</b>إضافة</span><span class="k"><b>F3</b>حفظ</span><span class="k"><b>F5</b>بحث</span><span class="k"><b>F7</b>طباعة</span>
    <span class="k"><b>F9</b>باركود</span><span class="k"><b>F11</b>إدراج صنف</span><span class="k"><b>Esc</b>خروج</span>
    <span class="sp"></span>
    <span>بيانات منشأتك معزولة عن أي منشأة أخرى، وكل دخول إليها مسجّل</span>
  </div>

  @if (auth.user()?.ai_available && !auth.aiMode() && !aiOpen()) { <button class="ai-fab" (click)="aiOpen.set(true)">المحاسب الذكي</button> }
  @if (aiOpen()) { <ai-panel (closed)="aiOpen.set(false)" /> }

  @if (info(); as i) {
    <div class="overlay" (click)="info.set(null)"><div class="dialog" (click)="$event.stopPropagation()">
      <header><span>{{ i === 'keys' ? 'اختصارات لوحة المفاتيح' : 'خصوصية بياناتك' }}</span><button class="x" (click)="info.set(null)">✕</button></header>
      <div class="body">
        @if (i === 'keys') {
          <table class="grid keys"><tbody>
            <tr><td><b>F2</b></td><td>مستند جديد</td></tr><tr><td><b>F3</b></td><td>حفظ</td></tr><tr><td><b>F4</b></td><td>تعديل</td></tr>
            <tr><td><b>F5</b></td><td>بحث عن مستند</td></tr><tr><td><b>F6</b></td><td>حذف السطر / إلغاء السند</td></tr><tr><td><b>F7</b></td><td>طباعة</td></tr>
            <tr><td><b>F9</b></td><td>إدخال بالباركود</td></tr><tr><td><b>F11</b></td><td>إدراج صنف / حساب</td></tr><tr><td><b>F12</b></td><td>إدراج وحدة صنف</td></tr>
            <tr><td><b>Enter</b></td><td>الانتقال للخانة التالية</td></tr><tr><td><b>Esc</b></td><td>إغلاق الشاشة</td></tr>
          </tbody></table>
        } @else {
          <div>• بيانات منشأتك معزولة داخل قاعدة البيانات عن أي منشأة أخرى، وتفرض قاعدة البيانات نفسها هذا العزل في كل طلب.</div>
          <div>• لا يرى بياناتك إلا أنت ومن تمنحه صلاحية، والمحاسب يرى فرعه فقط.</div>
          <div>• فريق الدعم الفني في إدارة المنصة قد يدخل حساب منشأتك عند الحاجة لإصلاح عطل؛ يظهر كل دخول له في سجل الدخول باسمه وتُنسب إليه كل إجراءاته.</div>
          <div>• كل دخول إلى حسابك مسجّل، وتراه من: إعدادات النظام ← سجل الدخول والخصوصية.</div>
          <div>• المحاسب الذكي متوقف افتراضياً. عند تفعيله تُعالَج البيانات التي تسأل عنها لدى Claude (Anthropic).</div>
        }
      </div>
    </div></div>
  }
  `,
})
export class Shell implements OnInit {
  auth = inject(Auth); api = inject(Api); lk = inject(Lookups); ui = inject(Ui); tabs = inject(Tabs);
  m = money; today = today(); hijriToday = hijri(today());
  openMenu = signal<number | null>(null); sub = signal<string | null>(null);
  aiOpen = signal(false); info = signal<'keys' | 'privacy' | null>(null);
  dash = signal<any>(null);
  menus = computed(() => MENUS.filter((m) => !m.owner || (this.auth.isOwner() && (m.action !== 'ai' || this.auth.user()?.ai_available))));
  quick = [
    { label: 'فاتورة مبيعات', hint: 'بيع للعميل', screen: this.find('inv-sale') },
    { label: 'سند قبض', hint: 'استلام مبلغ', screen: this.find('v-receipt') },
    { label: 'سند صرف', hint: 'دفع مصروف', screen: this.find('v-payment') },
    { label: 'فاتورة مشتريات', hint: 'بضاعة من مورد', screen: this.find('inv-purchase') },
    { label: 'كشف حساب', hint: 'عميل أو مورد', screen: this.find('r-stmt') },
    { label: 'أرصدة المخزون', hint: 'الكميات المتوفرة', screen: this.find('r-stock') },
  ];

  async ngOnInit() {
    await this.lk.load();
    this.dash.set(await this.api.get('/reports/dashboard'));
  }
  find(key: string): Screen {
    const walk = (items: MenuItem[]): Screen | undefined => {
      for (const it of items) { if ('sep' in it) continue; if (it.screen?.key === key) return it.screen; const c = it.children && walk(it.children); if (c) return c; }
      return undefined;
    };
    for (const m of MENUS) { const r = walk(m.items); if (r) return r; }
    throw new Error(key);
  }
  isSep(it: MenuItem): it is { sep: true } { return 'sep' in it; }
  visible(items: MenuItem[]) {
    const out = items.filter((it) => this.isSep(it) || !it.owner || this.auth.isOwner());
    return out.filter((it, i) => !(this.isSep(it) && (i === 0 || this.isSep(out[i - 1]))));
  }
  menuClick(m: Menu, i: number) {
    if (m.action) { this.openMenu.set(null); this.run(m.action); return; }
    this.openMenu.set(this.openMenu() === i ? null : i);
  }
  pick(it: MenuItem) {
    if (this.isSep(it) || it.children) return;
    if (it.soon) { this.ui.toast(`"${it.label}" قيد التطوير وسيُضاف قريباً في نفس المكان`); return; }
    this.openMenu.set(null);
    if (it.action) this.run(it.action);
    if (it.screen) this.openScreen(it.screen);
  }
  openScreen(sc: Screen) { this.tabs.open(sc.key, sc.title, sc.component, sc.inputs ?? {}); }
  async run(action: string) {
    if (action === 'ai') { if (this.auth.aiMode()) this.tabs.activeId.set(null); else this.aiOpen.set(true); }
    if (action === 'home') { this.tabs.activeId.set(null); this.dash.set(await this.api.get('/reports/dashboard')); }
    if (action === 'keys' || action === 'privacy') this.info.set(action);
  }
  async setMode(mode: 'system' | 'ai') {
    if ((mode === 'ai') === this.auth.aiMode()) return;
    await this.auth.setMode(mode);
    this.aiOpen.set(false); this.tabs.activeId.set(null);
    if (mode === 'system') this.dash.set(await this.api.get('/reports/dashboard'));
  }
  async switchCompany() {
    if (!(await this.ui.confirm('تبديل الشركة', 'ستُغلق الشاشات المفتوحة في هذه النافذة. النوافذ الأخرى لا تتأثر.', 'متابعة'))) return;
    this.tabs.closeAll(); await this.auth.leaveCompany();
  }
  openSetup() { this.openScreen(this.find('chart-setup')); }
  async logout() {
    if (!(await this.ui.confirm('تسجيل الخروج', 'هل تريد الخروج من النظام؟', 'خروج'))) return;
    this.tabs.closeAll(); await this.auth.logout();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (this.ui.confirmState()) return;
    if (e.key === 'Escape' && this.openMenu() !== null) { this.openMenu.set(null); e.preventDefault(); return; }
    if (e.key === 'Escape' && document.querySelector('.overlay')) return; // dialogs handle their own Esc
    if (/^F\d+$/.test(e.key) || e.key === 'Escape') {
      if (this.tabs.handleKey(e)) e.preventDefault();
      else if (/^F\d+$/.test(e.key)) e.preventDefault();
    }
  }
  @HostListener('document:mousedown', ['$event'])
  docClick(e: MouseEvent) { if (!(e.target as Element).closest('.menubar')) this.openMenu.set(null); }
}
