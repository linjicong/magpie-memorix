#!/usr/bin/env node
/**
 * End-to-end self test for magpie-memorix.
 *
 *   node bin/selftest.mjs [--endpoint http://127.0.0.1:3211] [--project <dir>] [--store]
 *
 * Checks, in order: Node version, memorix reachability, the three tools this
 * plugin depends on, one real recall, and (with --store) one written
 * observation. Prints exactly what failed and what to do about it.
 */

import { findProjectRoot } from '../src/project.js';
import { MemorixClient } from '../src/mcp.js';

const args = process.argv.slice(2);

function valueOf(flag, fallback) {
  const at = args.indexOf(flag);
  if (at < 0) return fallback;
  const value = args[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node bin/selftest.mjs [--endpoint URL] [--project DIR] [--store]');
  process.exit(0);
}

const endpoint = valueOf('--endpoint', process.env.MEMORIX_ENDPOINT || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const shouldStore = args.includes('--store');
const projectDir = valueOf('--project', process.cwd());

const line = (ok, text, detail = '') => console.log(`${ok ? '✓' : '✗'} ${text}${detail ? `  ${detail}` : ''}`);

function fail(hint) {
  console.error(`\n${hint}`);
  process.exit(1);
}

console.log(`magpie-memorix self test — endpoint ${endpoint}\n`);

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const nodeMinor = Number.parseInt(process.versions.node.split('.')[1], 10);
const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);
line(nodeOk, `node ${process.versions.node}`, nodeOk ? '' : 'memorix needs >= 22.18.0');
if (!nodeOk) fail('Install Node.js 22.18.0 or newer, then run this again with that node.');

const root = findProjectRoot(projectDir);
line(Boolean(root), 'git project root', root || `${projectDir} is not inside a git repository`);
if (!root) {
  fail(
    'memorix keys its store by git project. Run this inside a repository, or pass --project <repo>.\n' +
      'A directory without .git can never be bound, and the hook will report "unbound" and skip.',
  );
}

const client = new MemorixClient(endpoint);
client.defaultTimeoutMs = 15000;

const tools = await client.listTools({ projectRoot: root, timeoutMs: 15000 });
if (!tools.ok) {
  line(false, 'memorix reachable', tools.message);
  fail(
    `Start the service first:  memorix serve-http --port ${new URL(endpoint).port}\n` +
      'If it is already running, check the port and that no firewall blocks localhost.',
  );
}
line(true, 'memorix reachable', `${tools.names.length} tools`);

const required = ['memorix_project_context', 'memorix_store', 'memorix_search'];
const missing = required.filter((name) => !tools.names.includes(name));
line(missing.length === 0, 'required tools', missing.length ? `missing ${missing.join(', ')}` : required.join(', '));
if (missing.length) fail('This memorix build does not expose the tools the plugin needs (1.10.x does).');

const recall = await client.callTool('memorix_project_context', { task: 'selftest: describe this project', format: 'prompt', refresh: 'auto' }, { projectRoot: root, timeoutMs: 20000 });
line(recall.ok, 'recall project context', recall.ok ? `${recall.text.length} chars` : recall.message);
if (!recall.ok) fail('Recall failed. Run `memorix status` in the project to see why the project cannot be read.');
console.log('\n--- first lines of the brief ---');
console.log(recall.text.split('\n').slice(0, 8).join('\n'));
console.log('--- end ---\n');

if (shouldStore) {
  const observation = {
    entityName: (root.split(/[\\/]/).pop() || 'project').toLowerCase(),
    type: 'how-it-works',
    title: 'magpie-memorix self test',
    narrative: '[请求] 运行 magpie-memorix 自检\n[结果] 网关 hook 能连上 memorix 并写入一条 observation。',
    facts: ['magpie-memorix 自检通过'],
    concepts: ['memorix', 'magpie', 'selftest'],
    topicKey: 'magpie:selftest',
  };
  const stored = await client.callTool('memorix_store', observation, { projectRoot: root, timeoutMs: 15000 });
  line(stored.ok, 'write an observation', stored.ok ? 'stored' : stored.message);
  if (!stored.ok) fail('Write failed. The recall path works, so check the store permissions / read-only mode.');
}

console.log(`\nDashboard: ${endpoint}`);
console.log('All checks passed. Install it with:  magpie plugin add <path-to-this-folder>');
