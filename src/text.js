/**
 * Text helpers: pull plain text out of a protocol reply, recover file paths
 * that really exist under the working tree, and cheap signal detection.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

const TEXT_PART_TYPES = new Set(['text', 'output_text', 'input_text', 'thinking', 'reasoning']);

function joinBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const out = [];
  for (const block of blocks) {
    if (typeof block === 'string') out.push(block);
    else if (block && typeof block.text === 'string' && (block.type === undefined || TEXT_PART_TYPES.has(block.type))) {
      out.push(block.text);
    }
  }
  return out.join('\n').trim();
}

/** The client-facing reply as plain text, per protocol shape. */
export function extractReplyText(reply, protocol) {
  if (typeof reply === 'string') return reply;
  if (!reply || typeof reply !== 'object') return '';
  switch (protocol) {
    case 'anthropic':
      return joinBlocks(reply.content);
    case 'chat': {
      const choice = Array.isArray(reply.choices) ? reply.choices[0] : null;
      const message = choice?.message ?? null;
      if (message) {
        const text = typeof message.content === 'string' ? message.content : joinBlocks(message.content);
        if (text) return text;
        if (typeof message.reasoning_content === 'string') return message.reasoning_content;
      }
      return typeof reply.output_text === 'string' ? reply.output_text : '';
    }
    case 'responses': {
      if (typeof reply.output_text === 'string' && reply.output_text) return reply.output_text;
      const output = Array.isArray(reply.output) ? reply.output : [];
      const chunks = [];
      for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
          const text = joinBlocks(item.content);
          if (text) chunks.push(text);
        } else if (typeof item.text === 'string') {
          chunks.push(item.text);
        }
      }
      return chunks.join('\n').trim();
    }
    case 'gemini': {
      const candidates = Array.isArray(reply.candidates) ? reply.candidates : [];
      const parts = candidates[0]?.content?.parts;
      return joinBlocks(parts);
    }
    default:
      return typeof reply.text === 'string' ? reply.text : '';
  }
}

/** Last user text in a request body, used when `ctx.query` is unavailable. */
export function extractQueryFromRequest(body, protocol) {
  if (!body || typeof body !== 'object') return '';
  switch (protocol) {
    case 'anthropic':
    case 'chat': {
      const messages = body.messages;
      if (!Array.isArray(messages)) return '';
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'user') continue;
        const text = typeof message.content === 'string' ? message.content : joinBlocks(message.content);
        if (text) {
          const stripped = stripInjected(text);
          if (stripped) return stripped;
        }
      }
      return '';
    }
    case 'responses': {
      if (typeof body.input === 'string') return stripInjected(body.input);
      const input = Array.isArray(body.input) ? body.input : [];
      for (let i = input.length - 1; i >= 0; i -= 1) {
        const item = input[i];
        if (!item || item.role !== 'user') continue;
        const text = typeof item.content === 'string' ? item.content : joinBlocks(item.content);
        if (text) {
          const stripped = stripInjected(text);
          if (stripped) return stripped;
        }
      }
      return '';
    }
    case 'gemini': {
      const contents = Array.isArray(body.contents) ? body.contents : [];
      for (let i = contents.length - 1; i >= 0; i -= 1) {
        const item = contents[i];
        if (!item || (item.role && item.role !== 'user')) continue;
        const text = joinBlocks(item.parts);
        if (text) {
          const stripped = stripInjected(text);
          if (stripped) return stripped;
        }
      }
      return '';
    }
    default:
      return '';
  }
}

/** Remove any previously injected block so it never lands in a memory entry. */
export function stripInjected(text) {
  return String(text ?? '')
    .replace(/<memorix-context[\s\S]*?<\/memorix-context>\s*/g, '')
    .trim();
}

const PATH_PATTERN =
  /(?:^|[\s`"'([<（,、：:])((?:[A-Za-z0-9_.@-]+[\\/]){0,8}[A-Za-z0-9_.@-]+)\.([A-Za-z0-9]{1,6})(?=$|[\s`"')>\]，。；：、,])/g;

const KNOWN_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'txt',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'xml', 'csv', 'env', 'lock',
]);

const SKIP_SEGMENTS = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'coverage', '.next', 'target']);

function normalizeCandidate(raw) {
  let value = String(raw || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!value || value.length > 200) return '';
  if (/^[A-Za-z]:\//.test(value) || value.startsWith('/')) return '';
  if (value.includes('://')) return '';
  const segments = value.split('/');
  if (segments.some((segment) => SKIP_SEGMENTS.has(segment.toLowerCase()))) return '';
  return value;
}

function existsUnder(cwd, relativePath) {
  if (!cwd) return true; // no cwd to verify against: trust the text only when asked
  try {
    const st = statSync(join(cwd, relativePath));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * File paths mentioned in text that actually exist under `cwd`.
 * Existence checking is what keeps hallucinated paths out of the memory store.
 */
export function extractFilePaths(text, { cwd = '', limit = 8, verify = true } = {}) {
  const body = String(text ?? '');
  const found = new Set();
  for (const match of body.matchAll(PATH_PATTERN)) {
    const candidate = normalizeCandidate(`${match[1]}.${match[2]}`);
    if (!candidate) continue;
    // A bare filename has no directory to lean on, so only trust a known extension.
    if (!candidate.includes('/') && !KNOWN_EXT.has(match[2].toLowerCase())) continue;
    if (verify && !existsUnder(cwd, candidate)) continue;
    found.add(candidate);
    if (found.size >= limit) break;
  }
  return [...found];
}

/**
 * Tool results in the request carry `file_path` / `path` keys. Walk a bounded
 * subset of the body and keep the ones that exist in the working tree.
 */
export function extractRequestFilePaths(request, { cwd = '', limit = 8, verify = true, budget = 2000 } = {}) {
  const found = new Set();
  const visited = { nodes: 0 };
  const keys = new Set(['file_path', 'filePath', 'filepath', 'path', 'file']);

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || visited.nodes > budget || found.size >= limit) return;
    visited.nodes += 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && keys.has(key)) {
        const candidate = normalizeCandidate(value);
        if (candidate && (!verify || existsUnder(cwd, candidate))) found.add(candidate);
        if (found.size >= limit) return;
      } else if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  };

  walk(request, 0);
  return [...found];
}

export function hasCodeFence(text) {
  return /```/.test(String(text ?? ''));
}

export function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

export function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Existing-file check usable outside path extraction (used by tests too). */
export function relativeIfInside(cwd, absolutePath) {
  try {
    const rel = relative(cwd, absolutePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '';
    return normalize(rel).split(sep).join('/');
  } catch {
    return '';
  }
}

/**
 * A bounded slice of everything the model would read, for finding the working
 * directory an agent named in its own instructions. Our injected block is
 * stripped first so it can never decide the project.
 */
export function collectRequestText(body, protocol, { limit = 200_000, maxMessages = 24 } = {}) {
  if (!body || typeof body !== 'object') return '';
  const chunks = [];

  const push = (value) => {
    const text = typeof value === 'string' ? value : joinBlocks(value);
    if (!text) return;
    chunks.push(text);
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  };

  if (protocol === 'anthropic') {
    if (body.system) push(body.system);
  } else if (protocol === 'responses') {
    if (body.instructions) push(body.instructions);
  } else if (protocol === 'gemini') {
    const parts = body.systemInstruction && body.systemInstruction.parts;
    if (parts) push(parts);
  }

  const list = protocol === 'gemini'
    ? body.contents
    : protocol === 'responses'
      ? body.input
      : body.messages;

  if (typeof list === 'string') {
    push(list);
  } else if (Array.isArray(list)) {
    for (const item of list.slice(-maxMessages)) {
      if (!item || typeof item !== 'object') continue;
      push(item.content ?? item.parts);
      if (chunks.reduce((total, chunk) => total + chunk.length, 0) > limit) break;
    }
  }

  return stripInjected(chunks.join('\n')).slice(0, limit);
}

