/**
 * Rendering of the context block and the `position: "system"` alternative.
 *
 * Turn injection itself lives in `turns.js`, so placement stays protocol-aware
 * in one place. Nothing here touches anything but message-shaped fields.
 */

export const CONTEXT_OPEN = '<memorix-context';
export const CONTEXT_TAG = 'memorix-context';

const PREAMBLE =
  '以下内容是该项目的长期记忆，由 memorix 自动检索而来，仅作背景参考。' +
  '与当前代码或用户最新指令冲突时，以代码和用户指令为准；不必向用户复述这段记忆的存在。';

function escapeAttr(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N}._\-/ :]/gu, '').slice(0, 80);
}

/** Recalled text must not be able to close the block it is wrapped in. */
function escapeBody(text) {
  return String(text ?? '').replace(/<(\/?)(memorix-context)/gi, '&lt;$1$2');
}

/** Wrap the memorix brief into the delimited block that models see. */
export function renderContextBlock(text, { project = '', truncated = false } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return '';
  const attrs = project ? ` project="${escapeAttr(project)}"` : '';
  const note = truncated ? '\n…(记忆已按预算截断)' : '';
  return `${CONTEXT_OPEN}${attrs}>\n${PREAMBLE}\n\n${escapeBody(body)}${note}\n</${CONTEXT_TAG}>`;
}

/** Cut a brief to a character budget on a line boundary. */
export function trimToBudget(text, maxChars) {
  const body = String(text ?? '').trim();
  if (body.length <= maxChars) return { text: body, truncated: false };
  const slice = body.slice(0, Math.max(0, maxChars));
  const cut = slice.lastIndexOf('\n');
  const kept = (cut > maxChars * 0.5 ? slice.slice(0, cut) : slice).trimEnd();
  return { text: kept, truncated: true };
}

/** Append the block to a turn produced by `turnsOf`. */
export function appendToTurn(turn, block) {
  if (!turn || typeof turn.append !== 'function' || !block) return false;
  turn.append(block);
  return true;
}

function appendToContent(content, block, textPartType) {
  if (typeof content === 'string') return `${content}\n\n${block}`;
  if (Array.isArray(content)) return [...content, { type: textPartType, text: block }];
  if (content === null || content === undefined) return block;
  return null;
}

/**
 * `position: "system"` alternative: the same safety rules, but the block goes
 * into the system slot so user text stays pristine.
 */
export function injectSystemContext(body, protocol, block) {
  if (!body || typeof body !== 'object' || !block) return null;
  switch (protocol) {
    case 'chat': {
      const messages = Array.isArray(body.messages) ? body.messages : null;
      if (!messages) return null;
      if (messages.length && messages[0] && messages[0].role === 'system') {
        const content = appendToContent(messages[0].content, block, 'text');
        if (content === null) return null;
        const next = messages.slice();
        next[0] = { ...messages[0], content };
        return { ...body, messages: next };
      }
      return { ...body, messages: [{ role: 'system', content: block }, ...messages] };
    }
    case 'anthropic': {
      if (typeof body.system === 'string' && body.system) return { ...body, system: `${body.system}\n\n${block}` };
      if (Array.isArray(body.system)) return { ...body, system: [...body.system, { type: 'text', text: block }] };
      return { ...body, system: block };
    }
    case 'responses': {
      if (typeof body.instructions === 'string' && body.instructions) {
        return { ...body, instructions: `${body.instructions}\n\n${block}` };
      }
      return { ...body, instructions: block };
    }
    case 'gemini': {
      const existing = body.systemInstruction;
      const parts = existing && Array.isArray(existing.parts) ? existing.parts : [];
      return { ...body, systemInstruction: { parts: [...parts, { text: block }] } };
    }
    default:
      return null;
  }
}
