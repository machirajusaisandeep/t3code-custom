import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    label: "Grok",
    color: "#a8a29e",
    mark: GrokIcon,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = Object.fromEntries(
  Object.entries(PROVIDER_PRESENTATION).map(([provider, presentation]) => [
    provider,
    presentation.label,
  ]),
) as Record<UsageProviderKind, string>;

export const PROVIDER_COLOR: Record<UsageProviderKind, string> = Object.fromEntries(
  Object.entries(PROVIDER_PRESENTATION).map(([provider, presentation]) => [
    provider,
    presentation.color,
  ]),
) as Record<UsageProviderKind, string>;

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills (`#d97757` for Claude, white on dark for OpenAI,
 * black/white for Grok), which are the same colours as the chart bands, so
 * swapping a colour dot for a mark keeps the series association intact rather
 * than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = Object.fromEntries(
  Object.entries(PROVIDER_PRESENTATION).map(([provider, presentation]) => [
    provider,
    presentation.mark,
  ]),
) as Record<UsageProviderKind, Icon>;

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
