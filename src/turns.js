/**
 * A protocol-neutral view of the turns in a request.
 *
 * Each entry exposes the text the model would see and an `append(text)` that
 * adds a new part to that turn in place. Only message-shaped turns appear here;
 * tool declarations, reasoning and system slots stay out of reach.
 *
 * The shape mirrors magpie's own powercontext plugin so behaviour is familiar:
 * a block appended to a user turn is exactly what the upstream model receives.
 */

import { createHash } from 'node:crypto';

export const MARKER = '<memorix-context';

const COMPLETE_BLOCK = /<memorix-context[^>]*>[\s\S]*?<\/memorix-context>/i;

/** A real injected block: an opening tag with a matching close. */
export function hasBlock(text) {
  return COMPLETE_BLOCK.test(String(text ?? ''));
}

function contentKey(protocol) {
  if (protocol === 'gemini') return 'parts';
  return 'content';
}

function partIsText(part, role, protocol) {
  if (!part || typeof part.text !== 'string') return false;
  if (protocol === 'gemini') return part.thought !== true;
  if (role === 'assistant') return part.type === 'text' || part.type === 'output_text';
  return part.type === 'text' || part.type === 'input_text';
}

/**
 * @returns {Array<{index:number, role:'user'|'assistant', text:string, append:(text:string)=>void}>}
 */
export function turnsOf(body, protocol) {
  if (!body || typeof body !== 'object') return [];

  if (protocol === 'responses' && typeof body.input === 'string') {
    return [{
      index: 0,
      role: 'user',
      text: body.input,
      append: (text) => {
        body.input = `${body.input}\n\n${text}`;
      },
    }];
  }

  const list = protocol === 'gemini'
    ? body.contents
    : protocol === 'responses'
      ? body.input
      : body.messages;
  if (!Array.isArray(list)) return [];

  const key = contentKey(protocol);
  const out = [];

  list.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    if (protocol === 'responses' && message.type !== undefined && message.type !== 'message') return;

    let role;
    if (message.role === 'user') role = 'user';
    else if (message.role === 'assistant' || (protocol === 'gemini' && message.role === 'model')) role = 'assistant';
    if (!role) return;

    const container = message[key];
    if (typeof container === 'string') {
      out.push({
        index,
        role,
        text: container,
        append: (text) => {
          message[key] = `${message[key]}\n\n${text}`;
        },
      });
      return;
    }
    if (!Array.isArray(container)) return;

    const parts = container.filter((part) => partIsText(part, role, protocol));
    if (!parts.length) return;

    const appendPart = protocol === 'gemini'
      ? { text: '' }
      : { type: protocol === 'responses' ? 'input_text' : 'text', text: '' };
    out.push({
      index,
      role,
      text: parts.map((part) => part.text).join('\n'),
      append: (text) => {
        container.push(protocol === 'gemini' ? { text } : { ...appendPart, text });
      },
    });
  });

  return out;
}

/** Stable identity for a turn, so a replayed request maps onto the same slot. */
export function turnKey(turn) {
  return createHash('sha256').update(`${turn.index}\u0000${turn.text}`).digest('hex').slice(0, 16);
}

/**
 * The user turn this request is about: the one holding magpie's reading of the
 * user's message, else the last user turn with text.
 */
export function targetTurn(turns, query = '') {
  const users = turns.filter((turn) => turn.role === 'user');
  const needle = String(query ?? '').trim();
  for (let i = users.length - 1; i >= 0; i -= 1) {
    if (needle && users[i].text.includes(needle)) return users[i];
  }
  return users.at(-1) ?? null;
}
