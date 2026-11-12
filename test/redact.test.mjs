import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textLooksSecret, hasSecret } from '../src/redact.js';

test('common credential shapes are detected', () => {
  assert.equal(textLooksSecret('please use ghp_aaaaaaaaaaaaaaaaaaaaaaaa for the API'), true);
  assert.equal(textLooksSecret('postgres://user:pw@db.internal/prod'), true);
  assert.equal(textLooksSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(textLooksSecret('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'), true);
});

test('assignment-shaped values are detected whatever the secret is', () => {
  assert.equal(textLooksSecret('api_key = "abc123"'), true);
  assert.equal(textLooksSecret('password: hunter2'), true);
});

test('ordinary prose is not flagged', () => {
  assert.equal(textLooksSecret('修复了登录超时问题，原因是 token 刷新逻辑写错了'), false);
  assert.equal(textLooksSecret('src/auth.ts 里的 ttl 是 3600'), false);
  assert.equal(textLooksSecret(''), false);
});

test('nested tool arguments are inspected', () => {
  assert.equal(hasSecret({ input: { password: 'hunter2' } }), true);
  assert.equal(hasSecret({ input: { file_path: 'src/app.ts' } }), false);
  assert.equal(hasSecret('{"apiKey":"abc123"}'), true);
});
