import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type ChangeRequestCheck,
  type ChangeRequestCheckStatus,
} from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly author?: string | null;
  readonly assignees?: ReadonlyArray<string>;
  readonly checks?: ReadonlyArray<ChangeRequestCheck>;
}

const GitHubActorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  // gh < 2.47 exports headRepository as {id, name} only; nameWithOwner was
  // added later. Both fields stay optional so a version-drifted gh CLI can
  // never fail the decode and silently drop the PR from the list.
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  author: Schema.optional(Schema.NullOr(GitHubActorSchema)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(GitHubActorSchema))),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const GitHubStatusCheckSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  workflowName: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeCheckStatus(input: {
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
  readonly state?: string | null | undefined;
}): ChangeRequestCheckStatus | null {
  const conclusion = input.conclusion?.trim().toUpperCase();
  switch (conclusion) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    case "CANCELLED":
      return "cancel";
    case "STALE":
      return "fail";
  }

  switch (input.state?.trim().toUpperCase()) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
      return "fail";
    case "PENDING":
    case "EXPECTED":
      return "pending";
  }

  switch (input.status?.trim().toUpperCase()) {
    case "COMPLETED":
      return "pending";
    case "QUEUED":
    case "IN_PROGRESS":
    case "REQUESTED":
    case "WAITING":
      return "pending";
  }

  return null;
}

function normalizeGitHubChecks(
  rawChecks: ReadonlyArray<unknown> | null | undefined,
): ReadonlyArray<ChangeRequestCheck> | undefined {
  if (!rawChecks) return undefined;

  const checks: ChangeRequestCheck[] = [];
  for (const rawCheck of rawChecks) {
    const decoded = Schema.decodeUnknownExit(GitHubStatusCheckSchema)(rawCheck);
    if (Exit.isFailure(decoded)) continue;

    const name =
      trimOptionalString(decoded.value.name) ?? trimOptionalString(decoded.value.context);
    const status = normalizeCheckStatus(decoded.value);
    if (name === null || status === null) continue;

    const workflow = trimOptionalString(decoded.value.workflowName);
    const url =
      trimOptionalString(decoded.value.detailsUrl) ?? trimOptionalString(decoded.value.targetUrl);
    checks.push({
      name,
      status,
      ...(workflow ? { workflow } : {}),
      ...(url ? { url } : {}),
    });
  }

  return checks.length > 0 ? checks : undefined;
}

function actorHandle(
  actor: Schema.Schema.Type<typeof GitHubActorSchema> | null | undefined,
): string | null {
  return trimOptionalString(actor?.login) ?? trimOptionalString(actor?.name);
}

function normalizeGitHubPullRequestRecord(
  raw: Schema.Schema.Type<typeof GitHubPullRequestSchema>,
): NormalizedGitHubPullRequestRecord {
  const explicitNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryName = trimOptionalString(raw.headRepository?.name);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (explicitNameWithOwner?.includes("/") ? (explicitNameWithOwner.split("/")[0] ?? null) : null);
  const headRepositoryNameWithOwner =
    explicitNameWithOwner ??
    (headRepositoryOwnerLogin && headRepositoryName
      ? `${headRepositoryOwnerLogin}/${headRepositoryName}`
      : null);
  const author = actorHandle(raw.author);
  const assignees = (raw.assignees ?? [])
    .map(actorHandle)
    .filter((handle): handle is string => handle !== null);
  const checks = normalizeGitHubChecks(raw.statusCheckRollup);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    updatedAt: raw.updatedAt ?? Option.none(),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    ...(author ? { author } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
    ...(checks ? { checks } : {}),
  };
}

const decodeGitHubPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubPullRequest = decodeJsonResult(GitHubPullRequestSchema);
const decodeGitHubPullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);

export const formatGitHubJsonDecodeError = formatSchemaError;

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitHubPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGitHubPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
