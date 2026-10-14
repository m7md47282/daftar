import { Injectable, inject } from '@angular/core';
import { Ui } from './ui';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// Thin fetch wrapper. Errors from the server are already plain Arabic.
@Injectable({ providedIn: 'root' })
export class Api {
  private ui = inject(Ui);
  onUnauthorized: () => void = () => {};
  // The company of every request is explicit and per window (§5.4): one tab's choice never changes another's.
  companyId: number | null = null;
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.companyId ? { 'x-company-id': String(this.companyId) } : {}), ...extra };
  }

  async req<T = any>(method: string, url: string, body?: unknown, opts: { quiet?: boolean } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch('/api' + url, {
        method, credentials: 'same-origin',
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      const msg = 'تعذر الاتصال بالخادم — تحقق من الإنترنت';
      if (!opts.quiet) this.ui.toast(msg, 'bad');
      throw new ApiError(msg, 0);
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) {
      const msg = data?.error ?? 'حدث خطأ';
      if (res.status === 401 && url !== '/auth/me') this.onUnauthorized();
      if (!opts.quiet) this.ui.toast(msg, 'bad');
      throw new ApiError(msg, res.status);
    }
    return data as T;
  }
  get<T = any>(url: string, params?: Record<string, unknown>, opts?: { quiet?: boolean }) {
    const q = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])) : '';
    return this.req<T>('GET', url + q, undefined, opts);
  }
  post<T = any>(url: string, body?: unknown, opts?: { quiet?: boolean }) { return this.req<T>('POST', url, body ?? {}, opts); }
  put<T = any>(url: string, body?: unknown) { return this.req<T>('PUT', url, body ?? {}); }
  patch<T = any>(url: string, body?: unknown) { return this.req<T>('PATCH', url, body ?? {}); }
  del<T = any>(url: string) { return this.req<T>('DELETE', url); }
}

// Downloads/opens a binary endpoint with the company header (PDFs, attachments, exports).
export async function openBinary(api: Api, url: string, download?: string) {
  const res = await fetch('/api' + url, { credentials: 'same-origin', headers: api.headers() });
  if (!res.ok) { const j = await res.json().catch(() => null); throw new ApiError(j?.error ?? 'تعذر فتح الملف', res.status); }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  if (download) { const a = document.createElement('a'); a.href = href; a.download = download; a.click(); }
  else window.open(href, '_blank');
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
