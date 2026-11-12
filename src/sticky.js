/**
 * Per-conversation replay cache.
 *
 * A gateway cannot rely on the client to carry context it never saw: the
 * request magpie forwards on turn N+1 contains only the client's own history.
 * Re-injecting the block each earlier turn was given keeps the prompt prefix
 * byte-identical from one request to the next, so the provider's prompt cache
 * keeps hitting, and makes a tool loop (the same turn sent again) a no-op.
 */

import { createHash } from 'node:crypto';

const MAX_SESSIONS = 256;
const MAX_TURNS = 128;
const MAX_BYTES = 8 << 20;
const IDLE_MS = 6 * 60 * 60 * 1000;

const sessions = new Map();

function sha(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function sessionIdentity({ endpoint = '', origin = '', protocol = '', sessionId = '', cwd = '' } = {}) {
  return sha([endpoint, origin, protocol, sessionId, cwd].join('\u0000'));
}

function open(id, now) {
  let session = sessions.get(id);
  if (session) {
    session.at = now;
    sessions.delete(id);
    sessions.set(id, session);
    return session;
  }
  session = { turns: new Map(), bytes: 0, at: now };
  sessions.set(id, session);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return session;
}

/** The block this conversation already gave that turn, if any. */
export function lookup(id, key, now = Date.now()) {
  const session = open(id, now);
  const entry = session.turns.get(key);
  if (!entry) return null;
  session.turns.delete(key);
  session.turns.set(key, entry);
  return entry;
}

/** Remember the block a turn received, trimming the cache to its budget. */
export function remember(id, key, text, bytes, now = Date.now()) {
  const session = open(id, now);
  const existing = session.turns.get(key);
  if (existing) {
    session.bytes -= existing.bytes;
    session.turns.delete(key);
  }
  session.turns.set(key, { text, bytes, at: now });
  session.bytes += bytes;
  while (session.turns.size > MAX_TURNS || session.bytes > MAX_BYTES) {
    const oldest = session.turns.keys().next().value;
    if (oldest === undefined) break;
    const dropped = session.turns.get(oldest);
    session.turns.delete(oldest);
    session.bytes -= dropped?.bytes ?? 0;
  }
  return session;
}

/** Drop conversations that have not been touched for a while. */
export function sweep(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.at > IDLE_MS) sessions.delete(id);
  }
}

export function resetSticky() {
  sessions.clear();
}

export function stickyStats() {
  return {
    sessions: sessions.size,
    turns: [...sessions.values()].reduce((total, session) => total + session.turns.size, 0),
    bytes: [...sessions.values()].reduce((total, session) => total + session.bytes, 0),
  };
}
