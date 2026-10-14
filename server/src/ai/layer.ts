import { tx } from '../db/pools.ts';
import type { Ctx } from '../core/types.ts';
import { branchScope } from '../core/types.ts';
import { fail } from '../core/errors.ts';
import { TOOLS, toolByName, jsonSchema, addPending, takePending } from './tools.ts';

// The tool layer (MCP-shaped: list, call, confirm). The only way the AI touches a company: in-process,
// with the person's own company context, so row-level security and every core rule apply unchanged.
// Reads run directly. Writes run inside a rolled-back transaction for an exact preview; saved only on confirm.
export type CallResult =
  | { status: 'result'; result: unknown }
  | { status: 'preview_not_saved'; pending_id: string; summary: string; preview: any };

const scopeOf = (c: Ctx) => ({ companyId: c.companyId, branchScope: branchScope(c), userId: c.userId });

export const listTools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, write: t.write, inputSchema: jsonSchema(t) }));

export async function callTool(c: Ctx, name: string, rawInput: unknown): Promise<CallResult> {
  const tool = toolByName(name);
  if (!tool) fail(`أداة غير معروفة: ${name}`, 404);
  const input = tool!.input.parse(rawInput ?? {});
  if (!tool!.write) return { status: 'result', result: await tx(scopeOf(c), (t) => tool!.run(t, c, input)) };
  const preview: any = await tx(scopeOf(c), (t) => tool!.run(t, c, input), { rollback: true });
  const summary = tool!.summarize?.(preview) ?? tool!.name;
  const pending_id = await tx(scopeOf(c), (t) => addPending(t, c, { tool: tool!.name, input, summary }));
  return { status: 'preview_not_saved', pending_id, summary, preview };
}

export async function confirmTool(c: Ctx, pendingId: string, onDone?: (t: any, r: { tool: string; result: any; summary: string }) => Promise<void>) {
  return tx(scopeOf(c), async (t) => {
    const p = await takePending(t, c, pendingId);
    const tool = toolByName(p.tool)!;
    const result: any = await tool.run(t, c, p.input);
    const out = { tool: p.tool, result, summary: tool.summarize?.(result) ?? p.tool };
    if (onDone) await onDone(t, out);
    return out;
  });
}

export async function rejectTool(c: Ctx, pendingId: string) {
  return tx(scopeOf(c), async (t) => (await t.query('delete from ai_pending where id = $1 and company_id = $2 and user_id = $3 returning summary', [pendingId, c.companyId, c.userId])).rows[0] ?? null);
}
