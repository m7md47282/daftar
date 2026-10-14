import { Injectable, inject } from '@angular/core';
import { Api } from './api';
import { Ui } from './ui';
import { Auth } from './auth';

// §13.3: sensitive actions ask for the person's own password; the token lasts 5 minutes for one action only.
@Injectable({ providedIn: 'root' })
export class Reauth {
  private api = inject(Api); private ui = inject(Ui); private auth = inject(Auth);
  async token(action: 'period.lock' | 'period.reopen' | 'year.reopen' | 'year.close' | 'snapshot.approve', what: string): Promise<string | null> {
    // Demo users have no real password; the demo one is shown so visitors can try locking and closing.
    const hint = this.auth.user()?.is_demo ? ' (في النسخة التجريبية: demo1234)' : '';
    const pw = await this.ui.prompt('تأكيد الهوية', `${what} — أدخل كلمة مرورك الشخصية للتأكيد. لا توجد كلمة سر مشتركة.${hint}`, 'كلمة المرور', 'تأكيد', { password: true });
    if (!pw) return null;
    try { return (await this.api.post('/reauth', { action, password: pw })).token; }
    catch (e: any) { this.ui.toast(e?.message || 'كلمة المرور غير صحيحة', 'bad'); return null; }
  }
}
