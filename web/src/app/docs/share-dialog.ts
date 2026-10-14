import { Component, inject, input, output, signal } from '@angular/core';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { money } from '../core/fmt';

// Send an invoice to the customer: download the PDF, or create a private link
// and open it in the user's own WhatsApp / email (no third party sees the data).
@Component({
  selector: 'share-dialog',
  template: `
  <div class="overlay" (click)="closed.emit()">
    <div class="dialog" style="width:min(560px,100%)" (click)="$event.stopPropagation()">
      <header><span>إرسال {{ doc().label }} رقم {{ doc().number }}</span><button class="x" (click)="closed.emit()">✕</button></header>
      <div class="body">
        <div class="banner info">رابط خاص صالح لمدة 30 يوماً، يفتح هذه الفاتورة فقط ولا يكشف أي بيانات أخرى.</div>
        <div class="f"><label>جوال العميل</label><input class="inp num" [value]="phone()" (input)="phone.set($any($event.target).value)" placeholder="05xxxxxxxx" /></div>
        @if (link()) {
          <div class="f"><label>الرابط</label><input class="inp num" readonly [value]="link()" (focus)="$any($event.target).select()" /></div>
        }
      </div>
      <footer>
        <button class="btn primary" (click)="whatsapp()">إرسال عبر واتساب</button>
        <button class="btn" (click)="email()">إرسال بالبريد</button>
        <button class="btn" (click)="copy()">نسخ الرابط</button>
        <a class="btn" [href]="'/api/invoices/id/' + doc().id + '/pdf?company=' + api.companyId" target="_blank">تنزيل PDF</a>
      </footer>
    </div>
  </div>`,
})
export class ShareDialog {
  doc = input.required<any>();
  closed = output<void>();
  api = inject(Api); ui = inject(Ui);
  link = signal('');
  phone = signal('');
  ngOnInit() { this.phone.set(this.doc().party_phone && !/x/i.test(this.doc().party_phone) ? this.doc().party_phone : ''); }
  async ensure() {
    if (!this.link()) this.link.set((await this.api.post(`/invoices/id/${this.doc().id}/share`)).url);
    return this.link();
  }
  message(url: string) {
    const d = this.doc();
    return `السلام عليكم ${d.party_name}،\nمرفق ${d.label} رقم ${d.number} بتاريخ ${d.date} بمبلغ ${money(d.total)} ريال.\n${url}`;
  }
  async whatsapp() {
    const url = await this.ensure();
    let p = this.phone().replace(/\D/g, '');
    if (p.startsWith('05')) p = '966' + p.slice(1);
    window.open(`https://wa.me/${p}?text=${encodeURIComponent(this.message(url))}`, '_blank');
  }
  async email() {
    const url = await this.ensure();
    window.location.href = `mailto:?subject=${encodeURIComponent(`${this.doc().label} رقم ${this.doc().number}`)}&body=${encodeURIComponent(this.message(url))}`;
  }
  async copy() {
    const url = await this.ensure();
    await navigator.clipboard.writeText(url).catch(() => {});
    this.ui.toast('تم نسخ الرابط', 'ok');
  }
}
