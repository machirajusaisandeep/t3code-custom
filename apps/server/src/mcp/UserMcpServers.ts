/**
 * Live snapshot of enabled, user-configured MCP servers.
 *
 * Every provider adapter (Claude/Codex/Grok/Cursor/OpenCode) merges this
 * snapshot into its own MCP wiring at session start, alongside T3's
 * built-in "t3-code" server (see `McpProviderSession.ts`). Adapters read it
 * with a plain synchronous call — the same idiom
 * `McpProviderSession.readMcpProviderSession` uses — so none of the five
 * adapters need to depend on `ServerSettingsService` directly just to see
 * the current MCP server list. `layer` seeds the snapshot at boot and keeps
 * it current via `ServerSettingsService.streamChanges`, following the same
 * pattern as `ProviderInstanceRegistryHydration.ts`.
 *
 * For OAuth-authorized remote servers, this module also injects a fresh
 * `Authorization` header into each server's snapshot copy — the *only*
 * place vendor sessions ever see an OAuth credential. This is deliberately
 * separate from `McpServerRegistry.buildTransport`'s `authProvider`-based
 * path: vendor adapters only understand plain header records, so a header
 * is materialized here for them, while `McpServerRegistry`'s own SDK-driven
 * connections (test connection, authorize) hand the SDK an `authProvider`
 * directly and never also get this header. A refresh failure degrades to
 * "no header" rather than throwing — the vendor session then fails the same
 * way an unauthenticated request always would.
 *
 * @module UserMcpServers
 */
import type { McpServerConfig, ServerSettings } from "@t3tools/contracts";
import { McpServerId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MCP_OAUTH_REDIRECT_URI } from "./McpServerOAuthFlow.ts";
import { getFreshAccessToken } from "./McpServerOAuthProvider.ts";

export interface EnabledMcpServer {
  readonly id: McpServerId;
  readonly config: McpServerConfig;
}

let snapshot: ReadonlyArray<EnabledMcpServer> = [];

function extractEnabledEntries(settings: ServerSettings): ReadonlyArray<EnabledMcpServer> {
  return Object.entries(settings.mcpServers)
    .filter(([, config]) => config.enabled)
    .map(([id, config]) => ({ id: McpServerId.make(id), config }));
}

function materializeOAuthHeader(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  id: McpServerId,
  config: McpServerConfig,
): Effect.Effect<McpServerConfig> {
  const transport = config.transport;
  if (transport.type === "stdio" || !transport.oauth?.authorized) {
    return Effect.succeed(config);
  }
  return getFreshAccessToken(secrets, id, transport.url, MCP_OAUTH_REDIRECT_URI).pipe(
    Effect.map((token) => {
      if (Option.isNone(token)) return config;
      const headers = (transport.headers ?? []).filter(
        (header) => header.name.toLowerCase() !== "authorization",
      );
      return {
        ...config,
        transport: {
          ...transport,
          headers: [
            ...headers,
            { name: "Authorization", value: `Bearer ${token.value}`, sensitive: true },
          ],
        },
      };
    }),
  );
}

function materializeEnabled(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  settings: ServerSettings,
): Effect.Effect<ReadonlyArray<EnabledMcpServer>> {
  return Effect.forEach(extractEnabledEntries(settings), (entry) =>
    materializeOAuthHeader(secrets, entry.id, entry.config).pipe(
      Effect.map((config) => ({ id: entry.id, config })),
    ),
  );
}

/** Plain synchronous read — call from adapter session-start code. */
export function readEnabledMcpServers(): ReadonlyArray<EnabledMcpServer> {
  return snapshot;
}

/** Exposed for tests. */
export const __testing = {
  setEnabledMcpServers(next: ReadonlyArray<EnabledMcpServer>): void {
    snapshot = next;
  },
};

// Independent of settings-change events, so a long-lived server process
// keeps OAuth-authorized servers' access tokens fresh for sessions started
// long after the user last touched the MCP settings panel — a settings edit
// is the only other thing that would otherwise re-run materialization.
const OAUTH_REFRESH_TICK_INTERVAL = Duration.seconds(60);

/**
 * Seeds the snapshot from current settings and forks two daemon fibers
 * (scoped to this layer's lifetime): one reacting to every subsequent
 * settings change, and one on a fixed interval purely to keep OAuth-derived
 * headers fresh between settings changes. Errors are logged and swallowed —
 * a bad settings emission or a failed refresh tick should never take down
 * MCP wiring for already-running sessions.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;

    const initial = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    if (initial) snapshot = yield* materializeEnabled(secrets, initial);

    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((settings) =>
        materializeEnabled(secrets, settings).pipe(
          Effect.map((next) => {
            snapshot = next;
          }),
        ),
      ),
      Effect.catchCause((cause) => Effect.logError("UserMcpServers sync failed", cause)),
      Effect.forkScoped,
    );

    yield* Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      snapshot = yield* materializeEnabled(secrets, settings);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("UserMcpServers OAuth refresh tick failed", cause),
      ),
      Effect.repeat(Schedule.fixed(OAUTH_REFRESH_TICK_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
