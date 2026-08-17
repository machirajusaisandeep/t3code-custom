import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart, table, legend, and skeleton, so
 * adding a provider only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--foreground)",
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

/** The chart layers every series from zero, so order only controls how it is read. */
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
