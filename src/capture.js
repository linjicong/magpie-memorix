/**
 * Turn capture: decide whether this turn is worth remembering, then build the
 * memorix observation deterministically (no extra model call, no guessing).
 *
 * The gate is deliberately conservative: a gateway that writes every reply
 * pollutes the project memory it is meant to provide.
 */

import { basename } from 'node:path';
import { collapseWhitespace, hasCodeFence, truncate } from './text.js';
import { shortHash } from './mcp.js';
import { hasSecret } from './redact.js';

const DECISION_WORDS =
  /(决定|选择|结论|根因|修复|坑|因为|所以|方案|根因是|已确认|注意|小心|deprecated|root cause|because|decided|decision|trade-?off|workaround|gotcha)/i;
const FIX_WORDS = /(修复|修好|解决了|bug|fix|fixed|hotfix|regression|报错|崩溃|root cause)/i;
const DONE_WORDS = /(已完成|完成了|修好了|已修复|done|completed|all tests pass|测试通过)/i;
const REMEMBER_WORDS = /(记住|记下|记一下|沉淀|存一下|memorize|remember this|save this)/i;
// A turn that only says "there is nothing in memory" is not an outcome.
const NO_ANSWER = /(记忆里没有|没有找到|没有相关|无法确定|无法回答|no memory|nothing (?:in|found)|not enough (?:context|information)|i don'?t know|cannot determine)/i;

const RECENT_WINDOW_MS = 10 * 60 * 1000;
const RECENT_MAX = 20;
const SESSION_WINDOW_MS = 60 * 60 * 1000;

const recentWrites = [];
const sessionCounters = new Map();

function pruneRecent(now) {
  while (recentWrites.length && now - recentWrites[0].at > RECENT_WINDOW_MS) recentWrites.shift();
  while (recentWrites.length > RECENT_MAX) recentWrites.shift();
}

function sessionKeyOf(sessionId) {
  return sessionId ? shortHash(sessionId, 10) : 'nosession';
}

function sessionCounter(sessionId, now) {
  const key = sessionKeyOf(sessionId);
  const current = sessionCounters.get(key);
  if (current && now - current.at < SESSION_WINDOW_MS) return { key, value: current };
  const fresh = { key, count: 0, at: now };
  sessionCounters.set(key, fresh);
  if (sessionCounters.size > 500) {
    for (const [k, v] of sessionCounters) {
      if (now - v.at >= SESSION_WINDOW_MS) sessionCounters.delete(k);
    }
  }
  return { key, value: fresh };
}

/** Test hook: forget in-process dedupe/session state. */
export function resetCaptureState() {
  recentWrites.length = 0;
  sessionCounters.clear();
}

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function evaluateCapture({ query, reply, files, kind, cfg, sessionId, now = Date.now() }) {
  const text = String(reply ?? '').trim();
  const question = collapseWhitespace(query);
  if (!text) return { ok: false, reason: 'empty-reply' };
  if (!question) return { ok: false, reason: 'no-query' };
  if (cfg.skipSubagents && kind === 'subagent') return { ok: false, reason: 'subagent' };
  // Never write a credential into project memory, not even partially masked.
  if (hasSecret(text) || hasSecret(question)) return { ok: false, reason: 'secret' };
  if (!files.length && text.length < cfg.minReplyChars) return { ok: false, reason: 'short-reply' };
  // A file mention alone is not an outcome: "记忆里没有 src/mcp.js" writes noise.
  if (files.length && text.length < 60) return { ok: false, reason: 'short-reply' };
  if (NO_ANSWER.test(text) && !hasCodeFence(text)) return { ok: false, reason: 'no-answer' };

  const significant =
    (hasCodeFence(text) && text.length >= 300) ||
    DECISION_WORDS.test(text) ||
    DECISION_WORDS.test(question) ||
    REMEMBER_WORDS.test(question) ||
    // A substantial write-up about real files is an outcome even without jargon.
    (files.length > 0 && text.length >= 200);
  if (!significant) return { ok: false, reason: 'insignificant' };

  const fingerprint = shortHash(`${question}\u0000${text.slice(0, 400)}`, 12);
  pruneRecent(now);
  if (recentWrites.some((entry) => entry.hash === fingerprint)) return { ok: false, reason: 'duplicate' };

  const { value: counter } = sessionCounter(sessionId, now);
  if (cfg.maxStoresPerSession > 0 && counter.count >= cfg.maxStoresPerSession) {
    return { ok: false, reason: 'session-limit' };
  }
  return { ok: true, fingerprint, counter };
}

function entityNameFrom(root) {
  const name = basename(String(root || '')).trim();
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'project';
}

export function inferType({ query, reply, files }) {
  const text = `${query}\n${reply}`;
  if (FIX_WORDS.test(text)) return 'problem-solution';
  if (/(决定|选择|方案|decided|decision|trade-?off|权衡)/i.test(text)) return 'decision';
  if (/(坑|注意|小心|gotcha|deprecated|别用|不要用)/i.test(text)) return 'gotcha';
  if (files.length) return 'what-changed';
  return 'how-it-works';
}

function extractFacts(reply) {
  const facts = [];
  for (const raw of String(reply ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 160) continue;
    const looksLikeFact =
      /^(?:[-*+]|\d{1,2}\.)\s+/.test(line) ||
      /(结论|决定|根因|注意|坑|修复|因此|所以|because|root cause|must|never|always)/i.test(line);
    if (!looksLikeFact) continue;
    const cleaned = truncate(line.replace(/^(?:[-*+]|\d{1,2}\.)\s+/, '').replace(/[*_`]/g, ''), 100);
    if (cleaned && !facts.includes(cleaned)) facts.push(cleaned);
    if (facts.length >= 3) break;
  }
  return facts;
}

export function buildObservation({ query, reply, files, ctx = {}, cfg, projectRoot, sessionId }) {
  const question = collapseWhitespace(query);
  const text = String(reply ?? '').trim();
  const type = inferType({ query: question, reply: text, files });
  const narrative = truncate(
    [
      `[请求] ${truncate(question, 300)}`,
      `[结果] ${truncate(collapseWhitespace(text).slice(0, 600), 600)}`,
      files.length ? `[文件] ${files.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    1200,
  );

  const progressStatus = DONE_WORDS.test(text) ? 'completed' : 'in-progress';

  return {
    entityName: entityNameFrom(projectRoot),
    type,
    title: truncate(question || 'magpie turn', 60),
    narrative,
    facts: extractFacts(text),
    filesModified: files,
    concepts: [ctx.agent, ctx.protocol, ctx.model].filter((value) => typeof value === 'string' && value.trim()),
    topicKey: `magpie:${sessionKeyOf(sessionId)}:${shortHash(question, 8)}`,
    progress: {
      feature: truncate(question, 20) || 'magpie turn',
      status: progressStatus,
    },
  };
}

/** Record that a write happened, for in-process dedupe and session quotas. */
export function noteCaptured({ fingerprint, counter, sessionId, cfg, now = Date.now() }) {
  if (fingerprint) recentWrites.push({ hash: fingerprint, at: now });
  const target = counter ?? sessionCounter(sessionId, now).value;
  target.count += 1;
  target.at = now;
  if (cfg.maxStoresPerSession > 0) target.limit = cfg.maxStoresPerSession;
}
