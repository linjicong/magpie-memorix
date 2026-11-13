import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot, projectRootFromText, resolveProjectRoot, cleanCwd } from '../src/project.js';

function repo(name = 'repo') {
  const dir = mkdtempSync(join(tmpdir(), `memorix-${name}-`));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

test('cwd resolves to the nearest git root', () => {
  const root = repo();
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  assert.equal(findProjectRoot(join(root, 'src', 'deep')), root);
  assert.equal(findProjectRoot(join(root, '..')), null);
});

test('a caller that names its directory in text is honoured', () => {
  const root = repo();
  const text = [
    'Current working directory: ' + root,
    'You are a coding agent.',
  ].join('\n');
  assert.equal(projectRootFromText(text), root);
});

test('claude-style and env-block forms are read', () => {
  const root = repo();
  assert.equal(projectRootFromText(` - Primary working directory: ${root}`), root);
  assert.equal(projectRootFromText(`<environment_context>\n  <cwd>${root}</cwd>\n</environment_context>`), root);
});

test('a path merely quoted in prose is not the project', () => {
  const root = repo();
  assert.equal(projectRootFromText(`see ${root} for details`), null);
});

test('an injected memorix block never decides the project', () => {
  const root = repo();
  const text = `<memorix-context project="x">\n[文件] ${root}/src/app.ts\n</memorix-context>\nfiller`;
  assert.equal(projectRootFromText(text), null);
});

test('a cwd that arrives with quotes and a period still resolves', () => {
  const root = repo('quoted');
  // magpie 0.1.4026 parses `Current working directory: "D:\repo".` verbatim.
  assert.equal(cleanCwd(`"${root}".`), root);
  assert.equal(cleanCwd(`“${root}”，`), root);
  assert.equal(findProjectRoot(`"${root}".`), root);
  assert.equal(resolveProjectRoot({ projectRoot: '' }, `"${root}".`, ''), root);
});

test('a non-git cwd falls through to the request text', () => {
  const root = repo('textwin');
  const plain = mkdtempSync(join(tmpdir(), 'memorix-plain-'));
  assert.equal(resolveProjectRoot({ projectRoot: '' }, plain, `cwd: ${root}`), root);
});

test('resolveProjectRoot prefers config, then cwd, then text', () => {
  const a = repo('a');
  const b = repo('b');
  assert.equal(resolveProjectRoot({ projectRoot: a }, '', ''), a);
  assert.equal(resolveProjectRoot({ projectRoot: '' }, a, ''), a);
  assert.equal(resolveProjectRoot({ projectRoot: '' }, '', `cwd: ${b}`), b);
  assert.equal(resolveProjectRoot({ projectRoot: '' }, '', 'nothing here'), null);
});

test('a configured root without .git is still usable', () => {
  const plain = mkdtempSync(join(tmpdir(), 'memorix-plain-'));
  writeFileSync(join(plain, 'readme.md'), '# x\n');
  assert.equal(resolveProjectRoot({ projectRoot: plain }, '', ''), plain);
});
