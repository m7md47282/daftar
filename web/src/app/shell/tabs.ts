import { Injectable, signal, computed, type Type } from '@angular/core';

export type Tab = { id: number; key: string; title: string; component: Type<unknown>; inputs: Record<string, unknown> };
// What a screen can do when its function keys are pressed. All optional.
export type Keys = Partial<Record<'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12', () => void>> & { beforeClose?: () => Promise<boolean> };

@Injectable({ providedIn: 'root' })
export class Tabs {
  tabs = signal<Tab[]>([]);
  activeId = signal<number | null>(null);
  active = computed(() => this.tabs().find((t) => t.id === this.activeId()) ?? null);
  private keys = new Map<number, Keys>();
  private n = 0;

  // Opening the same screen twice just focuses it (like the desktop app).
  open(key: string, title: string, component: Type<unknown>, inputs: Record<string, unknown> = {}) {
    const existing = this.tabs().find((t) => t.key === key);
    if (existing) { this.activeId.set(existing.id); return; }
    const id = ++this.n;
    this.tabs.update((t) => [...t, { id, key, title, component, inputs: { ...inputs, tabId: id } }]);
    this.activeId.set(id);
  }
  async close(id: number) {
    const k = this.keys.get(id);
    if (k?.beforeClose && !(await k.beforeClose())) return;
    const list = this.tabs();
    const i = list.findIndex((t) => t.id === id);
    this.keys.delete(id);
    this.tabs.set(list.filter((t) => t.id !== id));
    if (this.activeId() === id) this.activeId.set(list[i + 1]?.id ?? list[i - 1]?.id ?? null);
  }
  closeAll() { this.tabs.set([]); this.keys.clear(); this.activeId.set(null); }
  register(tabId: number, keys: Keys) { this.keys.set(tabId, keys); }
  setTitle(tabId: number, title: string) { this.tabs.update((t) => t.map((x) => (x.id === tabId ? { ...x, title } : x))); }

  handleKey(e: KeyboardEvent): boolean {
    const id = this.activeId();
    if (id == null) return false;
    if (e.key === 'Escape') { this.close(id); return true; }
    const fn = this.keys.get(id)?.[e.key as keyof Keys] as (() => void) | undefined;
    if (fn) { fn(); return true; }
    return false;
  }
}
