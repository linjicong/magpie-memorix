/**
 * Minimal MCP client for memorix's stateless HTTP endpoint.
 *
 * memorix `serve-http` accepts plain JSON-RPC on `POST /mcp` when the request
 * carries `Mcp-Protocol-Version: 2026-07-28` (or `Mcp-Stateless: true`), so the
 * hook never needs an `initialize` handshake or a session id. The project is
 * bound with `Mcp-Project-Root`; memorix answers with `Mcp-Project-Handle`,
 * which we then send instead of the absolute path.
 *
 * The reply may be `application/json` or `text/event-stream`, so both shapes
 * are parsed here. No retries except one re-bind when a cached handle expired.
 */

import { createHash } from 'node:crypto';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const HANDLE_EXPIRED_CODE = -32001;
export const META_PROTOCOL_KEY = 'io.modelcontextprotocol/protocolVersion';
export const META_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

const CIRCUIT_MS = 5 * 60 * 1000;
/** A short pause after a transport failure: retrying every request only adds latency. */
const BACKOFF_MS = 30 * 1000;
const CLIENTS = new Map();
let nextId = 0;

/** One client per endpoint, shared by every request in this Bun process. */
export function getClient(endpoint, timeoutMs) {
  if (!CLIENTS.has(endpoint)) CLIENTS.set(endpoint, new MemorixClient(endpoint));
  const client = CLIENTS.get(endpoint);
  if (Number.isFinite(timeoutMs)) client.defaultTimeoutMs = timeoutMs;
  return client;
}

/** Test hook: forget cached handles and clients. */
export function resetClients() {
  CLIENTS.clear();
  nextId = 0;
}

export class MemorixClient {
  constructor(endpoint) {
    this.endpoint = String(endpoint || '').replace(/\/+$/, '');
    this.defaultTimeoutMs = 6000;
    this.handles = new Map();
    this.broken = new Map();
    this.backoff = new Map();
    this.stats = { calls: 0, failures: 0, sse: 0 };
  }

  keyOf(projectRoot) {
    return projectRoot || this.endpoint;
  }

  isBackedOff(key) {
    const until = this.backoff.get(key) || 0;
    if (Date.now() >= until) {
      this.backoff.delete(key);
      return false;
    }
    return true;
  }

  /** Move the retry clock forward after a transport-level failure. */
  backOff(key, ms = BACKOFF_MS) {
    this.backoff.set(key, Date.now() + ms);
  }

  isBroken(projectRoot) {
    const until = this.broken.get(projectRoot) || 0;
    if (Date.now() >= until) {
      this.broken.delete(projectRoot);
      return false;
    }
    return true;
  }

  /** tools/call → {ok:true,text} | {ok:false,code,message}. */
  async callTool(name, args, { projectRoot = '', signal, timeoutMs } = {}) {
    this.stats.calls += 1;
    const key = this.keyOf(projectRoot);
    if (this.isBackedOff(key)) {
      this.stats.failures += 1;
      return { ok: false, code: 'unavailable', message: 'memorix backoff: last call failed transport' };
    }
    if (projectRoot && this.isBroken(projectRoot)) {
      this.stats.failures += 1;
      return { ok: false, code: 'invalid', message: 'memorix circuit open for this project' };
    }

    let result = await this.#request('tools/call', { name, arguments: args || {} }, { projectRoot, signal, timeoutMs, useHandle: true });

    if (!result.ok && result.code === 'stale-handle') {
      this.handles.delete(projectRoot);
      result = await this.#request('tools/call', { name, arguments: args || {} }, { projectRoot, signal, timeoutMs, useHandle: false });
    }

    if (!result.ok) {
      this.stats.failures += 1;
      if (result.code === 'invalid' && projectRoot) this.broken.set(projectRoot, Date.now() + CIRCUIT_MS);
      if (result.code === 'unavailable' && !signal?.aborted) this.backOff(key);
      return result;
    }

    this.backoff.delete(key);

    const payload = result.result;
    const text = textFromToolResult(payload);
    if (payload && payload.isError) {
      this.stats.failures += 1;
      if (projectRoot) this.broken.set(projectRoot, Date.now() + CIRCUIT_MS);
      return { ok: false, code: 'invalid', message: text || 'tool returned isError' };
    }
    return { ok: true, text, raw: payload };
  }

  /** tools/list → tool names, for the self-test and dashboard diagnostics. */
  async listTools({ projectRoot = '', signal, timeoutMs } = {}) {
    const result = await this.#request('tools/list', {}, { projectRoot, signal, timeoutMs, useHandle: true });
    if (!result.ok) return result;
    const tools = result.result && Array.isArray(result.result.tools) ? result.result.tools : [];
    return { ok: true, names: tools.map((tool) => tool && tool.name).filter((name) => typeof name === 'string') };
  }

  async #request(method, params, { projectRoot = '', signal, timeoutMs, useHandle = true }) {
    // The 2026-07-28 envelope: the body repeats what the headers announce, and
    // every request states the revision plus the client capabilities it relies on.
    const envelopeParams = {
      ...(params && typeof params === 'object' ? params : {}),
      _meta: {
        ...(params?._meta && typeof params._meta === 'object' ? params._meta : {}),
        [META_PROTOCOL_KEY]: MCP_PROTOCOL_VERSION,
        [META_CAPABILITIES_KEY]: {},
      },
    };

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': method,
    };
    if (typeof envelopeParams.name === 'string' && envelopeParams.name) headers['mcp-name'] = envelopeParams.name;
    const handle = useHandle ? this.handles.get(projectRoot) : undefined;
    if (handle) headers['mcp-project-handle'] = handle;
    else if (projectRoot) headers['mcp-project-root'] = projectRoot;

    if (projectRoot && /[^\x20-\x7e]/.test(projectRoot)) {
      // Header values are latin1; a non-ASCII project path cannot be bound this
      // way. Failing fast beats sending a path memorix would never match.
      return { ok: false, code: 'unbound', message: 'non-ASCII project path cannot be sent as Mcp-Project-Root' };
    }

    const id = (nextId += 1);
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: envelopeParams });
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.defaultTimeoutMs;

    const timeoutSignal = AbortSignal.timeout(Math.max(200, budget));
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response;
    try {
      response = await fetch(`${this.endpoint}/mcp`, { method: 'POST', headers, body, signal: composed });
    } catch (error) {
      const name = error && error.name;
      return {
        ok: false,
        code: 'unavailable',
        message: name === 'AbortError' || name === 'TimeoutError' ? 'memorix request timed out' : `memorix unreachable: ${error?.message || error}`,
      };
    }

    const issuedHandle = response.headers.get('mcp-project-handle');
    if (issuedHandle && projectRoot) this.handles.set(projectRoot, issuedHandle);

    if (!response.ok) {
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      const rpcError = parsed && typeof parsed === 'object' ? parsed.error : null;
      if (response.status === 404 && rpcError && rpcError.code === HANDLE_EXPIRED_CODE) {
        return { ok: false, code: 'stale-handle', message: 'memorix project handle expired' };
      }
      if (response.status >= 500) {
        return { ok: false, code: 'unavailable', message: `memorix http ${response.status}` };
      }
      return {
        ok: false,
        code: 'invalid',
        message: `memorix http ${response.status}${rpcError?.message ? `: ${rpcError.message}` : ''}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    let payload;
    if (contentType.includes('text/event-stream')) {
      this.stats.sse += 1;
      payload = await readSseResponse(response, id);
    } else {
      let raw = '';
      try {
        raw = await response.text();
      } catch (error) {
        return { ok: false, code: 'unavailable', message: `memorix read failed: ${error?.message || error}` };
      }
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        return { ok: false, code: 'invalid', message: 'memorix returned malformed JSON' };
      }
    }

    if (!payload || typeof payload !== 'object') {
      return { ok: false, code: 'invalid', message: 'memorix returned an empty response' };
    }
    if (payload.error) {
      const rpcError = payload.error;
      if (rpcError.code === HANDLE_EXPIRED_CODE) {
        return { ok: false, code: 'stale-handle', message: 'memorix project handle expired' };
      }
      return { ok: false, code: 'invalid', message: rpcError.message || 'memorix json-rpc error' };
    }
    return { ok: true, result: payload.result, id: payload.id };
  }
}

/** Pull text out of an MCP tools/call result. */
export function textFromToolResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  const chunks = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
      else if (part && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  if (typeof result.structuredContent === 'object' && result.structuredContent) {
    const brief = result.structuredContent.brief;
    if (typeof brief === 'string') chunks.push(brief);
  }
  return chunks.join('\n').trim();
}

/**
 * Read a whole SSE body and return the JSON-RPC message with the matching id.
 * Exported shape is also used by tests through `parseSseText`.
 */
async function readSseResponse(response, expectedId) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text().catch(() => '');
    return parseSseText(text, expectedId);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let lastMessage = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = splitSseEvents(buffer);
      buffer = events.rest;
      for (const message of events.messages) {
        lastMessage = message;
        if (message && (message.result !== undefined || message.error !== undefined) && message.id === expectedId) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return message;
        }
      }
    }
  } catch {
    /* stream broke: fall back to whatever was parsed */
  }
  buffer += decoder.decode();
  const tail = parseSseText(buffer, expectedId);
  return tail || lastMessage;
}

/** Pure helper: parse a full SSE document (used by tests and non-stream fallback). */
export function parseSseText(text, expectedId) {
  const { messages } = splitSseEvents(String(text ?? ''));
  let last = null;
  for (const message of messages) {
    last = message;
    if (message && message.id === expectedId && (message.result !== undefined || message.error !== undefined)) {
      return message;
    }
  }
  return last;
}

function splitSseEvents(buffer) {
  const messages = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const rest = chunks.pop() ?? '';
  for (const chunk of chunks) {
    const dataLines = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    const data = dataLines.join('\n');
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* keep going: a partial event is not fatal */
    }
  }
  return { messages, rest };
}

/** Stable short hash used for cache keys and topic keys. */
export function shortHash(value, length = 8) {
  return createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, length);
}
