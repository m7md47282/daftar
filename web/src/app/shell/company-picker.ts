import { Component, inject } from '@angular/core';
import { Auth } from '../core/auth';

// A person with access to several companies chooses one per window (§5.4).
@Component({
  selector: 'company-picker',
  styles: [`:host { min-height: 100vh; display: grid; place-items: center; background: var(--bg); padding: 20px; }
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; width: min(520px, 100%); padding: 22px; display: flex; flex-direction: column; gap: 10px; }
    h1 { margin: 0 0 6px; font-size: 20px; } .co { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); cursor: pointer; }
    .co:hover { border-color: var(--accent); background: var(--accent-soft); } .co small { color: var(--ink-3); }`],
  template: `
  <div class="card">
    <h1>اختر الشركة</h1>
    <div class="muted">لكل نافذة شركتها؛ اختيارك هنا لا يغيّر النوافذ الأخرى.</div>
    @for (c of auth.companies(); track c.id) {
      <div class="co" (click)="auth.enter(c.id)"><div><b>{{ c.name }}</b><br /><small>{{ c.code }}</small></div>
        <span class="chip">{{ c.role === 'manager' ? 'مدير الشركة' : 'موظف' + (c.branch_name ? ' — ' + c.branch_name : '') }}</span></div>
    } @empty { <div class="banner warn">لا توجد شركة مفعّلة لحسابك. اطلب دعوة من مدير الشركة.</div> }
    <button class="btn" (click)="auth.logout()">خروج</button>
  </div>`,
})
export class CompanyPicker { auth = inject(Auth); }
