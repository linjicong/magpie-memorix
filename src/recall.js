/**
 * Recall: one bounded memorix `memorix_project_context` call per request,
 * cached briefly so a client that retries or replays a turn does not pay twice.
 */

import { getClient, shortHash } from './mcp.js';

const CACHE_TTL_MS = 60 * 1000; // default; cfg.recallCacheMs overrides it
const CACHE_MAX = 200;
const cache = new Map();

const AGENT_ALIASES = [
  [/claude/i, 'claude-code'],
  [/codex/i, 'codex'],
  [/cursor/i, 'cursor'],
  [/gemini/i, 'gemini-cli'],
  [/opencode/i, 'opencode'],
  [/trae/i, 'trae'],
  [/copilot/i, 'copilot'],
  [/windsurf/i, 'windsurf'],
  [/kiro/i, 'kiro'],
  [/antigravity/i, 'antigravity'],
];

const MEMORIX_AGENTS = new Set([
  'windsurf', 'cursor', 'claude-code', 'codex', 'copilot', 'antigravity',
  'gemini-cli', 'openclaw', 'hermes', 'omp', 'kiro', 'opencode', 'trae',
]);

export function resetRecallCache() {
  cache.clear();
}

/** Map magpie's agent id onto the enum memorix accepts. */
export function mapAgent(agentId, override) {
  if (override && MEMORIX_AGENTS.has(override)) return override;
  const raw = String(agentId ?? '').trim();
  if (!raw) return undefined;
  if (MEMORIX_AGENTS.has(raw)) return raw;
  for (const [pattern, mapped] of AGENT_ALIASES) {
    if (pattern.test(raw)) return mapped;
  }
  return undefined;
}

function cacheKey(projectRoot, query) {
  return `${projectRoot}\u0000${shortHash(query, 10)}`;
}

function readCache(key, now, ttl = CACHE_TTL_MS) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (ttl <= 0 || now - entry.at > ttl) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so the map behaves like an LRU.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(key, text, now) {
  cache.set(key, { at: now, text });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * @returns {{ok:true,text:string}|{ok:false,code:'empty'|'unavailable'|'invalid',message?:string}}
 */
export async function recallProjectContext({ projectRoot, query, cfg, signal, client, now = Date.now() }) {
  const question = String(query ?? '').trim();
  if (!question) return { ok: false, code: 'empty', message: 'no query text' };

  const key = cacheKey(projectRoot, question);
  const cached = readCache(key, now, cfg.recallCacheMs);
  if (cached) return { ok: true, text: cached.text, cached: true };

  const tools = client || getClient(cfg.endpoint, cfg.timeoutMs);
  const result = await tools.callTool(
    'memorix_project_context',
    {
      task: question.slice(0, 500),
      format: 'prompt',
      refresh: 'auto',
      ...(mapAgent(undefined, cfg.agent) ? { agent: mapAgent(undefined, cfg.agent) } : {}),
    },
    { projectRoot, signal, timeoutMs: cfg.timeoutMs },
  );

  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  const text = String(result.text ?? '').trim();
  // memorix answers with a brief that says there is nothing when it has nothing;
  // a very short answer is treated as empty rather than injected.
  if (!text || text.length < 40) return { ok: false, code: 'empty', message: 'brief too short' };

  writeCache(key, text, now);
  return { ok: true, text };
}

/** Recall with the agent hint resolved by the caller (keeps mapAgent pure for tests). */
export async function recallFor({ projectRoot, query, cfg, signal, agentId, client, now = Date.now() }) {
  const question = String(query ?? '').trim();
  if (!question) return { ok: false, code: 'empty', message: 'no query text' };

  const key = cacheKey(projectRoot, question);
  const cached = readCache(key, now, cfg.recallCacheMs);
  if (cached) return { ok: true, text: cached.text, cached: true };

  const tools = client || getClient(cfg.endpoint, cfg.timeoutMs);
  const agent = mapAgent(agentId, cfg.agent);
  const args = { task: question.slice(0, 500), format: 'prompt', refresh: 'auto' };
  if (agent) args.agent = agent;

  const result = await tools.callTool('memorix_project_context', args, {
    projectRoot,
    signal,
    timeoutMs: cfg.timeoutMs,
  });

  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  const text = String(result.text ?? '').trim();
  if (!text || text.length < 40) return { ok: false, code: 'empty', message: 'brief too short' };

  writeCache(key, text, now);
  return { ok: true, text };
}
