/**
 * magpie-memorix — memorix as a gateway-wide memory layer.
 *
 * Two async hooks, both fire-and-forget from magpie's point of view:
 *
 *   onRequest  — recall one bounded memorix brief and append it to the user
 *                turn this request is about (or the system slot when configured).
 *   onResponse — distil the finished turn and store one observation.
 *
 * Hard rules taken from magpie's hook contract:
 *   • a hook must never reject; any throw or timeout rolls the request back
 *     and suppresses onResponse for that turn.
 *   • only message-shaped fields may be rewritten. Touching model, stream,
 *     tools or tool_choice would fail the request, so they are never sent back.
 *   • every exit path reports a code from the fixed set so the gateway UI can
 *     explain what the plugin did.
 *
 * Cache discipline (learned from magpie's powercontext plugin): the block a
 * user turn was given is replayed on every later request, so the prompt prefix
 * stays byte-identical and the provider's prompt cache keeps hitting.
 */

import { basename } from 'node:path';
import { normalizeOptions, contextCharBudget } from './src/config.js';
import { resolveProjectRoot } from './src/project.js';
import { getClient, resetClients } from './src/mcp.js';
import {
  extractQueryFromRequest,
  extractReplyText,
  extractFilePaths,
  extractRequestFilePaths,
  collectRequestText,
} from './src/text.js';
import { turnsOf, targetTurn, turnKey, hasBlock } from './src/turns.js';
import { renderContextBlock, trimToBudget, appendToTurn, injectSystemContext } from './src/inject.js';
import { recallFor, resetRecallCache } from './src/recall.js';
import { fetchMemoryDetails } from './src/details.js';
import { evaluateCapture, buildObservation, noteCaptured, resetCaptureState } from './src/capture.js';
import { sessionIdentity, lookup, remember, sweep, resetSticky } from './src/sticky.js';

const DEBUG = typeof process !== 'undefined' && /^(1|true|yes|on)$/i.test(String(process.env?.MAGPIE_MEMORIX_DEBUG ?? ''));

function debug(event, detail) {
  if (!DEBUG) return;
  try {
    process.stderr.write(`[magpie-memorix] ${event} ${detail ? JSON.stringify(detail) : ''}\n`);
  } catch {
    /* logging must never break a request */
  }
}

const REPORT_CODES = new Set(['ready', 'empty', 'unbound', 'unauthorized', 'unavailable', 'invalid', 'skipped']);

function report(ctx, code, bytes) {
  const safe = REPORT_CODES.has(code) ? code : 'invalid';
  debug('report', { code: safe, bytes });

  try {
    if (typeof ctx?.report === 'function') ctx.report(safe, Number.isFinite(bytes) ? bytes : undefined);
  } catch {
    /* the report channel is advisory only */
  }
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * `memorix_project_context` gives titles and refs only. With `memoryDetails`
 * set, spend one search + one detail call to carry their bodies too — but only
 * while the hook still has budget left, so a slow brief never costs the turn.
 */
export async function enrichWithDetails(text, { cfg, projectRoot, query, signal, elapsedMs }) {
  if (!cfg.memoryDetails) return text;
  if (elapsedMs > cfg.gatewayTimeoutMs * 0.55) {
    debug('details-skipped', { reason: 'budget', elapsedMs });
    return text;
  }
  const details = await fetchMemoryDetails({ projectRoot, brief: text, query, cfg, signal });
  if (!details.ok) {
    debug('details-failed', { code: details.code, message: details.message });
    return text;
  }
  if (!details.text) return text;
  debug('details', { ids: details.ids.length, chars: details.text.length });
  return `${text}\n\n【记忆正文】\n${details.text}`;
}

function protocolOf(ctx) {
  return typeof ctx?.protocol === 'string' && ctx.protocol ? ctx.protocol : 'chat';
}

function sessionIdOf(ctx) {
  const session = ctx?.session;
  if (typeof session === 'string') return session;
  if (session && typeof session === 'object') {
    for (const key of ['id', 'sessionId', 'session_id']) {
      if (typeof session[key] === 'string' && session[key]) return session[key];
    }
  }
  return '';
}

function isLocal(ctx) {
  const origin = String(ctx?.origin ?? 'local');
  return origin === 'local';
}

/** Test hook: drop every in-process cache. */
export function reset() {
  resetClients();
  resetRecallCache();
  resetCaptureState();
  resetSticky();
}

/**
 * @param {object} body   pipeline request body (already parsed)
 * @param {object} ctx    magpie hook context
 * @returns {Promise<object|undefined>} the same body with the block appended
 */
export async function onRequest(body, ctx) {
  const started = Date.now();

  try {
    const cfg = normalizeOptions(ctx?.options);
    if (!cfg.enabled || !cfg.inject) return report(ctx, 'skipped');
    if (!body || typeof body !== 'object') return report(ctx, 'skipped');
    if (!isLocal(ctx) && !cfg.allowRemote) {
      debug('remote-origin', { origin: ctx?.origin });
      return report(ctx, 'skipped');
    }

    const protocol = protocolOf(ctx);
    const turns = turnsOf(body, protocol);
    if (!turns.length) return report(ctx, 'skipped');

    const projectRoot = resolveProjectRoot(
      cfg,
      ctx?.cwd,
      ctx?.cwd ? '' : collectRequestText(body, protocol),
    );
    if (!projectRoot) {
      debug('unbound', { cwd: ctx?.cwd });
      return report(ctx, 'unbound');
    }


    const query = String(ctx?.query ?? '').trim() || extractQueryFromRequest(body, protocol);
    if (!query) return report(ctx, 'empty');

    const target = targetTurn(turns, query);
    if (!target) return report(ctx, 'skipped');
    // Only the turn we would write into matters: an earlier reply may quote a
    // block (a log, a summary) without this turn already having one.
    if (hasBlock(target.text)) return report(ctx, 'skipped');

    if (cfg.position === 'system') {
      const recalled = await recallFor({ projectRoot, query, cfg, signal: ctx?.signal, agentId: ctx?.agent });
      if (!recalled.ok) return report(ctx, recalled.code);
      const enriched = await enrichWithDetails(recalled.text, {
        cfg, projectRoot, query, signal: ctx?.signal, elapsedMs: Date.now() - started,
      });
      const budget = contextCharBudget(cfg);
      const trimmed = trimToBudget(enriched, budget);
      const block = renderContextBlock(trimmed.text, { project: basename(projectRoot), truncated: trimmed.truncated });
      const next = injectSystemContext(body, protocol, block);
      if (!next) return report(ctx, 'empty');
      report(ctx, 'ready', byteLength(block));
      return next;
    }

    const sessionId = sessionIdOf(ctx);
    const identity = sessionIdentity({
      endpoint: cfg.endpoint,
      origin: String(ctx?.origin ?? 'local'),
      protocol,
      sessionId,
      cwd: String(ctx?.cwd ?? ''),
    });
    sweep();

    let changed = false;
    if (cfg.replayTurns) {
      for (const turn of turns) {
        if (turn.role !== 'user' || turn === target || hasBlock(turn.text)) continue;
        const kept = lookup(identity, turnKey(turn));
        if (kept?.text) {
          appendToTurn(turn, kept.text);
          changed = true;
        }
      }
    }

    const key = turnKey(target);
    const kept = cfg.replayTurns ? lookup(identity, key) : null;
    if (kept?.text) {
      appendToTurn(target, kept.text);
      debug('replay', { chars: kept.bytes, ms: Date.now() - started });
      report(ctx, 'ready', kept.bytes);
      return body;
    }

    const recalled = await recallFor({ projectRoot, query, cfg, signal: ctx?.signal, agentId: ctx?.agent });
    if (!recalled.ok) {
      debug('recall-failed', { code: recalled.code, message: recalled.message });
      report(ctx, recalled.code);
      return changed ? body : undefined;
    }

    const budget = contextCharBudget(cfg);
    const enriched = await enrichWithDetails(recalled.text, {
      cfg, projectRoot, query, signal: ctx?.signal, elapsedMs: Date.now() - started,
    });
    const trimmed = trimToBudget(enriched, budget);
    const block = renderContextBlock(trimmed.text, { project: basename(projectRoot), truncated: trimmed.truncated });
    if (!appendToTurn(target, block)) return changed ? body : undefined;

    const bytes = byteLength(block);
    remember(identity, key, block, bytes);
    if (ctx && typeof ctx.state === 'object' && ctx.state) {
      ctx.state.memorix = { injected: true, bytes, identity };
    }
    debug('injected', { chars: bytes, ms: Date.now() - started, cached: recalled.cached === true });
    report(ctx, 'ready', bytes);
    return body;
  } catch (error) {
    debug('onRequest-error', { message: error?.message || String(error) });
    report(ctx, 'invalid');
    return undefined;
  }
}

/**
 * @param {object} reply merged protocol reply (streams are already merged)
 * @param {object} ctx   same context, plus ctx.request / ctx.success
 */
export async function onResponse(reply, ctx) {
  const started = Date.now();

  try {
    const cfg = normalizeOptions(ctx?.options);
    if (!cfg.enabled || !cfg.capture) return null;
    if (!isLocal(ctx) && !cfg.allowRemote) return null;
    if (ctx?.success === false) {
      debug('incomplete-reply', {});
      return report(ctx, 'skipped'), null;
    }

    const protocol = protocolOf(ctx);
    const request = ctx?.request;
    const projectRoot = resolveProjectRoot(
      cfg,
      ctx?.cwd,
      ctx?.cwd ? '' : collectRequestText(request, protocol),
    );
    if (!projectRoot) return report(ctx, 'unbound'), null;


    const query = String(ctx?.query ?? '').trim() || extractQueryFromRequest(request, protocol);
    const replyText = extractReplyText(reply, protocol);

    const files = [
      ...new Set([
        ...extractFilePaths(replyText, { cwd: ctx?.cwd }),
        ...extractRequestFilePaths(request, { cwd: ctx?.cwd, limit: 6 }),
      ]),
    ].slice(0, 8);

    const sessionId = sessionIdOf(ctx);
    const verdict = evaluateCapture({ query, reply: replyText, files, kind: ctx?.kind, cfg, sessionId });
    if (!verdict.ok) {
      debug('capture-skip', { reason: verdict.reason });
      return report(ctx, 'skipped'), null;
    }

    const observation = buildObservation({
      query,
      reply: replyText,
      files,
      ctx: { agent: ctx?.agent, protocol, model: ctx?.model },
      cfg,
      projectRoot,
      sessionId,
    });

    const client = getClient(cfg.endpoint, cfg.timeoutMs);
    const stored = await client.callTool('memorix_store', observation, {
      projectRoot,
      signal: ctx?.signal,
      timeoutMs: cfg.timeoutMs,
    });
    if (!stored.ok) {
      debug('store-failed', { code: stored.code, message: stored.message });
      return report(ctx, stored.code), null;
    }

    noteCaptured({ fingerprint: verdict.fingerprint, counter: verdict.counter, sessionId, cfg });
    debug('stored', { type: observation.type, files: files.length, ms: Date.now() - started });
    return report(ctx, 'ready', byteLength(observation.narrative)), null;
  } catch (error) {
    debug('onResponse-error', { message: error?.message || String(error) });
    report(ctx, 'invalid');
    return null;
  }
}
