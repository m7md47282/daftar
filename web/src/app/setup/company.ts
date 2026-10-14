import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Lookups } from '../core/lookups';
import { Ui } from '../core/ui';
import { today } from '../core/fmt';
import { Tabs } from '../shell/tabs';
import { LedgerView } from '../books/books';

const ROLE: Record<string, string> = { manager: 'مدير الشركة', employee: 'موظف' };

// المستخدمون والدعوات (§6): seats, invitations (24 h, link shown once), stop/reactivate, branch restriction
@Component({
  selector: 'members-view', imports: [DatePipe],
  template: `
  <div class="win"><div class="win-body">
    @if (d(); as d) {
      <div class="kpis">
        <div class="kpi"><div class="l">المقاعد المستخدمة</div><div class="v">{{ d.seats.used }} / {{ d.seats.limit }}</div><div class="s">{{ d.seats.active_employees }} موظف فعال + {{ d.seats.pending_invites }} دعوة معلقة</div></div>
      </div>
      <div class="banner info">مدير الشركة لا يُحتسب من المقاعد. زيادة الحد من إدارة المنصة. إيقاف موظف يحرر مقعده ويحفظ نسبة قيوده إليه.</div>
      <table class="grid"><thead><tr><th>الاسم</th><th>اسم الدخول</th><th>الدور</th><th>الفرع</th><th>الحالة</th><th></th></tr></thead>
        <tbody>@for (m of d.members; track m.id) {
          <tr><td>{{ m.full_name }}</td><td class="num">{{ m.username }}</td><td>{{ R[m.role] }}</td>
            <td>@if (m.role === 'employee') {
              <select class="inp" style="height:28px" (change)="branch(m, $any($event.target).value)"><option value="">كل الشركة</option>
                @for (b of lk.branches(); track b.id) { <option [value]="b.id" [selected]="b.id === m.branch_id">{{ b.name }}</option> }</select> } @else { الكل }</td>
            <td>@if (m.status === 'active') { <span class="chip ok">فعّال</span> } @else { <span class="chip bad">موقوف</span> }</td>
            <td>@if (m.role === 'employee') { <button class="btn sm" (click)="toggle(m)">{{ m.status === 'active' ? 'إيقاف' : 'إعادة تفعيل' }}</button> }</td></tr>
        }</tbody></table>
      <h3 style="margin:6px 0 0">الدعوات</h3>
      <table class="grid"><thead><tr><th>البريد</th><th>الاسم</th><th>الدور</th><th>الحالة</th><th>تنتهي</th><th></th></tr></thead>
        <tbody>@for (i of d.invitations; track i.id) {
          <tr><td class="num">{{ i.email }}</td><td>{{ i.display_name }}</td><td>{{ R[i.role] }}</td><td>{{ S[i.status] }}</td><td class="num">{{ i.expires_at | date: 'yyyy-MM-dd HH:mm' }}</td>
            <td>@if (i.status === 'pending') { <button class="btn sm" (click)="cancel(i)">إلغاء</button> }</td></tr>
        } @empty { <tr><td colspan="6" class="muted">لا دعوات</td></tr> }</tbody></table>
      @if (link()) { <div class="banner warn"><div>رابط الدعوة (يظهر مرة واحدة، صالح 24 ساعة) — أرسله للموظف بنفسك:<br /><input class="inp num" readonly [value]="link()" (focus)="$any($event.target).select()" /></div></div> }
      <h3 style="margin:6px 0 0">دعوة موظف</h3>
      <div class="filters"><input class="inp" placeholder="الاسم" #n /><input class="inp num" placeholder="البريد الإلكتروني" #e />
        <select class="inp" #b><option value="">كل الشركة</option>@for (br of lk.branches(); track br.id) { <option [value]="br.id">مقيد بفرع: {{ br.name }}</option> }</select>
        <button class="btn sm primary" (click)="invite(n.value, e.value, b.value)" [disabled]="d.seats.used >= d.seats.limit">إنشاء دعوة</button></div>
    }
  </div></div>`,
})
export class MembersView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); lk = inject(Lookups); ui = inject(Ui);
  R = ROLE; S: Record<string, string> = { pending: 'معلقة', accepted: 'مقبولة', cancelled: 'ملغاة', expired: 'منتهية' };
  d = signal<any>(null); link = signal('');
  async ngOnInit() { await this.lk.load(); await this.load(); }
  async load() { this.d.set(await this.api.get('/members')); }
  async invite(display_name: string, email: string, branch: string) {
    const r = await this.api.post('/members/invite', { role: 'employee', display_name, email, branch_id: branch ? +branch : null });
    this.link.set(r.link); await this.load();
  }
  async cancel(i: any) { await this.api.post(`/invitations/id/${i.id}/cancel`); await this.load(); }
  async toggle(m: any) {
    const reason = m.status === 'active' ? await this.ui.prompt('إيقاف العضوية', 'يُمنع إجراؤه التالي فورًا، ولا تتأثر عضوياته في شركات أخرى.', 'السبب', 'إيقاف', { danger: true }) : '';
    if (reason === null) return;
    await this.api.patch(`/members/${m.id}`, { status: m.status === 'active' ? 'inactive' : 'active', reason }); await this.load();
  }
  async branch(m: any, v: string) { await this.api.patch(`/members/${m.id}`, { branch_id: v ? +v : null }); await this.load(); }
}

// تأسيس دليل الحسابات (§7.2, §8.3): choose a published template (preview, confirm presentation policy, start date) or a manual chart
@Component({
  selector: 'chart-setup',
  template: `
  <div class="win"><div class="win-body">
    @if (co(); as co) {
      @if (co.chart_state !== 'pending_template') {
        <div class="banner info">الدليل مؤسس ({{ co.chart_state === 'from_template' ? 'من القالب ' + co.template?.name + ' إصدار ' + co.template?.version : co.chart_state === 'manual' ? 'يدوي' : 'موروث' }}). لا يُستبدل دليل قائم ولا يُدمج بقالب.</div>
      } @else if (!canChoose()) {
        <div class="banner warn">اختيار القالب لهذه الشركة من صلاحية إدارة المنصة. لا يمكن ترحيل قيود قبل اكتمال التأسيس.</div>
      } @else {
        <div class="banner info">اختيار القالب لا ينشئ أي مبالغ أو أرصدة؛ يضيف الحسابات فقط. يبدأ التسجيل المالي بإجراء مستقل.</div>
        @for (t of templates(); track t.id) {
          <div style="border:1px solid var(--line);background:var(--panel);border-radius:4px;padding:12px;display:flex;flex-direction:column;gap:6px">
            <b>{{ t.name }} <span class="chip">الإصدار {{ t.version }}</span> <span class="chip">{{ t.accounts }} حساب</span></b><div class="muted">{{ t.description }}</div>
            <div><button class="btn sm" (click)="preview(t.id)">معاينة الدليل</button></div>
          </div>
        }
        @if (pv(); as p) {
          <div class="kpis"><div class="kpi"><div class="l">إجمالي</div><div class="v">{{ p.counts.total }}</div></div><div class="kpi"><div class="l">تجميعي</div><div class="v">{{ p.counts.groups }}</div></div>
            <div class="kpi"><div class="l">قابل للترحيل</div><div class="v">{{ p.counts.postable }}</div></div></div>
          <div class="grid-wrap" style="max-height:40vh"><table class="grid"><thead><tr><th>الرمز</th><th>الحساب</th><th>النوع</th><th>الطبيعة</th><th>الإقفال</th><th>الوصف</th></tr></thead>
            <tbody>@for (a of p.accounts; track a.code) { <tr [class.group]="a.is_group"><td class="num">{{ a.code }}</td><td>{{ a.name }}</td><td>{{ a.is_group ? 'تجميعي' : 'قابل للترحيل' }}</td>
              <td>{{ N[a.nature] ?? '—' }}</td><td>{{ a.closing === 'temporary' ? 'مؤقت' : a.closing === 'permanent' ? 'دائم' : '—' }}</td><td class="muted" style="white-space:normal">{{ a.description }}</td></tr> }</tbody></table></div>
          <div class="filters"><label>تاريخ بدء استخدام الحسابات</label><input class="inp num" type="date" [value]="start()" (change)="start.set($any($event.target).value)" />
            @if (p.has_variable_presentation) { <label><input type="checkbox" (change)="policy.set($any($event.target).checked)" /> أؤكد سياسة العرض: الحسابات المتغيرة تُعرض بحسب رصيد كل حساب منفردًا دون مقاصة بين أطراف مستقلة</label> }
            <button class="btn primary" (click)="apply(p.id, p.has_variable_presentation)">تطبيق القالب</button></div>
        }
        <div><button class="btn sm" (click)="manual()">سأنشئ الدليل يدويًا بدل القالب</button></div>
      }
    }
  </div></div>`,
})
export class ChartSetup implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); ui = inject(Ui);
  N: Record<string, string> = { debit: 'مدين', credit: 'دائن', variable: 'متغير' };
  co = signal<any>(null); templates = signal<any[]>([]); pv = signal<any>(null); start = signal(today().slice(0, 4) + '-01-01'); policy = signal(false);
  canChoose = computed(() => this.auth.user()?.support_mode || (this.auth.isOwner() && this.co()?.template_choice === 'manager'));
  async ngOnInit() { await this.load(); }
  async load() { this.co.set(await this.api.get('/company')); if (this.co().chart_state === 'pending_template') this.templates.set(await this.api.get('/templates')); }
  async preview(id: number) { this.pv.set(await this.api.get(`/templates/${id}`)); }
  async apply(id: number, variable: boolean) {
    if (variable && !this.policy()) { this.ui.toast('أكد سياسة العرض أولًا', 'bad'); return; }
    if (!(await this.ui.confirm('تطبيق القالب', 'سيُنشأ دليل مستقل لهذه الشركة من القالب. لا ينشئ أي أرصدة. متابعة؟', 'تطبيق'))) return;
    const r = await this.api.post('/company/template', { template_id: id, start_date: this.start(), accept_policy: this.policy() });
    this.ui.toast(`أُسس الدليل: ${r.accounts} حساب`, 'ok'); await this.auth.enter(this.co().id); await this.load();
  }
  async manual() { if (await this.ui.confirm('دليل يدوي', 'ستنشئ الحسابات بنفسك من شاشة دليل الحسابات.', 'متابعة')) { await this.api.post('/company/manual-chart'); await this.auth.enter(this.co().id); await this.load(); } }
}

// دليل الحسابات + بطاقة الحساب (§9–11)
@Component({
  selector: 'accounts-view', imports: [DatePipe],
  styles: [`.layout { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; } .card { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .tw { cursor: pointer; display: inline-block; width: 18px; color: var(--ink-3); } @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } }`],
  template: `
  <div class="win"><div class="win-body">
    <div class="filters"><input class="inp" style="width:240px" placeholder="بحث بالرمز أو الاسم" (input)="q.set($any($event.target).value)" />
      <label>كما في</label><input class="inp num" type="date" [value]="asOf()" (change)="asOf.set($any($event.target).value); load()" />
      @if (auth.isOwner()) { <button class="btn sm primary" (click)="startNew()">حساب جديد</button> }</div>
    <div class="layout">
      <div class="grid-wrap" style="max-height:68vh"><table class="grid">
        <thead><tr><th>الرمز</th><th>الحساب</th><th>الطبيعة</th><th>الإقفال</th></tr></thead>
        <tbody>@for (a of visible(); track a.id) {
          <tr class="click" [class.sel]="a.id === cur()?.id" [class.group]="a.is_group" (click)="open(a.id)">
            <td class="num">{{ a.code }}</td>
            <td [style.padding-inline-start.px]="8 + a.depth * 18">@if (a.is_group) { <span class="tw" (click)="toggle(a.id); $event.stopPropagation()">{{ collapsed().has(a.id) ? '◂' : '▾' }}</span> }
              {{ a.name }} @if (!a.active && !a.is_group) { <span class="chip bad">موقوف</span> } @if (a.unmapped) { <span class="chip bad">بلا عرض</span> } @if (a.is_result_account) { <span class="chip ok">تحويل النتيجة</span> }</td>
            <td class="muted">{{ N[a.nature] ?? '' }}</td><td class="muted">{{ a.closing === 'temporary' ? 'مؤقت' : a.closing === 'permanent' ? 'دائم' : '' }}</td></tr>
        }</tbody></table></div>
      <div class="card">
        @if (creating()) {
          <b>حساب جديد</b>
          <div class="f"><label>الأب (تجميعي)</label><select class="inp" #p><option value="">جذر جديد</option>@for (g of groups(); track g.id) { <option [value]="g.id" [selected]="g.id === cur()?.id">{{ g.code }} — {{ g.name }}</option> }</select></div>
          <div class="f"><label>الرمز</label><input class="inp num req" maxlength="50" #c /></div>
          <div class="f"><label>الاسم</label><input class="inp req" maxlength="200" #n /></div>
          <div class="f"><label>النوع</label><select class="inp" #g><option value="0">قابل للترحيل</option><option value="1">تجميعي</option></select></div>
          <div class="f"><label>التصنيف (للجذر)</label><select class="inp" #cl>@for (k of classes; track k[0]) { <option [value]="k[0]">{{ k[1] }}</option> }</select></div>
          <div class="f"><label>الطبيعة</label><select class="inp" #na><option value="debit">مدين</option><option value="credit">دائن</option><option value="variable">متغير</option></select></div>
          <div class="f"><label>الإقفال</label><select class="inp" #cs><option value="permanent">دائم</option><option value="temporary">مؤقت ضمن النتيجة</option></select></div>
          <div class="f"><label>بند العرض</label><input class="inp num" placeholder="رقم البند 1–37 أو مدين/دائن مثل 8/18" #pr /></div>
          <div class="f"><label>بداية الاستخدام</label><input class="inp num" type="date" [value]="todayV" #sd /></div>
          <div style="display:flex;gap:6px"><button class="btn primary" (click)="create(p.value, c.value, n.value, g.value === '1', cl.value, na.value, cs.value, pr.value, sd.value)">حفظ الحساب</button><button class="btn" (click)="creating.set(false)">إلغاء</button></div>
        } @else if (cur(); as a) {
          <b>{{ last(a).code }} — {{ last(a).name }}</b>
          <div class="muted">التصنيف: {{ C[a.classification] }} · {{ a.is_group ? 'تجميعي' : 'قابل للترحيل' }} · الطبيعة: {{ N[a.nature] ?? '—' }} · الإقفال: {{ a.closing === 'temporary' ? 'مؤقت' : a.closing === 'permanent' ? 'دائم' : '—' }}</div>
          <div class="muted">بداية الاستخدام {{ a.start_date }} @if (a.stop_date) { · موقوف بعد {{ a.stop_date }} } · الحركات: {{ a.usage.n }}</div>
          @if (a.template_origin) { <div class="muted">من القالب: {{ a.template_origin }}</div> }
          @if (a.ref_function) { <div class="muted">وظيفة مرجعية: {{ a.ref_function }}</div> }
          <b style="margin-top:6px">تاريخ التعريف (الاسم والرمز والعرض)</b>
          <table class="grid"><thead><tr><th>من</th><th>إلى</th><th>الرمز</th><th>الاسم</th><th>العرض</th></tr></thead>
            <tbody>@for (d of a.definitions; track d.valid_from) { <tr><td class="num">{{ d.valid_from }}</td><td class="num">{{ d.valid_to ?? '—' }}</td><td class="num">{{ d.code }}</td><td>{{ d.name }}</td><td class="num">{{ pres(d.presentation) }}</td></tr> }</tbody></table>
          @if (auth.isOwner()) {
            <b style="margin-top:6px">تعريف جديد بتاريخ سريان</b>
            <div class="filters"><input class="inp num" style="width:120px" placeholder="الرمز" [value]="last(a).code" #dc /><input class="inp" placeholder="الاسم" [value]="last(a).name" #dn />
              <input class="inp num" style="width:110px" placeholder="العرض" [value]="pres(last(a).presentation)" #dp /><input class="inp num" type="date" #df />
              <button class="btn sm" (click)="define(a, dc.value, dn.value, dp.value, df.value)">حفظ التعريف</button></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
              @if (!a.is_group) { <button class="btn sm" (click)="ledger(a)">دفتر الأستاذ</button> }
              <button class="btn sm" (click)="stop(a)">{{ a.stop_date ? 'إعادة السماح بالاستخدام' : 'إيقاف الاستخدام الجديد' }}</button>
              @if (!a.is_group && a.classification === 'equity' && a.closing === 'permanent') { <button class="btn sm" (click)="resultAcc(a)">تعيينه حساب تحويل النتيجة</button> }
              <button class="btn sm danger" (click)="remove(a)">حذف (غير المستخدم فقط)</button>
            </div>
          }
        } @else { <div class="muted">اختر حسابًا لعرض بطاقته وتاريخ تعريفاته.</div> }
      </div>
    </div>
  </div></div>`,
})
export class AccountsView implements OnInit {
  tabId = input.required<number>();
  api = inject(Api); auth = inject(Auth); ui = inject(Ui); tabs = inject(Tabs);
  N: Record<string, string> = { debit: 'مدين', credit: 'دائن', variable: 'متغير' };
  C: Record<string, string> = { asset: 'أصول', liability: 'التزامات', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' };
  classes = Object.entries(this.C); todayV = today();
  all = signal<any[]>([]); q = signal(''); asOf = signal(today()); cur = signal<any>(null); creating = signal(false);
  collapsed = signal(new Set<number>());
  groups = computed(() => this.all().filter((a) => a.is_group));
  visible = computed(() => {
    const byParent = new Map<number | null, any[]>();
    for (const a of this.all()) { const k = a.parent_id ?? null; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k)!.push(a); }
    const out: any[] = []; const q = this.q().trim();
    const walk = (p: number | null, depth: number) => {
      for (const a of (byParent.get(p) ?? []).sort((x, y) => x.code.localeCompare(y.code, 'en'))) {
        if (!q || a.code.startsWith(q) || a.name.includes(q)) out.push({ ...a, depth });
        if (q || !this.collapsed().has(a.id)) walk(a.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });
  async ngOnInit() { await this.load(); }
  async load() { this.all.set(await this.api.get('/accounts', { as_of: this.asOf() })); }
  toggle(id: number) { const s = new Set(this.collapsed()); s.has(id) ? s.delete(id) : s.add(id); this.collapsed.set(s); }
  async open(id: number) { this.creating.set(false); this.cur.set(await this.api.get(`/accounts/${id}`)); }
  last(a: any) { return a.definitions[a.definitions.length - 1]; }
  pres(p: any) { return !p ? '' : p.type === 'fixed' ? String(p.line) : `${p.debit_line}/${p.credit_line}`; }
  parsePres(s: string) { s = s.trim(); if (!s) return null; const m = s.split('/').map(Number); return m.length === 2 ? { type: 'by_balance', debit_line: m[0], credit_line: m[1] } : { type: 'fixed', line: m[0] }; }
  startNew() { this.creating.set(true); }
  async create(parent: string, code: string, name: string, isGroup: boolean, classification: string, nature: string, closing: string, pres: string, start: string) {
    await this.api.post('/accounts', { parent_id: parent ? +parent : null, code, name, is_group: isGroup, classification: parent ? undefined : classification, nature, closing, presentation: this.parsePres(pres), start_date: start });
    this.ui.toast('أُضيف الحساب', 'ok'); this.creating.set(false); await this.load();
  }
  async define(a: any, code: string, name: string, pres: string, from: string) {
    if (!from) { this.ui.toast('حدد تاريخ السريان', 'bad'); return; }
    this.cur.set(await this.api.post(`/accounts/${a.id}/definitions`, { code, name, presentation: a.is_group ? undefined : this.parsePres(pres), valid_from: from }));
    this.ui.toast('حُفظ التعريف الجديد — الهوية والرصيد لم يتغيرا', 'ok'); await this.load();
  }
  async stop(a: any) {
    if (a.stop_date) { this.cur.set(await this.api.post(`/accounts/${a.id}/stop`, { date: null })); await this.load(); return; }
    const d = await this.ui.prompt('إيقاف الاستخدام الجديد', 'يبقى الحساب في التقارير والتاريخ؛ تُرفض القيود الجديدة بعد التاريخ.', 'آخر تاريخ مسموح (YYYY-MM-DD)', 'إيقاف');
    if (!d) return;
    this.cur.set(await this.api.post(`/accounts/${a.id}/stop`, { date: d })); await this.load();
  }
  async resultAcc(a: any) { await this.api.post('/company/result-account', { account_id: a.id }); this.ui.toast('عُيّن حساب تحويل النتيجة', 'ok'); await this.load(); }
  async remove(a: any) {
    if (!(await this.ui.confirm('حذف الحساب', 'يُحذف فقط حساب غير مستخدم بلا أبناء؛ يبقى رمزه محجوزًا تاريخيًا.', 'حذف', true))) return;
    await this.api.del(`/accounts/${a.id}`); this.cur.set(null); await this.load();
  }
  ledger(a: any) { this.tabs.open(`led-${a.id}`, `أستاذ ${this.last(a).name}`, LedgerView, { accountId: a.id }); }
}
