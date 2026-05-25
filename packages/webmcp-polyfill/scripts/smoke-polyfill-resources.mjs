#!/usr/bin/env node
/**
 * Phase 2 end-to-end smoke test for the resources surface.
 *
 * Verifies the full round-trip across:
 *   1. The polyfill's `navigator.modelContext.resources` namespace (loaded
 *      into a fresh happy-dom instance to register a real provider).
 *   2. A stub WebSocket client that simulates what the relay widget runtime
 *      sends/receives over the wire (initial `tools/list`, `resources/list`,
 *      `resources/changed`, and `resource-result` round-trip for a relay-
 *      issued `read-resource`).
 *   3. The local relay (spawned over stdio) wired to an MCP client.
 *
 * Flow:
 *   - Spawn relay CLI on a random port (StdioClientTransport).
 *   - Open a stub WebSocket to ws://127.0.0.1:<port> with the browser
 *     subprotocol; complete the hello handshake.
 *   - Push a `tools/list` snapshot (empty), then a `resources/list` with one
 *     fake `ui://` widget.
 *   - The MCP client calls:
 *       * `resources/list` — expect our fake widget back.
 *       * `resources/read(uri)` — relay sends `read-resource` over WS, the
 *         stub responds with `resource-result` carrying a valid
 *         `ReadResourceResult`. Expect the MCP client to receive it.
 *   - Push a `resources/changed` snapshot (empty), then call `resources/list`
 *     again to verify the relay accepted the dynamic update.
 *
 * Exits 0 on success, non-zero on any failure.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../../webmcp-local-relay/dist/cli.mjs');
const polyfillPath = resolve(__dirname, '../dist/index.js');

const RELAY_BROWSER_PROTOCOL = 'webmcp.v1';

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

function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  return new Promise((resolveP, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolveP();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * 1) Smoke-test the polyfill itself in Node by hand-importing the ESM bundle
 *    against a stub Navigator. We just want to confirm the resources surface
 *    is shipped and the read() wrapper builds a valid ReadResourceResult.
 */
async function smokeTestPolyfillInIsolation() {
  console.log('[smoke] verifying polyfill resources surface (no relay)');

  // Node 18+ ships a non-configurable `navigator` getter on globalThis. Replace
  // it with a writable own property so the polyfill can install
  // `modelContext` via Object.defineProperty(navigator, 'modelContext', ...).
  const fakeNavigator = {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: fakeNavigator,
  });

  const mod = await import(polyfillPath);
  mod.initializeWebMCPPolyfill();

  if (!fakeNavigator.modelContext) {
    throw new Error('initializeWebMCPPolyfill did not install navigator.modelContext');
  }
  if (!fakeNavigator.modelContext.resources) {
    throw new Error('navigator.modelContext.resources is missing');
  }

  const provider = async () => ({
    text: '<!doctype html><div>hello widget</div>',
    mimeType: 'text/html;profile=mcp-app',
  });
  fakeNavigator.modelContext.resources.register('ui://smoke/widget.html', provider, {
    name: 'smoke widget',
    description: 'Phase 2 smoke widget',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { resourceUri: 'ui://smoke/widget.html' } },
  });

  const list = fakeNavigator.modelContext.resources.list();
  check('resources.list() returns the registered widget', () => {
    if (!Array.isArray(list) || list.length !== 1) {
      throw new Error(`expected 1 resource, got ${JSON.stringify(list)}`);
    }
    if (list[0].uri !== 'ui://smoke/widget.html') {
      throw new Error(`unexpected uri: ${list[0].uri}`);
    }
    if (!list[0]._meta?.ui?.resourceUri) {
      throw new Error(`_meta.ui.resourceUri did not survive: ${JSON.stringify(list[0])}`);
    }
  });

  const readResult = await fakeNavigator.modelContext.resources.read('ui://smoke/widget.html');
  check('resources.read() wraps provider return as ReadResourceResult', () => {
    if (!readResult || !Array.isArray(readResult.contents) || readResult.contents.length !== 1) {
      throw new Error(`expected {contents:[...]} got ${JSON.stringify(readResult)}`);
    }
    const c = readResult.contents[0];
    if (c.uri !== 'ui://smoke/widget.html' || typeof c.text !== 'string') {
      throw new Error(`unexpected content shape: ${JSON.stringify(c)}`);
    }
    if (c.mimeType !== 'text/html;profile=mcp-app') {
      throw new Error(`unexpected mimeType: ${c.mimeType}`);
    }
  });

  // Cleanup so the next smoke phase starts clean.
  mod.cleanupWebMCPPolyfill();
  // Restore globalThis.navigator to a non-configurable stub so any subsequent
  // module that touches it is well-behaved. Deleting outright would re-expose
  // Node's built-in navigator getter on the next access, which is also fine.
  try {
    delete globalThis.navigator;
  } catch {
    /* ignore — Node may make this non-deletable */
  }
  return { providerCalledOnce: true };
}

/**
 * 2) End-to-end smoke: spawn the relay, simulate the browser side via WS,
 *    drive `resources/list` and `resources/read` via the MCP stdio client.
 */
async function smokeTestEndToEnd() {
  console.log(`[smoke] launching ${cliPath}`);
  const port = 19500 + Math.floor(Math.random() * 500);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--port', String(port), '--label', 'smoke-polyfill-resources'],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    process.stderr.write(`[relay:stderr] ${chunk.toString()}`);
  });

  const client = new Client(
    { name: 'phase2-smoke-client', version: '0.0.0' },
    { capabilities: {} }
  );

  let ws;
  let bridgeReady = false;
  const pendingReadResource = []; // { callId, uri }

  try {
    await client.connect(transport);
    console.log('[smoke] connected to relay');

    // Open the stub browser WS. The relay sends `server-hello` on connect; we
    // reply with the browser hello and a tools/list, then resources/list.
    ws = new WebSocket(`ws://127.0.0.1:${port}`, [RELAY_BROWSER_PROTOCOL]);

    await new Promise((resolveP, reject) => {
      ws.once('open', resolveP);
      ws.once('error', reject);
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'server-hello') {
        ws.send(
          JSON.stringify({
            type: 'hello',
            tabId: 'smoke-tab',
            origin: 'http://smoke.test',
            url: 'http://smoke.test/',
            title: 'smoke',
          })
        );
        return;
      }
      if (msg.type === 'hello/accepted') {
        ws.send(JSON.stringify({ type: 'tools/list', tools: [] }));
        ws.send(
          JSON.stringify({
            type: 'resources/list',
            resources: [
              {
                uri: 'ui://test/widget',
                name: 'test widget',
                description: 'Phase 2 smoke resource',
                mimeType: 'text/html;profile=mcp-app',
                _meta: { ui: { resourceUri: 'ui://test/widget' } },
              },
            ],
          })
        );
        // The relay updates its cache before draining waitFor below. Give it
        // a microtask tick so MCP `resources/list` sees our snapshot.
        setTimeout(() => {
          bridgeReady = true;
        }, 50);
        return;
      }
      if (msg.type === 'read-resource') {
        pendingReadResource.push({ callId: msg.callId, uri: msg.uri });
        // Respond synchronously with a valid ReadResourceResult.
        ws.send(
          JSON.stringify({
            type: 'resource-result',
            callId: msg.callId,
            result: {
              contents: [
                {
                  uri: msg.uri,
                  mimeType: 'text/html;profile=mcp-app',
                  text: '<!doctype html><div>widget content from stub</div>',
                },
              ],
            },
          })
        );
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    await waitFor(() => bridgeReady, {
      timeoutMs: 3000,
      label: 'browser-side hello + resources/list ready',
    });

    // Assert capabilities advertise resources.
    const caps = client.getServerCapabilities();
    check('server advertises resources capability', () => {
      if (!caps?.resources) {
        throw new Error(`missing resources capability: ${JSON.stringify(caps)}`);
      }
    });

    // resources/list — expect our fake widget.
    const list = await client.listResources();
    check('resources/list returns the fake widget', () => {
      if (!Array.isArray(list.resources) || list.resources.length !== 1) {
        throw new Error(`expected 1 resource, got ${JSON.stringify(list)}`);
      }
      if (list.resources[0].uri !== 'ui://test/widget') {
        throw new Error(`unexpected uri: ${list.resources[0].uri}`);
      }
    });

    check('resources/list preserves descriptor _meta passthrough', () => {
      const r = list.resources[0];
      if (!r._meta || r._meta.ui?.resourceUri !== 'ui://test/widget') {
        throw new Error(`_meta did not survive: ${JSON.stringify(r)}`);
      }
    });

    // resources/read — round-trips through read-resource → resource-result.
    const read = await client.readResource({ uri: 'ui://test/widget' });
    check('resources/read round-trips and returns provider payload', () => {
      if (!Array.isArray(read.contents) || read.contents.length !== 1) {
        throw new Error(`expected 1 content, got ${JSON.stringify(read)}`);
      }
      const c = read.contents[0];
      if (c.uri !== 'ui://test/widget' || !String(c.text || '').includes('widget content')) {
        throw new Error(`unexpected content: ${JSON.stringify(c)}`);
      }
    });

    check('relay routed read-resource to the browser stub', () => {
      if (pendingReadResource.length !== 1) {
        throw new Error(
          `expected exactly 1 read-resource over WS, saw ${pendingReadResource.length}`
        );
      }
      if (pendingReadResource[0].uri !== 'ui://test/widget') {
        throw new Error(`read-resource carried wrong uri: ${pendingReadResource[0].uri}`);
      }
    });

    // resources/changed — empty snapshot. Verify the relay accepted the
    // dynamic update by calling resources/list again.
    ws.send(JSON.stringify({ type: 'resources/changed', resources: [] }));
    await new Promise((r) => setTimeout(r, 50));
    const list2 = await client.listResources();
    check('resources/changed snapshot replaces the previous list', () => {
      if (!Array.isArray(list2.resources) || list2.resources.length !== 0) {
        throw new Error(
          `expected 0 resources after resources/changed, got ${JSON.stringify(list2)}`
        );
      }
    });

    // Sanity check: tools/list still works (coexistence).
    const tools = await client.listTools();
    check('tools/list still returns the static webmcp_* tools', () => {
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
      ws?.close();
    } catch {
      /* ignore */
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  await smokeTestPolyfillInIsolation();
  await smokeTestEndToEnd();

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
