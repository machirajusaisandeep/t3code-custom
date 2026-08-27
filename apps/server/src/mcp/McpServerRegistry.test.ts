import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as McpServerOAuthTokens from "./McpServerOAuthTokens.ts";
import * as McpServerRegistry from "./McpServerRegistry.ts";

const stubExternalLauncherLayer = Layer.succeed(
  ExternalLauncher.ExternalLauncher,
  ExternalLauncher.ExternalLauncher.of({
    resolveAvailableEditors: () => Effect.succeed([]),
    resolveFileManagerRevealKind: () => Effect.succeed(undefined),
    launchBrowser: () => Effect.void,
    launchEditor: () => Effect.void,
  }),
);

const makeRegistryLayer = () =>
  McpServerRegistry.layer.pipe(
    Layer.provide(ServerSettingsModule.layerTest()),
    Layer.provide(stubExternalLauncherLayer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-mcp-server-registry-test-",
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("upserts, lists, and removes MCP servers", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;

    const created = yield* registry.upsert({
      config: {
        name: "My Server",
        enabled: true,
        transport: { type: "http", url: "https://example.com/mcp" },
      },
    });
    assert.equal(created.config.name, "My Server");

    const listed = yield* registry.list;
    assert.equal(listed.servers.length, 1);
    assert.equal(listed.servers[0]?.id, created.id);

    yield* registry.remove({ id: created.id });
    const afterRemove = yield* registry.list;
    assert.equal(afterRemove.servers.length, 0);
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("testConnection fails clearly when neither id nor config is given", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const result = yield* Effect.exit(registry.testConnection({}));
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("testConnection reports an error result for an unreachable server", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const result = yield* registry.testConnection({
      config: {
        name: "Unreachable",
        enabled: true,
        transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
      },
    });
    assert.equal(result.status, "error");
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("testConnection refuses an unsaved OAuth server", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const result = yield* registry.testConnection({
      config: {
        name: "OAuth Draft",
        enabled: true,
        transport: {
          type: "http",
          url: "https://example.com/mcp",
          oauth: { authorized: false },
        },
      },
    });
    assert.equal(result.status, "error");
    assert.equal(result.detail, "Save this server before testing an OAuth-authorized connection.");
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("testConnection does not refuse a saved OAuth server for lack of id", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const created = yield* registry.upsert({
      config: {
        name: "OAuth Server",
        enabled: true,
        transport: {
          type: "http",
          url: "http://127.0.0.1:1/mcp",
          oauth: { authorized: false },
        },
      },
    });
    const result = yield* registry.testConnection({
      id: created.id,
      config: created.config,
    });
    assert.equal(result.status, "error");
    assert.notEqual(
      result.detail,
      "Save this server before testing an OAuth-authorized connection.",
    );
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("clears stored OAuth secrets when an OAuth-configured server is removed", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const now = yield* Clock.currentTimeMillis;

    const created = yield* registry.upsert({
      config: {
        name: "OAuth Server",
        enabled: true,
        transport: { type: "http", url: "https://example.com/mcp", oauth: { authorized: true } },
      },
    });
    yield* McpServerOAuthTokens.writeTokens(secrets, created.id, {
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      expiresAtMs: now + 60_000,
    });
    assert.isDefined(yield* McpServerOAuthTokens.readTokens(secrets, created.id));

    yield* registry.remove({ id: created.id });

    assert.isUndefined(yield* McpServerOAuthTokens.readTokens(secrets, created.id));
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("clears stored OAuth secrets when an OAuth-configured server's URL changes", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const now = yield* Clock.currentTimeMillis;

    const created = yield* registry.upsert({
      config: {
        name: "OAuth Server",
        enabled: true,
        transport: { type: "http", url: "https://example.com/mcp", oauth: { authorized: true } },
      },
    });
    yield* McpServerOAuthTokens.writeTokens(secrets, created.id, {
      accessToken: "fake-access-token",
      expiresAtMs: now + 60_000,
    });
    assert.isDefined(yield* McpServerOAuthTokens.readTokens(secrets, created.id));

    yield* registry.upsert({
      id: created.id,
      config: {
        name: "OAuth Server",
        enabled: true,
        transport: {
          type: "http",
          url: "https://different.example.com/mcp",
          oauth: { authorized: true },
        },
      },
    });

    assert.isUndefined(yield* McpServerOAuthTokens.readTokens(secrets, created.id));
  }).pipe(Effect.provide(makeRegistryLayer())),
);
