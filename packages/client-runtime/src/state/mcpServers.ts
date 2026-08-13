import {
  type EnvironmentId,
  type McpServerId,
  type McpServerTestConnectionResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
  runStreamInEnvironment,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { runStream } from "../rpc/client.ts";

export type McpServerOAuthAuthorizeState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "awaiting-authorization"; readonly authorizationUrl: string }
  | { readonly status: "ok"; readonly toolNames: ReadonlyArray<string> }
  | { readonly status: "error"; readonly detail?: string };

const IDLE_OAUTH_STATE: McpServerOAuthAuthorizeState = { status: "idle" };

const oauthAuthorizeStateAtom = Atom.family((key: string) =>
  Atom.make<McpServerOAuthAuthorizeState>(IDLE_OAUTH_STATE).pipe(
    Atom.withLabel(`environment-data:mcp-servers:oauth-state:${key}`),
  ),
);

function oauthStateKey(environmentId: EnvironmentId, id: string): string {
  return `${environmentId}:${id}`;
}

export function createMcpServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();

  const authorize = createRuntimeCommand<
    EnvironmentRegistry | EnvironmentCacheStore | R,
    E,
    { readonly environmentId: EnvironmentId; readonly input: { readonly id: McpServerId } },
    McpServerTestConnectionResult,
    unknown
  >(runtime, {
    label: "environment-data:mcp-servers:oauth-authorize",
    scheduler: commandScheduler,
    concurrency: {
      mode: "serial",
      key: (target) => oauthStateKey(target.environmentId, target.input.id),
    },
    execute: (target, atomRegistry) => {
      const stateAtom = oauthAuthorizeStateAtom(
        oauthStateKey(target.environmentId, target.input.id),
      );
      atomRegistry.set(stateAtom, { status: "pending" });
      let terminal: McpServerTestConnectionResult | undefined;
      return runStreamInEnvironment(
        target.environmentId,
        runStream(WS_METHODS.mcpServersOAuthAuthorize, target.input),
      ).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "awaiting-authorization") {
              atomRegistry.set(stateAtom, {
                status: "awaiting-authorization",
                authorizationUrl: event.authorizationUrl,
              });
            } else {
              terminal = event.result;
            }
          }),
        ),
        Effect.map((): McpServerTestConnectionResult => {
          const result = terminal ?? {
            status: "error" as const,
            toolNames: [],
            detail: "Authorization ended unexpectedly.",
          };
          atomRegistry.set(
            stateAtom,
            result.status === "ok"
              ? { status: "ok", toolNames: result.toolNames }
              : { status: "error", ...(result.detail ? { detail: result.detail } : {}) },
          );
          return result;
        }),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            atomRegistry.set(stateAtom, { status: "error", detail: String(cause) });
          }),
        ),
      );
    },
  });

  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-servers:list",
      tag: WS_METHODS.mcpServersList,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:upsert",
      tag: WS_METHODS.mcpServersUpsert,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:remove",
      tag: WS_METHODS.mcpServersRemove,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    testConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:test-connection",
      tag: WS_METHODS.mcpServersTestConnection,
    }),
    authorize,
    authorizeState: (target: { readonly environmentId: EnvironmentId; readonly id: string }) =>
      oauthAuthorizeStateAtom(oauthStateKey(target.environmentId, target.id)),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:oauth-revoke",
      tag: WS_METHODS.mcpServersOAuthRevoke,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
