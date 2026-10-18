/**
 * Default limits for each fund, derived from its mandate.
 *
 * Shared by the one-off setter route and the admin limits editor's "reset to
 * defaults", so there is a single definition. Edits made in the admin editor are
 * stored in fund_constraints and take effect immediately; these are only what a
 * reset restores.
 */

export interface LimitDefault {
  type: string;
  value: unknown;
  isHard: boolean;
}

/**
 * HARD vs SOFT, and why the split falls where it does.
 *
 * Hard limits block the trade outright. Soft limits warn and ask for a written
 * justification.
 *
 * Concentration limits — position size, sector weight, number of names — are
 * SOFT. A PM who wants to run a position above the cap may, provided they write
 * down why, and that justification is recorded on the trade and reported to the
 * admins. The judgement is theirs to make and defend; the point of the limit is
 * that it cannot be exceeded quietly.
 *
 * What made the 800%-of-NAV trade possible was not softness here, it was the
 * absence of any solvency rule: the fund could spend cash it did not hold. That
 * is blocked in checkTrade and cannot be overridden.
 *
 * Deployment limits — minimum and maximum cash — stay SOFT. They describe pace
 * rather than risk: holding too much cash is a judgement to explain, not an act
 * to prevent, and they are exempt during the first 90 days anyway. Spending cash
 * the fund does not have is blocked separately by the solvency check in
 * checkTrade, which cannot be overridden at all.
 *
 * Note a position may still DRIFT above its cap as prices move. That is not a
 * breach of this rule, which governs trades; the limits panel will show it and
 * the PM is expected to trim.
 */

export const DEFAULT_LIMITS: Record<string, { rationale: string; constraints: LimitDefault[] }> = {
  // Contrarian value, FTSE 350. Diversified by construction; UK index sector
  // weights are lumpy (financials, energy) so the sector cap stays generous.
  "european-equity": {
    // MSCI Europe is less lumpy than the UK at the sector level — no single
    // energy-and-financials concentration — but healthcare and industrials both
    // run high, so 35% remains a sensible ceiling. The name cap stays at 40: a
    // growth core with contrarian satellites needs room for both without
    // becoming a tracker.
    rationale: "Long-only Europe inc. UK: quality growth core with contrarian positions",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "long_only", value: true, isHard: true },
      { type: "max_position_pct", value: 0.08, isHard: false },
      { type: "min_cash_pct", value: 0.02, isHard: false },
      { type: "max_cash_pct", value: 0.15, isHard: false },
      { type: "max_single_sector_pct", value: 0.35, isHard: false },
      { type: "max_position_count", value: 40, isHard: false },
    ],
  },

  // "A focused portfolio of 15-20 names" with an initial emphasis on staples.
  // Focus means larger positions and fewer of them; the sector cap is loose
  // enough to permit the stated starting tilt without an immediate breach.
  "global-equity": {
    rationale: "Long-only quality, focused 15–20 names with an initial staples tilt",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "long_only", value: true, isHard: true },
      { type: "max_position_pct", value: 0.12, isHard: false },
      { type: "min_cash_pct", value: 0.02, isHard: false },
      { type: "max_cash_pct", value: 0.15, isHard: false },
      { type: "max_single_sector_pct", value: 0.45, isHard: false },
      { type: "max_position_count", value: 25, isHard: false },
    ],
  },

  // "Net-long bias", concentrated, up to 20 positions, single-name shorts.
  // Net cap must ACCOMMODATE the bias rather than forbid it: 80% net allows a
  // conventional long-biased book while still ruling out an unhedged 100% long.
  "long-short": {
    rationale: "Net-long bias: net cap raised from the market-neutral 20% to 80%",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 1.8, isHard: true },
      { type: "max_net_exposure", value: 0.8, isHard: true },
      { type: "max_position_pct", value: 0.08, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.4, isHard: false },
      { type: "max_single_sector_pct", value: 0.4, isHard: false },
      { type: "max_position_count", value: 20, isHard: false },
    ],
  },

  // "Balanced book of 12-14 positions... independent of broad market direction."
  // Neutrality is the product, so the net cap is tight and hard.
  "market-neutral": {
    rationale: "True market neutrality: hard ±10% net, balanced 12–14 name book",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 2.0, isHard: true },
      { type: "max_net_exposure", value: 0.1, isHard: true },
      { type: "max_position_pct", value: 0.1, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.5, isHard: false },
      { type: "max_single_sector_pct", value: 0.3, isHard: false },
      { type: "max_position_count", value: 16, isHard: false },
    ],
  },

  // "Rules-based... portfolio optimisation... across a diversified book."
  // Systematic books hold many small positions; a 4% cap and an 80-name ceiling
  // reflect optimiser output rather than discretionary conviction sizing.
  // Long/short, structured 130/30: up to 130% long and 30% short, net close to
  // fully invested. The standard shape for a systematic book — the model ranks
  // the universe, longs the top and shorts the bottom — and it keeps the S&P 500
  // a valid benchmark, since net exposure stays near 100%. Gross is the hard
  // leverage limit; net is capped at 100% so the fund cannot run levered long.
  // The engine has no minimum net, so staying near 100% is the PM's discipline.
  "systematic-equity": {
    rationale: "Systematic 130/30: diversified long and short book, net near fully invested",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 1.6, isHard: true },
      { type: "max_net_exposure", value: 1.0, isHard: true },
      { type: "max_position_pct", value: 0.04, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.4, isHard: false },
      { type: "max_single_sector_pct", value: 0.3, isHard: false },
      { type: "max_position_count", value: 100, isHard: false },
    ],
  },

  // Pair trades only, 2-5 pairs (4-10 positions), mega-cap tech. Concentration
  // IS the strategy, so the position cap is deliberately loose. A sector cap is
  // meaningless in a single-sector fund and is set to 100% rather than removed,
  // so the panel still shows the measurement.
  "tech-relative-value": {
    rationale: "Tech pairs: hard ±10% net, concentrated by design, sector cap not applicable",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 2.0, isHard: true },
      { type: "max_net_exposure", value: 0.1, isHard: true },
      { type: "max_position_pct", value: 0.15, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.6, isHard: false },
      { type: "max_single_sector_pct", value: 1.0, isHard: false },
      { type: "max_position_count", value: 12, isHard: false },
    ],
  },
};
