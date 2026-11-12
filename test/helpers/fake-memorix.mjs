/**
 * A tiny stand-in for `memorix serve-http` used by the test suite.
 *
 * It answers JSON-RPC on POST /mcp, learns the stateless protocol version the
 * way memorix does, issues a project handle for the first request and records
 * every message so tests can assert on headers and call counts.
 */

import { createServer } from 'node:http';

export function startFakeMemorix({ handle = 'handle-1', sse = false, expireOnce = false, fail = false, toolTexts = {} } = {}) {
  const requests = [];
  let expireArmed = expireOnce;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let message = null;
      try {
        message = JSON.parse(raw);
      } catch {
        message = null;
      }
      const record = {
        headers: { ...req.headers },
        body: message,
        method: message?.method,
        tool: message?.params?.name,
      };
      requests.push(record);

      if (fail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"down"}');
        return;
      }

      if (expireArmed && record.headers['mcp-project-handle']) {
        expireArmed = false;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? 1, error: { code: -32001, message: 'handle expired' } }));
        return;
      }

      const payload = {
        jsonrpc: '2.0',
        id: message?.id ?? 1,
        result: {
          content: [{
            type: 'text',
            text: toolTexts[record.tool] ?? (record.tool === 'memorix_store'
              ? '{"ok":true}'
              : `关于本项目的记忆（${record.tool}）：本项目使用 ESM 与 node --test；改动前先读 docs/plans 下的设计文档，避免重复实现已有能力。`),
          }],
        },
      };

      if (sse) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'mcp-project-handle': handle,
          'cache-control': 'no-cache',
        });
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-project-handle': handle });
      res.end(JSON.stringify(payload));
    });
  });

  server.keepAliveTimeout = 1;

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(done);
        }),
      });
    });
  });
}
