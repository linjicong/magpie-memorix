import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCapture,
  buildObservation,
  inferType,
  noteCaptured,
  resetCaptureState,
} from '../src/capture.js';
import { normalizeOptions } from '../src/config.js';

const cfg = normalizeOptions({});

beforeEach(() => resetCaptureState());

const base = {
  query: '修复登录接口的 401',
  reply: '## 结论\n**根因**：token 过期时间写成了 1 秒。已修复。\n\n```ts\nconst ttl = 3600;\n```\n',
  files: ['src/auth.ts'],
  kind: '',
  cfg,
  sessionId: 'sess-1',
};

test('a meaningful turn passes the gate', () => {
  const verdict = evaluateCapture(base);
  assert.equal(verdict.ok, true);
  assert.equal(typeof verdict.fingerprint, 'string');
});

test('each skip reason is reachable', () => {
  assert.equal(evaluateCapture({ ...base, reply: '' }).reason, 'empty-reply');
  assert.equal(evaluateCapture({ ...base, query: '' }).reason, 'no-query');
  assert.equal(evaluateCapture({ ...base, kind: 'subagent' }).reason, 'subagent');
  const secretReply = '已修复。\napi_key = "sk-live-abcdefghijklmnop"';
  assert.equal(evaluateCapture({ ...base, reply: secretReply, files: [] }).reason, 'secret');
  assert.equal(evaluateCapture({ ...base, reply: 'ok', files: [], cfg: normalizeOptions({ minReplyChars: 10 }) }).reason, 'short-reply');
  assert.equal(evaluateCapture({ ...base, query: '随便问一句', reply: 'done', files: [], cfg: normalizeOptions({ minReplyChars: 0 }) }).reason, 'insignificant');
});

test('a file mention alone does not make a one-liner worth storing', () => {
  const verdict = evaluateCapture({ ...base, reply: '记忆里没有 src/mcp.js', files: ['src/mcp.js'] });
  assert.equal(verdict.reason, 'short-reply');
});

test('the same turn is not stored twice', () => {
  const first = evaluateCapture(base);
  assert.equal(first.ok, true);
  noteCaptured({ fingerprint: first.fingerprint, counter: first.counter, sessionId: 'sess-1', cfg });
  assert.equal(evaluateCapture(base).reason, 'duplicate');
});

test('a session stops at its quota', () => {
  const cfg2 = normalizeOptions({ maxStoresPerSession: 1 });
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = evaluateCapture({ ...base, cfg: cfg2, sessionId: 'sess-quota', reply: `第 ${i} 次：结论是 ttl 写错了，已改成 3600，并补了一个回归测试覆盖这个分支；同时把错误码从 500 改成 422，避免客户端重试。` });
    if (last.ok) noteCaptured({ fingerprint: last.fingerprint, counter: last.counter, sessionId: 'sess-quota', cfg: cfg2 });
  }
  assert.equal(last.reason, 'session-limit');
});

test('type inference follows the strongest signal', () => {
  assert.equal(inferType({ query: 'x', reply: '根因是缓存未失效，已修复', files: [] }), 'problem-solution');
  assert.equal(inferType({ query: '决定用 ESM 而不是 TS', reply: 'ok', files: [] }), 'decision');
  assert.equal(inferType({ query: 'q', reply: '注意：这个坑别踩', files: [] }), 'gotcha');
  assert.equal(inferType({ query: 'q', reply: 'changed', files: ['a.ts'] }), 'what-changed');
  assert.equal(inferType({ query: 'q', reply: 'how it works', files: [] }), 'how-it-works');
});

test('observation is deterministic and carries the turn', () => {
  const obs = buildObservation({
    ...base,
    ctx: { agent: 'claude', protocol: 'anthropic', model: 'm' },
    projectRoot: '/repo/demo-app',
    sessionId: 'sess-42',
  });
  assert.equal(obs.entityName, 'demo-app');
  assert.equal(obs.type, 'problem-solution');
  assert.equal(obs.title, base.query);
  assert.deepEqual(obs.filesModified, ['src/auth.ts']);
  assert.match(obs.topicKey, /^magpie:/);
  assert.equal(obs.progress.status, 'completed');
  assert.ok(obs.facts.length >= 1);
  assert.ok(obs.facts.every((fact) => fact.length <= 100));
  assert.deepEqual(obs.concepts, ['claude', 'anthropic', 'm']);
  assert.ok(obs.narrative.length <= 1200);
});
