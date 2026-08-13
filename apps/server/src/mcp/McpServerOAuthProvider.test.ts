import { McpServerId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getFreshAccessToken } from "./McpServerOAuthProvider.ts";
import { writeTokens } from "./McpServerOAuthTokens.ts";

/**
 * These cover only the non-network fast paths of `getFreshAccessToken` — a
 * cached token far from expiry, and no stored token at all. The refresh
 * branch (near-expiry token, calling the SDK's `auth()`) does real RFC
 * 8414/9728 discovery over HTTP and isn't exercised here: mocking that
 * faithfully would need a fake `fetchFn` wired through the whole discovery
 * + DCR + token-refresh chain, which risks giving false confidence if the
 * mock doesn't match the SDK's actual request shapes. That path is verified
 * by reading the SDK source (see McpServerOAuthProvider.ts's module doc),
 * not by an automated test.
 */
function makeInMemorySecretStore(): ServerSecretStore.ServerSecretStore["Service"] {
  const store = new Map<string, Uint8Array>();
  return {
    get: (name) =>
      Effect.sync(() => (store.has(name) ? Option.some(store.get(name)!) : Option.none())),
    set: (name, value) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    getOrCreateRandom: () => Effect.die("not used by these tests"),
    remove: (name) =>
      Effect.sync(() => {
        store.delete(name);
      }),
  };
}

const testServerId = McpServerId.make("test-server-id");
const redirectUri = "http://127.0.0.1:34339/callback";

it.effect("returns the cached access token when far from expiry, without needing a refresh", () =>
  Effect.gen(function* () {
    const secrets = makeInMemorySecretStore();
    const now = yield* Clock.currentTimeMillis;
    yield* writeTokens(secrets, testServerId, {
      accessToken: "cached-token",
      refreshToken: "refresh-token",
      expiresAtMs: now + 60 * 60_000,
    });
    const token = yield* getFreshAccessToken(
      secrets,
      testServerId,
      "https://example.com/mcp",
      redirectUri,
    );
    assert.deepStrictEqual(token, Option.some("cached-token"));
  }),
);

it.effect("returns none, without throwing, when there are no stored tokens at all", () =>
  Effect.gen(function* () {
    const secrets = makeInMemorySecretStore();
    const token = yield* getFreshAccessToken(
      secrets,
      testServerId,
      "https://example.com/mcp",
      redirectUri,
    );
    assert.deepStrictEqual(token, Option.none());
  }),
);
