/**
 * Injects a hidden relay widget iframe and bridges widget messages to host tools.
 *
 * Usage:
 * `<script src=".../embed.js" data-relay-host="127.0.0.1" data-relay-port="9333"></script>`
 *
 * Add `data-debug` to enable diagnostic logging:
 * `<script src=".../embed.js" data-debug></script>`
 *
 * Override the per-request timeout (default 60000 ms) for slow tools that
 * chain multiple API calls:
 * `<script src=".../embed.js" data-request-timeout="120000"></script>`
 */
import type {
  ModelContextTestingPolyfillExtensions,
  ModelContextTestingToolInfo,
  ModelContextWithExtensions,
  ToolListItem,
} from '@mcp-b/webmcp-types';
import { isJsonObject } from './shared.js';

/** Loose JSON object — values aren't recursively typed since we just forward them. */
type JsonObject = Record<string, unknown>;

/**
 * Minimal tool shape sent to the relay widget — just name, description, and
 * a JSON-object inputSchema. Intentionally looser than ToolListItem so both
 * modelContext (ToolListItem) and modelContextTesting (string schema) can
 * be normalised into the same shape.
 */
interface RelayToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  /**
   * Tool-level `_meta` block forwarded verbatim to the relay (and onwards to
   * the MCP client). MCP Apps uses `_meta.ui.resourceUri` here to attach a
   * `ui://` widget to a tool result. The polyfill's testing-shim listTools()
   * surface emits this; native Chromium has not adopted it yet.
   */
  _meta?: JsonObject;
}

interface ToolBridge {
  listTools: () => RelayToolDescriptor[] | Promise<RelayToolDescriptor[]>;
  invoke: (name: string, args: JsonObject) => unknown;
}

/**
 * Resource descriptor sent to the relay widget (and onwards over WebSocket).
 *
 * Mirrors the relay's `BrowserResourceDescriptorSchema` (looseObject): only
 * `uri` and `name` are required; the rest pass through verbatim.
 */
interface RelayResourceDescriptor {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: JsonObject;
}

/**
 * MCP `ReadResourceResult` payload returned by the host page's resource
 * provider. The relay validates this against the SDK schema before forwarding
 * to the MCP client, so the bridge intentionally types the shape loosely.
 */
interface RelayReadResourceResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    _meta?: JsonObject;
  }>;
  _meta?: JsonObject;
}

interface ResourcesBridge {
  list: () => RelayResourceDescriptor[];
  read: (uri: string) => Promise<RelayReadResourceResult>;
}

/**
 * Polyfill-only shape duck-typed at runtime to detect `navigator.modelContext.resources`.
 *
 * We declare an internal-only interface here (rather than importing the new
 * `ModelContextResources` type) so this script keeps compiling against older
 * `@mcp-b/webmcp-types` releases that don't yet expose `resources` on
 * `Navigator.modelContext`.
 */
interface PolyfillResourcesSurface {
  register(uri: string, provider: () => unknown, options?: unknown): void;
  unregister(uri: string): void;
  list?: () => RelayResourceDescriptor[];
  read?: (uri: string) => Promise<RelayReadResourceResult>;
  addEventListener(
    type: 'resourcechange',
    listener: () => void,
    options?: boolean | AddEventListenerOptions
  ): void;
}

interface WidgetRequestMessage {
  requestId: string;
  type: string;
  toolName?: unknown;
  args?: unknown;
  uri?: unknown;
}

interface RelayConfig {
  autoConnect: boolean;
  relayHost: string;
  relayPort: string;
  relayId?: string;
  relayWorkspace?: string;
  requestTimeout?: string;
  tabId: string;
  widgetUrl: string;
  widgetOrigin: string;
}

const RELAY_IFRAME_SELECTOR = '[data-webmcp-relay]';
const TAB_ID_STORAGE_KEY = '__webmcp_relay_tab_id';
const FALLBACK_WIDGET_URL =
  'https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-local-relay/dist/browser/widget.html';

let widgetWindow: Window | null = null;
let config: RelayConfig;

function getCurrentScriptElement(): HTMLScriptElement | null {
  return document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;
}

const scriptEl = getCurrentScriptElement();
const DEBUG = scriptEl ? scriptEl.hasAttribute('data-debug') : false;

function debugWarn(...args: unknown[]): void {
  if (DEBUG) console.warn('[webmcp-relay-embed]', ...args);
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${String(Date.now())}_${String(Math.random()).slice(2, 10)}`;
}

function readOrCreateTabId(): string {
  try {
    const storedTabId = sessionStorage.getItem(TAB_ID_STORAGE_KEY);
    if (storedTabId) {
      return storedTabId;
    }
  } catch (err) {
    debugWarn('sessionStorage read failed, tab ID will not persist:', err);
  }

  const tabId = createTabId();
  try {
    sessionStorage.setItem(TAB_ID_STORAGE_KEY, tabId);
  } catch (err) {
    debugWarn('sessionStorage write failed:', err);
  }

  return tabId;
}

function resolveWidgetUrl(script: HTMLScriptElement | null): string {
  if (script?.src) {
    try {
      return new URL('widget.html', script.src).href;
    } catch (err) {
      debugWarn('Failed to resolve widget URL from script src, falling back to CDN:', err);
    }
  } else {
    debugWarn('Script element has no src attribute, falling back to CDN widget URL.');
  }
  return FALLBACK_WIDGET_URL;
}

function buildRelayConfig(script: HTMLScriptElement | null): RelayConfig {
  const widgetUrl = resolveWidgetUrl(script);
  const relayId = script?.getAttribute('data-relay-id') || undefined;
  const relayWorkspace = script?.getAttribute('data-relay-workspace') || undefined;
  const requestTimeout = script?.getAttribute('data-request-timeout') || undefined;
  return {
    autoConnect: script?.getAttribute('data-auto-connect') !== 'false',
    relayHost: script?.getAttribute('data-relay-host') || '127.0.0.1',
    relayPort: script?.getAttribute('data-relay-port') || '9333',
    ...(relayId ? { relayId } : {}),
    ...(relayWorkspace ? { relayWorkspace } : {}),
    ...(requestTimeout ? { requestTimeout } : {}),
    tabId: readOrCreateTabId(),
    widgetUrl,
    widgetOrigin: new URL(widgetUrl).origin,
  };
}

function parseTestingSchema(rawSchema: unknown): JsonObject {
  if (typeof rawSchema !== 'string' || rawSchema.length === 0) {
    return { type: 'object', properties: {} };
  }
  try {
    const parsed: unknown = JSON.parse(rawSchema);
    return isJsonObject(parsed) ? parsed : { type: 'object', properties: {} };
  } catch (err) {
    debugWarn(
      'Tool inputSchema is not valid JSON:',
      typeof rawSchema === 'string' ? rawSchema.slice(0, 200) : rawSchema,
      err
    );
    return { type: 'object', properties: {} };
  }
}

function toInvokeArgs(value: unknown): JsonObject {
  if (isJsonObject(value)) return value;
  if (value !== undefined && value !== null) {
    debugWarn('Tool invocation args must be an object, got', typeof value);
  }
  return {};
}

function mapToolListItem(tool: ToolListItem): RelayToolDescriptor {
  const out: RelayToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
  // Boundary preservation: forward tool-level `_meta` so the relay can
  // surface `_meta.ui.resourceUri` (MCP Apps Phase 3). The relay's own
  // `normalizeInboundTool` currently strips additional fields — note this in
  // the embed-side patch so Phase 3 knows to extend the relay normalizer too.
  const meta = (tool as ToolListItem & { _meta?: unknown })._meta;
  if (isJsonObject(meta)) {
    out._meta = meta;
  }
  return out;
}

function mapTestingToolInfo(tool: ModelContextTestingToolInfo): RelayToolDescriptor {
  const out: RelayToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: parseTestingSchema(tool.inputSchema),
  };
  const meta = (tool as ModelContextTestingToolInfo & { _meta?: unknown })._meta;
  if (isJsonObject(meta)) {
    out._meta = meta;
  }
  return out;
}

/**
 * At runtime, navigator.modelContext may be the extended BrowserMcpServer
 * (with listTools/callTool/addEventListener) installed by @mcp-b/global,
 * or the bare ModelContextCore from the native browser / polyfill.
 * We duck-type to detect the extended version.
 */
function getExtendedModelContext(): ModelContextWithExtensions | undefined {
  const mc = navigator.modelContext;
  if (
    mc &&
    typeof (mc as Partial<ModelContextWithExtensions>).listTools === 'function' &&
    typeof (mc as Partial<ModelContextWithExtensions>).callTool === 'function'
  ) {
    return mc as ModelContextWithExtensions;
  }
  return undefined;
}

function getToolBridge(): ToolBridge | null {
  const modelContext = getExtendedModelContext();
  if (modelContext) {
    return {
      listTools() {
        return modelContext.listTools().map(mapToolListItem);
      },
      invoke(name: string, args: JsonObject) {
        return modelContext.callTool({ name, arguments: args });
      },
    };
  }

  const testing = navigator.modelContextTesting;
  if (
    testing &&
    typeof testing.listTools === 'function' &&
    typeof testing.executeTool === 'function'
  ) {
    return {
      listTools() {
        return testing.listTools().map(mapTestingToolInfo);
      },
      async invoke(name: string, args: JsonObject) {
        const serialized: string | null = await testing.executeTool(name, JSON.stringify(args));
        if (serialized === null) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Tool execution interrupted by navigation' }],
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(serialized);
        } catch {
          throw new Error(
            `Testing tool returned invalid JSON: ${String(serialized).slice(0, 200)}`
          );
        }
        if (!isJsonObject(parsed)) {
          throw new Error('Testing tool response was not an object');
        }
        return parsed;
      },
    };
  }

  debugWarn('No WebMCP runtime found (navigator.modelContext or navigator.modelContextTesting).');
  return null;
}

function getResourcesSurface(): PolyfillResourcesSurface | null {
  const mc = navigator.modelContext as unknown as {
    resources?: PolyfillResourcesSurface;
  } | null;
  if (!mc) return null;
  const candidate = mc.resources;
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof candidate.register === 'function' &&
    typeof candidate.unregister === 'function' &&
    typeof candidate.list === 'function' &&
    typeof candidate.read === 'function' &&
    typeof candidate.addEventListener === 'function'
  ) {
    return candidate;
  }
  return null;
}

function getResourcesBridge(): ResourcesBridge | null {
  const surface = getResourcesSurface();
  if (!surface || !surface.list || !surface.read) return null;
  return {
    list() {
      const raw = surface.list?.() ?? [];
      // Only forward entries that have `uri` and `name` strings — the relay's
      // schema requires both as non-empty strings. Drop malformed entries
      // silently to match the spirit of the existing tool mapping helpers.
      return raw.filter(
        (r): r is RelayResourceDescriptor =>
          isJsonObject(r) && typeof r.uri === 'string' && typeof r.name === 'string'
      );
    },
    read(uri: string) {
      return Promise.resolve(surface.read?.(uri) as Promise<RelayReadResourceResult>);
    },
  };
}

let pushScheduled = false;
let pushResourcesScheduled = false;

function onToolsChanged(): void {
  if (pushScheduled || !widgetWindow) return;
  pushScheduled = true;
  setTimeout(() => {
    pushScheduled = false;
    if (!widgetWindow) return;
    const bridge = getToolBridge();
    const toolsPromise = bridge ? Promise.resolve(bridge.listTools()) : Promise.resolve([]);
    toolsPromise
      .then((tools) => {
        if (!widgetWindow) return;
        widgetWindow.postMessage(
          {
            type: 'webmcp.tools.changed',
            tools: Array.isArray(tools) ? tools : [],
          },
          config.widgetOrigin
        );
      })
      .catch((err: unknown) => {
        debugWarn('Failed to push tool changes:', err);
      });
  }, 0);
}

function onResourcesChanged(): void {
  if (pushResourcesScheduled || !widgetWindow) return;
  pushResourcesScheduled = true;
  setTimeout(() => {
    pushResourcesScheduled = false;
    if (!widgetWindow) return;
    const bridge = getResourcesBridge();
    const resources = bridge ? bridge.list() : [];
    widgetWindow.postMessage(
      {
        type: 'webmcp.resources.changed',
        resources,
      },
      config.widgetOrigin
    );
  }, 0);
}

function trySubscribeResources(): boolean {
  const surface = getResourcesSurface();
  if (!surface) return false;
  try {
    surface.addEventListener('resourcechange', onResourcesChanged);
    return true;
  } catch (error) {
    debugWarn('resources.addEventListener threw:', error);
    return false;
  }
}

function subscribeToResourcesChanges(): void {
  if (trySubscribeResources()) {
    return;
  }
  // The polyfill installs the resources namespace synchronously during
  // `initializeWebMCPPolyfill`, but native Chromium may install it later.
  // Use the same retry cadence as tool subscriptions to stay forgiving.
  let retries = 0;
  let retryDelayMs = 100;
  const MAX_RETRIES = 40;
  const MAX_RETRY_DELAY_MS = 1000;

  const scheduleRetry = (): void => {
    setTimeout(() => {
      retries++;
      if (trySubscribeResources()) return;
      if (retries >= MAX_RETRIES) {
        debugWarn(
          `Could not subscribe to resourcechange after ${MAX_RETRIES} retries. Dynamic resource updates will not be relayed.`
        );
        return;
      }
      retryDelayMs = Math.min(Math.round(retryDelayMs * 1.5), MAX_RETRY_DELAY_MS);
      scheduleRetry();
    }, retryDelayMs);
  };
  scheduleRetry();
}

function trySubscribe(): boolean {
  const mc = getExtendedModelContext();
  if (mc) {
    try {
      mc.addEventListener('toolchange', onToolsChanged);
      return true;
    } catch (error) {
      debugWarn('addEventListener threw:', error);
    }
  }
  const testing = navigator.modelContextTesting as
    | (typeof navigator.modelContextTesting & Partial<ModelContextTestingPolyfillExtensions>)
    | undefined;
  if (testing && typeof testing.registerToolsChangedCallback === 'function') {
    try {
      testing.registerToolsChangedCallback(onToolsChanged);
      return true;
    } catch (error) {
      debugWarn('Failed to subscribe via registerToolsChangedCallback:', error);
    }
  }
  return false;
}

function subscribeToToolChanges(): void {
  if (trySubscribe()) {
    return;
  }

  let retries = 0;
  let retryDelayMs = 100;
  const MAX_RETRIES = 40;
  const MAX_RETRY_DELAY_MS = 1000;

  const scheduleRetry = (): void => {
    setTimeout(() => {
      retries++;
      if (trySubscribe()) {
        return;
      }

      if (retries >= MAX_RETRIES) {
        debugWarn(
          `Could not subscribe to tool changes after ${MAX_RETRIES} retries. Dynamic tool updates will not be relayed.`
        );
        return;
      }

      retryDelayMs = Math.min(Math.round(retryDelayMs * 1.5), MAX_RETRY_DELAY_MS);
      scheduleRetry();
    }, retryDelayMs);
  };

  scheduleRetry();
}

function respondToSource(
  source: MessageEventSource | null,
  origin: string,
  payload: Record<string, unknown>
): void {
  if (!source || typeof source !== 'object' || !('postMessage' in source)) {
    return;
  }

  (source as Window).postMessage(payload, origin);
}

function parseWidgetRequest(value: unknown): WidgetRequestMessage | null {
  if (
    !isJsonObject(value) ||
    typeof value.requestId !== 'string' ||
    typeof value.type !== 'string'
  ) {
    return null;
  }

  return {
    requestId: value.requestId,
    type: value.type,
    toolName: value.toolName,
    args: value.args,
    uri: value.uri,
  };
}

function handleResourcesListRequest(request: WidgetRequestMessage, event: MessageEvent): void {
  const bridge = getResourcesBridge();
  const resources = bridge ? bridge.list() : [];
  respondToSource(event.source, event.origin, {
    type: 'webmcp.resources.list.response',
    requestId: request.requestId,
    resources,
  });
}

function handleResourcesReadRequest(request: WidgetRequestMessage, event: MessageEvent): void {
  const bridge = getResourcesBridge();
  const uri = typeof request.uri === 'string' ? request.uri : '';
  if (!bridge) {
    respondToSource(event.source, event.origin, {
      type: 'webmcp.resources.read.error',
      requestId: request.requestId,
      error: 'No WebMCP resources runtime found on this page',
    });
    return;
  }
  if (uri.length === 0) {
    respondToSource(event.source, event.origin, {
      type: 'webmcp.resources.read.error',
      requestId: request.requestId,
      error: 'Resource read request is missing a uri',
    });
    return;
  }

  Promise.resolve()
    .then(() => bridge.read(uri))
    .then((result) => {
      respondToSource(event.source, event.origin, {
        type: 'webmcp.resources.read.response',
        requestId: request.requestId,
        // The bridge already returns the MCP `ReadResourceResult` shape
        // (`{contents: [...], _meta?}`). The widget forwards `result` verbatim
        // over the WebSocket; the relay validates it server-side.
        result,
      });
    })
    .catch((error: unknown) => {
      respondToSource(event.source, event.origin, {
        type: 'webmcp.resources.read.error',
        requestId: request.requestId,
        error: String(error instanceof Error ? error.message : error),
      });
    });
}

function handleListRequest(request: WidgetRequestMessage, event: MessageEvent): void {
  const bridge = getToolBridge();
  const toolsPromise = bridge ? Promise.resolve(bridge.listTools()) : Promise.resolve([]);

  toolsPromise
    .then((tools) => {
      respondToSource(event.source, event.origin, {
        type: 'webmcp.tools.list.response',
        requestId: request.requestId,
        tools: Array.isArray(tools) ? tools : [],
      });
    })
    .catch((error: unknown) => {
      debugWarn('Failed to list tools:', error);
      respondToSource(event.source, event.origin, {
        type: 'webmcp.tools.list.response',
        requestId: request.requestId,
        tools: [],
        error: `Failed to list tools: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
}

/**
 * Monkey-patches `navigator.modelContext.elicitInput` to bridge elicitation
 * requests through the relay widget iframe to the local relay server, which
 * forwards them to the MCP client (e.g. Claude Code).
 *
 * This is the same pattern used in `@mcp-b/chrome-devtools-mcp` for CDP-based
 * elicitation forwarding. The relay widget and server handle the new
 * `elicitation-request` / `elicitation-response` message types.
 */
let elicitBridgeInstalled = false;

function installElicitBridge(widgetSource: MessageEventSource, widgetOrigin: string): void {
  if (elicitBridgeInstalled) return;

  const mc = getExtendedModelContext() as
    | (ModelContextWithExtensions & {
        elicitInput?: (
          params: Record<string, unknown>,
          options?: unknown
        ) => Promise<Record<string, unknown>>;
      })
    | undefined;
  if (!mc || typeof mc.elicitInput !== 'function') {
    debugWarn('Elicitation bridge not installed: elicitInput not available on modelContext');
    return;
  }

  mc.elicitInput = (
    params: Record<string, unknown>,
    _options?: unknown
  ): Promise<Record<string, unknown>> => {
    const callId = createElicitCallId();
    return new Promise<Record<string, unknown>>((resolve) => {
      const ELICIT_TIMEOUT_MS = 60_000;

      const cleanup = (): void => {
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
      };

      const timeout = setTimeout(() => {
        cleanup();
        debugWarn('Elicitation request timed out after 60s');
        resolve({ action: 'decline', content: null });
      }, ELICIT_TIMEOUT_MS);

      const handler = (event: MessageEvent): void => {
        if (event.origin !== widgetOrigin) return;
        const data = event.data as Record<string, unknown>;
        if (
          !isJsonObject(data) ||
          data.type !== 'webmcp.elicitation.response' ||
          data.callId !== callId
        ) {
          return;
        }
        cleanup();
        resolve(
          isJsonObject(data.result)
            ? (data.result as Record<string, unknown>)
            : { action: 'decline', content: null }
        );
      };
      window.addEventListener('message', handler);

      (widgetSource as Window).postMessage(
        { type: 'webmcp.elicitation.request', callId, params },
        widgetOrigin
      );
    });
  };

  elicitBridgeInstalled = true;
  debugWarn('Elicitation bridge installed');
}

let elicitCallCounter = 0;
function createElicitCallId(): string {
  elicitCallCounter += 1;
  return `elicit_${String(Date.now())}_${String(elicitCallCounter)}`;
}

function handleInvokeRequest(request: WidgetRequestMessage, event: MessageEvent): void {
  const bridge = getToolBridge();
  if (!bridge) {
    respondToSource(event.source, event.origin, {
      type: 'webmcp.tools.invoke.error',
      requestId: request.requestId,
      error: 'No WebMCP runtime found on this page',
    });
    return;
  }

  // Install elicitation bridge before invoking the tool, so that tool
  // handlers can call elicitInput() and have it forwarded to the MCP client.
  if (event.source) {
    installElicitBridge(event.source, event.origin);
  }

  Promise.resolve(bridge.invoke(String(request.toolName ?? ''), toInvokeArgs(request.args)))
    .then((result) => {
      respondToSource(event.source, event.origin, {
        type: 'webmcp.tools.invoke.response',
        requestId: request.requestId,
        result: isJsonObject(result) ? result : {},
      });
    })
    .catch((error: unknown) => {
      respondToSource(event.source, event.origin, {
        type: 'webmcp.tools.invoke.error',
        requestId: request.requestId,
        error: String(error instanceof Error ? error.message : error),
      });
    });
}

async function injectRelayWidget(cfg: RelayConfig): Promise<void> {
  if (document.querySelector(RELAY_IFRAME_SELECTOR)) {
    return;
  }

  const searchParams = new URLSearchParams();
  searchParams.set('tabId', cfg.tabId);
  searchParams.set('hostOrigin', window.location.origin);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.search = '';
  cleanUrl.hash = '';
  searchParams.set('hostUrl', cleanUrl.href);
  searchParams.set('hostTitle', document.title || '');
  searchParams.set('relayHost', cfg.relayHost);
  searchParams.set('relayPort', cfg.relayPort);
  searchParams.set('autoConnect', cfg.autoConnect ? 'true' : 'false');
  if (cfg.relayId) {
    searchParams.set('relayId', cfg.relayId);
  }
  if (cfg.relayWorkspace) {
    searchParams.set('relayWorkspace', cfg.relayWorkspace);
  }
  if (cfg.requestTimeout) {
    searchParams.set('requestTimeout', cfg.requestTimeout);
  }

  // Try fetch + blob URL to work around CDNs serving .html as text/plain.
  let blobUrl: string | null = null;
  try {
    const response = await fetch(cfg.widgetUrl);
    if (!response.ok) {
      console.warn(
        `[webmcp-relay-embed] Widget HTML fetch returned ${String(response.status)}; falling back to direct iframe src.`
      );
    } else if (response.ok) {
      const html = await response.text();
      const configScript = `<script>window.__WEBMCP_RELAY_CONFIG=${JSON.stringify(Object.fromEntries(searchParams))};</script>`;
      const blob = new Blob([html.replace('</head>', `${configScript}</head>`)], {
        type: 'text/html',
      });
      blobUrl = URL.createObjectURL(blob);
      config.widgetOrigin = window.location.origin;
    }
  } catch (err) {
    debugWarn('Failed to fetch widget HTML for blob URL:', err);
  }

  const iframe = document.createElement('iframe');
  // Fallback: direct iframe src (works when widget.html is served as text/html).
  iframe.src = blobUrl ?? `${cfg.widgetUrl}?${searchParams.toString()}`;
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('data-webmcp-relay', '1');
  iframe.setAttribute('allow', 'loopback-network; local-network; local-network-access');
  document.body.appendChild(iframe);
  widgetWindow = iframe.contentWindow;
  iframe.addEventListener('load', () => {
    widgetWindow = iframe.contentWindow;
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
  });
  iframe.addEventListener('error', () => {
    console.error(
      '[webmcp-relay-embed] Failed to load relay widget iframe from:',
      iframe.src,
      '-- WebMCP tools will NOT be relayed. Check network connectivity and widget URL.'
    );
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
  });
}

if (!document.querySelector(RELAY_IFRAME_SELECTOR)) {
  try {
    config = buildRelayConfig(scriptEl);
  } catch (err) {
    console.error('[webmcp-relay-embed] Failed to initialize relay configuration:', err);
    throw err;
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== config.widgetOrigin) {
      return;
    }
    if (!widgetWindow || event.source !== widgetWindow) {
      return;
    }

    const data = event.data;
    if (isJsonObject(data) && data.type === 'webmcp.reload') {
      window.location.reload();
      return;
    }

    const request = parseWidgetRequest(event.data);
    if (!request) {
      return;
    }

    if (request.type === 'webmcp.tools.list.request') {
      handleListRequest(request, event);
      return;
    }

    if (request.type === 'webmcp.tools.invoke.request') {
      handleInvokeRequest(request, event);
      return;
    }

    if (request.type === 'webmcp.resources.list.request') {
      handleResourcesListRequest(request, event);
      return;
    }

    if (request.type === 'webmcp.resources.read.request') {
      handleResourcesReadRequest(request, event);
    }
  });

  const launchWidget = (): void => {
    injectRelayWidget(config).catch((err) => {
      console.error('[webmcp-relay-embed] Failed to inject relay widget:', err);
    });
  };
  if (document.body) {
    launchWidget();
  } else {
    document.addEventListener('DOMContentLoaded', launchWidget, { once: true });
  }

  subscribeToToolChanges();
  subscribeToResourcesChanges();
}
