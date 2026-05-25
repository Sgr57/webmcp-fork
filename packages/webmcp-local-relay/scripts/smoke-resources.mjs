#!/usr/bin/env node
/**
 * Smoke test for resources/* forwarding.
 *
 * Spawns the relay CLI over stdio, performs MCP initialization, and asserts:
 *   1. server capabilities declare `resources` (with listChanged: true)
 *   2. resources/list returns an empty list when no browser is connected
 *   3. resources/read returns an InvalidParams error when no browser owns the URI
 *      (relay should NOT crash on this path)
 *   4. tools/list still returns the static webmcp_* tools (sanity check that
 *      the resources patch did not break existing functionality)
 *
 * Exit code 0 on success, non-zero on any failure.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../dist/cli.mjs');

const assertions = [];
function check(name, fn) {
  try {
    fn();
    assertions.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    assertions.push({ name, ok: false, error: err.message });
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

async function main() {
  console.log(`[smoke] launching ${cliPath}`);

  // Use a high randomised port to avoid clashing with any running relay
  // on the developer machine. The relay falls back through a small range
  // automatically if this exact port is occupied.
  const port = 19000 + Math.floor(Math.random() * 1000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--port', String(port), '--label', 'smoke-test'],
    stderr: 'pipe',
  });
  // Drain stderr so the relay's diagnostic output does not block the pipe.
  transport.stderr?.on('data', (chunk) => {
    process.stderr.write(`[relay:stderr] ${chunk.toString()}`);
  });

  const client = new Client(
    { name: 'smoke-test-client', version: '0.0.0' },
    { capabilities: {} }
  );

  let initResult;
  try {
    await client.connect(transport);
    initResult = client.getServerCapabilities();
    console.log('[smoke] connected, server capabilities:', JSON.stringify(initResult));

    check('server declares resources capability', () => {
      if (!initResult || !initResult.resources) {
        throw new Error(`missing resources capability; got ${JSON.stringify(initResult)}`);
      }
    });

    const list = await client.listResources();
    console.log('[smoke] resources/list response:', JSON.stringify(list));
    check('resources/list returns empty resources array', () => {
      if (!Array.isArray(list.resources)) {
        throw new Error(`expected resources array; got ${JSON.stringify(list)}`);
      }
      if (list.resources.length !== 0) {
        throw new Error(`expected 0 resources with no browser connected; got ${list.resources.length}`);
      }
    });

    let readError;
    try {
      await client.readResource({ uri: 'ui://nonexistent/widget.html' });
    } catch (err) {
      readError = err;
    }
    check('resources/read errors cleanly when uri is unknown', () => {
      if (!readError) {
        throw new Error('expected error from readResource; got success');
      }
      // The relay reports this as a tool/handler error which the SDK wraps.
      if (!/No browser source advertises resource/i.test(String(readError.message ?? readError))) {
        throw new Error(`unexpected error message: ${readError.message ?? readError}`);
      }
    });

    const tools = await client.listTools();
    console.log('[smoke] tools/list returned', tools.tools.length, 'tools');
    check('tools/list still returns static webmcp_* tools', () => {
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of [
        'webmcp_list_sources',
        'webmcp_list_tools',
        'webmcp_call_tool',
        'webmcp_open_page',
      ]) {
        if (!names.has(expected)) {
          throw new Error(`missing static tool ${expected}; got ${[...names].join(', ')}`);
        }
      }
    });
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }

  const failures = assertions.filter((a) => !a.ok);
  console.log(`\n[smoke] ${assertions.length - failures.length}/${assertions.length} checks passed`);
  if (failures.length > 0) {
    console.log('[smoke] failures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] fatal error:', err);
  process.exit(1);
});
