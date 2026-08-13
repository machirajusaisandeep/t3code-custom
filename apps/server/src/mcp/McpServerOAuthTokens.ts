/**
 * Durable OAuth client-registration + token storage for user-configured MCP
 * servers, backed by `ServerSecretStore` — the same file-permission-secured
 * store already used for sensitive MCP headers (see `serverSettings.ts`).
 * Tokens and dynamic client registration never touch `settings.json`; only a
 * boolean `transport.oauth.authorized` marker lives there.
 *
 * This module is pure storage: it has no dependency on the MCP SDK's auth
 * flow and never fails loudly — every read degrades to "nothing stored"
 * rather than propagating a decode/IO error, since a corrupt or missing
 * OAuth secret should just mean "needs re-authorization," not a crash.
 *
 * @module McpServerOAuthTokens
 */
import type { McpServerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Absolute epoch-ms expiry, computed at fetch/refresh time from `expires_in`. */
  readonly expiresAtMs: number;
}

/** Refresh this many ms before expiry so a request never races an in-flight expiry. */
export const REFRESH_EARLY_MARGIN_MS = 5 * 60_000;

/** RFC 6749 doesn't require `expires_in`; fall back to a conservative 1-hour assumption when a server omits it. */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

const StoredMcpOAuthState = Schema.Struct({
  /** Opaque JSON-encoded `OAuthClientInformationMixed` from the SDK — shape is dictated by the remote server's registration response, not by us. */
  clientInformationJson: Schema.optional(Schema.String),
  accessToken: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  expiresAtMs: Schema.optional(Schema.Number),
});
type StoredMcpOAuthState = typeof StoredMcpOAuthState.Type;

const StoredMcpOAuthStateJson = Schema.fromJsonString(StoredMcpOAuthState);
const decodeState = Schema.decodeUnknownEffect(StoredMcpOAuthStateJson);
const encodeState = Schema.encodeEffect(StoredMcpOAuthStateJson);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type SecretStore = ServerSecretStore.ServerSecretStore["Service"];

function secretName(id: McpServerId): string {
  return `mcp-oauth-${Buffer.from(id, "utf8").toString("base64url")}`;
}

const readState = (
  secrets: SecretStore,
  id: McpServerId,
): Effect.Effect<Option.Option<StoredMcpOAuthState>> =>
  secrets.get(secretName(id)).pipe(
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed(Option.none<StoredMcpOAuthState>())
        : decodeState(textDecoder.decode(bytes.value)).pipe(Effect.map(Option.some)),
    ),
    Effect.orElseSucceed(() => Option.none<StoredMcpOAuthState>()),
  );

const writeState = (
  secrets: SecretStore,
  id: McpServerId,
  state: StoredMcpOAuthState,
): Effect.Effect<void> =>
  encodeState(state).pipe(
    Effect.flatMap((encoded) => secrets.set(secretName(id), textEncoder.encode(encoded))),
    Effect.orElseSucceed(() => undefined),
  );

/** Clears all stored OAuth state (client registration + tokens) for a server. */
export const clearState = (secrets: SecretStore, id: McpServerId): Effect.Effect<void> =>
  secrets.remove(secretName(id)).pipe(Effect.orElseSucceed(() => undefined));

export const readClientInformation = (
  secrets: SecretStore,
  id: McpServerId,
): Effect.Effect<unknown | undefined> =>
  readState(secrets, id).pipe(
    Effect.map((state) =>
      Option.isSome(state) && state.value.clientInformationJson !== undefined
        ? (JSON.parse(state.value.clientInformationJson) as unknown)
        : undefined,
    ),
  );

export const writeClientInformation = (
  secrets: SecretStore,
  id: McpServerId,
  clientInformation: unknown,
): Effect.Effect<void> =>
  readState(secrets, id).pipe(
    Effect.flatMap((existing) =>
      writeState(secrets, id, {
        ...Option.getOrElse(existing, () => ({}) as StoredMcpOAuthState),
        clientInformationJson: JSON.stringify(clientInformation),
      }),
    ),
  );

export const readTokens = (
  secrets: SecretStore,
  id: McpServerId,
): Effect.Effect<McpOAuthTokens | undefined> =>
  readState(secrets, id).pipe(
    Effect.map((state) => {
      if (Option.isNone(state)) return undefined;
      const { accessToken, refreshToken, expiresAtMs } = state.value;
      if (!accessToken || expiresAtMs === undefined) return undefined;
      return { accessToken, ...(refreshToken ? { refreshToken } : {}), expiresAtMs };
    }),
  );

export const writeTokens = (
  secrets: SecretStore,
  id: McpServerId,
  tokens: McpOAuthTokens,
): Effect.Effect<void> =>
  readState(secrets, id).pipe(
    Effect.flatMap((existing) =>
      writeState(secrets, id, {
        ...Option.getOrElse(existing, () => ({}) as StoredMcpOAuthState),
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiresAtMs: tokens.expiresAtMs,
      }),
    ),
  );

/** Clears only the tokens, keeping client registration — used when a refresh token turns out to be invalid but the client registration is presumably still good. */
export const clearTokens = (secrets: SecretStore, id: McpServerId): Effect.Effect<void> =>
  readState(secrets, id).pipe(
    Effect.flatMap((existing) => {
      if (Option.isNone(existing)) return Effect.void;
      const {
        accessToken: _accessToken,
        refreshToken: _refreshToken,
        expiresAtMs: _expiresAtMs,
        ...rest
      } = existing.value;
      return writeState(secrets, id, rest);
    }),
  );
