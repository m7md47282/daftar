import { Injectable, signal } from '@angular/core';

type Toast = { id: number; text: string; kind: 'info' | 'ok' | 'bad' };
type Confirm = { title: string; text: string; ok: string; danger?: boolean; resolve: (v: boolean) => void };
type Prompt = { title: string; text: string; label: string; ok: string; password?: boolean; danger?: boolean; resolve: (v: string | null) => void };

@Injectable({ providedIn: 'root' })
export class Ui {
  toasts = signal<Toast[]>([]);
  confirmState = signal<Confirm | null>(null);
  promptState = signal<Prompt | null>(null);
  private n = 0;

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++this.n;
    this.toasts.update((t) => [...t, { id, text, kind }]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== id)), kind === 'bad' ? 6000 : 3500);
  }

  confirm(title: string, text: string, ok = 'تأكيد', danger = false): Promise<boolean> {
    return new Promise((resolve) => this.confirmState.set({ title, text, ok, danger, resolve }));
  }
  closeConfirm(v: boolean) { this.confirmState()?.resolve(v); this.confirmState.set(null); }

  // free text (a reason) or the person's own password for re-confirmation
  prompt(title: string, text: string, label: string, ok = 'متابعة', opts: { password?: boolean; danger?: boolean } = {}): Promise<string | null> {
    return new Promise((resolve) => this.promptState.set({ title, text, label, ok, ...opts, resolve }));
  }
  closePrompt(v: string | null) { this.promptState()?.resolve(v); this.promptState.set(null); }
}
