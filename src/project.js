/**
 * Project root resolution.
 *
 * memorix keys its store by the git project root. A hook sees `ctx.cwd`, and
 * magpie derives it from the caller's own text ("CWD:", "Primary working
 * directory:", Codex's <environment_context>, OpenCode's <env>). An agent that
 * names no directory — DSH, a plain SDK client — leaves it empty, so the same
 * text is scanned here as a fallback. No git binary, no subprocess, no shell.
 */

import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_DEPTH = 40;

function isGitMarker(path) {
  try {
    const st = statSync(path);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function findProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  let dir;
  try {
    dir = resolve(cwd.trim());
  } catch {
    return null;
  }
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (isGitMarker(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// A directory named by the caller, on a line of its own or after a keyword.
// Windows paths may hold spaces; the capture stops at a quote or newline.
const KEYWORD_PATH =
  /(?:working\s*dir(?:ectory)?|working_directory|primary\s+working\s+directory|cwd|workspace(?:\s*(?:root|folder|directory))?|project\s*root|repo(?:sitory)?(?:\s*root)?)\s*[:=：]\s*["']?([A-Za-z]:[\\/][^"'\r\n]*|\/[^"'\r\n]*)/gi;

const ENV_BLOCK = /<(?:environment_context|env|environment)\b[^>]*>([\s\S]*?)<\/(?:environment_context|env|environment)>/gi;

const ANY_ABSOLUTE = /(?:^|[\s"'`(<>])([A-Za-z]:[\\/][^"'\r\n]*|\/[^"'\r\n]*)/gm;

const CLUTTER = [/<(?:memorix-context|powercontext-reference)\b/i];

function cleanCandidate(raw) {
  let value = String(raw ?? '').trim();
  value = value.replace(/<[^>]*>[^<]*$/g, '').trim();
  value = value.replace(/[),;。，；]+$/g, '').trim();
  if (!value || value.length > 260) return '';
  return value;
}

function rootForCandidate(candidate) {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned) return null;
  if (isDirectory(cleaned)) {
    const root = findProjectRoot(cleaned);
    if (root) return root;
  }
  return null;
}

/**
 * The git root a request's own text names, or null.
 *
 * Keyword lines win; inside an environment block, any absolute path is tried
 * (agents put their cwd there). A quoted path in prose is never enough on its
 * own — it usually names someone else's checkout.
 */
export function projectRootFromText(text) {
  const body = String(text ?? '');
  if (!body) return null;
  if (CLUTTER.some((pattern) => pattern.test(body))) {
    // Our own injected block can hold paths; it never decides the project.
    body.replace(/<memorix-context[\s\S]*?<\/memorix-context>/gi, ' ');
  }

  for (const match of body.matchAll(KEYWORD_PATH)) {
    const root = rootForCandidate(match[1]);
    if (root) return root;
  }

  for (const block of body.matchAll(ENV_BLOCK)) {
    for (const match of block[1].matchAll(ANY_ABSOLUTE)) {
      const root = rootForCandidate(match[1]);
      if (root) return root;
    }
  }
  return null;
}

/**
 * `cfg.projectRoot` wins when set, then the caller's cwd, then the directory
 * the request itself names. Returns null when none resolves, which the hook
 * reports as "unbound".
 */
export function resolveProjectRoot(cfg, cwd, text = '') {
  if (cfg && typeof cfg.projectRoot === 'string' && cfg.projectRoot) {
    try {
      const configured = resolve(cfg.projectRoot);
      const root = findProjectRoot(configured) ?? (isDirectory(configured) ? configured : null);
      if (root) return root;
    } catch {
      /* fall through */
    }
  }
  const fromCwd = findProjectRoot(cwd);
  if (fromCwd) return fromCwd;
  return projectRootFromText(text);
}
