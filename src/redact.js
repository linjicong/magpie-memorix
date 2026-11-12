/**
 * Secret screening before a turn is written to project memory.
 *
 * Masking part of a prompt can still leave the rest on the memory server, so a
 * turn that looks like it carries a credential is dropped rather than stored.
 */

const SECRET = new RegExp(
  [
    // key = value / "token": "..." assignments
    String.raw`(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|token|authorization|[A-Za-z0-9]*(?:password|passwd|pwd)|secret|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*\S+`,
    // credentials inside a URL
    String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@`,
    // vendor key shapes
    String.raw`\b(?:sk|rk)_live_[A-Za-z0-9]{8,}`,
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`,
    String.raw`-----BEGIN [^-]*PRIVATE KEY-----`,
  ].join('|'),
  'iu',
);

export function textLooksSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  if (!SECRET.test(text)) return false;
  SECRET.lastIndex = 0;
  return true;
}

/**
 * Deep check for structured values: tool arguments embed credentials inside
 * JSON strings, and field names such as `password` matter as much as values.
 */
export function hasSecret(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    if (textLooksSecret(value)) return true;
    const trimmed = value.trim();
    if (/^[{[]/.test(trimmed)) {
      try {
        return hasSecret(JSON.parse(trimmed), depth + 1);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasSecret(item, depth + 1));
  return Object.entries(value).some(([key, item]) => (
    SECRET.test(`${key}: ${typeof item === 'string' ? item : '[value]'}`) || hasSecret(item, depth + 1)
  ));
}
