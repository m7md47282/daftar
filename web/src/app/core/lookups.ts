import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';

// Company structure used by every form (branches, warehouses, cost centers, reps, years).
@Injectable({ providedIn: 'root' })
export class Lookups {
  private api = inject(Api);
  company = signal<any>(null);
  branches = signal<any[]>([]);
  warehouses = signal<any[]>([]);
  costCenters = signal<any[]>([]);
  reps = signal<any[]>([]);
  fiscalYears = signal<any[]>([]);

  async load() {
    const [co, s, y] = await Promise.all([this.api.get('/company'), this.api.get('/structure'), this.api.get('/years')]);
    this.company.set(co); this.branches.set(s.branches); this.warehouses.set(s.warehouses);
    this.costCenters.set(s.cost_centers); this.reps.set(s.sales_reps); this.fiscalYears.set(y);
  }
  branchName(id: number | null | undefined) { return this.branches().find((b) => b.id === id)?.name ?? ''; }
  yearFor(date: string) { return this.fiscalYears().find((y) => y.start_date <= date && y.end_date >= date) ?? null; }
}
