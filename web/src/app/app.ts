import { Component, OnInit, inject } from '@angular/core';
import { Auth } from './core/auth';
import { Ui } from './core/ui';
import { Login } from './shell/login';
import { Shell } from './shell/shell';
import { AdminConsole } from './admin/admin';
import { CompanyPicker } from './shell/company-picker';
import { InvitePage } from './shell/invite';

@Component({
  selector: 'app-root',
  imports: [Login, Shell, AdminConsole, CompanyPicker, InvitePage],
  template: `
  @if (inviteToken) { <invite-page [token]="inviteToken" /> }
  @else if (auth.ready()) {
    @if (auth.needsCompany()) { <company-picker /> }
    @else if (!auth.user()) { <app-login /> }
    @else if (auth.user()!.role === 'superadmin') { <admin-console /> }
    @else { <app-shell /> }
  }
  <div class="toasts">@for (t of ui.toasts(); track t.id) { <div class="toast" [class]="t.kind">{{ t.text }}</div> }</div>
  @if (ui.confirmState(); as c) {
    <div class="overlay" (click)="ui.closeConfirm(false)" (keydown.escape)="ui.closeConfirm(false)">
      <div class="dialog" style="width:min(460px,100%)" (click)="$event.stopPropagation()">
        <header><span>{{ c.title }}</span></header>
        <div class="body">{{ c.text }}</div>
        <footer>
          <button class="btn" [class.primary]="!c.danger" [class.danger]="c.danger" (click)="ui.closeConfirm(true)" autofocus>{{ c.ok }}</button>
          <button class="btn" (click)="ui.closeConfirm(false)">رجوع</button>
        </footer>
      </div>
    </div>
  }
  @if (ui.promptState(); as p) {
    <div class="overlay" (keydown.escape)="ui.closePrompt(null)">
      <div class="dialog" style="width:min(460px,100%)" (click)="$event.stopPropagation()">
        <header><span>{{ p.title }}</span><button class="x" (click)="ui.closePrompt(null)">✕</button></header>
        <div class="body">
          <div>{{ p.text }}</div>
          <div class="f" style="grid-template-columns:1fr;gap:4px"><label>{{ p.label }}</label>
            <input #pv class="inp" [type]="p.password ? 'password' : 'text'" autofocus (keydown.enter)="ui.closePrompt(pv.value || null)" /></div>
        </div>
        <footer>
          <button class="btn" [class.primary]="!p.danger" [class.danger]="p.danger" (click)="ui.closePrompt(pv.value || null)">{{ p.ok }}</button>
          <button class="btn" (click)="ui.closePrompt(null)">رجوع</button>
        </footer>
      </div>
    </div>
  }`,
})
export class App implements OnInit {
  auth = inject(Auth); ui = inject(Ui);
  inviteToken = location.pathname.startsWith('/invite/') ? location.pathname.slice(8) : '';
  ngOnInit() { if (!this.inviteToken) this.auth.load(); else this.auth.load(); }
}
