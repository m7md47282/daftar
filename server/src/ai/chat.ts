import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import { tx, type Tx } from '../db/pools.ts';
import type { Ctx } from '../core/types.ts';
import { branchScope } from '../core/types.ts';
import { DomainError, fail } from '../core/errors.ts';
import { today } from '../core/audit.ts';
import { getSetting } from '../platform.ts';
import { TOOLS, jsonSchema } from './tools.ts';
import { callTool } from './layer.ts';
import { addUsage, charge, emptyUsage, requireCredits } from './credits.ts';

const SYSTEM = `أنت المحاسب الذكي لهذه المنشأة التجارية في المملكة العربية السعودية. تعمل داخل نظام محاسبي، ولا تملك أي قدرة خارج الأدوات المتاحة لك.

قواعد العمل:
- تحدث بالعربية الفصحى المبسطة، بإيجاز ووضوح، فالمستخدم صاحب منشأة وليس محاسباً.
- لا تخترع أرقاماً أو معرّفات. ابحث أولاً (search_parties, search_items, search_accounts, get_company_setup) ثم استخدم المعرّفات الحقيقية.
- إذا كان الطلب غامضاً (عميلان بنفس الاسم، صنف غير واضح، وحدة غير محددة، مبلغ ناقص) اسأل سؤالاً واحداً واضحاً بدل التخمين.
- الأسعار في الأدوات بالريال وبدون ضريبة القيمة المضافة (15%) ما لم يقل المستخدم صراحة إن السعر شامل الضريبة؛ عندها اقسم على 1.15.
- أدوات الإنشاء (create_*, void_voucher) لا تحفظ شيئاً مباشرة: تعرض معاينة على المستخدم مع زر تأكيد. بعد استدعائها لخّص المعاينة في سطرين واطلب منه الضغط على "تأكيد". لا تستدعِ الأداة نفسها مرة ثانية لنفس العملية.
- بعد تأكيد إنشاء فاتورة أو سند يظهر للمستخدم زر PDF تلقائياً. لطلب PDF لمستند موجود استخدم export_pdf ولا تكتب الرابط في ردك.
- إذا رفض النظام عملية فاشرح السبب كما ورد في رسالة الخطأ واقترح الحل، ولا تحاول الالتفاف على القاعدة.
- القيود المرحّلة لا تُعدّل ولا تُحذف؛ التصحيح يكون بمرتجع أو بإلغاء السند (قيد عكسي).
- عند عرض أرقام استخدم جداول Markdown قصيرة، والمبالغ بالريال بخانتين عشريتين.`;

const demoUsage = new Map<string, number>(); // soft per-instance cap; the platform limit is per day

let cachedTools: Anthropic.Beta.BetaTool[] | null = null;
function tools(): Anthropic.Beta.BetaTool[] {
  // deterministic order so the cached prefix stays stable
  cachedTools ??= TOOLS.map((t) => ({ name: t.name, description: t.description + (t.write ? ' [WRITE: shows a preview; the user must press confirm]' : ''), input_schema: jsonSchema(t) }));
  return cachedTools;
}

export type ChatCtx = { c: Ctx; isDemo: boolean };
const scope = (x: ChatCtx) => ({ companyId: x.c.companyId, branchScope: branchScope(x.c), userId: x.c.userId });
type Pending = { id: string; tool: string; summary: string; preview: unknown };
type FileOut = { label: string; url: string };

export async function aiConfigured() {
  return !!(await getSetting('anthropic_api_key'));
}

export async function chat(ctx: ChatCtx, conversationId: string | undefined, text: string) {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) fail('المحاسب الذكي غير مفعّل على المنصة بعد (لم يُضبط مفتاح الذكاء الاصطناعي)');
  if (ctx.isDemo) {
    const limit = Number((await getSetting('ai_daily_limit_demo')) ?? 20);
    const k = `${ctx.c.companyId}:${today()}`;
    const used = demoUsage.get(k) ?? 0;
    if (used >= limit) fail(`انتهى حد الرسائل اليومي للنسخة التجريبية (${limit})`);
    demoUsage.set(k, used + 1);
  } else {
    await requireCredits(ctx.c.companyId);
  }
  const model = (await getSetting('ai_model')) || 'claude-opus-5-5';
  const client = new Anthropic({ apiKey });

  let messages: Anthropic.Beta.BetaMessageParam[] = [];
  let id = conversationId;
  if (id) {
    const rows = await tx(scope(ctx), async (t) => (await t.query('select messages from ai_conversations where id = $1 and user_id = $2', [id, ctx.c.userId])).rows);
    if (rows.length) messages = rows[0].messages; else id = undefined;
  }
  id ??= randomBytes(9).toString('base64url');
  const conv = { messages };
  conv.messages.push({ role: 'user', content: `[تاريخ اليوم ${today()} — المستخدم: ${ctx.c.userName}]\n${text}` });

  const pendings: Pending[] = [];
  const files: FileOut[] = [];
  const toolLog: string[] = [];
  const usage = emptyUsage();
  let finalText = '';
  let credits: number | null = null;

  try {
    for (let step = 0; step < 15; step++) {
      const resp = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: tools(),
        messages: conv.messages,
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as any) as Anthropic.Beta.BetaMessage;
      addUsage(usage, resp.usage);

      // keep the full content (thinking blocks included) so the conversation stays valid
      conv.messages.push({ role: 'assistant', content: resp.content as any });
      finalText = resp.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n').trim();

      if (resp.stop_reason === 'refusal') { finalText = 'لا أستطيع المساعدة في هذا الطلب.'; break; }
      if (resp.stop_reason !== 'tool_use') break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        toolLog.push(block.name);
        results.push(await runTool(ctx, block.id, block.name, block.input, pendings, files));
      }
      conv.messages.push({ role: 'user', content: results });
    }
  } finally {
    // charge for whatever was actually used, even if the loop failed midway
    if (!ctx.isDemo) credits = (await charge(ctx.c.companyId, ctx.c.userId, model, usage, text)) / 1000;
  }
  await tx(scope(ctx), (t) => t.query(
    `insert into ai_conversations(id, company_id, user_id, messages, updated_at) values ($1,$2,$3,$4,now())
     on conflict (id) do update set messages = $4, updated_at = now()`, [id, ctx.c.companyId, ctx.c.userId, JSON.stringify(conv.messages)]));
  return { conversation_id: id, text: finalText, pending: pendings, files, tools_used: toolLog, credits };
}

async function runTool(ctx: ChatCtx, toolUseId: string, name: string, rawInput: unknown, pendings: Pending[], files: FileOut[]): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const err = (msg: string): Anthropic.Beta.BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: toolUseId, content: msg, is_error: true });
  try {
    const out = await callTool(ctx.c, name, rawInput);
    if (out.status === 'result') {
      const r: any = out.result;
      if (r?.pdf_url) files.push({ label: `${r.label} رقم ${r.number}`, url: r.pdf_url });
      let s = JSON.stringify(r);
      if (s.length > 60_000) s = s.slice(0, 60_000) + '…[truncated — narrow the filters]';
      return { type: 'tool_result', tool_use_id: toolUseId, content: s };
    }
    pendings.push({ id: out.pending_id, tool: name, summary: out.summary, preview: out.preview });
    return { type: 'tool_result', tool_use_id: toolUseId,
      content: `PREVIEW ONLY — nothing was saved. The user now sees a confirmation card (id ${out.pending_id}). Numbers shown are previews (document numbers may change). Preview: ${JSON.stringify(out.preview).slice(0, 20_000)}` };
  } catch (e) {
    if (e instanceof DomainError) return err(`النظام رفض العملية: ${e.message}`);
    if (e instanceof ZodError) return err(`Invalid input: ${e.message}`);
    throw e;
  }
}

// Called after the human pressed confirm or cancel, so the assistant knows what happened.
export async function noteOutcome(tx: Tx, conversationId: string | undefined, userId: number, note: string) {
  if (!conversationId) return;
  await tx.query(`update ai_conversations set messages = messages || $3::jsonb, updated_at = now() where id = $1 and user_id = $2`,
    [conversationId, userId, JSON.stringify([{ role: 'user', content: `[ملاحظة من النظام] ${note}` }])]);
}
