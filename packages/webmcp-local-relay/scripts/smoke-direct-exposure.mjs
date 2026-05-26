#!/usr/bin/env node
/**
 * Smoke test for `--expose-tools` flag (Phase 4.5).
 *
 * Spawns the relay CLI with `--expose-tools=direct`, connects a stub browser
 * source that advertises a tool with `_meta.ui.resourceUri` and a matching
 * `ui://` resource, and asserts via the MCP client that:
 *
 *   1. `tools/list` returns the browser tool as a top-level tool (NOT a
 *      `webmcp_*` wrapper).
 *   2. The returned tool carries `_meta.ui.resourceUri` intact — critical for
 *      MCP Apps widget hosts (Claude Desktop Cowork) to mount the iframe.
 *   3. `resources/list` returns the `ui://` resource the browser advertised.
 *   4. `notifications/tools/list_changed` and
 *      `notifications/resources/list_changed` were both received after the
 *      browser connected.
 *
 * Exit code 0 on success, non-zero on any failure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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

const port = 19000 + Math.floor(Math.random() * 1000);

async function main() {
  console.log(`[smoke] launching ${cliPath} with --expose-tools=direct on port ${port}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cliPath,
      '--port',
      String(port),
      '--label',
      'smoke-direct',
      '--expose-tools',
      'direct',
    ],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    process.stderr.write(`[relay] ${chunk.toString()}`);
  });

  const client = new Client(
    { name: 'smoke-direct-client', version: '0.0.0' },
    { capabilities: {} }
  );

  const notifications = { tools: 0, resources: 0 };
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/tools/list_changed') {
      notifications.tools += 1;
    } else if (notification.method === 'notifications/resources/list_changed') {
      notifications.resources += 1;
    }
  };

  try {
    await client.connect(transport);

    // 1. Pre-source list — should be empty (no static wrappers in direct mode).
    const preList = await client.listTools();
    check('direct mode pre-source: 0 tools (no wrappers, no sources yet)', () => {
      if (preList.tools.length !== 0) {
        throw new Error(`expected 0 tools, got ${preList.tools.length}: ${preList.tools.map(t => t.name).join(', ')}`);
      }
    });

    // 2. Connect stub browser source.
    await sleep(150);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'invoke') {
        ws.send(JSON.stringify({
          type: 'result',
          callId: msg.callId,
          result: { content: [{ type: 'text', text: 'invoked' }] },
        }));
      } else if (msg.type === 'read-resource') {
        ws.send(JSON.stringify({
          type: 'resource-result',
          callId: msg.callId,
          result: {
            contents: [{
              uri: msg.uri,
              mimeType: 'text/html;profile=mcp-app',
              text: '<html>widget</html>',
            }],
          },
        }));
      }
    });

    ws.send(JSON.stringify({
      type: 'hello',
      tabId: 'bellaroma',
      origin: 'https://bellaroma.example.com',
      url: 'https://bellaroma.example.com/',
    }));
    ws.send(JSON.stringify({
      type: 'tools/list',
      tools: [
        {
          name: 'get_product',
          description: 'Get product details',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          _meta: { ui: { resourceUri: 'ui://bellaroma/product-card.html' } },
        },
      ],
    }));
    ws.send(JSON.stringify({
      type: 'resources/list',
      resources: [
        {
          uri: 'ui://bellaroma/product-card.html',
          name: 'product card widget',
          mimeType: 'text/html;profile=mcp-app',
        },
      ],
    }));

    // 3. Wait until both notifications have been received.
    const deadline = Date.now() + 3000;
    while ((notifications.tools === 0 || notifications.resources === 0) && Date.now() < deadline) {
      await sleep(40);
    }

    check('received notifications/tools/list_changed after source connect', () => {
      if (notifications.tools === 0) {
        throw new Error('no notifications/tools/list_changed received');
      }
    });
    check('received notifications/resources/list_changed after source connect', () => {
      if (notifications.resources === 0) {
        throw new Error('no notifications/resources/list_changed received');
      }
    });

    // 4. tools/list returns the browser tool top-level with _meta intact.
    const toolList = await client.listTools();
    check('tools/list returns get_product as top-level tool', () => {
      const tool = toolList.tools.find((t) => t.name === 'get_product');
      if (!tool) {
        throw new Error(`get_product not found; got: ${toolList.tools.map((t) => t.name).join(', ')}`);
      }
    });
    check('tools/list does NOT return webmcp_* wrappers in direct mode', () => {
      const wrapperNames = toolList.tools.filter((t) => t.name.startsWith('webmcp_'));
      if (wrapperNames.length > 0) {
        throw new Error(`unexpected wrappers in direct mode: ${wrapperNames.map((t) => t.name).join(', ')}`);
      }
    });
    check('top-level get_product carries _meta.ui.resourceUri', () => {
      const tool = toolList.tools.find((t) => t.name === 'get_product');
      const uri = tool?._meta?.ui?.resourceUri;
      if (uri !== 'ui://bellaroma/product-card.html') {
        throw new Error(`expected ui://bellaroma/product-card.html, got ${JSON.stringify(tool?._meta)}`);
      }
    });

    // 5. resources/list returns the resource the browser advertised.
    const resList = await client.listResources();
    check('resources/list returns the browser-registered ui:// resource', () => {
      if (!Array.isArray(resList.resources) || resList.resources.length !== 1) {
        throw new Error(`expected 1 resource, got ${JSON.stringify(resList)}`);
      }
      const r = resList.resources[0];
      if (r.uri !== 'ui://bellaroma/product-card.html') {
        throw new Error(`unexpected uri: ${r.uri}`);
      }
      if (r.mimeType !== 'text/html;profile=mcp-app') {
        throw new Error(`unexpected mimeType: ${r.mimeType}`);
      }
    });

    // 6. resources/read returns the payload from the browser.
    const readResult = await client.readResource({ uri: 'ui://bellaroma/product-card.html' });
    check('resources/read returns the widget html via the browser source', () => {
      const first = readResult.contents?.[0];
      if (!first || first.text !== '<html>widget</html>') {
        throw new Error(`unexpected contents: ${JSON.stringify(readResult)}`);
      }
    });

    // 7. After the browser disconnects, both lists should drop the entry.
    notifications.tools = 0;
    notifications.resources = 0;
    ws.close();
    const deadline2 = Date.now() + 2000;
    while ((notifications.tools === 0 || notifications.resources === 0) && Date.now() < deadline2) {
      await sleep(40);
    }
    check('emits tools/list_changed when source disconnects', () => {
      if (notifications.tools === 0) {
        throw new Error('no tools/list_changed after disconnect');
      }
    });
    check('emits resources/list_changed when source disconnects', () => {
      if (notifications.resources === 0) {
        throw new Error('no resources/list_changed after disconnect');
      }
    });
    const finalTools = await client.listTools();
    check('post-disconnect: tools/list is empty', () => {
      if (finalTools.tools.length !== 0) {
        throw new Error(`expected 0 tools, got ${finalTools.tools.map(t => t.name).join(', ')}`);
      }
    });
    const finalRes = await client.listResources();
    check('post-disconnect: resources/list is empty', () => {
      if (finalRes.resources.length !== 0) {
        throw new Error(`expected 0 resources, got ${JSON.stringify(finalRes)}`);
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
