/**
 * Option normalization for the magpie-memorix gateway hook.
 *
 * magpie hands the package's options (plugins.json <- `magpie plugin options`)
 * to the hook as `ctx.options`. Everything is re-validated here so a bad value
 * can never turn into a long request stall or an unbounded injection.
 */

export const DEFAULTS = {
  enabled: true,
  endpoint: 'http://127.0.0.1:3211',
  gatewayTimeoutMs: 8000,
  timeoutMs: 6000,
  inject: true,
  capture: true,
  contextTokens: 800,
  position: 'tail-user',
  projectRoot: '',
  skipSubagents: true,
  minReplyChars: 120,
  maxStoresPerSession: 10,
  agent: '',
  replayTurns: true,
  allowRemote: false,
  memoryDetails: 0,
  memoryDetailChars: 1000,
  memoryDetailsSearch: true,
  recallCacheMs: 60000,
};

 /** magpie clamps hook timeouts to 100..30000 ms; we keep the same window. */
const GATEWAY_TIMEOUT_MIN = 100;
const GATEWAY_TIMEOUT_MAX = 30000;

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

function toEndpoint(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return fallback;
  return trimmed;
}

export function normalizeOptions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULTS, ...source };

  const gatewayTimeoutMs = toInt(
    merged.gatewayTimeoutMs,
    DEFAULTS.gatewayTimeoutMs,
    GATEWAY_TIMEOUT_MIN,
    GATEWAY_TIMEOUT_MAX,
  );
  // Leave at least two seconds of the hook budget for the gateway round trip.
  const timeoutMs = toInt(
    merged.timeoutMs,
    Math.min(DEFAULTS.timeoutMs, Math.max(200, gatewayTimeoutMs - 2000)),
    200,
    Math.max(200, gatewayTimeoutMs),
  );

  return {
    enabled: toBool(merged.enabled, DEFAULTS.enabled),
    endpoint: toEndpoint(merged.endpoint, DEFAULTS.endpoint),
    gatewayTimeoutMs,
    timeoutMs,
    inject: toBool(merged.inject, DEFAULTS.inject),
    capture: toBool(merged.capture, DEFAULTS.capture),
    contextTokens: toInt(merged.contextTokens, DEFAULTS.contextTokens, 100, 4000),
    position: merged.position === 'system' ? 'system' : 'tail-user',
    projectRoot: typeof merged.projectRoot === 'string' ? merged.projectRoot.trim() : '',
    skipSubagents: toBool(merged.skipSubagents, DEFAULTS.skipSubagents),
    minReplyChars: toInt(merged.minReplyChars, DEFAULTS.minReplyChars, 0, 5000),
    maxStoresPerSession: toInt(merged.maxStoresPerSession, DEFAULTS.maxStoresPerSession, 0, 100),
    agent: typeof merged.agent === 'string' ? merged.agent.trim() : '',
    replayTurns: toBool(merged.replayTurns, DEFAULTS.replayTurns),
    allowRemote: toBool(merged.allowRemote, DEFAULTS.allowRemote),
    memoryDetails: toInt(merged.memoryDetails, DEFAULTS.memoryDetails, 0, 5),
    memoryDetailChars: toInt(merged.memoryDetailChars, DEFAULTS.memoryDetailChars, 200, 3000),
    memoryDetailsSearch: toBool(merged.memoryDetailsSearch, DEFAULTS.memoryDetailsSearch),
    recallCacheMs: toInt(merged.recallCacheMs, DEFAULTS.recallCacheMs, 0, 3600000),
  };
}

/** Character budget for the injected block (roughly 3 chars per token). */
export function contextCharBudget(cfg) {
  return Math.max(280, Math.round(cfg.contextTokens * 3));
}
