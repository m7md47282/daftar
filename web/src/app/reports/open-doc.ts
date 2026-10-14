import { Tabs } from '../shell/tabs';
import { InvoiceForm } from '../docs/invoice-form';
import { VoucherForm } from '../docs/voucher-form';

const T: Record<string, string> = { sale: 'فاتورة مبيعات', sale_return: 'مرتجع مبيعات', purchase: 'فاتورة مشتريات', purchase_return: 'مرتجع مشتريات', receipt: 'سند قبض', payment: 'سند صرف', journal: 'سند قيد' };

// Drill-down from any report line to the original document.
export function openDoc(tabs: Tabs, type: 'invoice' | 'voucher', kind: string, number: number) {
  tabs.open(`${kind}-${number}`, `${T[kind]} ${number}`, type === 'invoice' ? InvoiceForm : VoucherForm, { kind, number });
}
