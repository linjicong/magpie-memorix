/**
 * Optional memory-body enrichment.
 *
 * `memorix_project_context` returns a prompt brief that lists memory titles and
 * ids only. An agent behind the gateway has no MCP tools of its own, so the
 * bodies stay unreadable. When `memoryDetails` is set, the plugin expands the
 * ids the brief itself named — no second search, and the bodies always belong
 * to the titles the model was shown.
 *
 * Off by default: it is one extra round trip on every new turn.
 */

import { collapseWhitespace, stripInjected, truncate } from './text.js';
import { getClient } from './mcp.js';

const PURPOSE =
  'magpie gateway request enrichment: the Autopilot brief lists these memory titles, ' +
  'but the calling agent has no MCP tools to expand them, so their bodies are supplied here.';

/** Observation ids the brief named, as `#2`, `#5`. */
export function parseBriefIds(brief, limit = 3) {
  const ids = [];
  for (const match of String(brief ?? '').matchAll(/(?:^|[\s(])#(\d{1,6})\b/g)) {
    const id = Number(match[1]);
    if (!Number.isInteger(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** Observation ids out of a search result, `obs:2` / `obs:2@local/proj`. */
export function parseSearchIds(text, limit = 3) {
  const ids = [];
  for (const match of String(text ?? '').matchAll(/obs:(\d{1,6})/g)) {
    const id = Number(match[1]);
    if (!Number.isInteger(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/**
 * Turn memorix's verbose detail text into one line per entry:
 *   #2 how-it-works: <narrative, condensed>
 */
export function condenseDetails(text, maxChars) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let heading = '';
  let body = null;

  const flush = () => {
    if (body === null) return;
    const cleaned = collapseWhitespace(stripInjected(body));
    if (cleaned) entries.push(`${heading || 'memory'}: ${truncate(cleaned, 220)}`);
    body = null;
    heading = '';
  };

  for (const raw of lines) {
    const line = raw.trim();
    const head = /^#(\d{1,6})\s*(?:\[[^\]]+\])?\s*(.*)$/.exec(line);
    if (head) {
      flush();
      heading = `#${head[1]}${head[2] ? ` ${truncate(head[2], 60)}` : ''}`;
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (/^Narrative:/i.test(line)) {
      body = line.replace(/^Narrative:\s*/i, '');
      continue;
    }
    if (body !== null) body += ` ${line}`;
  }
  flush();

  if (!entries.length) return truncate(stripInjected(text).replace(/\n{3,}/g, '\n\n').trim(), maxChars);
  return truncate(entries.join('\n'), maxChars);
}

/**
 * @returns {{ok:true,text:string,ids:number[]}|{ok:false,code:string,message?:string}}
 */
export async function fetchMemoryDetails({ projectRoot, brief, query, cfg, signal, client }) {
  const limit = cfg.memoryDetails;
  if (!limit) return { ok: true, text: '', ids: [] };

  const tools = client || getClient(cfg.endpoint, cfg.timeoutMs);
  const budget = Math.min(cfg.timeoutMs, 3000);

  const ids = parseBriefIds(brief, limit);
  // The brief only carries the newest reliable entries; an older fact the user
  // asks about is still in the store, so one bounded search joins them.
  if (cfg.memoryDetailsSearch && ids.length < limit) {
    const search = await tools.callTool(
      'memorix_search',
      // After a project_context brief, memorix requires a stated reason to look
      // further; the gateway states it here because the agent cannot.
      { query: String(query ?? '').slice(0, 200), limit, purpose: PURPOSE, force: true },
      { projectRoot, signal, timeoutMs: budget },
    );
    if (search.ok) {
      for (const id of parseSearchIds(search.text, limit)) {
        if (!ids.includes(id)) ids.push(id);
        if (ids.length >= limit) break;
      }
    }
  }
  if (!ids.length) return { ok: true, text: '', ids: [] };

  const detail = await tools.callTool(
    'memorix_detail',
    // `force` is what memorix requires to expand records its own brief already
    // named; the gateway is the agent's only way to read them, so it is asked
    // on the agent's behalf, with the reason stated.
    { ids, purpose: PURPOSE, force: true },
    { projectRoot, signal, timeoutMs: budget },
  );
  if (!detail.ok) return { ok: false, code: detail.code, message: detail.message };

  return { ok: true, text: condenseDetails(detail.text, cfg.memoryDetailChars), ids };
}
