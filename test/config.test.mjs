import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeOptions, contextCharBudget } from '../src/config.js';

test('defaults survive an empty options object', () => {
  const cfg = normalizeOptions({});
  assert.equal(cfg.endpoint, DEFAULTS.endpoint);
  assert.equal(cfg.position, 'tail-user');
  assert.equal(cfg.replayTurns, true);
  assert.equal(cfg.allowRemote, false);
});

test('bad values fall back instead of breaking the hook', () => {
  const cfg = normalizeOptions({
    endpoint: 'ftp://example.com',
    gatewayTimeoutMs: 'soon',
    timeoutMs: -5,
    position: 'middle',
    contextTokens: 999999,
  });
  assert.equal(cfg.endpoint, DEFAULTS.endpoint);
  assert.equal(cfg.gatewayTimeoutMs, DEFAULTS.gatewayTimeoutMs);
  assert.equal(cfg.position, 'tail-user');
  assert.equal(cfg.contextTokens, 4000);
});

test('client timeout stays below the gateway budget', () => {
  const cfg = normalizeOptions({ gatewayTimeoutMs: 4000, timeoutMs: 9000 });
  assert.equal(cfg.gatewayTimeoutMs, 4000);
  assert.equal(cfg.timeoutMs, 4000);
  assert.ok(cfg.timeoutMs <= cfg.gatewayTimeoutMs);
});

test('bools accept strings and endpoint strips trailing slash', () => {
  const cfg = normalizeOptions({ capture: 'off', inject: 'YES', endpoint: 'http://127.0.0.1:3211//' });
  assert.equal(cfg.capture, false);
  assert.equal(cfg.inject, true);
  assert.equal(cfg.endpoint, 'http://127.0.0.1:3211');
});

test('char budget tracks tokens with a floor', () => {
  assert.equal(contextCharBudget({ contextTokens: 100 }), 300);
  assert.equal(contextCharBudget({ contextTokens: 900 }), 2700);
});
