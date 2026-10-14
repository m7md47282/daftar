import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { Auth } from '../core/auth';
import { money } from '../core/fmt';

type Msg = { role: 'user' | 'ai' | 'note'; text: string; pending?: Pending[]; files?: { label: string; url: string }[] };
type Pending = { id: string; tool: string; summary: string; preview: any; state: 'open' | 'done' | 'cancelled' | 'busy'; result?: any; pdf?: string | null };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
// Small markdown subset: tables, bold, bullets, line breaks. Input is escaped first.
function md(src: string): string {
  const lines = esc(src).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      let h = `<table class="grid md"><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { h += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`; i++; }
      out.push(h + '</tbody></table>'); i--; continue;
    }
    if (/^\s*[-*•]\s+/.test(l)) { out.push(`<div class="li">• ${l.replace(/^\s*[-*•]\s+/, '')}</div>`); continue; }
    if (/^#{1,4}\s/.test(l)) { out.push(`<div class="h">${l.replace(/^#+\s/, '')}</div>`); continue; }
    out.push(l ? `<div>${l}</div>` : '<div class="sp"></div>');
  }
  return out.join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

@Component({
  selector: 'ai-panel',
  host: { '[class.embedded]': 'embedded()' },
  styles: [`
    :host { position: fixed; inset-block: 0; left: 0; width: min(520px, 100vw); z-index: 40; display: flex; flex-direction: column; background: var(--surface); border-inline-start: 1px solid var(--line); box-shadow: 0 0 40px rgba(0,0,0,.18); }
    :host(.embedded) { position: static; width: auto; height: 100%; min-height: 0; box-shadow: none; border: 1px solid var(--line); border-radius: 4px; }
    :host(.embedded) .msgs { padding: 18px max(14px, calc((100% - 860px) / 2)); }
    :host(.embedded) .compose { padding-inline: max(10px, calc((100% - 860px) / 2)); }
    .credits { font-size: 12px; color: #b8c0cc; }
    .files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #2a2f3a; color: #fff; }
    header b { font-size: 15px; } header small { color: #b8c0cc; display: block; font-size: 12px; }
    header .x { color: #fff; }
    .msgs { flex: 1; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .m { max-width: 92%; padding: 9px 12px; border-radius: 8px; line-height: 1.7; font-size: 14px; }
    .m.user { align-self: flex-start; background: var(--accent); color: #fff; border-start-start-radius: 2px; }
    .m.ai { align-self: flex-end; background: var(--panel); border: 1px solid var(--line); border-start-end-radius: 2px; width: 92%; }
    .m.note { align-self: center; background: var(--ok-soft); color: var(--ok); font-size: 13px; }
    .m ::ng-deep table.md { margin: 6px 0; font-size: 12px; }
    .m ::ng-deep .li { padding-inline-start: 6px; } .m ::ng-deep .h { font-weight: 700; margin-top: 4px; } .m ::ng-deep .sp { height: 6px; }
    .card { border: 1px solid var(--req-line); background: #fffbea; border-radius: 6px; padding: 10px 12px; margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
    .card .t { font-weight: 600; }
    .card table { font-size: 12px; }
    .card .row { display: flex; gap: 8px; }
    .compose { border-top: 1px solid var(--line); padding: 10px; display: flex; gap: 8px; background: #eceef2; }
    .compose textarea { flex: 1; resize: none; height: 64px; }
    .hint { color: var(--ink-3); font-size: 13px; display: flex; flex-direction: column; gap: 6px; }
    .hint button { text-align: right; border: 1px dashed var(--line); background: var(--panel); padding: 8px 10px; border-radius: 4px; cursor: pointer; }
    .hint button:hover { border-color: var(--accent); }
    .typing { align-self: flex-end; color: var(--ink-3); font-size: 13px; }
  `],
  template: `
  <header>
    <div><b>المحاسب الذكي</b><small>يستخدم النظام نيابةً عنك — لا يحفظ شيئاً قبل تأكيدك</small></div>
    <div style="display:flex;gap:6px;align-items:center">
      @if (auth.user()?.ai_credits != null) { <span class="credits">الرصيد: {{ auth.user()!.ai_credits!.toFixed(2) }}</span> }
      <button class="x" title="محادثة جديدة" (click)="newChat()">⟲</button>
      @if (!embedded()) { <button class="x" (click)="closed.emit()">✕</button> }
    </div>
  </header>
  <div class="msgs" #scroller>
    @if (!msgs().length) {
      <div class="hint">
        <span>اكتب ما تريد كما تقوله لمحاسبك، مثلاً:</span>
        @for (s of samples; track s) { <button (click)="send(s)">{{ s }}</button> }
      </div>
    }
    @for (m of msgs(); track $index) {
      <div class="m" [class]="m.role" >
        @if (m.role === 'ai') { <div [innerHTML]="md(m.text)"></div> } @else { {{ m.text }} }
        @if (m.files?.length) {
          <div class="files">@for (f of m.files; track f.url) { <a class="btn sm" [href]="withCo(f.url)" target="_blank">PDF — {{ f.label }}</a> }</div>
        }
        @for (p of m.pending ?? []; track p.id) {
          <div class="card">
            <div class="t">{{ p.summary }}</div>
            @if (p.preview?.journal?.length) {
              <table class="grid"><thead><tr><th>الحساب</th><th class="n">مدين</th><th class="n">دائن</th></tr></thead>
                <tbody>@for (j of p.preview.journal; track $index) { <tr><td>{{ j.account_code }} {{ j.account_name }}</td><td class="n">{{ j.debit ? fm(j.debit) : '' }}</td><td class="n">{{ j.credit ? fm(j.credit) : '' }}</td></tr> }</tbody></table>
            }
            @if (p.tool === 'create_invoice' && p.preview?.lines?.length) {
              <table class="grid"><thead><tr><th>الصنف</th><th class="n">الكمية</th><th class="n">السعر</th><th class="n">الإجمالي</th></tr></thead>
                <tbody>@for (l of p.preview.lines; track $index) { <tr><td>{{ l.item_name }}</td><td class="n">{{ l.qty }} {{ l.unit_name }}</td><td class="n">{{ fm(l.price) }}</td><td class="n">{{ fm(l.total) }}</td></tr> }</tbody></table>
            }
            @switch (p.state) {
              @case ('open') { <div class="row"><button class="btn primary sm" (click)="confirm(p)">تأكيد وحفظ</button><button class="btn sm" (click)="cancel(p)">إلغاء</button></div> }
              @case ('busy') { <span class="muted">جارٍ الحفظ…</span> }
              @case ('done') { <span class="chip ok">تم الحفظ{{ p.result?.number ? ' — رقم ' + p.result.number : '' }}</span>
                @if (p.pdf) { <a class="btn sm" [href]="withCo(p.pdf)" target="_blank">تنزيل PDF</a> } }
              @case ('cancelled') { <span class="chip bad">أُلغيت</span> }
            }
          </div>
        }
      </div>
    }
    @if (busy()) { <div class="typing">المحاسب يعمل على طلبك…</div> }
  </div>
  <div class="compose">
    <textarea class="inp" placeholder="اكتب طلبك… (Enter للإرسال)" [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown.enter)="onEnter($any($event))"></textarea>
    <button class="btn primary" [disabled]="busy() || !draft().trim()" (click)="send(draft())">إرسال</button>
  </div>`,
})
export class AiPanel {
  withCo = (u: string) => u + (u.includes('?') ? '&' : '?') + 'company=' + this.api.companyId;
  closed = output<void>();
  embedded = input(false);
  api = inject(Api); ui = inject(Ui); auth = inject(Auth);
  md = md; fm = money;
  scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  msgs = signal<Msg[]>([]); draft = signal(''); busy = signal(false);
  conversationId: string | undefined;
  samples = [
    'كم مبيعاتي اليوم وكم الربح؟',
    'من هم أكثر العملاء مديونية؟',
    'أنشئ فاتورة مبيعات نقدية لعميل عام: 3 متر قطن مصري سادة',
    'سجّل سند صرف 450 ريال كهرباء لفرع جدة',
    'كم الضريبة المستحقة هذا الربع؟',
  ];

  private scroll() { setTimeout(() => { const el = this.scroller()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }); }
  onEnter(e: KeyboardEvent) { if (e.shiftKey) return; e.preventDefault(); this.send(this.draft()); }
  newChat() { this.msgs.set([]); this.conversationId = undefined; }

  async send(text: string) {
    text = text.trim();
    if (!text || this.busy()) return;
    this.draft.set('');
    this.msgs.update((m) => [...m, { role: 'user', text }]);
    this.busy.set(true); this.scroll();
    try {
      const r = await this.api.post('/ai/chat', { conversation_id: this.conversationId, message: text });
      this.conversationId = r.conversation_id;
      this.auth.setCredits(r.credits);
      this.msgs.update((m) => [...m, { role: 'ai', text: r.text || (r.pending.length ? 'راجع العملية أدناه ثم اضغط تأكيد.' : '—'),
        pending: r.pending.map((p: any) => ({ ...p, state: 'open' })), files: r.files }]);
    } catch (e: any) {
      this.msgs.update((m) => [...m, { role: 'note', text: e.message }]);
    } finally { this.busy.set(false); this.scroll(); }
  }
  async confirm(p: Pending) {
    p.state = 'busy'; this.msgs.update((m) => [...m]);
    try {
      const r = await this.api.post(`/ai/confirm/${p.id}`, { conversation_id: this.conversationId });
      p.state = 'done'; p.result = r.result; p.pdf = r.pdf_url;
      this.ui.toast('تم الحفظ', 'ok');
    } catch { p.state = 'open'; }
    this.msgs.update((m) => [...m]);
  }
  async cancel(p: Pending) {
    await this.api.post(`/ai/reject/${p.id}`, { conversation_id: this.conversationId }).catch(() => {});
    p.state = 'cancelled'; this.msgs.update((m) => [...m]);
  }
}
