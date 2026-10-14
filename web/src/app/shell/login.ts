import { Component, inject, signal } from '@angular/core';
import { Auth } from '../core/auth';

@Component({
  selector: 'app-login',
  styles: [`
    :host { min-height: 100vh; display: grid; grid-template-columns: 1.1fr 1fr; background: var(--bg); }
    .side { background: #1c2733; color: #e8edf3; padding: 56px 56px 40px; display: flex; flex-direction: column; gap: 28px; }
    .brand { font-size: 34px; font-weight: 700; color: var(--brand); }
    .tag { font-size: 20px; line-height: 1.6; max-width: 460px; }
    .privacy { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; max-width: 520px; }
    .privacy h2 { margin: 0; font-size: 18px; color: #fff; display: flex; gap: 10px; align-items: center; }
    .privacy p { margin: 0; line-height: 1.8; color: #c9d3de; display: flex; gap: 10px; }
    .privacy p b { color: #fff; }
    .lock { width: 22px; height: 22px; flex: none; }
    .tick { color: #7fd1a4; flex: none; }
    .foot { margin-top: auto; color: #7d8a99; font-size: 12px; }
    .main { display: grid; place-items: center; padding: 32px 20px; }
    form { width: min(380px, 100%); display: flex; flex-direction: column; gap: 14px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    .f { grid-template-columns: 1fr; gap: 4px; }
    .inp { height: 42px; font-size: 15px; }
    .btn.primary { height: 44px; font-size: 16px; }
    .or { display: flex; align-items: center; gap: 10px; color: var(--ink-3); font-size: 13px; margin-top: 8px; }
    .or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--line); }
    .demo { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .demo .btn { height: 52px; flex-direction: column; gap: 0; }
    .demo small { color: var(--ink-3); font-size: 12px; }
    @media (max-width: 900px) { :host { grid-template-columns: 1fr; } .side { padding: 32px 20px; } }
  `],
  template: `
  <section class="side">
    <div class="brand">دفتر</div>
    <div class="tag">نظامك المحاسبي بنفس الشاشات التي تعرفها — فواتير، سندات، مخزون، وتقارير — ومعه محاسب ذكي يعمل بأمرك.</div>
    <div class="privacy">
      <h2>
        <svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        بياناتك لك وحدك
      </h2>
      <p><span class="tick">✓</span><span><b>لا يرى بياناتك إلا أنت ومن تمنحه الصلاحية</b>، ومحاسب الفرع يرى فرعه فقط. يدخل فريق الدعم الفني عند الحاجة لإصلاح عطل فقط، ويظهر دخوله في سجلك.</span></p>
      <p><span class="tick">✓</span><span><b>بيانات منشأتك معزولة</b> عن أي منشأة أخرى، ولا نبيعها أو نشاركها مع أي جهة.</span></p>
      <p><span class="tick">✓</span><span><b>كل دخول إلى حسابك مسجّل</b> وتستطيع مراجعته في أي وقت.</span></p>
    </div>
    <div class="foot">بياناتك مشفّرة أثناء النقل ومستضافة في مراكز بيانات سحابية.</div>
  </section>
  <section class="main">
    <form (submit)="submit($event)">
      <h1>تسجيل الدخول</h1>
      <div class="f"><label>اسم المستخدم</label><input class="inp num" autocomplete="username" [value]="u()" (input)="u.set($any($event.target).value)" autofocus /></div>
      <div class="f"><label>كلمة المرور</label><input class="inp" type="password" autocomplete="current-password" [value]="p()" (input)="p.set($any($event.target).value)" /></div>
      @if (err()) { <div class="banner bad">{{ err() }}</div> }
      <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'جارٍ الدخول…' : 'دخول' }}</button>
      <div class="or">أو جرّب النظام ببيانات تجريبية</div>
      <div class="demo">
        <button class="btn" type="button" (click)="demo('owner')" [disabled]="busy()">دخول كمالك<small>كل الفروع والتقارير</small></button>
        <button class="btn" type="button" (click)="demo('accountant')" [disabled]="busy()">دخول كمحاسب فرع<small>فرع جدة فقط</small></button>
      </div>
      <div class="muted" style="font-size:12px;text-align:center">النسخة التجريبية خاصة بك ببيانات وهمية، وتُحذف تلقائياً بعد 24 ساعة.</div>
    </form>
  </section>`,
})
export class Login {
  auth = inject(Auth);
  u = signal(''); p = signal(''); err = signal(''); busy = signal(false);
  async submit(e: Event) {
    e.preventDefault();
    this.busy.set(true); this.err.set('');
    try { await this.auth.login(this.u(), this.p()); } catch (x: any) { this.err.set(x.message); } finally { this.busy.set(false); }
  }
  async demo(as: 'owner' | 'accountant') {
    this.busy.set(true); this.err.set('');
    try { await this.auth.demo(as); } catch (x: any) { this.err.set(x.message); } finally { this.busy.set(false); }
  }
}
