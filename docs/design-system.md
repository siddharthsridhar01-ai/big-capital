# BIG Capital — Brand & Design System

This document is the source of truth for visual design across the PM interface, the public website, factsheets, and any future surface. Everything we build references this.

## Design philosophy

**Tradition over trend.** BIG Capital looks like an established asset manager from the boutique British/European tradition (Fundsmith, J O Hambro, Lindsell Train, Baillie Gifford, Ruffer), not a fintech startup (Robinhood, Wealthfront, Betterment). The logo's deep navy and serif wordmark set this direction explicitly.

**Editorial, not dashboard-y.** Even the internal PM tools should feel closer to reading a well-typeset journal than operating a trading terminal. Generous whitespace, deliberate typography, sober tables, restrained color. Numbers are presented with care — tabular figures, right-aligned, properly formatted.

**Restraint is a feature.** No gradients. No glass effects. No animated background blobs. No purple. No neon. No emoji in the UI. The visual hierarchy comes from typography weight, spacing, and the navy/white/grey palette — nothing else.

**Charts are quiet.** Single-color line charts on white with thin gridlines. No 3D, no shadows, no gratuitous color. Performance is shown with one navy line for the fund and one grey line for the benchmark. That's the whole vocabulary.

## Color palette

The palette is deliberately small. Five colors do everything.

| Token | Hex | RGB | Use |
|-------|-----|-----|-----|
| `--navy` | `#00183A` | 0, 24, 58 | Primary brand color. Logo, headings, primary buttons, primary chart line. The signature color — used assertively. |
| `--navy-soft` | `#1F3458` | 31, 52, 88 | Hover / pressed states on primary, secondary headings |
| `--ink` | `#0A0A0A` | 10, 10, 10 | Body text. Near-black, not pure black — softer on the eye on white paper-like backgrounds. |
| `--paper` | `#FAFAF7` | 250, 250, 247 | Page background. Slight warm off-white — evokes paper, not screen. |
| `--rule` | `#D9D9D2` | 217, 217, 210 | Table borders, dividers, subtle separators. Warm grey to harmonise with paper. |
| `--muted` | `#6B6B66` | 107, 107, 102 | Secondary text, labels, metadata, axis labels |
| `--positive` | `#1F5C3A` | 31, 92, 58 | Positive returns, gains — dark forest green, NOT bright green. Used sparingly. |
| `--negative` | `#7A1F1F` | 122, 31, 31 | Negative returns, losses — deep claret red, NOT alarm red. Used sparingly. |
| `--white` | `#FFFFFF` | 255, 255, 255 | Card surfaces, table backgrounds inside paper-coloured pages |

**Hard rules:**
- Never use `--positive` or `--negative` for emphasis — only for actual P&L signed values.
- Black-on-white text is **not allowed**. Use `--ink` on `--paper` or `--white`.
- The primary chart line is always `--navy`. Benchmark is always `--muted` at 60% opacity or `--rule` with a dashed stroke.
- No color outside this palette ever appears in the UI without an explicit decision.

## Typography

Two typefaces, both serving the editorial direction.

**Display & headings: Tiempos Headline, or Source Serif Pro, or Lora** (in order of preference; Lora is the free Google Fonts fallback if Tiempos licensing is out of reach for a student fund). All three are transitional/modern serifs with the contrast and authority that match the logo wordmark.

**Body & UI: Inter? No.** Per the design philosophy, generic UI sans is wrong here. Use **Söhne** (paid, ideal) or **Söhne Breit**, or as a free alternative, **Roboto Serif** for short body text and **IBM Plex Sans** for genuine UI affordances (buttons, form labels, table headers where the serif would feel heavy).

**Numerals: always tabular figures.** All numbers in the UI use tabular figures so they align in columns. In CSS: `font-feature-settings: "tnum" 1, "lnum" 1;` everywhere a number is rendered.

### Type scale (rem)

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `--text-display` | 3.5rem (56px) | 400 | Marketing hero, factsheet covers |
| `--text-h1` | 2.5rem (40px) | 400 | Fund name on fund page |
| `--text-h2` | 1.875rem (30px) | 400 | Section headings ("Top Holdings") |
| `--text-h3` | 1.375rem (22px) | 500 | Sub-sections |
| `--text-lead` | 1.125rem (18px) | 400 | Strategy summary, briefing intro |
| `--text-body` | 1rem (16px) | 400 | Default reading text |
| `--text-small` | 0.875rem (14px) | 400 | Table cells, metadata |
| `--text-caption` | 0.75rem (12px) | 500 | Labels, axis values, footnotes — slightly heavier so they hold up at small size |

All headings use the display serif. All body uses the body serif. UI affordances use the sans.

## Spacing

8-pixel base grid. Tokens: `--space-1` through `--space-12` in multiples of 8px (1 = 8, 2 = 16, 3 = 24, 4 = 32, 6 = 48, 8 = 64, 12 = 96).

**Page rhythm:**
- Page top padding on factsheet/fund pages: `--space-12` (96px)
- Section spacing: `--space-8` (64px) between major sections, `--space-6` (48px) between sub-sections
- Component internal padding: `--space-3` to `--space-4`
- Generous whitespace around tables — they're the focal point of factsheets

## Components

### Tables (the most important component)

Tables are central to a fund platform. They get the most care.

- Border style: 1px solid `--rule` on **bottom of header row only** and **bottom of last row only**. No outer border, no internal verticals, no zebra striping. Inspired by FT, Economist, and academic statistical tables.
- Header: small caps, `--muted` color, `--text-caption` size, letter-spacing 0.04em, padding-bottom 12px.
- Cells: `--text-small`, `--ink` color, padding 10px vertical 16px horizontal, baseline-aligned.
- Numbers: tabular figures, right-aligned.
- Currency: prefixed symbol (£, $, €) tight to the number — `£100,000.00` not `£ 100,000.00`.
- Percentages: trailing `%` tight to the number. Two decimal places for returns (`+12.34%`), one for weights (`8.2%`), zero for exposures (`98%`).
- Signed numbers: explicit `+` for gains. Use the colour tokens (`--positive` / `--negative`) sparingly — only in P&L columns, not in performance tables (since side-by-side coloured cells get noisy fast).

### Buttons

- Primary: `--navy` background, white text, 1px solid `--navy` border, 6px radius (almost square — no pill shapes), `--text-small`, 500 weight, sans typeface, padding 10px 20px.
- Secondary: transparent background, `--navy` text, 1px solid `--navy` border.
- Tertiary (text link): `--navy` text with 1px solid `--navy` underline, offset 4px from baseline.
- Destructive: `--negative` border and text on white. We do not use destructive primaries — destructive actions always require confirmation.

No drop shadows. No gradients. No transitions beyond simple opacity/color fades at 150ms.

### Cards

- White surface on `--paper` background.
- 1px solid `--rule` border, no radius (or 4px max for soft pages — straight corners by default).
- No shadow.
- Padding `--space-4` (32px) for primary content cards.

### Charts

- Single-line performance: `--navy` 1.5px stroke for the fund, `--muted` 1px dashed for benchmark.
- Bar charts (sector/geography weights): `--navy` bars on `--paper`, no grid lines, just baseline.
- Gridlines: 1px `--rule`, horizontal only.
- Axes: `--muted` color, `--text-caption` size, sans typeface.
- No legends inside the chart — label the lines directly at the right edge ("UK Equity Fund", "FTSE All-Share").
- No tooltips that obscure the chart — use a thin vertical guideline with values shown above the chart area.

### Forms (PM trade ticket)

This is the high-stakes UI surface. Decisions get made here.

- Inputs: 1px solid `--rule`, focus state 1px solid `--navy` with 2px outer ring of `--navy` at 10% opacity, no inset shadows.
- Labels above inputs, small caps, `--muted`, `--text-caption`.
- Validation errors: 1px solid `--negative`, error text in `--negative` below the input, no icons.
- Constraint warnings (soft violations): A bordered notice in `--navy-soft` with the constraint name in small caps and the violation explained in body text. PM checks a "I acknowledge" box and provides rationale to override.
- Constraint blocks (hard violations): A bordered notice in `--negative`, no override.

## The factsheet layout

This is the public canonical document. It must look like it could have been printed and handed to an investor in 1995 or 2025 with equal credibility.

**Top:** Fund name in `--text-h1`. Tagline (strategy summary) below in `--text-lead`. Right-aligned: as-of date, base currency, NAV, since-inception return.

**Below header:** Two-column performance table (1M / 3M / YTD / 1Y / 3Y / Since Inception, Fund vs Benchmark vs Excess).

**Middle:** Single performance chart spanning full content width. Modest height (320px). Fund and benchmark.

**Below chart:** Three sections side by side: Top 10 Holdings | Sector Breakdown | Geographic Breakdown. (Sector and geographic shown as small horizontal bar charts with labels.)

**Below:** Risk metrics table (volatility, Sharpe, max drawdown, beta).

**Below:** PM commentary — the monthly briefing, rendered as flowing serif body text, not in a card.

**Bottom:** Team section. PM with headshot, name, role, short bio. Analysts in a tighter grid below. Then disclaimers in `--text-caption`, `--muted`.

## What we don't do

- No animated counters on numbers (looks startup-y).
- No live tickers on the public site (we don't show live data publicly).
- No dark mode for the public site. Optional dark mode in the internal PM tool only, if I build it.
- No emoji.
- No "rocket" or "to the moon" language anywhere. Not even ironically.
- No stock photography of suits/handshakes/skyscrapers.
- No social media share buttons stuck to the side of factsheets.
- No cookie banner more intrusive than a single line at the bottom.

## Reference implementations

When in doubt, look at:
- **fundsmith.co.uk** — closest spiritual sibling, especially the factsheet
- **lindselltrain.com** — clean, sober, type-led
- **jhambro.com** — exactly the monthly briefing format we're modelling
- **ft.com** — for table treatment and chart restraint
- **bailliegifford.com** — for editorial feel of the fund pages
