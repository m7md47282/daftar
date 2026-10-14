import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tx } from '../db/pools.ts';
import type { Ctx } from './types.ts';
import { fail } from './errors.ts';
import { audit } from './audit.ts';
import { env } from '../env.ts';

export const MAX_SIZE = 10 * 1024 * 1024;
export const MAX_ACTIVE = 5;

// Identify the real type from the bytes, never from the name or the browser's claim (§18).
export function sniff(buf: Buffer): 'application/pdf' | 'image/jpeg' | 'image/png' | null {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

function structuralCheck(buf: Buffer, mime: string) {
  if (mime === 'application/pdf') {
    const text = buf.toString('latin1');
    if (!/%%EOF\s*$/.test(text.slice(-1024))) fail('ملف PDF غير مكتمل البنية');
    // active content is not acceptable as evidence
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia|XFA)\b/.test(text)) fail('ملف PDF يحتوي محتوى نشطًا غير مسموح');
    if (/\/Encrypt\b/.test(text)) fail('ملف PDF محمي لا يمكن التحقق من محتواه');
  }
  if (mime === 'image/jpeg' && !(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) fail('ملف JPEG غير مكتمل البنية');
  if (mime === 'image/png' && !buf.subarray(buf.length - 12).includes(Buffer.from('IEND'))) fail('ملف PNG غير مكتمل البنية');
}

// Storage: private files under STORAGE_DIR/<company>/; in production mount a bucket here.
async function store(companyId: number, buf: Buffer) {
  const key = `${companyId}/${randomBytes(16).toString('hex')}`;
  const dir = join(env.storageDir, String(companyId));
  await mkdir(dir, { recursive: true });
  await writeFile(join(env.storageDir, key), buf, { mode: 0o600 });
  return key;
}

export async function addAttachment(tx: Tx, c: Ctx, target: { draft_id?: number; entry_id?: number }, file: { filename: string; data: Buffer }) {
  const buf = file.data;
  if (!buf?.length) fail('الملف فارغ');
  if (buf.length > MAX_SIZE) fail('حجم الملف يتجاوز 10 ميغابايت');
  const mime = sniff(buf);
  if (!mime) fail('نوع الملف غير مقبول — المسموح PDF وJPEG وPNG فقط');
  structuralCheck(buf, mime!);
  const name = (file.filename || 'مرفق').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  let draftId: number | null = null, entryId: number | null = null;
  if (target.draft_id) {
    const { rows: [d] } = await tx.query('select id, status, entry_id from drafts where id = $1 and company_id = $2', [target.draft_id, c.companyId]);
    if (!d) fail('المسودة غير موجودة', 404);
    draftId = d.id; entryId = d.entry_id ?? null;
  } else if (target.entry_id) {
    const { rows: [e] } = await tx.query('select id from journal_entries where id = $1 and company_id = $2', [target.entry_id, c.companyId]);
    if (!e) fail('القيد غير موجود', 404);
    entryId = e.id;
  } else fail('حدد المسودة أو القيد');
  const { rows: [{ n }] } = await tx.query(
    `select count(*)::int as n from attachments where company_id = $1 and excluded_at is null and (($2::int is not null and draft_id = $2) or ($3::int is not null and entry_id = $3))`,
    [c.companyId, draftId, entryId]);
  if (n >= MAX_ACTIVE) fail('الحد الأقصى خمسة مرفقات فعالة للمستند');
  const key = await store(c.companyId, buf);
  const { rows: [a] } = await tx.query(
    `insert into attachments(company_id, draft_id, entry_id, filename, mime, size, sha256, storage_key, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, filename, mime, size, uploaded_at`,
    [c.companyId, draftId, entryId, name, mime, buf.length, createHash('sha256').update(buf).digest('hex'), key, c.userId]);
  await audit(tx, c, 'attachment.add', 'attachment', a.id, { after: { filename: name, mime, size: buf.length, entry_id: entryId, draft_id: draftId } });
  return a;
}

// Download checks company access (RLS) and the stored integrity hash.
export async function readAttachment(tx: Tx, c: Ctx, id: number) {
  const { rows: [a] } = await tx.query('select * from attachments where id = $1 and company_id = $2', [id, c.companyId]);
  if (!a) fail('المرفق غير موجود', 404);
  let data: Buffer;
  try { data = await readFile(join(env.storageDir, a.storage_key)); } catch { return fail('ملف المرفق مفقود من التخزين — يرجى إبلاغ الدعم', 410); }
  if (createHash('sha256').update(data).digest('hex') !== a.sha256) fail('ملف المرفق لا يطابق النسخة المحفوظة — لن يُعرض على أنه الأصل', 409);
  await audit(tx, c, 'attachment.download', 'attachment', a.id);
  return { filename: a.filename, mime: a.mime, data };
}

// Posted evidence is never silently replaced or deleted: it is excluded with a reason and stays available.
export async function excludeAttachment(tx: Tx, c: Ctx, id: number, reason: string) {
  if (!reason?.trim()) fail('سبب الاستبعاد مطلوب');
  const { rows: [a] } = await tx.query('select * from attachments where id = $1 and company_id = $2', [id, c.companyId]);
  if (!a) fail('المرفق غير موجود', 404);
  if (a.excluded_at) fail('المرفق مستبعد مسبقًا');
  await tx.query('update attachments set excluded_at = now(), excluded_by = $2, exclusion_reason = $3 where id = $1', [id, c.userId, reason.trim()]);
  await audit(tx, c, 'attachment.exclude', 'attachment', id, { reason });
}
