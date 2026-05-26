import { execFile } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

import { RelayBridgeServer, type RelayBridgeServerOptions } from './bridgeServer.js';
import type { AggregatedTool, SourceInfo } from './registry.js';
import {
  EMPTY_STATIC_TOOL_INPUT_SHAPE,
  publicInputSchemaFromZodShape,
  type StaticToolInputShape,
  WEBMCP_CALL_TOOL_INPUT_SHAPE,
  WEBMCP_OPEN_PAGE_INPUT_SHAPE,
} from './staticToolSchemas.js';

/**
 * Handle returned by MCP tool registration.
 */
interface RegisteredToolHandle {
  remove: () => void;
}

interface StaticToolRegistration<T extends StaticToolInputShape = StaticToolInputShape> {
  name: string;
  description: string;
  inputShape: T;
  annotations?: unknown;
  handler: (args: z.output<z.ZodObject<T>>) => Promise<Record<string, unknown>>;
}

interface PublicToolMetadata {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
}

/**
 * Tool exposure mode.
 *
 * - `direct` — relayed browser tools are advertised as top-level MCP tools
 *   with their original metadata (including `_meta.ui.resourceUri`) intact.
 *   The four `webmcp_*` wrapper tools are NOT registered.
 * - `wrapped` — only the four `webmcp_*` wrappers are advertised. Browser
 *   tools are reachable indirectly via `webmcp_call_tool`. Backward-compatible
 *   with the upstream `mcp-b` behavior.
 * - `both` — both modes coexist: top-level tools AND the four wrappers are
 *   advertised. This is the safest default for clients that don't yet handle
 *   MCP Apps `_meta.ui.resourceUri` widget rendering — those clients can
 *   still call wrappers, while MCP Apps hosts (e.g. Claude Desktop Cowork)
 *   see top-level tools and engage widget rendering.
 *
 * @see CLI flag `--expose-tools=direct|wrapped|both`
 */
export type ExposeToolsMode = 'direct' | 'wrapped' | 'both';

/**
 * Base options shared by all {@link LocalRelayMcpServer} configurations.
 */
interface LocalRelayMcpServerBaseOptions {
  /**
   * MCP server name reported during initialization.
   */
  serverName?: string;
  /**
   * MCP server version reported during initialization.
   */
  serverVersion?: string;
  /**
   * How browser-relayed tools are advertised to MCP clients.
   * @defaultValue `'both'`
   */
  exposeTools?: ExposeToolsMode;
}

/**
 * Construction options for {@link LocalRelayMcpServer}.
 *
 * Provide either an existing `bridge` instance OR `bridgeOptions` to create
 * one internally — not both.
 */
export type LocalRelayMcpServerOptions = LocalRelayMcpServerBaseOptions &
  (
    | { bridge: RelayBridgeServer; bridgeOptions?: never }
    | { bridge?: never; bridgeOptions?: RelayBridgeServerOptions }
  );

/**
 * MCP server facade that exposes browser-relayed tools over MCP transport.
 */
export class LocalRelayMcpServer {
  /**
   * Underlying WebSocket bridge used for browser communication.
   */
  readonly bridge: RelayBridgeServer;

  private readonly mcpServer: McpServer;
  private readonly staticToolData = new Map<string, PublicToolMetadata>();
  private readonly dynamicToolHandles = new Map<string, RegisteredToolHandle>();
  private readonly dynamicToolData = new Map<string, AggregatedTool>();
  private readonly dynamicToolSignature = new Map<string, string>();
  private readonly exposeTools: ExposeToolsMode;

  private syncing = false;
  private syncRequested = false;
  private connected = false;

  /**
   * Creates a local relay MCP server with static and dynamic tool registration.
   */
  constructor(options: LocalRelayMcpServerOptions = {}) {
    this.bridge = options.bridge ?? new RelayBridgeServer(options.bridgeOptions);
    this.exposeTools = options.exposeTools ?? 'both';

    this.mcpServer = new McpServer(
      {
        name: options.serverName ?? 'webmcp-local-relay',
        version: options.serverVersion ?? '0.0.0',
      },
      {
        capabilities: {
          // Declare tools support explicitly so the `tools/list` request
          // handler can be registered even when no static `webmcp_*` tools
          // are present (i.e. `--expose-tools=direct`). When at least one
          // static tool is registered via `mcpServer.registerTool`, the SDK
          // auto-injects the same capability, so this is a safe overlap.
          tools: { listChanged: true },
          // Declare resources support so MCP clients route resources/list and
          // resources/read to the relay. Resource state is populated dynamically
          // from connected browser sources; an empty list is returned when none
          // are advertised. `listChanged` mirrors how tools are advertised.
          resources: { listChanged: true },
        },
      }
    );

    this.bridge.on('stateChanged', () => {
      void this.syncDynamicTools().catch((err) => {
        this.logSyncError(err);
      });
    });

    // Forward elicitation requests from browser tool handlers to the MCP client.
    this.bridge.on(
      'elicitationRequest',
      (request: { callId: string; connectionId: string; params: Record<string, unknown> }) => {
        void (async () => {
          try {
            const result = await this.mcpServer.server.elicitInput(
              request.params as Parameters<typeof this.mcpServer.server.elicitInput>[0]
            );
            this.bridge.sendElicitationResponse(
              request.connectionId,
              request.callId,
              result as Record<string, unknown>
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[webmcp-local-relay] warn: elicitation forwarding failed: ${message}\n`
            );
            this.bridge.sendElicitationResponse(request.connectionId, request.callId, {
              action: 'decline',
              content: null,
              error: message,
            });
          }
        })();
      }
    );

    // Static `webmcp_*` wrapper tools are only registered in `wrapped` or
    // `both` modes. In `direct` mode, MCP clients see browser tools as
    // top-level tools with `_meta.ui.resourceUri` intact (required for MCP
    // Apps widget rendering), and the wrappers would only add noise.
    if (this.exposeTools !== 'direct') {
      this.registerStaticTools();
    }
    this.overrideListToolsHandler();
    this.registerResourcesHandlers();

    // Forward browser-side resource list updates to the MCP client. Mirrors
    // the existing tool-list change propagation in `applyDynamicTools`.
    this.bridge.on('resourcesChanged', () => {
      if (!this.connected) {
        return;
      }
      try {
        this.mcpServer.sendResourceListChanged();
      } catch (err) {
        process.stderr.write(
          `[webmcp-local-relay] warn: failed to send resource list changed notification: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    });
  }

  /**
   * Starts the browser bridge and synchronizes dynamic MCP tools.
   */
  async start(): Promise<void> {
    await this.bridge.start();
    await this.syncDynamicTools();
  }

  /**
   * Connects the MCP server to a transport.
   *
   * This may be called exactly once per instance lifecycle.
   */
  async connect(transport: Transport): Promise<void> {
    if (this.connected) {
      throw new Error('MCP server transport already connected');
    }

    await this.mcpServer.connect(transport);
    this.connected = true;

    this.mcpServer.server.onerror = (error) => {
      process.stderr.write(
        `[webmcp-local-relay] error: MCP protocol error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
    };
  }

  /**
   * Convenience helper that connects the server over stdio transport.
   */
  async startStdio(): Promise<void> {
    await this.connect(new StdioServerTransport());
  }

  /**
   * Stops MCP transport and bridge resources.
   */
  async stop(): Promise<void> {
    this.connected = false;
    let mcpCloseError: unknown;
    try {
      await this.mcpServer.close();
    } catch (err) {
      mcpCloseError = err;
      process.stderr.write(
        `[webmcp-local-relay] error: failed to close MCP server: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
      );
    }
    await this.bridge.stop();
    if (mcpCloseError) {
      process.stderr.write(
        '[webmcp-local-relay] warn: shutdown completed with errors (MCP server close failed)\n'
      );
    }
  }

  /**
   * Returns dynamic tool names currently registered in MCP.
   */
  listDynamicToolNames(): string[] {
    return Array.from(this.dynamicToolHandles.keys()).sort();
  }

  /**
   * Overrides the SDK's ListTools handler to return real JSON Schema
   * for dynamic tools instead of the empty `z.object({}).passthrough()`
   * schema that the SDK would otherwise convert to `{ type: 'object' }`.
   *
   * The MCP SDK's McpServer internally runs `toJsonSchemaCompat()` on
   * registered inputSchema values, which strips plain JSON Schema objects
   * (non-Zod) to empty schemas. This override bypasses that conversion
   * for dynamic (relayed) tools while preserving static tools as-is.
   */
  private overrideListToolsHandler(): void {
    // Touch internal SDK state so the SDK's `setToolRequestHandlers` is
    // marked initialised. Without this, the *first* call to
    // `mcpServer.registerTool` (which happens when a browser source connects
    // in `direct` mode) would overwrite our custom `tools/list` handler with
    // the SDK's default one — and the default one filters by
    // `_registeredTools`, missing `_meta` projection nuances. Setting the
    // private flag is a known SDK escape hatch; the SDK uses the same
    // pattern internally.
    (this.mcpServer as unknown as { _toolHandlersInitialized: boolean })._toolHandlersInitialized =
      true;

    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, () => {
      // Mode `wrapped` hides relayed browser tools — only the static wrappers
      // (which the LLM can invoke via `webmcp_call_tool`) are surfaced.
      const includeDynamic = this.exposeTools !== 'wrapped';
      const dynamicTools: Array<Record<string, unknown>> = includeDynamic
        ? Array.from(this.dynamicToolData.entries()).map(([name, tool]) => ({
            name,
            // Preserve title alongside name so MCP Apps clients can display the
            // friendly label declared by the browser source.
            ...(tool.title ? { title: tool.title } : {}),
            description: this.dynamicToolDescription(tool),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            // Preserve `_meta` end-to-end (Phase 2 fix continued). MCP Apps
            // hosts read `_meta.ui.resourceUri` from the tool definition to
            // discover the inline widget — without this projection the widget
            // never mounts even when the resource is reachable via
            // `resources/list`.
            ...(tool._meta ? { _meta: tool._meta } : {}),
          }))
        : [];

      const tools: Array<Record<string, unknown>> = [
        ...Array.from(this.staticToolData.values()).map((tool) => ({ ...tool })),
        ...dynamicTools,
      ].sort((left, right) => String(left.name).localeCompare(String(right.name)));

      return { tools };
    });
  }

  /**
   * Wires `resources/list` and `resources/read` handlers to the browser bridge.
   *
   * The relay maintains no local resource registry — every call is forwarded
   * to whichever connected browser source advertised the URI. MCP Apps spec
   * 2026-01-26 allows servers to omit UI-only resources from
   * `resources/list` because hosts can discover them via `_meta.ui.resourceUri`
   * on tool definitions; the relay forwards whatever browsers advertise.
   */
  private registerResourcesHandlers(): void {
    this.mcpServer.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = this.bridge.listResources().map((resource) => ({ ...resource }));
      return { resources };
    });

    this.mcpServer.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      // The bridge returns `unknown` because it does not interpret browser
      // payloads. Validate against the SDK schema before handing the result
      // to the MCP client so a malformed browser response is reported as a
      // server error rather than silently propagated. Mirrors the
      // normalizeCallToolResult validation on the tool side.
      const raw = await this.bridge.readResource(uri);
      const parsed = ReadResourceResultSchema.safeParse(raw);
      if (!parsed.success) {
        const preview = JSON.stringify(raw)?.slice(0, 500) ?? 'undefined';
        throw new Error(
          `Browser returned invalid ReadResourceResult for "${uri}": ${parsed.error.message}; payload: ${preview}`
        );
      }
      return parsed.data;
    });
  }

  private registerStaticTool<T extends StaticToolInputShape>({
    name,
    description,
    inputShape,
    annotations,
    handler,
  }: StaticToolRegistration<T>): void {
    this.mcpServer.registerTool(
      name,
      {
        description,
        inputSchema: inputShape,
        ...(annotations ? { annotations } : {}),
      } as Parameters<McpServer['registerTool']>[1],
      handler as Parameters<McpServer['registerTool']>[2]
    );
    this.staticToolData.set(name, {
      name,
      description,
      inputSchema: publicInputSchemaFromZodShape(inputShape),
      ...(annotations ? { annotations } : {}),
    });
  }

  /**
   * Registers built-in management tools exposed by the relay.
   */
  private registerStaticTools(): void {
    this.registerStaticTool({
      name: 'webmcp_list_sources',
      description: 'List connected browser tool sources and their metadata.',
      inputShape: EMPTY_STATIC_TOOL_INPUT_SHAPE,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      handler: async () => {
        if (this.bridge.mode === 'client') {
          const sources = this.bridge.listSourcesFromRelay();
          const info = {
            mode: 'client' as const,
            count: sources.length,
            sources,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
            structuredContent: info,
          };
        }
        const sources = this.bridge.registry.listSources();
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: sources.length, sources }, null, 2) },
          ],
          structuredContent: {
            count: sources.length,
            sources,
          },
        };
      },
    });

    this.registerStaticTool({
      name: 'webmcp_list_tools',
      description:
        'List WebMCP tools available from connected browser sources. Returns tool definitions including name, description, input schema, and source info. Use webmcp_call_tool to invoke a tool by name.',
      inputShape: EMPTY_STATIC_TOOL_INPUT_SHAPE,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      handler: async () => {
        const tools = this.listAggregatedTools();
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: tools.length, tools }, null, 2) },
          ],
          structuredContent: {
            count: tools.length,
            tools,
          },
        };
      },
    });

    this.registerStaticTool({
      name: 'webmcp_call_tool',
      description:
        'Call a WebMCP tool registered by a connected browser page. Use webmcp_list_tools first to see available tools and their input schemas.',
      inputShape: WEBMCP_CALL_TOOL_INPUT_SHAPE,
      annotations: {
        readOnlyHint: false,
      },
      handler: async ({ name, arguments: args }) => {
        const tools = this.listAggregatedTools();
        const toolSummary = this.buildToolSummary(tools);

        const matched = tools.find((t) => t.name === name);
        if (!matched) {
          const errorLines = [`Tool "${name}" not found.`];
          if (toolSummary) {
            errorLines.push('', 'Available tools:', toolSummary);
          } else {
            errorLines.push(
              '',
              'No tools are currently available. Ensure a browser page with WebMCP is connected.'
            );
          }
          return {
            content: [{ type: 'text' as const, text: errorLines.join('\n') }],
            isError: true,
          };
        }

        try {
          const result = await this.bridge.invokeTool(name, args ?? {});

          const updatedTools =
            this.bridge.mode === 'client'
              ? this.buildAggregatedToolsFromRelay()
              : this.bridge.registry.listTools();
          const updatedSummary = this.buildToolSummary(updatedTools);
          if (updatedSummary) {
            result.content = [
              ...result.content,
              { type: 'text' as const, text: `\n---\nAvailable tools:\n${updatedSummary}` },
            ];
          }

          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorLines = [`Failed to call tool "${name}": ${message}`];
          if (toolSummary) {
            errorLines.push('', 'Available tools:', toolSummary);
          }
          return {
            content: [{ type: 'text' as const, text: errorLines.join('\n') }],
            isError: true,
          };
        }
      },
    });

    this.registerStaticTool({
      name: 'webmcp_open_page',
      description:
        "Open a URL in the user's default browser, or refresh a connected source page. Use to launch WebMCP-enabled pages or reload stale connections.",
      inputShape: WEBMCP_OPEN_PAGE_INPUT_SHAPE,
      annotations: { readOnlyHint: false },
      handler: async ({ url, refresh }) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid URL: ${url}` }],
            isError: true,
          };
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Only http: and https: URLs are allowed. Got: ${parsed.protocol}`,
              },
            ],
            isError: true,
          };
        }

        if (refresh) {
          if (this.bridge.mode === 'client') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Refresh is not supported in client mode. Only the server relay can reload sources.',
                },
              ],
              isError: true,
            };
          }

          const sources = this.bridge.registry.listSources();
          const matched = sources.find((s) => {
            if (!s.url) return false;
            try {
              return new URL(s.url).origin === parsed.origin;
            } catch {
              process.stderr.write(
                `[webmcp-local-relay] warn: source ${s.sourceId} has unparseable URL: ${s.url}\n`
              );
              return false;
            }
          });

          if (!matched) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No connected source matches origin ${parsed.origin}. The page may not be open or connected.`,
                },
              ],
              isError: true,
            };
          }

          try {
            this.bridge.reloadSource(matched.sourceId);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Reload sent to source ${matched.sourceId} (${matched.url ?? matched.origin}).`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to reload source: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        }

        try {
          await this.openInBrowser(url);
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        if (this.bridge.mode === 'server') {
          const sources = this.bridge.registry.listSources();
          const existing = sources.find((s) => {
            if (!s.url) return false;
            try {
              return new URL(s.url).origin === parsed.origin;
            } catch {
              process.stderr.write(
                `[webmcp-local-relay] warn: source ${s.sourceId} has unparseable URL: ${s.url}\n`
              );
              return false;
            }
          });

          if (existing) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Opened ${url} in the default browser. Note: a source from ${existing.url ?? existing.origin} is already connected.`,
                },
              ],
            };
          }
        }

        return {
          content: [{ type: 'text' as const, text: `Opened ${url} in the default browser.` }],
        };
      },
    });
  }

  /**
   * Builds a concise plain-text list of available tools.
   */
  private buildToolSummary(tools: AggregatedTool[]): string | null {
    if (tools.length === 0) {
      return null;
    }

    return tools
      .map((t) => {
        const desc = t.description ? ` - ${t.description.split('\n')[0]}` : '';
        return `  ${t.name}${desc}`;
      })
      .join('\n');
  }

  /**
   * Opens a URL in the user's default browser using the platform open command.
   *
   * Uses the re-serialized `URL.href` to prevent injection of shell metacharacters.
   * On Windows, PowerShell `Start-Process` is used instead of `cmd /c start`
   * because cmd.exe interprets `&`, `|`, and other metacharacters in URLs.
   */
  private openInBrowser(url: string): Promise<void> {
    const safeUrl = new URL(url).href;
    return new Promise((resolve, reject) => {
      const platform = process.platform;
      let command: string;
      let args: string[];
      if (platform === 'darwin') {
        command = 'open';
        args = [safeUrl];
      } else if (platform === 'win32') {
        command = 'powershell.exe';
        args = ['-NoProfile', '-Command', `Start-Process "${safeUrl}"`];
      } else {
        command = 'xdg-open';
        args = [safeUrl];
      }
      execFile(command, args, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Coalesces concurrent sync requests into a single serialized sync loop.
   */
  private async syncDynamicTools(): Promise<void> {
    if (this.syncing) {
      this.syncRequested = true;
      return;
    }

    this.syncing = true;

    try {
      do {
        this.syncRequested = false;
        const tools = this.listAggregatedTools();
        this.applyDynamicTools(tools);
      } while (this.syncRequested);
    } finally {
      const retryRequested = this.syncRequested;
      this.syncRequested = false;
      this.syncing = false;
      if (retryRequested) {
        void this.syncDynamicTools().catch((err) => {
          this.logSyncError(err);
        });
      }
    }
  }

  /**
   * Returns the current aggregated tool list, dispatching based on bridge mode.
   */
  private listAggregatedTools(): AggregatedTool[] {
    return this.bridge.mode === 'client'
      ? this.buildAggregatedToolsFromRelay()
      : this.bridge.registry.listTools();
  }

  /**
   * Converts relay client tool descriptors to aggregated tool shape.
   * Populates per-tool source metadata from the relay's tool-source mapping.
   */
  private buildAggregatedToolsFromRelay(): AggregatedTool[] {
    const toolSourceMap = this.bridge.getToolSourceMapFromRelay();
    const allSources = this.bridge.listSourcesFromRelay();
    const sourceById = new Map(allSources.map((s) => [s.sourceId, s]));

    return this.bridge
      .listToolsFromRelay()
      .map((tool) => {
        const sourceIds = toolSourceMap[tool.name] ?? [];
        const sources: SourceInfo[] = [];
        for (const id of sourceIds) {
          const source = sourceById.get(id);
          if (source) {
            sources.push(source as SourceInfo);
          } else {
            process.stderr.write(
              `[webmcp-local-relay] warn: tool "${tool.name}" references unknown sourceId "${id}"\n`
            );
          }
        }

        return {
          ...tool,
          originalName: tool.name,
          sources,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Applies registry tool state to MCP dynamic registrations.
   */
  private applyDynamicTools(tools: AggregatedTool[]): void {
    const nextNames = new Set(tools.map((tool) => tool.name));
    let changed = false;

    for (const [name, handle] of this.dynamicToolHandles.entries()) {
      if (nextNames.has(name)) {
        continue;
      }

      handle.remove();
      this.dynamicToolHandles.delete(name);
      this.dynamicToolData.delete(name);
      this.dynamicToolSignature.delete(name);
      changed = true;
    }

    for (const tool of tools) {
      const signature = this.toolSignature(tool);
      const currentSignature = this.dynamicToolSignature.get(tool.name);

      if (currentSignature === signature && this.dynamicToolHandles.has(tool.name)) {
        continue;
      }

      const existing = this.dynamicToolHandles.get(tool.name);
      if (existing) {
        existing.remove();
        this.dynamicToolHandles.delete(tool.name);
      }

      const handle = this.registerDynamicTool(tool);
      this.dynamicToolHandles.set(tool.name, handle);
      this.dynamicToolData.set(tool.name, tool);
      this.dynamicToolSignature.set(tool.name, signature);
      changed = true;
    }

    if (changed && this.connected) {
      try {
        this.mcpServer.sendToolListChanged();
      } catch (err) {
        process.stderr.write(
          `[webmcp-local-relay] warn: failed to send tool list changed notification: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  /**
   * Registers a single dynamic tool and returns a removal handle.
   */
  private registerDynamicTool(tool: AggregatedTool): RegisteredToolHandle {
    const inputSchema = z.object({}).passthrough();
    const config = {
      description: this.dynamicToolDescription(tool),
      inputSchema,
    };

    const handle = this.mcpServer.registerTool(
      tool.name,
      tool.annotations ? { ...config, annotations: tool.annotations } : config,
      async (args: Record<string, unknown>) => {
        try {
          return await this.bridge.invokeTool(tool.name, args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const details = err instanceof Error ? (err.stack ?? err.message) : String(err);
          process.stderr.write(
            `[webmcp-local-relay] error: dynamic tool "${tool.name}" invocation failed: ${details}\n`
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to invoke relayed tool "${tool.name}": ${message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    return {
      remove: () => {
        handle.remove();
      },
    };
  }

  /**
   * Builds a display description for relayed tools including source context.
   * In client mode, source metadata is unavailable, so tools are labeled `[WebMCP relay]`.
   */
  private dynamicToolDescription(tool: AggregatedTool): string {
    const source = tool.sources[0];
    const sourceLabel = source
      ? `[WebMCP ${source.tabId}${source.title ? ` • ${source.title}` : ''}]`
      : '[WebMCP relay]';

    return `${sourceLabel} ${tool.description ?? `Relayed tool ${tool.originalName}`}`;
  }

  /**
   * Produces a stable signature for change detection of dynamic tool metadata.
   */
  private toolSignature(tool: AggregatedTool): string {
    return JSON.stringify({
      name: tool.name,
      originalName: tool.originalName,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      execution: tool.execution,
      _meta: tool._meta,
      icons: tool.icons,
      sources: tool.sources.map((source) => ({
        sourceId: source.sourceId,
        tabId: source.tabId,
      })),
    });
  }

  /**
   * Logs tool sync errors with full detail.
   */
  private logSyncError(err: unknown): void {
    const details = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[webmcp-local-relay] error: failed to sync dynamic tools: ${details}\n`);
  }
}
