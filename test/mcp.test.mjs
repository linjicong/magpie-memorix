import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClient, resetClients, parseSseText, textFromToolResult, MCP_PROTOCOL_VERSION } from '../src/mcp.js';
import { startFakeMemorix } from './helpers/fake-memorix.mjs';

test('stateless JSON-RPC binds a project and then reuses the issued handle', async () => {
  resetClients();
  const fake = await startFakeMemorix();
  try {
    const client = getClient(fake.endpoint, 2000);
    const first = await client.callTool('memorix_project_context', { task: 'q' }, { projectRoot: '/repo/a', timeoutMs: 2000 });
    assert.equal(first.ok, true);
    const second = await client.callTool('memorix_project_context', { task: 'q' }, { projectRoot: '/repo/a', timeoutMs: 2000 });

    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[0].headers['mcp-project-root'], '/repo/a');
    assert.equal(fake.requests[0].headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(fake.requests[0].headers['mcp-method'], 'tools/call');
    assert.equal(fake.requests[0].headers['mcp-name'], 'memorix_project_context');
    const sentMeta = fake.requests[0].body.params._meta;
    assert.equal(sentMeta['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
    assert.deepEqual(sentMeta['io.modelcontextprotocol/clientCapabilities'], {});
    assert.equal(fake.requests[1].headers['mcp-project-handle'], 'handle-1');
    assert.equal(fake.requests[1].headers['mcp-project-root'], undefined);
    assert.ok(second.text.includes('记忆'));
  } finally {
    await fake.close();
  }
});

test('a non-ASCII project path is refused instead of mangled', async () => {
  resetClients();
  const fake = await startFakeMemorix();
  try {
    const client = getClient(fake.endpoint, 2000);
    const result = await client.callTool('memorix_project_context', {}, { projectRoot: '/repo/中文项目', timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unbound');
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('SSE replies are parsed like JSON replies', async () => {
  resetClients();
  const fake = await startFakeMemorix({ sse: true });
  try {
    const client = getClient(fake.endpoint, 2000);
    const result = await client.callTool('memorix_search', { query: 'x' }, { projectRoot: '/repo/b', timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(client.stats.sse, 1);
  } finally {
    await fake.close();
  }
});

test('an expired handle triggers exactly one re-bind with the root header', async () => {
  resetClients();
  const fake = await startFakeMemorix({ expireOnce: true });
  try {
    const client = getClient(fake.endpoint, 2000);
    await client.callTool('memorix_project_context', {}, { projectRoot: '/repo/c', timeoutMs: 2000 });
    const retried = await client.callTool('memorix_project_context', {}, { projectRoot: '/repo/c', timeoutMs: 2000 });
    assert.equal(retried.ok, true);
    assert.equal(fake.requests.length, 3, 'first binds, second is rejected, third retries');
    assert.equal(fake.requests[2].headers['mcp-project-root'], '/repo/c');
    assert.equal(fake.requests[2].headers['mcp-project-handle'], undefined);
    assert.equal(fake.requests[2].body.params.name, 'memorix_project_context');
  } finally {
    await fake.close();
  }
});

test('a transport failure opens the backoff and stops retrying', async () => {
  resetClients();
  const fake = await startFakeMemorix({ fail: true });
  try {
    const client = getClient(fake.endpoint, 1000);
    const first = await client.callTool('memorix_store', {}, { projectRoot: '/repo/d', timeoutMs: 1000 });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'unavailable');
    const before = fake.requests.length;
    const second = await client.callTool('memorix_store', {}, { projectRoot: '/repo/d', timeoutMs: 1000 });
    assert.equal(second.code, 'unavailable');
    assert.equal(fake.requests.length, before, 'no request while backing off');
  } finally {
    await fake.close();
  }
});

test('text extraction understands MCP content blocks', () => {
  assert.equal(textFromToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(textFromToolResult({ structuredContent: { brief: 'brief' } }), 'brief');
  assert.equal(textFromToolResult(null), '');
});

test('SSE parser keeps the last complete message', () => {
  const text = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}\n\n';
  assert.equal(parseSseText(text, 7).id, 7);
  assert.equal(parseSseText('data: {"id":9}\n\n', 7).id, 9);
});
