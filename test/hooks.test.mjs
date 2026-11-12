import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequest, onResponse, reset } from '../context.hooks.js';
import { startFakeMemorix } from './helpers/fake-memorix.mjs';

const servers = [];
let fake;
let repo;

beforeEach(async () => {
  reset();
  repo = mkdtempSync(join(tmpdir(), 'memorix-hooks-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'auth.ts'), 'export {};\n');
});

afterEach(async () => {
  while (servers.length) await servers.pop().close();
});

async function memorix(opts) {
  fake = await startFakeMemorix(opts);
  servers.push(fake);
  return fake;
}

function makeContext(endpoint, overrides = {}) {
  const reports = [];
  const ctx = {
    protocol: 'chat',
    model: 'test-model',
    origin: 'local',
    agent: 'claude',
    session: 'sess-1',
    cwd: repo,
    query: '登录接口 401 怎么修',
    options: { endpoint },
    signal: new AbortController().signal,
    state: {},
    report: (code, bytes) => reports.push({ code, bytes }),
    ...overrides,
  };
  return { ctx, reports, last: () => reports.at(-1)?.code };
}

const userTurn = (text) => ({ role: 'user', content: text });
const assistantTurn = (text) => ({ role: 'assistant', content: text });

test('first request gets one block on the user turn and nothing else changes', async () => {
  await memorix();
  const { ctx, last } = makeContext(fake.endpoint);
  const body = {
    model: 'test-model',
    stream: true,
    tools: [{ type: 'function', function: { name: 'read' } }],
    messages: [userTurn('登录接口 401 怎么修')],
  };
  const before = structuredClone(body);
  const out = await onRequest(body, ctx);

  assert.equal(out, body, 'the same body object is returned with the block appended');
  assert.equal(last(), 'ready');
  assert.match(body.messages[0].content, /<memorix-context/);
  assert.equal(body.model, before.model);
  assert.equal(body.stream, before.stream);
  assert.deepEqual(body.tools, before.tools);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].tool, 'memorix_project_context');
});

test('a later request replays the earlier turn verbatim, so the prefix is stable', async () => {
  await memorix();
  const first = { messages: [userTurn('登录接口 401 怎么修')] };
  const { ctx: ctx1 } = makeContext(fake.endpoint);
  await onRequest(first, ctx1);
  const firstBlock = first.messages[0].content;

  const second = {
    messages: [
      userTurn('登录接口 401 怎么修'),
      assistantTurn('看 token 刷新'),
      userTurn('把 ttl 改成 3600'),
    ],
  };
  const { ctx: ctx2, last } = makeContext(fake.endpoint, { query: '把 ttl 改成 3600' });
  await onRequest(second, ctx2);

  assert.equal(last(), 'ready');
  assert.match(second.messages[0].content, /<memorix-context/, 'earlier turn restored');
  assert.equal(
    second.messages[0].content.replace(/\n\n<memorix-context[\s\S]*$/, ''),
    '登录接口 401 怎么修',
    'client text is untouched before the replayed block',
  );
  assert.equal(second.messages[0].content.split('<memorix-context')[1], firstBlock.split('<memorix-context')[1]);
  assert.match(second.messages[2].content, /<memorix-context/);
  assert.equal(fake.requests.length, 2, 'one recall per new turn');
});

test('a repeated turn (tool loop) is replayed without asking memorix again', async () => {
  await memorix();
  const body = { messages: [userTurn('登录接口 401 怎么修')] };
  const { ctx } = makeContext(fake.endpoint);
  await onRequest(body, ctx);
  const once = body.messages[0].content;

  const again = { messages: [userTurn('登录接口 401 怎么修')] };
  const { ctx: ctx2, last } = makeContext(fake.endpoint);
  await onRequest(again, ctx2);
  assert.equal(last(), 'ready');
  assert.equal(again.messages[0].content, once);
  assert.equal(fake.requests.length, 1);
});

test('an already annotated turn is left alone', async () => {
  await memorix();
  const body = { messages: [userTurn('问题\n\n<memorix-context>\nold\n</memorix-context>')] };
  const { ctx, last } = makeContext(fake.endpoint);
  await onRequest(body, ctx);
  assert.equal(last(), 'skipped');
  assert.equal(fake.requests.length, 0);
});

test('no git root means unbound, and no call is made', async () => {
  await memorix();
  const plain = mkdtempSync(join(tmpdir(), 'memorix-plain-'));
  const { ctx, last } = makeContext(fake.endpoint, { cwd: plain });
  await onRequest({ messages: [userTurn('q')] }, ctx);
  assert.equal(last(), 'unbound');
  assert.equal(fake.requests.length, 0);
});

test('a remote origin is skipped unless explicitly allowed', async () => {
  await memorix();
  const { ctx, last } = makeContext(fake.endpoint, { origin: 'remote' });
  await onRequest({ messages: [userTurn('q')] }, ctx);
  assert.equal(last(), 'skipped');
  assert.equal(fake.requests.length, 0);
});

test('a finished turn is stored once, and a secret-bearing turn never', async () => {
  await memorix();
  const body = { messages: [userTurn('修复 src/auth.ts 的 ttl')] };
  const { ctx } = makeContext(fake.endpoint);
  await onRequest(body, ctx);

  const reply = {
    choices: [{
      message: {
        content: '根因：ttl 写成了 1 秒。已修复 src/auth.ts，结论：改为 3600。\n```ts\nconst ttl = 3600;\n```',
      },
    }],
  };
  const { ctx: ctx2, last } = makeContext(fake.endpoint, { request: body, success: true, query: '修复 src/auth.ts 的 ttl' });
  await onResponse(reply, ctx2);
  assert.equal(last(), 'ready');
  const storeCalls = fake.requests.filter((r) => r.tool === 'memorix_store');
  assert.equal(storeCalls.length, 1);
  const args = storeCalls[0].body.params.arguments;
  assert.equal(args.type, 'problem-solution');
  assert.deepEqual(args.filesModified, ['src/auth.ts']);
  assert.match(args.narrative, /根因/);

  const duplicate = await onResponse(reply, { ...ctx2, query: '修复 src/auth.ts 的 ttl' });
  assert.equal(duplicate, null);
  assert.equal(fake.requests.filter((r) => r.tool === 'memorix_store').length, 1);
});

test('a reply carrying a credential is not written', async () => {
  await memorix();
  const reply = { choices: [{ message: { content: '配置好了。api_key = "{{API_KEY_4c5tt2p8}}"。' } }] };
  const { ctx, last } = makeContext(fake.endpoint, { success: true, query: '配置密钥' });
  await onResponse(reply, ctx);
  assert.equal(last(), 'skipped');
  assert.equal(fake.requests.filter((r) => r.tool === 'memorix_store').length, 0);
});

test('memoryDetails adds the entry bodies to the block', async () => {
  await memorix({
    toolTexts: {
      memorix_project_context: 'Reliable memory\n- #3 how-it-works: callTool ... (src/mcp.js)',
      memorix_detail: '#3 [INFO] callTool\nNarrative: 包装 MCP 调用；失败返回错误码，不抛给调用方。',
    },
  });
  const { ctx, last } = makeContext(fake.endpoint, {
    options: {
      endpoint: fake.endpoint,
      memoryDetails: 3,
      memoryDetailChars: 300,
    },
  });
  const body = { messages: [userTurn('说明 callTool')] };
  await onRequest(body, ctx);

  assert.equal(last(), 'ready');
  assert.match(body.messages[0].content, /【记忆正文】/);
  assert.match(
    body.messages[0].content,
    /包装 MCP 调用/,
    'the narrative body is carried, not only the title',
  );
  assert.deepEqual(
    fake.requests.map((r) => r.tool),
    ['memorix_project_context', 'memorix_search', 'memorix_detail'],
  );
});

test('a budget already spent skips the detail round trip', async () => {
  await memorix();
  const { enrichWithDetails } = await import('../context.hooks.js');
  const cfg = { memoryDetails: 3, gatewayTimeoutMs: 8000 };
  const text = await enrichWithDetails('brief', { cfg, projectRoot: repo, query: 'q', elapsedMs: 5000 });
  assert.equal(text, 'brief');
  assert.equal(fake.requests.length, 0, 'nothing is asked once the budget is spent');
});

test('an incomplete reply is skipped', async () => {
  await memorix();
  const reply = { choices: [{ message: { content: 'partial' } }] };
  const { ctx, last } = makeContext(fake.endpoint, { success: false });
  await onResponse(reply, ctx);
  assert.equal(last(), 'skipped');
});
