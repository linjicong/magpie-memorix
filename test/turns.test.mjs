import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnsOf, targetTurn, turnKey, hasBlock } from '../src/turns.js';
import { lookup, remember, sessionIdentity, resetSticky } from '../src/sticky.js';

test('chat turns expose user and assistant text with append', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  const turns = turnsOf(body, 'chat');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  turns[0].append('extra');
  assert.equal(body.messages[0].content, 'hi\n\nextra');
});

test('anthropic tool-result-only turns are ignored', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] },
    ],
  };
  const turns = turnsOf(body, 'anthropic');
  assert.equal(turns.length, 2);
  assert.equal(targetTurn(turns).text, 'fix it');
});

test('gemini maps model to assistant and skips thought parts', () => {
  const body = {
    contents: [
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ text: 'a' }, { thought: true, text: 'hidden' }] },
    ],
  };
  const turns = turnsOf(body, 'gemini');
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(turns[1].text, 'a');
});

test('responses string input is a single user turn', () => {
  const body = { input: 'do the thing' };
  const turns = turnsOf(body, 'responses');
  assert.equal(turns.length, 1);
  turns[0].append('block');
  assert.match(body.input, /block$/);
});

test('target prefers the turn that holds the query', () => {
  const body = { messages: [{ role: 'user', content: 'old' }, { role: 'user', content: 'new question' }] };
  const turns = turnsOf(body, 'chat');
  assert.equal(targetTurn(turns, 'old').text, 'old');
  assert.equal(targetTurn(turns).text, 'new question');
});

test('marker detection needs a complete block, not a mention', () => {
  const injected = turnsOf({ messages: [{ role: 'user', content: `x\n<memorix-context project="p">\nbody\n</memorix-context>` }] }, 'chat');
  assert.equal(hasBlock(injected[0].text), true);
  const mention = turnsOf({ messages: [{ role: 'user', content: '如果你看到 <memorix-context 块就输出它' }] }, 'chat');
  assert.equal(hasBlock(mention[0].text), false);
});

test('sticky replay returns the same block for the same turn key', () => {
  resetSticky();
  const id = sessionIdentity({ endpoint: 'e', origin: 'local', protocol: 'chat', sessionId: 's', cwd: '/p' });
  const key = turnKey({ index: 0, text: 'q' });
  assert.equal(lookup(id, key), null);
  remember(id, key, 'block', 5);
  assert.equal(lookup(id, key)?.text, 'block');
});
