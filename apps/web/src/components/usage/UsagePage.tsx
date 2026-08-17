import type { UsageProviderKind } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import {
  enumerateDays,
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import type { UsageViewFilters } from "@t3tools/shared/usageMerge";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { UsageChartLegend, UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

export function UsagePage() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "day">("model");
  const [enabledProviders, setEnabledProviders] = useState<ReadonlySet<UsageProviderKind> | null>(
    null,
  );
  const [enabledModels, setEnabledModels] = useState<ReadonlySet<string> | null>(null);

  // Recomputed only when the window length changes, so a re-render does not
  // shift the range and refetch every environment.
  const window = useMemo(() => makeWindow(windowDays), [windowDays]);
  const filters = useMemo((): UsageViewFilters | undefined => {
    if (enabledProviders === null && enabledModels === null) return undefined;
    return {
      ...(enabledProviders === null ? {} : { providers: enabledProviders }),
      ...(enabledModels === null ? {} : { models: enabledModels }),
    };
  }, [enabledModels, enabledProviders]);
  const { merged, all, environments, isPending, isPartial, refresh } = useUsage(window, filters);

  const visibleProviders = useMemo(
    () =>
      enabledProviders === null
        ? PROVIDER_ORDER
        : PROVIDER_ORDER.filter((provider) => enabledProviders.has(provider)),
    [enabledProviders],
  );

  const availableModels = useMemo(() => {
    if (enabledProviders === null) return all.models;
    return all.models.filter((model) => enabledProviders.has(model.provider));
  }, [all.models, enabledProviders]);

  const toggleProvider = useCallback((provider: UsageProviderKind) => {
    setEnabledProviders((current) => {
      const next = new Set(current ?? PROVIDER_ORDER);
      if (next.has(provider)) {
        if (next.size === 1) return current;
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next.size === PROVIDER_ORDER.length ? null : next;
    });
  }, []);

  const toggleModel = useCallback(
    (model: string) => {
      setEnabledModels((current) => {
        const catalog = availableModels.map((entry) => entry.model);
        const next = new Set(current ?? catalog);
        if (next.has(model)) {
          if (next.size === 1) return current;
          next.delete(model);
        } else {
          next.add(model);
        }
        return next.size === catalog.length ? null : next;
      });
    },
    [availableModels],
  );

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const settling = isPending || isPartial;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const recentDays = useMemo(() => merged.daily.toReversed().slice(0, 8), [merged.daily]);

  // Ranked by whatever the toggle is showing, so the bars always descend.
  const orderedProviders = useMemo(
    () =>
      merged.providers.toSorted((a, b) =>
        metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
      ),
    [merged.providers, metric],
  );

  const activeDays = merged.daily.filter((day) => day.totalTokens > 0).length;
  const dailyAverage = activeDays === 0 ? 0 : merged.totalTokens / activeDays;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
              <WorkspaceBreadcrumbItem current>Usage</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
              <WorkspaceBreadcrumbItem current>Usage</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                {formatDayShort(window.sinceDay)} to {formatDayShort(window.untilDay)}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-border">
                  {WINDOW_OPTIONS.map((option) => (
                    <button
                      key={option.days}
                      type="button"
                      onClick={() => setWindowDays(option.days)}
                      className={cn(
                        "cursor-pointer px-3 py-1.5 text-xs",
                        option.days === windowDays
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={refresh}
                  aria-label="Refresh usage"
                  className="cursor-pointer rounded-md border border-border p-2 text-muted-foreground hover:text-foreground"
                >
                  <RefreshCwIcon className="size-3.5" />
                </button>
              </div>
            </div>

            {settling ? (
              <>
                {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
                <UsageSkeleton />
              </>
            ) : (
              <>
                <UsageCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                />

                {/* Cost first: the financial answer, then the provider split. */}
                <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                  {/* The summary follows the chart toggle, so the headline and the
                  series are always reading the same units. */}
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs tracking-wide text-muted-foreground uppercase">
                        {metric === "cost" ? "Raw token cost" : "Processed tokens"}
                      </span>
                      <span className="text-4xl font-semibold text-foreground tabular-nums">
                        {metric === "cost"
                          ? `${formatUsd(merged.costUsd)}*`
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost"
                          ? "* if billed at full API rate"
                          : `Input, cache reads and output across ${formatCount(merged.sessions)} sessions.`}
                      </span>
                    </div>

                    {orderedProviders.map((provider) => {
                      const share = metric === "cost" ? provider.costShare : provider.tokenShare;
                      return (
                        <button
                          key={provider.provider}
                          type="button"
                          onClick={() => toggleProvider(provider.provider)}
                          className="flex cursor-pointer flex-col gap-1.5 text-left"
                        >
                          <div className="flex items-baseline justify-between">
                            <span className="flex items-center gap-2 text-sm text-foreground">
                              <ProviderMark provider={provider.provider} className="size-4" />
                              {PROVIDER_LABEL[provider.provider]}
                            </span>
                            <span className="text-sm text-foreground tabular-nums">
                              {metric === "cost"
                                ? formatUsd(provider.costUsd)
                                : formatTokens(provider.totalTokens)}
                            </span>
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full"
                              style={{
                                width: `${(share * 100).toFixed(1)}%`,
                                backgroundColor: PROVIDER_COLOR[provider.provider],
                              }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                              : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-sm font-medium text-foreground">
                        Daily {metric === "tokens" ? "processed tokens" : "cost"}
                      </h2>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex overflow-hidden rounded-md border border-border">
                          {(["cost", "tokens"] as const).map((option) => (
                            <button
                              key={option}
                              type="button"
                              onClick={() => setMetric(option)}
                              className={cn(
                                "cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase",
                                option === metric
                                  ? "bg-muted text-foreground"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                        <ModelFilter
                          models={availableModels}
                          selected={enabledModels}
                          onToggle={toggleModel}
                          onClear={() => setEnabledModels(null)}
                        />
                        <UsageChartLegend
                          providers={PROVIDER_ORDER}
                          selected={enabledProviders}
                          onToggle={toggleProvider}
                        />
                      </div>
                    </div>
                    <UsageProviderChart
                      days={days}
                      daily={merged.daily}
                      metric={metric}
                      providers={visibleProviders}
                    />
                  </div>
                </section>

                <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
                  <Metric
                    label="Processed tokens"
                    value={formatTokens(merged.totalTokens)}
                    detail={`${formatTokens(dailyAverage)} per active day`}
                  />
                  <Metric
                    label="Cached input"
                    value={formatTokens(merged.cachedInputTokens)}
                    detail={`${formatPercent(cachedShare)} of observed input`}
                  />
                  <Metric
                    label="Uncached input"
                    value={formatTokens(merged.uncachedInputTokens)}
                    detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
                  />
                  <Metric
                    label="Output"
                    value={formatTokens(merged.outputTokens)}
                    detail={`includes ${formatTokens(merged.reasoningTokens)} reasoning`}
                  />
                  <Metric
                    label="Cache savings"
                    value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                    detail={
                      merged.costUsd > 0
                        ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw token cost`
                        : "vs full input rates"
                    }
                  />
                </section>

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
                    <div className="flex overflow-hidden rounded-md border border-border">
                      {(["model", "day"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setBreakdown(option)}
                          className={cn(
                            "cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase",
                            option === breakdown
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>

                  {breakdown === "model" ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">Model</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {merged.models.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-muted-foreground">
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          merged.models.map((model) => (
                            <tr
                              key={`${model.provider}:${model.model}`}
                              className="cursor-pointer border-b border-border/50 hover:bg-muted/40"
                              onClick={() =>
                                setEnabledModels((current) =>
                                  current !== null && current.size === 1 && current.has(model.model)
                                    ? null
                                    : new Set([model.model]),
                                )
                              }
                            >
                              <td className="py-2 text-foreground">
                                <span className="flex items-center gap-2">
                                  <ProviderMark provider={model.provider} className="size-3.5" />
                                  {model.model}
                                </span>
                              </td>
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(model.costUsd)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatPercent(model.costShare)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(model.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">Day</th>
                          {visibleProviders.map((provider) => (
                            <th key={provider} className="py-2 text-right font-normal">
                              {PROVIDER_LABEL[provider]}
                            </th>
                          ))}
                          <th className="py-2 text-right font-normal">Total</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentDays.length === 0 ? (
                          <tr>
                            <td
                              colSpan={visibleProviders.length + 3}
                              className="py-6 text-center text-muted-foreground"
                            >
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          recentDays.map((day) => (
                            <tr key={day.day} className="border-b border-border/50">
                              <td className="py-2 text-foreground">{formatDayShort(day.day)}</td>
                              {visibleProviders.map((provider) => (
                                <td
                                  key={provider}
                                  className="py-2 text-right text-muted-foreground tabular-nums"
                                >
                                  {formatUsd(day.byProvider.get(provider)?.costUsd ?? 0)}
                                </td>
                              ))}
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(day.costUsd)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(day.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ModelFilter({
  models,
  selected,
  onToggle,
  onClear,
}: {
  readonly models: readonly { readonly model: string; readonly provider: UsageProviderKind }[];
  readonly selected: ReadonlySet<string> | null;
  readonly onToggle: (model: string) => void;
  readonly onClear: () => void;
}) {
  if (models.length === 0) return null;
  const label =
    selected === null
      ? "All models"
      : selected.size === 1
        ? (models.find((entry) => selected.has(entry.model))?.model ?? "1 model")
        : `${selected.size} models`;

  return (
    <Menu>
      <MenuTrigger
        className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[10px] tracking-wide text-muted-foreground uppercase hover:text-foreground"
        aria-label="Filter by model"
      >
        {label}
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {selected !== null ? (
          <button
            type="button"
            onClick={onClear}
            className="mb-1 w-full cursor-pointer px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            Show all models
          </button>
        ) : null}
        {models.map((entry) => (
          <MenuCheckboxItem
            key={`${entry.provider}:${entry.model}`}
            checked={selected === null || selected.has(entry.model)}
            onCheckedChange={() => onToggle(entry.model)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark provider={entry.provider} className="size-3.5" />
              <span className="truncate">{entry.model}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_MARK[provider];
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-background px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment that failed, or
 * one whose transcripts another environment already reported. Environments
 * that are still answering never reach this notice; the page shows the
 * loading skeleton until every one is terminal.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report usage.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded from totals.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border px-3 py-2 text-xs">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">
        {scanning.length === 1
          ? "1 device still scanning"
          : `${scanning.length} devices still scanning`}
      </span>
    </div>
  );
}

/** Deterministic bar heights (each unique: they double as keys). */
const SKELETON_BAR_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67];

/**
 * Static stand-in with the loaded page's shape: headline, provider split,
 * chart and metrics strip. No shimmer; blocks fill in exactly once when the
 * last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">
              Raw token cost
            </span>
            <div className="my-1.5 h-8 w-36 rounded-sm bg-muted" />
            <div className="h-3 w-28 rounded-sm bg-muted" />
          </div>

          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <ProviderMark provider={provider} className="size-4" />
                  {PROVIDER_LABEL[provider]}
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-1 w-full rounded-full bg-muted" />
              <div className="h-3 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="py-1 text-sm font-medium text-foreground">Daily cost</h2>
          {/* Mirrors the chart's h-56 body and w-14 axis gutter to avoid a
              relayout when the real chart swaps in. */}
          <div className="flex h-56 items-end gap-1 pl-16">
            {SKELETON_BAR_HEIGHTS.map((height) => (
              <div
                key={height}
                className="flex-1 rounded-sm bg-muted"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
        {["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map(
          (label) => (
            <div key={label} className="flex flex-col gap-0.5 bg-background px-4 py-3">
              <span className="text-xs text-muted-foreground">{label}</span>
              <div className="my-1 h-5 w-16 rounded-sm bg-muted" />
              <div className="h-3 w-24 rounded-sm bg-muted" />
            </div>
          ),
        )}
      </section>
    </>
  );
}
