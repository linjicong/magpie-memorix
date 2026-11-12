/**
 * Aggregator: `node --test test/all.test.mjs` runs every suite in one process.
 *
 * Node 22 on Windows hangs when it fans many test files out into separate
 * child processes here, so the package script uses this single entry instead.
 */

import './config.test.mjs';
import './project.test.mjs';
import './redact.test.mjs';
import './turns.test.mjs';
import './inject.test.mjs';
import './text.test.mjs';
import './capture.test.mjs';
import './mcp.test.mjs';
import './details.test.mjs';
import './hooks.test.mjs';
