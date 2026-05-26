import type { ExposeToolsMode } from './mcpRelayServer.js';

/**
 * Valid values for `--expose-tools`.
 */
export const EXPOSE_TOOLS_MODES = ['direct', 'wrapped', 'both'] as const satisfies readonly ExposeToolsMode[];

/**
 * Parsed CLI options for relay startup.
 */
export interface CliOptions {
  host: string;
  port: number;
  portExplicitlySet: boolean;
  allowedOrigins: string[];
  label?: string;
  workspace?: string;
  relayId?: string;
  exposeTools: ExposeToolsMode;
}

/**
 * Parses supported CLI flags for relay startup.
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: '127.0.0.1',
    port: 9333,
    portExplicitlySet: false,
    // Permissive by default for zero-config local development — any browser page can connect.
    // Use --widget-origin to restrict to trusted origins on shared machines or in production.
    allowedOrigins: ['*'],
    // Default to `both`: expose top-level relayed tools (so MCP Apps widget
    // hosts like Claude Desktop Cowork can read `_meta.ui.resourceUri`) AND
    // the four `webmcp_*` wrapper tools (so older clients without MCP Apps
    // support still see something useful via `webmcp_list_tools` +
    // `webmcp_call_tool`). Use `--expose-tools=direct` to drop the wrappers
    // once you confirm all your clients render MCP Apps widgets natively.
    exposeTools: 'both',
  };

  const readFlagValue = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('-')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) {
      continue;
    }

    if (token === '--host' || token === '-H') {
      options.host = readFlagValue(token, i);
      i += 1;
      continue;
    }

    if (token === '--port' || token === '-p') {
      const raw = readFlagValue(token, i);
      i += 1;
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value) || value <= 0 || value > 65535) {
        throw new Error(`Invalid port "${raw}". Port must be a number between 1 and 65535.`);
      }
      options.port = value;
      options.portExplicitlySet = true;
      continue;
    }

    if (token === '--widget-origin' || token === '--allowed-origin' || token === '--ws-origin') {
      const raw = readFlagValue(token, i);
      i += 1;
      const split = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);

      if (split.length > 0) {
        options.allowedOrigins = split;
      }
      continue;
    }

    if (token === '--label') {
      options.label = readFlagValue(token, i);
      i += 1;
      continue;
    }

    if (token === '--workspace') {
      options.workspace = readFlagValue(token, i);
      i += 1;
      continue;
    }

    if (token === '--relay-id') {
      options.relayId = readFlagValue(token, i);
      i += 1;
      continue;
    }

    if (token === '--expose-tools') {
      const raw = readFlagValue(token, i);
      i += 1;
      if (!isExposeToolsMode(raw)) {
        throw new Error(
          `Invalid --expose-tools value "${raw}". Expected one of: ${EXPOSE_TOOLS_MODES.join(', ')}.`
        );
      }
      options.exposeTools = raw;
      continue;
    }

    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }

    if (token.startsWith('-')) {
      process.stderr.write(`[webmcp-local-relay] warn: unrecognized argument "${token}"\n`);
    } else {
      process.stderr.write(
        `[webmcp-local-relay] warn: unrecognized argument "${token}" (positional arguments are not supported)\n`
      );
    }
  }

  return options;
}

function isExposeToolsMode(value: string): value is ExposeToolsMode {
  return (EXPOSE_TOOLS_MODES as readonly string[]).includes(value);
}

/**
 * Prints CLI usage to stderr.
 */
export function printHelp(): void {
  process.stderr.write(
    [
      'webmcp-local-relay',
      '',
      'Usage:',
      '  webmcp-local-relay [--host 127.0.0.1] [--port 9333] [--widget-origin https://myapp.example.com]',
      '',
      'Options:',
      '  --host, -H               Bind host for local websocket relay (default: 127.0.0.1)',
      '  --port, -p               Preferred root port for the local relay cluster (default: 9333)',
      '  --widget-origin          Allowed host page origin(s), comma-separated (default: *)',
      '  --allowed-origin         Alias for --widget-origin',
      '  --ws-origin              Alias for --widget-origin',
      '  --label                  Human-readable relay label reported during discovery',
      '  --workspace              Optional workspace name reported during discovery',
      '  --relay-id               Stable relay identifier reported during discovery',
      '  --expose-tools           How browser tools are exposed to MCP clients:',
      '                             direct   - browser tools as top-level MCP tools',
      '                                        with _meta.ui.resourceUri intact (best',
      '                                        for MCP Apps widget hosts).',
      '                             wrapped  - only the four webmcp_* wrapper tools',
      '                                        (upstream mcp-b behavior; backward compat',
      '                                        for clients without MCP Apps support).',
      '                             both     - default; both direct and wrapped tools',
      '                                        coexist.',
      '  --help, -h               Show help',
      '',
    ].join('\n')
  );
}
