/**
 * `OAuthClientProvider` adapter bridging the MCP SDK's Promise-based OAuth
 * client interface to `ServerSecretStore`-backed storage
 * (`McpServerOAuthTokens.ts`).
 *
 * Two call sites construct this with different `interactive` values:
 *  - `McpServerOAuthFlow.authorizeMcpServer` (`interactive: true`) — the only
 *    place a browser redirect is ever allowed to happen.
 *  - `getFreshAccessToken` below, and `McpServerRegistry.buildTransport`'s
 *    "test connection" transport (`interactive: false`) — here
 *    `redirectToAuthorization` throws instead of prompting. This makes an
 *    interactive redirect from background/diagnostic code structurally
 *    impossible, even though both paths ultimately call the SDK's own
 *    `auth()` under the hood (which tries a token refresh before ever
 *    reaching a redirect).
 *
 * @module McpServerOAuthProvider
 */
import type { McpServerId } from "@t3tools/contracts";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  clearState,
  clearTokens,
  DEFAULT_TOKEN_TTL_SECONDS,
  readClientInformation,
  readTokens,
  REFRESH_EARLY_MARGIN_MS,
  type SecretStore,
  writeClientInformation,
  writeTokens,
} from "./McpServerOAuthTokens.ts";

/** Thrown by a non-interactive provider's `redirectToAuthorization` — the structural guard described above. */
export class McpOAuthInteractionRequiredError extends Error {
  constructor() {
    super("This MCP server needs interactive re-authorization.");
  }
}

export interface McpOAuthProviderOptions {
  readonly id: McpServerId;
  readonly secrets: SecretStore;
  readonly redirectUri: string;
  readonly interactive: boolean;
  /** CSRF state for this one attempt. Only meaningful when `interactive` is true — an interactive flow never reaches the redirect branch, so this is never read there. */
  readonly state?: string;
  /** Only invoked when `interactive` is true. */
  readonly onRedirect?: (url: URL) => void;
}

export function createMcpOAuthClientProvider(
  options: McpOAuthProviderOptions,
): OAuthClientProvider {
  let pendingCodeVerifier: string | undefined;

  return {
    get redirectUrl() {
      return options.interactive ? options.redirectUri : undefined;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "T3 Code",
        redirect_uris: [options.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => options.state ?? "",
    clientInformation: () =>
      Effect.runPromise(readClientInformation(options.secrets, options.id)) as Promise<
        OAuthClientInformationMixed | undefined
      >,
    saveClientInformation: (clientInformation) =>
      Effect.runPromise(writeClientInformation(options.secrets, options.id, clientInformation)),
    tokens: () =>
      Effect.runPromise(readTokens(options.secrets, options.id)).then(
        (tokens): OAuthTokens | undefined =>
          tokens
            ? {
                access_token: tokens.accessToken,
                token_type: "Bearer",
                ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
              }
            : undefined,
      ),
    saveTokens: (tokens) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* writeTokens(options.secrets, options.id, {
            accessToken: tokens.access_token,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
            expiresAtMs: now + (tokens.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
          });
        }),
      ),
    redirectToAuthorization: (url) => {
      if (!options.interactive) {
        throw new McpOAuthInteractionRequiredError();
      }
      options.onRedirect?.(url);
    },
    saveCodeVerifier: (codeVerifier) => {
      pendingCodeVerifier = codeVerifier;
    },
    codeVerifier: () => {
      if (pendingCodeVerifier === undefined) {
        throw new Error("No PKCE code verifier available for this MCP OAuth flow.");
      }
      return pendingCodeVerifier;
    },
    invalidateCredentials: (scope) =>
      Effect.runPromise(
        scope === "tokens"
          ? clearTokens(options.secrets, options.id)
          : scope === "all"
            ? clearState(options.secrets, options.id)
            : Effect.void,
      ),
  };
}

/**
 * Non-interactive read of a currently-valid access token, refreshing via the
 * stored refresh token when near expiry. Never triggers a browser redirect —
 * the provider it builds always has `interactive: false`, so any refresh
 * failure (invalid/expired refresh token, network error, or no refresh token
 * at all) surfaces as `Option.none()` rather than a thrown error or an
 * interactive flow. Callers should treat `Option.none()` as "needs
 * re-authorization," not as a hard failure.
 */
export const getFreshAccessToken = (
  secrets: SecretStore,
  id: McpServerId,
  serverUrl: string,
  redirectUri: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const stored = yield* readTokens(secrets, id);
    if (!stored) return Option.none();
    const now = yield* Clock.currentTimeMillis;
    if (stored.expiresAtMs - REFRESH_EARLY_MARGIN_MS > now) {
      return Option.some(stored.accessToken);
    }

    const provider = createMcpOAuthClientProvider({
      id,
      secrets,
      redirectUri,
      interactive: false,
    });
    const authorized = yield* Effect.tryPromise({
      try: () => auth(provider, { serverUrl }),
      catch: () => "refresh-failed" as const,
    }).pipe(
      Effect.map((result) => result === "AUTHORIZED"),
      Effect.orElseSucceed(() => false),
    );
    if (!authorized) {
      // Refresh failed (or a redirect would have been required) — clear
      // stale state so the UI reflects "needs re-authorization" rather than
      // silently retrying a dead refresh token on every future tick.
      yield* clearState(secrets, id);
      return Option.none();
    }

    const refreshed = yield* readTokens(secrets, id);
    return refreshed ? Option.some(refreshed.accessToken) : Option.none();
  });
