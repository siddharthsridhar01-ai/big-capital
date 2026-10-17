/**
 * The cash rate: one number for both the cash hurdle and Sharpe's risk-free rate.
 *
 * These were separate and both wrong. The hurdle was hardcoded at 4.3%, which
 * was SOFR in mid-2025; by August 2026 SOFR had fallen to roughly 3.66%, so the
 * neutral funds were measured against a return cash had not paid for a year.
 * Sharpe, meanwhile, used a risk-free rate of ZERO, which overstates it badly
 * whenever cash pays anything: at 4% cash, a fund returning 6% at 10%
 * volatility has a true Sharpe of about 0.2, but read as 0.6.
 *
 * Holding one figure here keeps them consistent — the hurdle IS the risk-free
 * rate, so a fund that only matches its hurdle correctly shows a Sharpe of zero.
 *
 * It is a constant, reviewed rather than fetched. A live SOFR feed would track
 * it exactly, but it is one more pipeline to keep alive for a number that moves
 * slowly. Update it when policy rates move materially. Last set: August 2026.
 */
export const CASH_RATE_ANNUAL = 0.0365;

/** Trading days per year, for daily accrual and annualisation. */
export const TRADING_DAYS = 252;
