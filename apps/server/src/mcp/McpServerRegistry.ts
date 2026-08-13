/**
 * Registry for user-configured MCP servers.
 *
 * Backs the MCP-servers settings panel: CRUD over `ServerSettings.mcpServers`
 * (persisted/redacted through `ServerSettingsService`, same as provider
 * instance environment variables) plus a `testConnection` that actually
 * speaks MCP to the server to list its tools. Session start merges every
 * `enabled` entry here into whichever agent CLI is driving a thread — see
 * `resolveSessionMcpServers.ts`.
 *
 * @module McpServerRegistry
 */
import {
  type McpServerConfig,
  McpServerId,
  type McpServerOAuthAuthorizeInput,
  McpServerRegistryError,
  type McpServerOAuthRevokeInput,
  type McpServerRemoveInput,
  type McpServerTestConnectionInput,
  type McpServerTestConnectionResult,
  type McpServerUpsertInput,
  type McpServerUpsertResult,
  type McpServersListResult,
  ServerSettingsError,
} from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  authorizeMcpServer,
  clearMcpServerOAuth,
  MCP_OAUTH_REDIRECT_URI,
  type McpServerOAuthAuthorizeProgressEvent,
  revokeMcpServerOAuth,
} from "./McpServerOAuthFlow.ts";
import { createMcpOAuthClientProvider } from "./McpServerOAuthProvider.ts";

export interface McpServerRegistryShape {
  readonly list: Effect.Effect<McpServersListResult, ServerSettingsError>;
  readonly upsert: (
    input: McpServerUpsertInput,
  ) => Effect.Effect<McpServerUpsertResult, ServerSettingsError>;
  readonly remove: (input: McpServerRemoveInput) => Effect.Effect<void, ServerSettingsError>;
  readonly testConnection: (
    input: McpServerTestConnectionInput,
  ) => Effect.Effect<McpServerTestConnectionResult, McpServerRegistryError | ServerSettingsError>;
  readonly authorize: (
    input: McpServerOAuthAuthorizeInput,
  ) => Stream.Stream<
    McpServerOAuthAuthorizeProgressEvent,
    McpServerRegistryError | ServerSettingsError
  >;
  readonly revoke: (input: McpServerOAuthRevokeInput) => Effect.Effect<void, ServerSettingsError>;
}

export class McpServerRegistry extends Context.Service<McpServerRegistry, McpServerRegistryShape>()(
  "t3/mcp/McpServerRegistry",
) {}

function buildTransport(
  config: McpServerConfig,
  id: McpServerId | undefined,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Transport {
  const transport = config.transport;
  if (transport.type === "stdio") {
    const env: Record<string, string> = {};
    for (const variable of transport.env ?? []) {
      env[variable.name] = variable.value;
    }
    return new StdioClientTransport({
      command: transport.command,
      args: [...transport.args],
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      ...(transport.env ? { env } : {}),
    });
  }

  const url = new URL(transport.url);

  if (transport.oauth) {
    if (!id) {
      throw new Error("OAuth-configured MCP servers must be saved before testing.");
    }
    // `authProvider` only — an OAuth transport never also carries a manually
    // set `Authorization` header. The SDK's transport asks the provider for
    // a token on every request and refreshes it internally on a 401; vendor
    // sessions (Claude/Codex/…) get a separately materialized header
    // instead, injected only into their snapshot copy (see UserMcpServers.ts).
    const authProvider = createMcpOAuthClientProvider({
      id,
      secrets,
      redirectUri: MCP_OAUTH_REDIRECT_URI,
      interactive: false,
    });
    return transport.type === "sse"
      ? (new SSEClientTransport(url, { authProvider }) as unknown as Transport)
      : (new StreamableHTTPClientTransport(url, { authProvider }) as unknown as Transport);
  }

  const headers: Record<string, string> = {};
  for (const header of transport.headers ?? []) {
    headers[header.name] = header.value;
  }
  const opts = transport.headers ? { requestInit: { headers } } : undefined;
  // The SDK's `sessionId` getters return `string | undefined`, which trips
  // `exactOptionalPropertyTypes` against `Transport.sessionId?: string` even
  // though both transports genuinely implement `Transport` at runtime.
  return transport.type === "sse"
    ? (new SSEClientTransport(url, opts) as unknown as Transport)
    : (new StreamableHTTPClientTransport(url, opts) as unknown as Transport);
}

const listToolNames = (
  config: McpServerConfig,
  id: McpServerId | undefined,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<ReadonlyArray<string>, McpServerRegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({ name: "t3-code", version: "0.0.0" });
      const transport = buildTransport(config, id, secrets);
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        return tools.map((tool) => tool.name);
      } finally {
        await client.close().catch(() => {});
      }
    },
    catch: (cause) =>
      new McpServerRegistryError({
        operation: "testConnection",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  // Guards the fixed OAuth loopback callback port: only one MCP server
  // authorization attempt runs at a time, across every server.
  const oauthSemaphore = yield* Semaphore.make(1);
  const oauthDeps = { secrets, serverSettings };

  const list: McpServerRegistryShape["list"] = serverSettings.getSettings.pipe(
    Effect.map(ServerSettings.redactServerSettingsForClient),
    Effect.map((settings) => ({
      servers: Object.entries(settings.mcpServers).map(([id, config]) => ({
        id: McpServerId.make(id),
        config,
      })),
    })),
  );

  const upsert: McpServerRegistryShape["upsert"] = (input) =>
    Effect.gen(function* () {
      const current = yield* serverSettings.getSettings;
      const id = input.id ?? McpServerId.make(NodeCrypto.randomUUID());
      const previous = current.mcpServers[id];
      const mcpServers = { ...current.mcpServers, [id]: input.config };
      const next = yield* serverSettings.updateSettings({ mcpServers });

      // OAuth credentials are bound to a specific transport type, URL, and
      // auth mode. If a previously-OAuth-configured server just switched
      // away from OAuth, changed transport type, or changed its URL, any
      // stored credentials are for a now-stale issuer/resource — clear them
      // so `authorized` can't lie about what's actually still usable.
      if (previous && previous.transport.type !== "stdio" && previous.transport.oauth) {
        const nextTransport = input.config.transport;
        const stillSameOAuthServer =
          nextTransport.type !== "stdio" &&
          nextTransport.oauth !== undefined &&
          nextTransport.url === previous.transport.url;
        if (!stillSameOAuthServer) {
          yield* clearMcpServerOAuth(oauthDeps, id);
        }
      }

      const redacted = ServerSettings.redactServerSettingsForClient(next);
      return { id, config: redacted.mcpServers[id] ?? input.config };
    });

  const remove: McpServerRegistryShape["remove"] = (input) =>
    Effect.gen(function* () {
      yield* clearMcpServerOAuth(oauthDeps, input.id).pipe(Effect.ignore);
      const current = yield* serverSettings.getSettings;
      const mcpServers = { ...current.mcpServers };
      delete mcpServers[input.id];
      yield* serverSettings.updateSettings({ mcpServers });
    });

  const resolveTestConnectionConfig = (
    input: McpServerTestConnectionInput,
  ): Effect.Effect<
    { readonly id: McpServerId | undefined; readonly config: McpServerConfig },
    McpServerRegistryError | ServerSettingsError
  > => {
    if (input.config) return Effect.succeed({ id: input.id, config: input.config });
    if (!input.id) {
      return new McpServerRegistryError({
        operation: "testConnection",
        detail: "Either id or config must be provided.",
      });
    }
    const id = input.id;
    return serverSettings.getSettings.pipe(
      Effect.flatMap((settings) => {
        const existing = settings.mcpServers[id];
        return existing
          ? Effect.succeed({ id, config: existing })
          : new McpServerRegistryError({
              operation: "testConnection",
              id,
              detail: `No MCP server registered with id ${id}.`,
            });
      }),
    );
  };

  const testConnection: McpServerRegistryShape["testConnection"] = (input) =>
    Effect.gen(function* () {
      const { id, config } = yield* resolveTestConnectionConfig(input);
      // OAuth needs a stable id to key stored credentials against — refuse
      // rather than attempt a connection that can never succeed.
      if (config.transport.type !== "stdio" && config.transport.oauth && !id) {
        return {
          status: "error" as const,
          toolNames: [],
          detail: "Save this server before testing an OAuth-authorized connection.",
        };
      }
      return yield* listToolNames(config, id, secrets).pipe(
        Effect.map((toolNames): McpServerTestConnectionResult => ({ status: "ok", toolNames })),
        Effect.catch(
          (error): Effect.Effect<McpServerTestConnectionResult> =>
            Effect.succeed({ status: "error", toolNames: [], detail: error.detail }),
        ),
      );
    });

  const authorize: McpServerRegistryShape["authorize"] = (input) =>
    authorizeMcpServer(
      { secrets, serverSettings, externalLauncher, semaphore: oauthSemaphore },
      input.id,
    );

  const revoke: McpServerRegistryShape["revoke"] = (input) =>
    revokeMcpServerOAuth(oauthDeps, input.id);

  return McpServerRegistry.of({ list, upsert, remove, testConnection, authorize, revoke });
});

export const layer = Layer.effect(McpServerRegistry, make);
