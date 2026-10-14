import { Injectable, inject, signal, computed } from '@angular/core';
import { Api } from './api';

export type Company = { id: number; code: string; name: string; is_demo: boolean; chart_state: string; role: 'manager' | 'employee'; branch_id: number | null; branch_name: string | null };
// The shape the screens use. role: 'superadmin' (platform console), 'owner' (company manager or platform support), 'accountant' (employee).
export type User = {
  id: number; username: string; full_name: string; role: 'superadmin' | 'owner' | 'accountant';
  branch_id: number | null; branch_name: string | null; tenant_id: number | null; tenant_name: string | null;
  is_demo: boolean; ai_enabled: boolean; ai_available: boolean; ui_mode: 'system' | 'ai'; ai_credits: number | null;
  is_platform_admin: boolean; support_mode: boolean; chart_state: string | null;
};

const KEY = 'daftar.company';

@Injectable({ providedIn: 'root' })
export class Auth {
  private api = inject(Api);
  user = signal<User | null>(null);
  companies = signal<Company[]>([]);
  me = signal<any>(null);
  ready = signal(false);
  needsCompany = signal(false);
  isOwner = computed(() => this.user()?.role === 'owner');

  constructor() { this.api.onUnauthorized = () => { this.user.set(null); this.me.set(null); }; }

  // who am I + which company this window works in
  async load() {
    try {
      const r = await this.api.get<{ user: any; companies: Company[] }>('/auth/me', undefined, { quiet: true });
      this.me.set(r.user); this.companies.set(r.companies);
      const saved = Number(sessionStorage.getItem(KEY) || 0);
      const pick = r.companies.find((c) => c.id === saved) ?? (r.companies.length === 1 ? r.companies[0] : null);
      if (pick || (saved && r.user.is_platform_admin)) await this.enter(pick?.id ?? saved, false);
      else { this.api.companyId = null; this.setPlatformOrPicker(); }
    } catch { this.user.set(null); this.me.set(null); }
    this.ready.set(true);
  }

  private setPlatformOrPicker() {
    const u = this.me();
    if (u.is_platform_admin) {
      this.needsCompany.set(false);
      this.user.set({ id: u.id, username: u.username, full_name: u.full_name, role: 'superadmin', branch_id: null, branch_name: null, tenant_id: null, tenant_name: null,
        is_demo: false, ai_enabled: false, ai_available: false, ui_mode: u.ui_mode, ai_credits: null, is_platform_admin: true, support_mode: false, chart_state: null });
    } else { this.user.set(null); this.needsCompany.set(true); }
  }

  async enter(companyId: number, persist = true) {
    this.api.companyId = companyId;
    const co = await this.api.get('/company');
    const ai = await this.api.get('/ai/status', undefined, { quiet: true }).catch(() => null);
    const u = this.me();
    if (persist) sessionStorage.setItem(KEY, String(companyId));
    else sessionStorage.setItem(KEY, String(companyId));
    const membership = this.companies().find((c) => c.id === companyId);
    this.needsCompany.set(false);
    this.user.set({
      id: u.id, username: u.username, full_name: u.full_name, role: co.role === 'employee' ? 'accountant' : 'owner',
      branch_id: co.branch_id, branch_name: membership?.branch_name ?? null, tenant_id: co.id, tenant_name: co.name, is_demo: co.is_demo,
      ai_enabled: !!ai?.enabled, ai_available: !!ai?.available, ui_mode: u.ui_mode, ai_credits: ai?.credits ?? null,
      is_platform_admin: u.is_platform_admin, support_mode: co.role === 'platform', chart_state: co.chart_state,
    });
  }
  async leaveCompany() {
    sessionStorage.removeItem(KEY);
    this.api.companyId = null;
    this.setPlatformOrPicker();
  }

  async login(username: string, password: string) {
    await this.api.post('/auth/login', { username, password });
    sessionStorage.removeItem(KEY);
    await this.load();
  }
  async demo(as: 'owner' | 'accountant') {
    const r = await this.api.post('/auth/demo', { as: as === 'owner' ? 'manager' : 'employee' });
    sessionStorage.setItem(KEY, String(r.company_id));
    await this.load();
  }
  aiMode = computed(() => !!this.user()?.ai_available && this.user()?.ui_mode === 'ai');
  async setMode(mode: 'system' | 'ai') {
    await this.api.patch('/auth/mode', { mode });
    this.me.update((u) => (u ? { ...u, ui_mode: mode } : u));
    this.user.update((u) => (u ? { ...u, ui_mode: mode } : u));
  }
  setCredits(c: number | null) { if (c != null) this.user.update((u) => (u ? { ...u, ai_credits: c } : u)); }
  async refreshAi() {
    const ai = await this.api.get('/ai/status', undefined, { quiet: true }).catch(() => null);
    this.user.update((u) => (u ? { ...u, ai_enabled: !!ai?.enabled, ai_available: !!ai?.available, ai_credits: ai?.credits ?? null } : u));
  }
  async logout() {
    await this.api.post('/auth/logout').catch(() => {});
    sessionStorage.removeItem(KEY);
    this.api.companyId = null;
    this.user.set(null); this.me.set(null);
  }
}
