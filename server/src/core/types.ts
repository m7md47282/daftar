import { fail } from './errors.ts';

export type Via = 'web' | 'ai' | 'seed' | 'system';
export type Role = 'manager' | 'employee' | 'platform';

// Who is acting, in which company. Built fresh for every request from the database, so a
// membership that was stopped a second ago is already refused (§5.4).
// role 'platform' = a platform admin who explicitly selected this company (support access).
export type Ctx = {
  userId: number;
  userName: string;
  companyId: number;
  role: Role;
  branchId: number | null; // branch restriction for an employee (extension D2)
  via: Via;
};

export const isManager = (c: Ctx) => c.role === 'manager' || c.role === 'platform';
export const requireManager = (c: Ctx) => { if (!isManager(c)) fail('هذا الإجراء لمدير الشركة', 403); };
export const branchScope = (c: Ctx): 'all' | number => (c.role === 'employee' && c.branchId ? c.branchId : 'all');

export type InvoiceKind = 'sale' | 'sale_return' | 'purchase' | 'purchase_return';
export type VoucherKind = 'receipt' | 'payment';

export const INVOICE_LABEL: Record<InvoiceKind, string> = {
  sale: 'فاتورة مبيعات', sale_return: 'فاتورة مرتجع مبيعات', purchase: 'فاتورة مشتريات', purchase_return: 'فاتورة مرتجع مشتريات',
};
export const VOUCHER_LABEL: Record<VoucherKind, string> = { receipt: 'سند قبض', payment: 'سند صرف' };
export const PURPOSE_LABEL: Record<string, string> = { normal: 'قيد عادي', adjustment: 'تسوية مراجعة', opening: 'افتتاح التأسيس', closing: 'إقفال نظامي' };
