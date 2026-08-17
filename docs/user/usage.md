# Usage

Usage shows raw token cost and processed tokens scanned from the provider CLIs on each connected
environment — Claude Code, Codex, and Grok. It reads the providers' local session history, so turns
you ran outside T3 Code still count, as long as their transcripts are on that machine. Cost figures
are the API-equivalent price of the tokens, not what a subscription billed; Grok's own per-turn cost
is used when the transcript includes it.

Open **Usage** from the sidebar. Use **Past 24h** for an hourly chart covering the exact rolling
24-hour period. The **7 days**, **30 days**, and **90 days** ranges use daily resolution. Cost and
token toggles update the headline, the chart, and the breakdown together, and refreshing rescans
every connected environment.

The metrics strip also reports cached vs. uncached input tokens, output tokens, and cache savings
compared to full API rates.

## Filters

- **Provider.** Tap Codex, Claude Code, or Grok next to the chart to hide or
  show that series. Totals, the chart, and the breakdown all follow the same
  selection.
- **Model.** Use the model menu to include only some models, or tap a row in
  the model breakdown to isolate it. Tap the same row again, or choose
  **Show all models**, to clear the filter.

On mobile the same filters live on the provider chips and the **By model** list.
