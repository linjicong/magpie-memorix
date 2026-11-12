import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractReplyText,
  extractQueryFromRequest,
  stripInjected,
  extractFilePaths,
  extractRequestFilePaths,
  collapseWhitespace,
  truncate,
} from '../src/text.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'memorix-text-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(join(dir, 'README.md'), '# x\n');
  return dir;
}

test('reply extraction covers every protocol shape', () => {
  const chat = { choices: [{ message: { content: 'answer' } }] };
  assert.equal(extractReplyText(chat, 'chat'), 'answer');
  const anthropic = { content: [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'b' }] };
  assert.equal(extractReplyText(anthropic, 'anthropic'), 'a\nb');
  const responses = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'c' }] }] };
  assert.equal(extractReplyText(responses, 'responses'), 'c');
  const gemini = { candidates: [{ content: { parts: [{ text: 'd' }] } }] };
  assert.equal(extractReplyText(gemini, 'gemini'), 'd');
  assert.equal(extractReplyText({ output_text: 'plain' }, 'responses'), 'plain');
});

test('query extraction walks back to the last real user text', () => {
  const body = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [{ type: 'text', text: 'second\n\n<memorix-context>\nx\n</memorix-context>' }] },
    ],
  };
  assert.equal(extractQueryFromRequest(body, 'chat'), 'second');
  assert.equal(extractQueryFromRequest({ input: 'only' }, 'responses'), 'only');
});

test('stripInjected removes only the memorix block', () => {
  assert.equal(stripInjected('keep <memorix-context a="b">\nstuff\n</memorix-context>\n'), 'keep');
});

test('path extraction keeps existing files and drops invented ones', () => {
  const cwd = workspace();
  const text = '见 src/app.ts 与 src/missing.ts，以及 README.md 和 node_modules/x/y.ts';
  const found = extractFilePaths(text, { cwd });
  assert.deepEqual(found.sort(), ['README.md', 'src/app.ts']);
  assert.equal(extractFilePaths(text, { cwd, verify: false }).length >= 2, true);
});

test('request file paths come from tool arguments', () => {
  const cwd = workspace();
  const request = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', input: { file_path: 'src/app.ts' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', input: { file_path: '/abs/elsewhere.ts' } }] },
    ],
  };
  assert.deepEqual(extractRequestFilePaths(request, { cwd }), ['src/app.ts']);
});

test('small text helpers', () => {
  assert.equal(collapseWhitespace('  a\n\tb  '), 'a b');
  assert.equal(truncate('abcdef', 3), 'ab…');
  assert.equal(truncate('ab', 3), 'ab');
});
