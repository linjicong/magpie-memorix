import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBriefIds, condenseDetails, fetchMemoryDetails } from '../src/details.js';
import { normalizeOptions } from '../src/config.js';
import { resetClients, getClient } from '../src/mcp.js';
import { startFakeMemorix } from './helpers/fake-memorix.mjs';

test('ids are read out of the brief the model was shown', () => {
  const brief = [
    'Reliable memory',
    '- #2 how-it-works: 请读 src/mcp.js 里 callTool... (src/mcp.js#client)',
    '- #5 what-changed: ... (src/mcp.js)',
    '- #2 again',
  ].join('\n');
  assert.deepEqual(parseBriefIds(brief, 3), [2, 5]);
  assert.deepEqual(parseBriefIds('no ids here'), []);
});

test('detail text is condensed to one line per entry', () => {
  const detail = [
    '[STORE] Explicit Working Memory  [L2]',
    '',
    '#2 [INFO] callTool',
    'Date: 2026/11/12 15:26:58',
    'Narrative: [请求] 说明 callTool',
    '[结果] 包装 MCP 调用，失败返回错误码。',
    '',
    '#5 [CHANGE] src/mcp.js',
    'Narrative: 改了 SSE 解析。',
  ].join('\n');
  const condensed = condenseDetails(detail, 400);
  assert.match(condensed, /^#2 callTool: /m);
  assert.match(condensed, /包装 MCP 调用/);
  assert.match(condensed, /#5 src\/mcp\.js: 改了 SSE 解析/);
  assert.ok(condensed.length <= 400);
});

test('brief ids are expanded, and a bounded search fills the rest', async () => {
  resetClients();
  const fake = await startFakeMemorix({
    toolTexts: {
      memorix_search: '| obs:2@local/proj | 3:26 PM | [INFO] | callTool |',
      memorix_detail: '#3 [INFO] callTool\nNarrative: 包装 MCP 调用，失败返回错误码。\n\n#2 [INFO] 旧结论\nNarrative: 旧结论的正文。',
    },
  });
  try {
    const cfg = normalizeOptions({ endpoint: fake.endpoint, memoryDetails: 3, memoryDetailChars: 400 });
    const client = getClient(fake.endpoint, 2000);
    const brief = 'Reliable memory\n- #3 how-it-works: callTool ...';
    const result = await fetchMemoryDetails({ projectRoot: '/repo/x', brief, query: 'callTool', cfg, client });

    assert.equal(result.ok, true);
    assert.deepEqual(result.ids, [3, 2], 'brief first, then what the search found');
    assert.match(result.text, /包装 MCP 调用/);
    assert.deepEqual(fake.requests.map((r) => r.tool), ['memorix_search', 'memorix_detail']);
    const searchArgs = fake.requests[0].body.params.arguments;
    assert.equal(searchArgs.query, 'callTool');
    assert.equal(searchArgs.force, true, 'memorix refuses to re-search its own brief without force');
    assert.match(searchArgs.purpose, /no MCP tools/i);
    const args = fake.requests[1].body.params.arguments;
    assert.deepEqual(args.ids, [3, 2]);
    assert.equal(args.force, true, 'memorix requires force to expand its own brief');
    assert.match(args.purpose, /no MCP tools/i);
  } finally {
    await fake.close();
  }
});

test('search can be turned off for latency', async () => {
  resetClients();
  const fake = await startFakeMemorix({
    toolTexts: { memorix_detail: '#3 [INFO] callTool\nNarrative: 正文。' },
  });
  try {
    const cfg = normalizeOptions({
      endpoint: fake.endpoint, memoryDetails: 3, memoryDetailsSearch: false,
    });
    const result = await fetchMemoryDetails({
      projectRoot: '/repo/x',
      brief: '- #3 callTool',
      query: 'q',
      cfg,
      client: getClient(fake.endpoint, 2000),
    });
    assert.deepEqual(fake.requests.map((r) => r.tool), ['memorix_detail']);
    assert.match(result.text, /正文/);
  } finally {
    await fake.close();
  }
});

test('off by default, and no ids anywhere costs one search only', async () => {
  resetClients();
  const fake = await startFakeMemorix({ toolTexts: { memorix_search: 'Found 0 observation(s).' } });
  try {
    const off = await fetchMemoryDetails({
      projectRoot: '/repo/x',
      brief: '- #3 something',
      query: 'q',
      cfg: normalizeOptions({ endpoint: fake.endpoint, memoryDetails: 0 }),
    });
    assert.equal(off.text, '');
    assert.equal(fake.requests.length, 0, 'nothing is asked when the option is off');

    const noIds = await fetchMemoryDetails({
      projectRoot: '/repo/x',
      brief: 'Reliable memory\n- nothing numbered',
      query: 'q',
      cfg: normalizeOptions({ endpoint: fake.endpoint, memoryDetails: 3 }),
      client: getClient(fake.endpoint, 2000),
    });
    assert.equal(noIds.text, '');
    assert.equal(fake.requests.length, 1, 'the search ran, found no id, so no detail');
  } finally {
    await fake.close();
  }
});
