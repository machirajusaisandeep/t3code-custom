/**
 * Interactive OAuth authorization flow for a saved, remote (`http`/`sse`) MCP
 * server: PKCE + dynamic client registration via the MCP SDK's own
 * `auth()`/`finishAuth()`, a one-shot loopback HTTP callback (mirroring
 * `apps/server/src/cloud/CliTokenManager.ts`'s `login()`), and a post-auth
 * `listTools` verification pass.
 *
 * Locked by a semaphore (passed in by the caller) so only one MCP server
 * authorization can be in flight at a time — the loopback port is fixed and
 * shared across every server, one attempt at a time.
 *
 * Limitation (intentional, not a bug): the loopback callback binds on the
 * machine running this server process. If the browser completing the OAuth
 * consent screen isn't on that same machine (e.g. this server is running on
 * a remote/SSH-only host), automatic browser launch will fail or open a
 * browser nobody can see. The authorization URL is still surfaced to the
 * caller as soon as it's known so the UI can offer it as a copyable link,
 * but completing the flow still requires *something* with network access to
 * `127.0.0.1:<port>` on this machine. A true remote/out-of-band flow
 * (mirroring `CliTokenManager.ts`'s `outOfBandOAuthLogin`) is not built here.
 *
 * @module McpServerOAuthFlow
 */
// @effect-diagnostics nodeBuiltinImport:off - the loopback OAuth callback is a Node HTTP boundary, matching CliTokenManager.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";

import {
  type McpServerConfig,
  type McpServerId,
  McpServerRegistryError,
  type McpServerTestConnectionResult,
  ServerSettingsError,
} from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type * as ExternalLauncher from "../process/externalLauncher.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { clearState, type SecretStore } from "./McpServerOAuthTokens.ts";
import { createMcpOAuthClientProvider } from "./McpServerOAuthProvider.ts";

// Distinct from the CLI login flow's loopback port (34338, CliTokenManager.ts)
// so the two never collide if both happen to run at once.
const MCP_OAUTH_CALLBACK_PORT = 34339;
/** Exported for reuse by non-interactive providers (`McpServerRegistry`, `UserMcpServers`) — functionally inert there since `interactive: false` never builds an authorization URL, but kept consistent with the one DCR-registered redirect URI. */
export const MCP_OAUTH_REDIRECT_URI = `http://127.0.0.1:${MCP_OAUTH_CALLBACK_PORT}/callback`;
// Matches CliTokenManager's CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT — no reason for
// this human-in-the-loop browser step to be shorter or longer than T3
// Connect's own login flow.
const MCP_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);

export type McpServerOAuthAuthorizeProgressEvent =
  | { readonly type: "awaiting-authorization"; readonly authorizationUrl: string }
  | { readonly type: "result"; readonly result: McpServerTestConnectionResult };

export interface McpOAuthFlowDeps {
  readonly secrets: SecretStore;
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly externalLauncher: ExternalLauncher.ExternalLauncher["Service"];
  readonly semaphore: Semaphore.Semaphore;
}

function buildOAuthTransport(
  config: McpServerConfig,
  authProvider: ReturnType<typeof createMcpOAuthClientProvider>,
): StreamableHTTPClientTransport | SSEClientTransport {
  if (config.transport.type === "stdio") {
    throw new Error("OAuth authorization only applies to http/sse MCP servers.");
  }
  const url = new URL(config.transport.url);
  return config.transport.type === "sse"
    ? new SSEClientTransport(url, { authProvider })
    : new StreamableHTTPClientTransport(url, { authProvider });
}

/**
 * Clears stored OAuth secrets for `id` and reconciles
 * `transport.oauth.authorized` back to `false`. Safe to call even if the
 * server was never authorized (a no-op in that case). Called on `remove`,
 * explicit `revoke`, switching a saved server's auth mode away from OAuth,
 * or changing its URL — all cases where existing credentials are either
 * gone or bound to a now-stale issuer/resource.
 */
export const clearMcpServerOAuth = (
  deps: Pick<McpOAuthFlowDeps, "secrets" | "serverSettings">,
  id: McpServerId,
): Effect.Effect<void, ServerSettingsError> =>
  Effect.gen(function* () {
    yield* clearState(deps.secrets, id);
    const current = yield* deps.serverSettings.getSettings;
    const config = current.mcpServers[id];
    if (!config || config.transport.type === "stdio" || !config.transport.oauth) return;
    const mcpServers = {
      ...current.mcpServers,
      [id]: {
        ...config,
        transport: { ...config.transport, oauth: { authorized: false } },
      },
    };
    yield* deps.serverSettings.updateSettings({ mcpServers });
  });

/** Explicit user-initiated revoke — identical to the lifecycle-cleanup helper above. */
export const revokeMcpServerOAuth = (
  deps: Pick<McpOAuthFlowDeps, "secrets" | "serverSettings">,
  id: McpServerId,
): Effect.Effect<void, ServerSettingsError> => clearMcpServerOAuth(deps, id);

/**
 * Runs one full authorize attempt for `id` as a stream of progress events,
 * terminating with a `result` event shaped like `McpServerTestConnectionResult`.
 * At most one attempt runs at a time across all MCP servers — a second
 * concurrent call waits for `deps.semaphore`'s single permit rather than
 * racing to bind the fixed loopback port twice.
 */
export function authorizeMcpServer(
  deps: McpOAuthFlowDeps,
  id: McpServerId,
): Stream.Stream<
  McpServerOAuthAuthorizeProgressEvent,
  McpServerRegistryError | ServerSettingsError
> {
  return Stream.callback<
    McpServerOAuthAuthorizeProgressEvent,
    McpServerRegistryError | ServerSettingsError
  >((queue) =>
    deps.semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const settings = yield* deps.serverSettings.getSettings;
          const config = settings.mcpServers[id];
          if (!config || config.transport.type === "stdio") {
            return yield* new McpServerRegistryError({
              operation: "oauthAuthorize",
              id,
              detail: `No remote MCP server registered with id ${id}.`,
            });
          }

          const client = new Client({ name: "t3-code", version: "0.0.0" });
          const redirectDeferred = yield* Deferred.make<URL>();
          const codeDeferred = yield* Deferred.make<string>();
          const csrfState = NodeCrypto.randomUUID();
          const provider = createMcpOAuthClientProvider({
            id,
            secrets: deps.secrets,
            redirectUri: MCP_OAUTH_REDIRECT_URI,
            interactive: true,
            state: csrfState,
            onRedirect: (url) => {
              Effect.runSync(Deferred.succeed(redirectDeferred, url));
            },
          });
          const authTransport = buildOAuthTransport(config, provider);
          const transport = authTransport as unknown as Transport;

          const callbackRoute = HttpRouter.add(
            "GET",
            "/callback",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const url = new URL(request.originalUrl, MCP_OAUTH_REDIRECT_URI);
              const code = url.searchParams.get("code");
              if (url.searchParams.get("state") !== csrfState || !code) {
                return HttpServerResponse.text("Invalid MCP OAuth authorization callback.", {
                  status: 400,
                });
              }
              yield* Deferred.succeed(codeDeferred, code);
              return HttpServerResponse.html(
                "<html><body>Authorization complete — you can close this tab.</body></html>",
              );
            }),
          );

          const result: McpServerTestConnectionResult = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* HttpRouter.serve(callbackRoute, {
                disableListenLog: true,
                disableLogger: true,
              }).pipe(
                Layer.provide(
                  NodeHttpServer.layer(NodeHttp.createServer, {
                    host: "127.0.0.1",
                    port: MCP_OAUTH_CALLBACK_PORT,
                    disablePreemptiveShutdown: true,
                  }),
                ),
                Layer.build,
              );

              const alreadyAuthorized = yield* Effect.tryPromise(() =>
                client.connect(transport),
              ).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              );

              if (!alreadyAuthorized) {
                const authorizationUrl = yield* Deferred.await(redirectDeferred);
                yield* deps.externalLauncher
                  .launchBrowser(authorizationUrl.toString())
                  .pipe(Effect.ignore);
                yield* Queue.offer(queue, {
                  type: "awaiting-authorization",
                  authorizationUrl: authorizationUrl.toString(),
                });

                const code = yield* Deferred.await(codeDeferred).pipe(
                  Effect.timeout(MCP_OAUTH_CALLBACK_TIMEOUT),
                  Effect.catchTag("TimeoutError", (cause) =>
                    Effect.fail(
                      new McpServerRegistryError({
                        operation: "oauthAuthorize",
                        id,
                        detail: "Timed out waiting for authorization.",
                        cause,
                      }),
                    ),
                  ),
                );
                yield* Effect.tryPromise(() => authTransport.finishAuth(code));
                yield* Effect.tryPromise(() => client.connect(transport));
              }

              const { tools } = yield* Effect.tryPromise(() => client.listTools());
              return {
                status: "ok" as const,
                toolNames: tools.map((tool) => tool.name),
              };
            }).pipe(
              Effect.catch((cause) =>
                Effect.succeed({
                  status: "error" as const,
                  toolNames: [] as ReadonlyArray<string>,
                  detail: cause instanceof Error ? cause.message : String(cause),
                }),
              ),
            ),
          ).pipe(Effect.ensuring(Effect.promise(() => client.close().catch(() => {}))));

          if (result.status === "ok") {
            const latest = yield* deps.serverSettings.getSettings;
            const latestConfig = latest.mcpServers[id];
            if (latestConfig && latestConfig.transport.type !== "stdio") {
              yield* deps.serverSettings.updateSettings({
                mcpServers: {
                  ...latest.mcpServers,
                  [id]: {
                    ...latestConfig,
                    transport: { ...latestConfig.transport, oauth: { authorized: true } },
                  },
                },
              });
            }
          }

          yield* Queue.offer(queue, { type: "result", result });
        }),
      )
      .pipe(
        Effect.catchTags({
          ServerSettingsError: (error) => Queue.fail(queue, error),
          McpServerRegistryError: (error) => Queue.fail(queue, error),
        }),
        Effect.andThen(Queue.end(queue)),
        Effect.forkScoped,
      ),
  );
}
