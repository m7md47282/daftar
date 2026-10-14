import type { Type } from '@angular/core';
import { InvoiceForm } from '../docs/invoice-form';
import { VoucherForm } from '../docs/voucher-form';
import { ItemsForm } from '../files/items';
import { PartiesForm } from '../files/parties';
import { StructureForm } from '../files/structure';
import { VatReport, StockReport, ItemMovement, DocList, PartyBalances } from '../reports/reports';
import { CompanySettings, AccessLog, AiSettings, PasswordSettings } from '../settings/settings';
import { JournalForm } from '../journal/journal-form';
import { EntriesList, DraftsList } from '../journal/lists';
import { LedgerView, PartyStatement, TrialBalanceView, WorksheetView } from '../books/books';
import { StatementView, SnapshotsView } from '../books/statements';
import { YearsView, ReviewView, ClosingView } from '../setup/periods';
import { MembersView, ChartSetup, AccountsView } from '../setup/company';

export type Screen = { key: string; title: string; component: Type<unknown>; inputs?: Record<string, unknown> };
export type MenuItem =
  | { sep: true }
  | { label: string; screen?: Screen; action?: string; soon?: boolean; owner?: boolean; key?: string; children?: MenuItem[] };
export type Menu = { label: string; items: MenuItem[]; owner?: boolean; action?: string };

const s = (key: string, title: string, component: Type<unknown>, inputs?: Record<string, unknown>): Screen => ({ key, title, component, inputs });
const SEP = { sep: true } as const;

// Same menus, same names, same order as the system the traders already use.
// Items marked "soon" keep their place so nothing moves when they ship.
export const MENUS: Menu[] = [
  { label: 'الملفات', items: [
    { label: 'دليل الحسابات', screen: s('accounts', 'دليل الحسابات', AccountsView) },
    { label: 'تأسيس الدليل من قالب', owner: true, screen: s('chart-setup', 'تأسيس الدليل', ChartSetup) },
    SEP,
    { label: 'الأصناف', screen: s('items', 'الأصناف', ItemsForm) },
    { label: 'العملاء', screen: s('customers', 'العملاء', PartiesForm, { kind: 'customer' }) },
    { label: 'الموردين', screen: s('suppliers', 'الموردين', PartiesForm, { kind: 'supplier' }) },
    SEP,
    { label: 'الفروع والمستودعات ومراكز التكلفة', screen: s('structure', 'الفروع والمستودعات', StructureForm) },
  ]},
  { label: 'الفواتير', items: [
    { label: 'نقاط البيع', soon: true }, { label: 'مرتجع نقاط بيع', soon: true }, SEP,
    { label: 'فاتورة مبيعات', screen: s('inv-sale', 'فاتورة مبيعات', InvoiceForm, { kind: 'sale' }) },
    { label: 'فاتورة مرتجع مبيعات', screen: s('inv-sale_return', 'فاتورة مرتجع مبيعات', InvoiceForm, { kind: 'sale_return' }) }, SEP,
    { label: 'فاتورة مشتريات', screen: s('inv-purchase', 'فاتورة مشتريات', InvoiceForm, { kind: 'purchase' }) },
    { label: 'فاتورة مرتجع مشتريات', screen: s('inv-purchase_return', 'فاتورة مرتجع مشتريات', InvoiceForm, { kind: 'purchase_return' }) }, SEP,
    { label: 'فاتورة عرض أسعار', soon: true }, { label: 'فاتورة طلب شراء', soon: true }, SEP,
    { label: 'كميات إفتتاحية', soon: true }, { label: 'فاتورة تسوية مخزون', soon: true },
  ]},
  { label: 'السندات', items: [
    { label: 'سند قبض', screen: s('v-receipt', 'سند قبض', VoucherForm, { kind: 'receipt' }) },
    { label: 'سند صرف', screen: s('v-payment', 'سند صرف', VoucherForm, { kind: 'payment' }) },
    SEP,
    { label: 'سند قيد', screen: s('je-new', 'سند قيد', JournalForm) },
    { label: 'المسودات', screen: s('drafts', 'المسودات', DraftsList) },
    { label: 'اليومية العامة', screen: s('entries', 'اليومية العامة', EntriesList) },
  ]},
  { label: 'تقارير المخزون', items: [
    { label: 'تقارير الأصناف', children: [
      { label: 'أرصدة المخزون', screen: s('r-stock', 'أرصدة المخزون', StockReport) },
      { label: 'حركة صنف', screen: s('r-item-mv', 'حركة صنف', ItemMovement) },
    ]},
    { label: 'تقارير العملاء', children: [
      { label: 'أرصدة العملاء', screen: s('r-cust-bal', 'أرصدة العملاء', PartyBalances, { kind: 'customer' }) },
      { label: 'كشف حساب عميل', screen: s('r-cust-stmt', 'كشف حساب عميل', PartyStatement, { kind: 'customer' }) },
    ]},
    { label: 'تقارير الموردين', children: [
      { label: 'أرصدة الموردين', screen: s('r-supp-bal', 'أرصدة الموردين', PartyBalances, { kind: 'supplier' }) },
      { label: 'كشف حساب مورد', screen: s('r-supp-stmt', 'كشف حساب مورد', PartyStatement, { kind: 'supplier' }) },
    ]},
    SEP,
    { label: 'التقرير اليومي', action: 'home' },
    SEP,
    { label: 'تقارير مبيعات نقاط البيع', soon: true }, { label: 'تقارير مرتجع نقاط بيع', soon: true }, SEP,
    { label: 'تقارير المبيعات', screen: s('r-sale', 'تقارير المبيعات', DocList, { kind: 'sale' }) },
    { label: 'تقارير مردودات المبيعات', screen: s('r-sale_return', 'تقارير مردودات المبيعات', DocList, { kind: 'sale_return' }) }, SEP,
    { label: 'تقارير المشتريات', screen: s('r-purchase', 'تقارير المشتريات', DocList, { kind: 'purchase' }) },
    { label: 'تقارير مردودات المشتريات', screen: s('r-purchase_return', 'تقارير مردودات المشتريات', DocList, { kind: 'purchase_return' }) }, SEP,
    { label: 'تقارير عرض الأسعار', soon: true }, { label: 'تقارير الكميات الإفتتاحية', soon: true }, { label: 'تقارير تسوية المخزون', soon: true }, SEP,
    { label: 'تقارير التحول بين المستودعات', soon: true },
  ]},
  { label: 'تقارير المحاسبة', items: [
    { label: 'كشف حساب', screen: s('r-stmt', 'كشف حساب', LedgerView) },
    SEP,
    { label: 'اليومية العامة', screen: s('entries', 'اليومية العامة', EntriesList) },
    { label: 'دفتر الأستاذ العام', screen: s('r-ledger', 'دفتر الأستاذ العام', LedgerView) },
    SEP,
    { label: 'تقرير القيمة المضافة', screen: s('r-vat', 'تقرير القيمة المضافة', VatReport) },
    SEP,
    { label: 'ميزان مراجعة', screen: s('r-tb', 'ميزان مراجعة', TrialBalanceView) },
    { label: 'ورقة التسويات', screen: s('r-ws', 'ورقة التسويات', WorksheetView) },
    SEP,
    { label: 'حساب المتاجرة والأرباح والخسائر (قائمة الدخل)', screen: s('r-is', 'قائمة الدخل', StatementView, { type: 'income_statement' }) },
    { label: 'الميزانية العمومية (المركز المالي)', screen: s('r-bs', 'قائمة المركز المالي', StatementView, { type: 'balance_sheet' }) },
    { label: 'قائمة التغيرات في حقوق الملكية', screen: s('r-eq', 'التغيرات في حقوق الملكية', StatementView, { type: 'equity_changes' }) },
    SEP,
    { label: 'النسخ المحفوظة والمعتمدة', screen: s('r-snaps', 'النسخ المحفوظة', SnapshotsView) },
  ]},
  { label: 'المحاسب الذكي', owner: true, action: 'ai', items: [] },
  { label: 'إعدادات النظام', items: [
    { label: 'إعدادات ...', owner: true, screen: s('set-company', 'الإعدادات', CompanySettings) },
    { label: 'المستخدمون والدعوات ...', owner: true, screen: s('set-members', 'المستخدمون والدعوات', MembersView) },
    { label: 'القيود التلقائية ...', soon: true },
    SEP,
    { label: 'إعدادات طباعة الفواتير ...', owner: true, screen: s('set-company', 'الإعدادات', CompanySettings) },
    { label: 'إعدادات طباعة سند صرف ...', owner: true, screen: s('set-company', 'الإعدادات', CompanySettings) },
    { label: 'إعدادات طباعة سند قبض ...', owner: true, screen: s('set-company', 'الإعدادات', CompanySettings) },
    SEP,
    { label: 'السنوات والفترات ...', screen: s('set-years', 'السنوات والفترات', YearsView) },
    { label: 'دورات المراجعة ...', screen: s('set-review', 'دورات المراجعة', ReviewView) },
    { label: 'إقفال السنة المالية ...', owner: true, screen: s('set-close', 'إقفال السنة المالية', ClosingView) },
    SEP,
    { label: 'المحاسب الذكي ...', owner: true, screen: s('set-ai', 'المحاسب الذكي', AiSettings) },
    { label: 'سجل الدخول والإجراءات ...', owner: true, screen: s('set-log', 'سجل الدخول والإجراءات', AccessLog) },
    { label: 'تغيير كلمة المرور ...', screen: s('set-pw', 'تغيير كلمة المرور', PasswordSettings) },
    SEP,
    { label: 'إدخال كميات الجرد', soon: true },
  ]},
  { label: 'مساعدة', items: [
    { label: 'اختصارات لوحة المفاتيح', action: 'keys' },
    { label: 'خصوصية بياناتك', action: 'privacy' },
  ]},
];
