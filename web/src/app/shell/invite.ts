import { Component, OnInit, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { Auth } from '../core/auth';

// §6.2 accepting an invitation: a new person chooses their own login; an existing person logs in as themself.
@Component({
  selector: 'invite-page',
  styles: [`:host { min-height: 100vh; display: grid; place-items: center; background: var(--bg); padding: 20px; }
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; width: min(460px, 100%); padding: 22px; display: flex; flex-direction: column; gap: 12px; }
    h1 { margin: 0; font-size: 20px; } .f { grid-template-columns: 1fr; gap: 4px; } .inp { height: 40px; }`],
  template: `
  <div class="card">
    @if (err()) { <h1>الدعوة</h1><div class="banner bad">{{ err() }}</div><a class="btn" href="/">الذهاب لتسجيل الدخول</a> }
    @else if (info(); as i) {
      <h1>دعوة للانضمام إلى {{ i.company_name }}</h1>
      <div class="muted">الدور: {{ i.role === 'manager' ? 'مدير الشركة' : 'موظف' }} · البريد: {{ i.email_hint }}</div>
      @if (auth.me()) {
        <div class="banner info">أنت مسجل الدخول باسم {{ auth.me().full_name }}. ستُضاف العضوية لهذا الحساب إن كان بريده مطابقًا للدعوة.</div>
        <button class="btn primary" (click)="accept()" [disabled]="busy()">قبول الدعوة</button>
      } @else if (i.has_account) {
        <div class="banner warn">لهذا البريد حساب قائم. سجّل الدخول به أولًا ثم افتح رابط الدعوة مرة أخرى.</div>
        <a class="btn primary" href="/">تسجيل الدخول</a>
      } @else {
        <div class="f"><label>الاسم</label><input class="inp" [value]="name()" (input)="name.set($any($event.target).value)" /></div>
        <div class="f"><label>اسم الدخول</label><input class="inp num" (input)="username.set($any($event.target).value)" /></div>
        <div class="f"><label>كلمة المرور (8 أحرف على الأقل)</label><input class="inp" type="password" (input)="password.set($any($event.target).value)" /></div>
        <button class="btn primary" (click)="accept()" [disabled]="busy()">إنشاء حسابي وقبول الدعوة</button>
      }
    } @else { <div class="muted">جارٍ التحقق من الدعوة…</div> }
  </div>`,
})
export class InvitePage implements OnInit {
  token = input.required<string>();
  api = inject(Api); auth = inject(Auth);
  info = signal<any>(null); err = signal(''); busy = signal(false);
  name = signal(''); username = signal(''); password = signal('');
  async ngOnInit() {
    try { const i = await this.api.get(`/invitations/${this.token()}`, undefined, { quiet: true }); this.info.set(i); this.name.set(i.display_name); }
    catch (e: any) { this.err.set(e.message); }
  }
  async accept() {
    this.busy.set(true);
    try {
      const r = await this.api.post(`/invitations/${this.token()}/accept`, { username: this.username(), password: this.password(), full_name: this.name() });
      sessionStorage.setItem('daftar.company', String(r.company_id));
      history.replaceState(null, '', '/');
      location.reload();
    } catch { this.busy.set(false); }
  }
}
