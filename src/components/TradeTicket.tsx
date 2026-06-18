"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import Decimal from "decimal.js";
import { serif, numeric } from "@/lib/typography";
import PdfMemoCard from "@/components/PdfMemoCard";
import { useIntradayPrices } from "@/hooks/useIntradayPrices";

// Simplified short-borrow-fee model: every fund assumes a flat annual borrow
// rate of 2.00% on shorted positions. Real borrow rates vary by security and
// liquidity — hard-to-borrow names can run 10-50% annually. This is a
// simplifying assumption appropriate for a paper-trading student fund.
// Phase 2b.4 will move this to `funds.assumed_short_borrow_rate_bps` and
// accrue daily via a background job.
const ASSUMED_SHORT_BORROW_RATE_BPS = 200; // 2.00% per annum

// ---------------------------------------------------------------------------
// Props from server
// ---------------------------------------------------------------------------

export interface TradeTicketProps {
  fund: {
    id: string;
    name: string;
    slug: string;
    baseCurrency: "GBP" | "USD" | "EUR";
    startingNav: string;
    tradingFeesBps: number;
    isLongShort: boolean;
  };
  security: {
    id: string;
    ticker: string;
    exchange: string;
    name: string;
    currency: "GBP" | "USD" | "EUR";
    gicsSector: string | null;
  };
  latestPrice: string | null;
  fxRateToBase: string; // 1 if same currency
  // Snapshot of current portfolio state for projections
  portfolioSnapshot: {
    nav: string; // current fund NAV in base ccy
    cashBalance: string; // current cash in base ccy
    currentPositionWeight: string; // 0..1, this security's current weight
    currentPositionQuantity: string; // shares (signed, negative for short)
    currentSectorWeight: string; // 0..1, current sector weight
    positionCount: number;
    grossExposure: string; // 0..N, only relevant for L/S
    netExposure: string; // -1..1, only relevant for L/S
  };
}

interface UploadedMemo {
  url: string;
  filename: string;
  sizeBytes: number;
}

interface ConstraintViolationResponse {
  constraintId: string;
  constraintType: string;
  isHard: boolean;
  message: string;
  currentValue: string;
  limit: string;
}

interface ConstraintCheck {
  pass: boolean;
  hardViolations: ConstraintViolationResponse[];
  softViolations: ConstraintViolationResponse[];
}

// ---------------------------------------------------------------------------
// Thesis (Phase 2c) types
// ---------------------------------------------------------------------------

type Conviction = "high" | "medium" | "low";
type HoldingPeriod = "short" | "medium" | "long" | "indefinite";

const PERIOD_LABELS: Record<HoldingPeriod, string> = {
  short: "Short (< 3 months)",
  medium: "Medium (3-12 months)",
  long: "Long (1-3 years)",
  indefinite: "Indefinite",
};

// A thesis as returned by GET /api/funds/[slug]/theses?securityId=...
interface ThesisOption {
  id: string;
  status: string;
  direction: string | null;
  conviction: string;
  holdingPeriod: string;
  summary: string;
  openedAt: string;
  memoBlobUrl: string | null;
  memoBlobFilename: string | null;
}

// ---------------------------------------------------------------------------
// Size mode logic
// ---------------------------------------------------------------------------

type Side = "buy" | "sell" | "short" | "cover";

interface ComputedSize {
  shares: Decimal; // unsigned
  notionalBase: Decimal; // in fund base ccy
  notionalNative: Decimal; // in security ccy
  weightTarget: Decimal; // 0..1
}

function fmtMoney(d: Decimal, currency: "GBP" | "USD" | "EUR"): string {
  const sym = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const n = d.toNumber();
  const formatted = new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return `${sym}${formatted}`;
}

function fmtPct(d: Decimal, decimals = 2): string {
  return `${d.times(100).toFixed(decimals)}%`;
}

/**
 * Like fmtPct but explicitly signed — always shows + or − prefix. Used for
 * the position-row display so a short position reads "-1.12%" rather than
 * silently dropping the negative sign or showing a bare "1.12%" that's
 * indistinguishable from a long.
 */
function fmtPctSigned(d: Decimal, decimals = 2): string {
  const value = d.times(100);
  if (value.isZero()) return `0.${"0".repeat(decimals)}%`;
  const sign = value.isNegative() ? "−" : "+";
  return `${sign}${value.abs().toFixed(decimals)}%`;
}

function fmtShares(d: Decimal): string {
  return new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(d.toNumber());
}

/**
 * Determines what tone (none, soft, hard) applies to a projection row,
 * given the latest constraint check result and the set of constraint types
 * that would map to that row.
 */
function toneForRow(
  check: ConstraintCheck | null,
  constraintTypes: string[]
): "ok" | "soft" | "hard" | undefined {
  if (!check) return undefined;
  const hardHit = check.hardViolations.some((v) =>
    constraintTypes.includes(v.constraintType)
  );
  if (hardHit) return "hard";
  const softHit = check.softViolations.some((v) =>
    constraintTypes.includes(v.constraintType)
  );
  if (softHit) return "soft";
  return undefined;
}

/**
 * Compact display name for GICS sectors. Most fit fine as-is; the very long
 * ones get abbreviated so they don't break the projection-row layout.
 */
function shortSectorLabel(sector: string | null): string {
  if (!sector) return "Sector";
  const aliases: Record<string, string> = {
    "Information Technology": "IT",
    "Communication Services": "Comms Services",
    "Consumer Discretionary": "Consumer Disc.",
    "Consumer Staples": "Consumer Staples",
  };
  return aliases[sector] ?? sector;
}

// ---------------------------------------------------------------------------

export default function TradeTicket(props: TradeTicketProps) {
  const {
    fund,
    security,
    latestPrice,
    fxRateToBase,
    portfolioSnapshot,
  } = props;

  // ===== State =====
  const [side, setSide] = useState<Side>("buy");
  const [sharesInput, setSharesInput] = useState<string>("");
  const [rationale, setRationale] = useState<string>("");
  const [uploadedMemo, setUploadedMemo] = useState<UploadedMemo | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState<boolean>(false);

  // Constraint check state — populated from the server
  const [constraintCheck, setConstraintCheck] = useState<ConstraintCheck | null>(null);
  const [checkingConstraints, setCheckingConstraints] = useState(false);
  const [softOverrideJustification, setSoftOverrideJustification] =
    useState<string>("");

  // ===== Thesis state (Phase 2c) =====
  // Active theses for THIS security in THIS fund, loaded once on mount.
  const [activeTheses, setActiveTheses] = useState<ThesisOption[]>([]);
  const [thesesLoaded, setThesesLoaded] = useState(false);

  // For OPEN: toggle between creating a new thesis or linking an existing one.
  const [openModeToggle, setOpenModeToggle] = useState<"create" | "link">(
    "create"
  );
  // For ADD onto a legacy position with no active thesis: optionally create one.
  const [addNoThesisChoice, setAddNoThesisChoice] = useState<"create" | "skip">(
    "skip"
  );
  // The existing thesis the trade links to (auto-defaulted when theses load;
  // user-selectable via dropdown when more than one is active).
  const [linkedThesisId, setLinkedThesisId] = useState<string | null>(null);

  // Inline "create thesis" fields (no security picker — it's THIS security).
  const [thConviction, setThConviction] = useState<Conviction>("medium");
  const [thHoldingPeriod, setThHoldingPeriod] =
    useState<HoldingPeriod>("medium");
  const [thSummary, setThSummary] = useState<string>("");
  const [thTargetWeightPct, setThTargetWeightPct] = useState<string>(""); // entered as %, e.g. "5"
  const [thTargetPrice, setThTargetPrice] = useState<string>("");
  const [thMemoFile, setThMemoFile] = useState<File | null>(null);

  // "Update thesis" note when adding to a position. Persistence as a thesis
  // comment is deferred to 2c.3; for now it's captured but not sent.
  const [thUpdateNote, setThUpdateNote] = useState<string>("");

  // Set once the inline thesis has actually been created (at submit time), so
  // a Back→Confirm retry reuses it rather than creating a duplicate. Cleared
  // whenever the inline thesis content changes (so edits produce a fresh one).
  const [createdThesisId, setCreatedThesisId] = useState<string | null>(null);

  // ===== Derived constants =====
  const nav = useMemo(
    () => new Decimal(portfolioSnapshot.nav || "0"),
    [portfolioSnapshot.nav]
  );
  const cash = useMemo(
    () => new Decimal(portfolioSnapshot.cashBalance || "0"),
    [portfolioSnapshot.cashBalance]
  );

  // ===== LIVE PRICE WIRING =====
  // Fetch live price for this single security via the intraday hook.
  // Refreshes every 30s while tab is visible.
  const securityIdArr = useMemo(() => [security.id], [security.id]);
  const { quotes: liveQuotes, lastUpdated: liveUpdatedAt } =
    useIntradayPrices(securityIdArr, { intervalMs: 30_000 });
  const liveQuote = liveQuotes.get(security.id) ?? null;

  // Frozen-at-review price. Null until Review is clicked; once set, this is
  // the price that goes into the database on submit. Live updates have no
  // effect after the freeze.
  const [frozenPriceNative, setFrozenPriceNative] = useState<Decimal | null>(
    null
  );

  // Keystroke-pause: live price ticks pause for 2s after any input edit so
  // the user isn't watching numbers jump mid-typing.
  const [lastKeystrokeAt, setLastKeystrokeAt] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    // Tick once a second so the pause expires naturally
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  const inKeystrokePause = now - lastKeystrokeAt < 2000;

  // Server-snapshot price (passed in as `latestPrice` prop)
  const serverSnapshotNative = useMemo(
    () => (latestPrice ? new Decimal(latestPrice) : null),
    [latestPrice]
  );

  // Effective price applied to all downstream calculations.
  // Priority: frozen > live (when not paused) > server snapshot.
  const priceNative = useMemo(() => {
    if (frozenPriceNative) return frozenPriceNative;
    if (!inKeystrokePause && liveQuote?.price != null) {
      return new Decimal(liveQuote.price);
    }
    // If we have a previous live value, keep showing it during the pause
    // rather than reverting to the server snapshot (jarring)
    if (liveQuote?.price != null) {
      return new Decimal(liveQuote.price);
    }
    return serverSnapshotNative;
  }, [frozenPriceNative, inKeystrokePause, liveQuote, serverSnapshotNative]);

  // Are we showing live data or the server snapshot?
  const isUsingLive = !frozenPriceNative && liveQuote?.price != null;
  const isUsingFallback = !frozenPriceNative && !liveQuote?.price && !!serverSnapshotNative;

  const fx = useMemo(() => new Decimal(fxRateToBase), [fxRateToBase]);
  const priceBase = useMemo(
    () => (priceNative ? priceNative.times(fx) : null),
    [priceNative, fx]
  );
  const currentWeight = useMemo(
    () => new Decimal(portfolioSnapshot.currentPositionWeight || "0"),
    [portfolioSnapshot.currentPositionWeight]
  );
  const currentQty = useMemo(
    () => new Decimal(portfolioSnapshot.currentPositionQuantity || "0"),
    [portfolioSnapshot.currentPositionQuantity]
  );

  // ===== Stepper logic =====
  const adjustShares = (delta: number) => {
    const current = parseInt(sharesInput, 10) || 0;
    const next = Math.max(0, current + delta);
    setSharesInput(next.toString());
  };

  // ===== Compute size from the shares input =====
  const size: ComputedSize | null = useMemo(() => {
    if (!priceBase || priceBase.isZero()) return null;
    const s = parseInt(sharesInput, 10);
    if (isNaN(s) || s < 1) return null;
    const shares = new Decimal(s);
    const notionalBase = shares.times(priceBase);
    const weight = nav.isZero() ? new Decimal(0) : notionalBase.dividedBy(nav);
    const notionalNative = priceNative
      ? shares.times(priceNative)
      : notionalBase;
    return { shares, notionalBase, notionalNative, weightTarget: weight };
  }, [sharesInput, priceBase, priceNative, nav]);

  // ===== Sizing hints — common round-number weight equivalents =====
  const sizingHints = useMemo(() => {
    if (!priceBase || priceBase.isZero() || nav.isZero()) return null;
    const hint = (pct: number): number => {
      const notional = nav.times(pct);
      return Math.round(notional.dividedBy(priceBase).toNumber());
    };
    return {
      onePct: hint(0.01),
      fivePct: hint(0.05),
      tenPct: hint(0.10),
    };
  }, [priceBase, nav]);

  // ===== Projection =====
  const projection = useMemo(() => {
    if (!size || !priceBase) return null;

    const tradeNotionalBase = size.notionalBase;
    const feeBase = tradeNotionalBase
      .times(fund.tradingFeesBps)
      .dividedBy(10000);
    const totalCashImpact =
      side === "buy" || side === "cover"
        ? tradeNotionalBase.plus(feeBase).negated()
        : tradeNotionalBase.minus(feeBase);

    // Project position quantity change
    const qtyChange =
      side === "buy"
        ? size.shares
        : side === "sell"
          ? size.shares.negated()
          : side === "short"
            ? size.shares.negated()
            : size.shares; // cover
    const newQty = currentQty.plus(qtyChange);
    // Signed weight preserves direction: positive for long, negative for short.
    // Used for the position row in the projection so a short shows as -1.12%.
    const newPositionValueSigned = newQty.times(priceBase);
    const newPositionWeightSigned = nav.isZero()
      ? new Decimal(0)
      : newPositionValueSigned.dividedBy(nav);
    // Absolute weight is what feeds gross-exposure / sector aggregation.
    const newPositionValueAbs = newQty.abs().times(priceBase);
    const newWeight = nav.isZero()
      ? new Decimal(0)
      : newPositionValueAbs.dividedBy(nav);

    const newCash = cash.plus(totalCashImpact);
    const newCashPct = nav.isZero() ? new Decimal(0) : newCash.dividedBy(nav);

    // Sector weight projection — sector aggregation uses absolute (gross) weight
    const weightDelta = newWeight.minus(currentWeight);
    const currentSectorW = new Decimal(portfolioSnapshot.currentSectorWeight);
    const newSectorWeight = currentSectorW.plus(weightDelta);

    return {
      tradeNotionalBase,
      feeBase,
      totalCashImpact,
      newPositionShares: newQty,
      newPositionWeight: newWeight, // absolute, used for max_position_pct
      newPositionWeightSigned, // signed, used for row display
      newCash,
      newCashPct,
      newSectorWeight,
    };
  }, [
    size,
    priceBase,
    side,
    currentQty,
    cash,
    nav,
    portfolioSnapshot.currentSectorWeight,
    currentWeight,
    fund.tradingFeesBps,
  ]);

  // ===== Memo requirement logic =====
  const isOpeningPosition =
    currentQty.isZero() && (side === "buy" || side === "short");
  // Phase 2c: the *thesis* now owns the deep investment memo (and opening a
  // position requires a thesis — see thesis section below). The per-trade
  // memo PDF therefore becomes always-optional supplementary research rather
  // than a hard gate, to avoid demanding two PDFs on a single open.
  const memoRequired = false;

  // ===== Constraint check (server-side, debounced) =====
  // Fires whenever side or shares changes. Uses the same engine that will
  // authoritatively gate submission in Phase 2b.4.
  const sharesIntForCheck = parseInt(sharesInput, 10);
  useEffect(() => {
    // Don't fire if there's no valid input yet
    if (
      !sharesIntForCheck ||
      sharesIntForCheck < 1 ||
      isNaN(sharesIntForCheck)
    ) {
      setConstraintCheck(null);
      return;
    }
    let cancelled = false;
    setCheckingConstraints(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/funds/${fund.slug}/check-trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            securityId: security.id,
            side,
            shares: sharesIntForCheck,
          }),
        });
        if (cancelled) return;
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setConstraintCheck(null);
          return;
        }
        setConstraintCheck(data.result);
      } catch {
        if (!cancelled) setConstraintCheck(null);
      } finally {
        if (!cancelled) setCheckingConstraints(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fund.slug, security.id, side, sharesIntForCheck]);

  // Are there active soft violations the PM hasn't justified?
  const hasSoftViolations =
    (constraintCheck?.softViolations?.length ?? 0) > 0;
  const hasHardViolations =
    (constraintCheck?.hardViolations?.length ?? 0) > 0;

  // ===== Thesis fetch + resolution (Phase 2c) =====
  // Load active theses for this security once. The trade ticket is scoped to a
  // single security, so this is keyed only on fund + security.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/funds/${fund.slug}/theses?securityId=${security.id}`
        );
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.ok && Array.isArray(data.theses)) {
          setActiveTheses(
            (data.theses as ThesisOption[]).filter(
              (t) => t.status === "active"
            )
          );
        } else {
          setActiveTheses([]);
        }
      } catch {
        if (!cancelled) setActiveTheses([]);
      } finally {
        if (!cancelled) setThesesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fund.slug, security.id]);

  // Default the linked thesis to the most recent active one (the list is
  // returned newest-first). Keep the user's pick if it's still valid.
  useEffect(() => {
    if (activeTheses.length > 0) {
      setLinkedThesisId((prev) =>
        prev && activeTheses.some((t) => t.id === prev)
          ? prev
          : activeTheses[0].id
      );
    } else {
      setLinkedThesisId(null);
    }
  }, [activeTheses]);

  // What is the PM trying to do to the position?
  //   open   — no current holding, buying/shorting in
  //   reduce — selling/covering an existing holding (informational thesis link)
  //   add    — anything else with a current holding (adding/modifying)
  const positionIntent: "open" | "add" | "reduce" = isOpeningPosition
    ? "open"
    : (side === "sell" || side === "cover") && !currentQty.isZero()
      ? "reduce"
      : "add";

  const thSummaryLen = thSummary.trim().length;
  const inlineThesisValid = thSummaryLen > 0 && thSummaryLen <= 500;

  // Resolve which thesis mode applies and whether it's complete enough to
  // proceed. `required` means the trade can't be reviewed until `valid`.
  const thesisResolution = useMemo((): {
    mode: "create" | "link" | "none";
    thesisId: string | null;
    valid: boolean;
    required: boolean;
  } => {
    if (positionIntent === "open") {
      // Opening a position requires a thesis: create one, or link an active one.
      if (activeTheses.length === 0 || openModeToggle === "create") {
        return {
          mode: "create",
          thesisId: null,
          valid: inlineThesisValid,
          required: true,
        };
      }
      return {
        mode: "link",
        thesisId: linkedThesisId,
        valid: !!linkedThesisId,
        required: true,
      };
    }
    if (positionIntent === "add") {
      if (activeTheses.length > 0) {
        // Auto-link to the active thesis (selectable if more than one).
        return {
          mode: "link",
          thesisId: linkedThesisId,
          valid: !!linkedThesisId,
          required: true,
        };
      }
      // Legacy holding with no thesis — optionally create one, else proceed.
      if (addNoThesisChoice === "create") {
        return {
          mode: "create",
          thesisId: null,
          valid: inlineThesisValid,
          required: false,
        };
      }
      return { mode: "none", thesisId: null, valid: true, required: false };
    }
    // reduce / close — informational. Link the active thesis if one exists.
    return {
      mode: activeTheses.length > 0 ? "link" : "none",
      thesisId: activeTheses.length > 0 ? linkedThesisId : null,
      valid: true,
      required: false,
    };
  }, [
    positionIntent,
    activeTheses,
    openModeToggle,
    linkedThesisId,
    inlineThesisValid,
    addNoThesisChoice,
  ]);

  // The thesis currently linked (for display in informational modes).
  const linkedThesis = useMemo(
    () => activeTheses.find((t) => t.id === linkedThesisId) ?? null,
    [activeTheses, linkedThesisId]
  );

  // Resolve the thesisId to submit — creating the inline thesis on demand.
  // Called at submit time so the thesis is only persisted on a committed
  // trade. Reuses a previously-created id across Back→Confirm retries.
  async function resolveThesisId(): Promise<string | null> {
    const r = thesisResolution;
    if (r.mode === "link" || r.mode === "none") {
      return r.thesisId ?? null;
    }
    // create
    if (createdThesisId) return createdThesisId;
    const form = new FormData();
    form.append("securityId", security.id);
    form.append("conviction", thConviction);
    form.append("holdingPeriod", thHoldingPeriod);
    form.append("summary", thSummary.trim());
    if (thTargetWeightPct) {
      const n = Number(thTargetWeightPct);
      // User enters "5" for 5% → store 0.05
      if (Number.isFinite(n)) form.append("targetWeightPct", String(n / 100));
    }
    if (thTargetPrice) form.append("targetPriceNative", thTargetPrice);
    if (thMemoFile) form.append("memo", thMemoFile);

    const res = await fetch(`/api/funds/${fund.slug}/theses`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? `Failed to create thesis (${res.status})`);
    }
    setCreatedThesisId(data.thesisId as string);
    return data.thesisId as string;
  }

  // ===== Validation =====
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!priceBase || priceBase.isZero()) {
      errors.push("No price available — cannot construct trade");
    }
    if (!size || size.shares.isZero()) {
      errors.push("Enter at least 1 share");
    }
    if (rationale.length < 50) {
      errors.push(
        `Rationale must be at least 50 characters (${rationale.length}/50)`
      );
    }
    if (memoRequired && !uploadedMemo) {
      errors.push(
        "New positions ≥1% target weight require an attached investment memo (PDF)"
      );
    }
    if (uploading) {
      errors.push("Wait for memo upload to complete");
    }
    // Sell/cover beyond what's held
    if (
      size &&
      (side === "sell" || side === "cover") &&
      size.shares.greaterThan(currentQty.abs())
    ) {
      errors.push(
        `Cannot ${side} ${fmtShares(size.shares)} shares — current position is only ${fmtShares(currentQty.abs())} shares`
      );
    }
    // Hard constraint violations
    if (constraintCheck) {
      for (const v of constraintCheck.hardViolations) {
        errors.push(`Hard constraint violated: ${v.message}`);
      }
    }
    // Soft constraint violations: require justification
    if (
      hasSoftViolations &&
      softOverrideJustification.trim().length < 20
    ) {
      errors.push(
        `Soft constraint breaches require a written justification of at least 20 characters (${softOverrideJustification.trim().length}/20)`
      );
    }
    // Thesis requirement (Phase 2c)
    if (thesisResolution.required && !thesisResolution.valid) {
      if (thesisResolution.mode === "create") {
        errors.push(
          `Thesis summary is required (max 500 characters)`
        );
      } else {
        errors.push("Select an active thesis to link this trade to");
      }
    }
    return errors;
  }, [
    priceBase,
    size,
    rationale,
    memoRequired,
    uploadedMemo,
    uploading,
    side,
    currentQty,
    constraintCheck,
    hasSoftViolations,
    softOverrideJustification,
    thesisResolution,
    thSummaryLen,
  ]);

  const canSubmit = validation.length === 0;

  // ===== Available sides depending on fund =====
  const sides: Side[] = fund.isLongShort
    ? ["buy", "sell", "short", "cover"]
    : ["buy", "sell"];

  // ===== Per-side disable logic based on current position =====
  // Trade intent guard. A side is disabled when it doesn't logically apply
  // given the current holding state:
  //   - SELL: only valid when long (qty > 0). With no position, "sell" would
  //     functionally be a short; the user should click SHORT explicitly to
  //     express that intent.
  //   - COVER: only valid when short (qty < 0). With no position, "cover"
  //     is nonsensical (nothing to cover).
  //   - BUY: always valid (opens or adds to a long; if currently short,
  //     would partially or fully cover — but the user should use COVER for
  //     clarity. We allow BUY anyway because adding-to-long is the most
  //     common intent.)
  //   - SHORT: always valid (opens or adds to a short).
  const isCurrentlyLong = currentQty.gt(0);
  const isCurrentlyShort = currentQty.lt(0);
  const sideDisabled: Record<Side, boolean> = {
    buy: false,
    sell: !isCurrentlyLong,
    short: false,
    cover: !isCurrentlyShort,
  };
  const sideDisabledReason: Record<Side, string | null> = {
    buy: null,
    sell: !isCurrentlyLong
      ? "You don't own this position — use SHORT to bet against it"
      : null,
    short: null,
    cover: !isCurrentlyShort
      ? "No short position to cover"
      : null,
  };

  // If the user navigated here and the default "buy" side stays, that's fine.
  // But if they had selected "sell" or "cover" on a previous render and the
  // position changed (e.g. fully closed), reset to "buy" to avoid a stuck
  // disabled-but-active state.
  useEffect(() => {
    if (sideDisabled[side]) {
      setSide("buy");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCurrentlyLong, isCurrentlyShort]);

  // ===== Render =====
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        color: "#0A0A0A",
      }}
    >
      <div
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid #E5E5DE",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            ...serif,
            fontSize: 16,
            color: "#00183A",
          }}
        >
          New trade
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#6B6B66",
          }}
        >
          {fund.name}
        </div>
      </div>

      {/* SIDE SELECTOR */}
      <Section label="Side">
        <div style={{ display: "flex", gap: 0 }}>
          {sides.map((s) => {
            const isDisabled = sideDisabled[s];
            const isActive = s === side;
            return (
              <button
                key={s}
                onClick={() => !isDisabled && setSide(s)}
                disabled={isDisabled}
                title={sideDisabledReason[s] ?? undefined}
                style={{
                  ...sideButtonStyle,
                  background: isActive
                    ? "#00183A"
                    : isDisabled
                      ? "#F5F4EE"
                      : "white",
                  color: isActive
                    ? "white"
                    : isDisabled
                      ? "#C8C8C0"
                      : "#6B6B66",
                  fontWeight: isActive ? 600 : 400,
                  cursor: isDisabled ? "not-allowed" : "pointer",
                }}
              >
                {s.toUpperCase()}
              </button>
            );
          })}
        </div>
      </Section>

      {/* SIZE */}
      <Section label="Size">
        <SharesInput
          value={sharesInput}
          onChange={(v) => {
            setSharesInput(v);
            setLastKeystrokeAt(Date.now());
          }}
          adjustShares={(delta) => {
            adjustShares(delta);
            setLastKeystrokeAt(Date.now());
          }}
        />
        {/* Live price status indicator */}
        <LivePriceStatus
          priceNative={priceNative}
          securityCurrency={security.currency}
          isUsingLive={isUsingLive}
          isUsingFallback={isUsingFallback}
          frozen={!!frozenPriceNative}
          inKeystrokePause={inKeystrokePause}
          liveUpdatedAt={liveUpdatedAt}
        />
        {/* Live readouts */}
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            background: "#FAFAF7",
            border: "1px solid #E5E5DE",
            fontSize: 12,
            color: "#6B6B66",
            display: "flex",
            gap: 24,
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span>Notional</span>
          <span style={{ ...numeric, color: size ? "#00183A" : "#9A9A8E" }}>
            {size
              ? fmtMoney(size.notionalBase, fund.baseCurrency)
              : "—"}
          </span>
          <span>Weight</span>
          <span style={{ ...numeric, color: size ? "#00183A" : "#9A9A8E" }}>
            {size ? fmtPct(size.weightTarget) : "—"}
          </span>
        </div>
        {/* Sizing hints */}
        {sizingHints && sizingHints.onePct > 0 && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: "#9A9A8E",
              display: "flex",
              gap: 14,
              alignItems: "baseline",
            }}
          >
            <span
              style={{
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              For reference
            </span>
            <span>
              1% ≈{" "}
              <span style={{ ...numeric, color: "#6B6B66" }}>
                {sizingHints.onePct.toLocaleString()}
              </span>{" "}
              shares
            </span>
            <span>·</span>
            <span>
              5% ≈{" "}
              <span style={{ ...numeric, color: "#6B6B66" }}>
                {sizingHints.fivePct.toLocaleString()}
              </span>{" "}
              shares
            </span>
            <span>·</span>
            <span>
              10% ≈{" "}
              <span style={{ ...numeric, color: "#6B6B66" }}>
                {sizingHints.tenPct.toLocaleString()}
              </span>{" "}
              shares
            </span>
          </div>
        )}
      </Section>

      {/* THESIS (Phase 2c) */}
      <Section label="Investment thesis">
        <ThesisPicker
          intent={positionIntent}
          fundSlug={fund.slug}
          activeTheses={activeTheses}
          thesesLoaded={thesesLoaded}
          resolution={thesisResolution}
          openModeToggle={openModeToggle}
          setOpenModeToggle={setOpenModeToggle}
          addNoThesisChoice={addNoThesisChoice}
          setAddNoThesisChoice={setAddNoThesisChoice}
          linkedThesisId={linkedThesisId}
          setLinkedThesisId={setLinkedThesisId}
          linkedThesis={linkedThesis}
          fullyClosing={!!projection && projection.newPositionShares.isZero()}
          security={security}
          conviction={thConviction}
          setConviction={(c) => {
            setThConviction(c);
            setCreatedThesisId(null);
          }}
          holdingPeriod={thHoldingPeriod}
          setHoldingPeriod={(p) => {
            setThHoldingPeriod(p);
            setCreatedThesisId(null);
          }}
          summary={thSummary}
          setSummary={(s) => {
            setThSummary(s);
            setCreatedThesisId(null);
          }}
          summaryLen={thSummaryLen}
          targetWeightPct={thTargetWeightPct}
          setTargetWeightPct={(v) => {
            setThTargetWeightPct(v);
            setCreatedThesisId(null);
          }}
          targetPrice={thTargetPrice}
          setTargetPrice={(v) => {
            setThTargetPrice(v);
            setCreatedThesisId(null);
          }}
          memoFile={thMemoFile}
          setMemoFile={(f) => {
            setThMemoFile(f);
            setCreatedThesisId(null);
          }}
          updateNote={thUpdateNote}
          setUpdateNote={setThUpdateNote}
        />
      </Section>

      {/* MEMO + RATIONALE */}
      <Section label="Trade rationale">
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                color: "#6B6B66",
                marginBottom: 4,
              }}
            >
              Rationale (required, min 50 chars){" "}
              <span style={{ color: "#9A9A8E", fontWeight: 400 }}>
                — {rationale.length}/50 — a brief paraphrase of why you&rsquo;re
                placing this specific trade
              </span>
            </label>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why now? What's the catalyst? What could go wrong?"
              rows={3}
              style={{
                ...inputStyle,
                resize: "vertical",
                fontFamily: "system-ui, sans-serif",
                lineHeight: 1.5,
              }}
            />
          </div>
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                color: "#6B6B66",
                marginBottom: 6,
              }}
            >
              Per-trade attachment (PDF){" "}
              <span style={{ color: "#9A9A8E" }}>
                — optional, subordinate to the thesis memo above
              </span>
            </label>
            <MemoUploader
              uploaded={uploadedMemo}
              onChange={setUploadedMemo}
              uploadError={uploadError}
              setUploadError={setUploadError}
              uploading={uploading}
              setUploading={setUploading}
            />
          </div>
        </div>
      </Section>

      {/* PROJECTION */}
      {projection && size && priceBase && (
        <>
          <Section label="Portfolio projection">
            <ProjectionTable>
              <ProjectionRow
                label={`${security.ticker} position`}
                before={fmtPct(currentWeight)}
                after={fmtPctSigned(projection.newPositionWeightSigned)}
                tone={toneForRow(constraintCheck, [
                  "max_position_pct",
                  "long_only",
                  "universe_only",
                ])}
              />
              <ProjectionRow
                label={`${shortSectorLabel(security.gicsSector)} exposure`}
                before={fmtPct(
                  new Decimal(portfolioSnapshot.currentSectorWeight)
                )}
                after={fmtPct(projection.newSectorWeight)}
                tone={toneForRow(constraintCheck, ["max_single_sector_pct"])}
              />
              <ProjectionRow
                label="Cash"
                before={fmtPct(
                  cash.dividedBy(nav.isZero() ? new Decimal(1) : nav)
                )}
                after={fmtPct(projection.newCashPct)}
                tone={toneForRow(constraintCheck, [
                  "min_cash_pct",
                  "max_cash_pct",
                ])}
              />
              <ProjectionRow
                label="Position count"
                before={String(portfolioSnapshot.positionCount)}
                after={String(
                  currentQty.isZero() && (side === "buy" || side === "short")
                    ? portfolioSnapshot.positionCount + 1
                    : projection.newPositionShares.isZero()
                      ? portfolioSnapshot.positionCount - 1
                      : portfolioSnapshot.positionCount
                )}
                tone={toneForRow(constraintCheck, ["max_position_count"])}
              />
              {fund.isLongShort && (
                <>
                  <ProjectionRow
                    label="Gross exposure"
                    before={fmtPct(
                      new Decimal(portfolioSnapshot.grossExposure)
                    )}
                    after={fmtPct(
                      new Decimal(portfolioSnapshot.grossExposure)
                    )}
                    tone={toneForRow(constraintCheck, ["max_gross_exposure"])}
                  />
                  <ProjectionRow
                    label="Net exposure"
                    before={fmtPct(new Decimal(portfolioSnapshot.netExposure))}
                    after={fmtPct(new Decimal(portfolioSnapshot.netExposure))}
                    tone={toneForRow(constraintCheck, ["max_net_exposure"])}
                  />
                </>
              )}
            </ProjectionTable>
          </Section>

          <Section label="Execution detail">
            <ProjectionTable>
              <ExecRow label="Trade type" value={side.toUpperCase()} />
              <ExecRow
                label="Quantity"
                value={`${fmtShares(size.shares)} shares`}
              />
              <ExecRow
                label="Price (last close)"
                value={`${fmtMoney(priceNative ?? new Decimal(0), security.currency)}${
                  security.currency !== fund.baseCurrency
                    ? ` (≈ ${fmtMoney(priceBase, fund.baseCurrency)} after FX)`
                    : ""
                }`}
              />
              <ExecRow
                label="Notional"
                value={fmtMoney(projection.tradeNotionalBase, fund.baseCurrency)}
              />
              <ExecRow
                label={`Trading fee (${fund.tradingFeesBps} bps)`}
                value={fmtMoney(projection.feeBase, fund.baseCurrency)}
              />
              <ExecRow
                label="Total cash impact"
                value={`${projection.totalCashImpact.isNegative() ? "−" : "+"}${fmtMoney(projection.totalCashImpact, fund.baseCurrency)}`}
                emphasis
              />
            </ProjectionTable>
          </Section>

          {/* SHORT BORROW FEE DISCLOSURE — only when opening/adding to a short */}
          {side === "short" && (
            <Section label="Short position cost (borrow fee)">
              <ShortFeePanel
                positionNotionalBase={projection.tradeNotionalBase}
                baseCurrency={fund.baseCurrency}
                annualRateBps={ASSUMED_SHORT_BORROW_RATE_BPS}
              />
            </Section>
          )}

          {/* COMPLIANCE CHECK — server-evaluated constraints */}
          <Section label="Compliance check">
            <ComplianceCheckPanel
              check={constraintCheck}
              checking={checkingConstraints}
              softOverrideJustification={softOverrideJustification}
              setSoftOverrideJustification={setSoftOverrideJustification}
            />
          </Section>
        </>
      )}

      {/* VALIDATION + SUBMIT */}
      <div
        style={{
          padding: "16px 20px",
          background: "#FAFAF7",
          borderTop: "1px solid #E5E5DE",
        }}
      >
        {validation.length > 0 && (
          <ul
            style={{
              fontSize: 12,
              color: "#7A1F1F",
              listStyle: "disc",
              paddingLeft: 18,
              marginTop: 0,
              marginBottom: 12,
              lineHeight: 1.6,
            }}
          >
            {validation.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            disabled={!canSubmit}
            onClick={() => {
              // Freeze the price at the moment of review. The price in
              // the confirmation modal and the price submitted to the
              // database will both be this frozen value, even if the
              // market ticks while the user is in the confirmation step.
              if (priceNative) setFrozenPriceNative(priceNative);
              setShowConfirm(true);
            }}
            style={{
              ...primaryButtonStyle,
              opacity: canSubmit ? 1 : 0.4,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            Review trade →
          </button>
          <div
            style={{
              fontSize: 11,
              color: "#9A9A8E",
            }}
          >
            {canSubmit
              ? "Review the summary before submitting."
              : "Resolve all blockers above to continue."}
          </div>
        </div>
      </div>

      {/* CONFIRM MODAL */}
      {showConfirm && projection && size && priceBase && (
        <ConfirmModal
          onCancel={() => {
            setShowConfirm(false);
            // Unfreeze so live prices resume in the trade ticket
            setFrozenPriceNative(null);
          }}
          fund={fund}
          security={security}
          side={side}
          size={size}
          projection={projection}
          priceNative={priceNative}
          rationale={rationale}
          uploadedMemo={uploadedMemo}
          softViolations={constraintCheck?.softViolations ?? []}
          softOverrideJustification={softOverrideJustification}
          resolveThesisId={resolveThesisId}
          thesisInfo={{
            mode: thesisResolution.mode,
            newSummary:
              thesisResolution.mode === "create" ? thSummary.trim() : null,
            linkedSummary:
              thesisResolution.mode === "link"
                ? (linkedThesis?.summary ?? null)
                : null,
          }}
          submitPayload={{
            securityId: security.id,
            side,
            shares: parseInt(sharesInput, 10),
            rationale,
            // The price the user saw and locked when clicking "Review trade".
            // Server uses this as a sanity check vs its own live fetch — if
            // the market has moved >1% since freeze, the trade is rejected
            // and the user is prompted to re-review.
            expectedPriceNative: frozenPriceNative
              ? frozenPriceNative.toString()
              : priceNative?.toString() ?? null,
            memo: uploadedMemo ?? undefined,
            softOverrideJustification:
              constraintCheck?.softViolations.length
                ? softOverrideJustification
                : undefined,
            // Trade-linked thesis update (persisted by submit-trade when a
            // thesis is linked). Only meaningful on the "add" flow.
            updateNote: thUpdateNote.trim() ? thUpdateNote.trim() : undefined,
          }}
          fundSlug={fund.slug}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "16px 20px",
        borderBottom: "1px solid #E5E5DE",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6B6B66",
          fontWeight: 500,
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function SharesInput({
  value,
  onChange,
  adjustShares,
}: {
  value: string;
  onChange: (v: string) => void;
  adjustShares: (delta: number) => void;
}) {
  // Click handler: respects Shift (±10) and Alt (±100) modifiers
  const handleStep = (
    sign: 1 | -1,
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    const magnitude = e.altKey ? 100 : e.shiftKey ? 10 : 1;
    adjustShares(sign * magnitude);
  };

  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 11,
          color: "#6B6B66",
          marginBottom: 6,
        }}
      >
        Shares
      </label>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 0,
        }}
      >
        <button
          type="button"
          onClick={(e) => handleStep(-1, e)}
          aria-label="Decrease shares"
          style={stepperButtonStyle}
        >
          −
        </button>
        <input
          type="number"
          min="0"
          step="1"
          value={value}
          onChange={(e) => {
            // strip non-integer input
            const v = e.target.value.replace(/[^0-9]/g, "");
            onChange(v);
          }}
          placeholder="0"
          style={{
            ...inputStyle,
            ...numeric,
            fontSize: 18,
            textAlign: "center",
            border: "1px solid #C8C8C0",
            borderLeft: "none",
            borderRight: "none",
            borderRadius: 0,
            flex: 1,
            padding: "8px 10px",
          }}
        />
        <button
          type="button"
          onClick={(e) => handleStep(1, e)}
          aria-label="Increase shares"
          style={{ ...stepperButtonStyle, borderRadius: "0 3px 3px 0" }}
        >
          +
        </button>
      </div>
      <div
        style={{
          fontSize: 10,
          color: "#9A9A8E",
          marginTop: 4,
          textAlign: "right",
        }}
      >
        <kbd
          style={{
            background: "#F0EFEA",
            border: "1px solid #E0DFD8",
            borderRadius: 2,
            padding: "0 4px",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          shift
        </kbd>{" "}
        ±10 ·{" "}
        <kbd
          style={{
            background: "#F0EFEA",
            border: "1px solid #E0DFD8",
            borderRadius: 2,
            padding: "0 4px",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          alt
        </kbd>{" "}
        ±100
      </div>
    </div>
  );
}

function MemoUploader({
  uploaded,
  onChange,
  uploadError,
  setUploadError,
  uploading,
  setUploading,
}: {
  uploaded: UploadedMemo | null;
  onChange: (m: UploadedMemo | null) => void;
  uploadError: string | null;
  setUploadError: (e: string | null) => void;
  uploading: boolean;
  setUploading: (b: boolean) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const upload = async (file: File) => {
    setUploadError(null);
    // Client-side gate first — file type and size — for fast feedback before
    // sending bytes over the wire. Server re-validates regardless.
    if (!/\.pdf$/i.test(file.name)) {
      setUploadError("File must be a PDF (.pdf extension)");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(
        `File too large — max 10 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB)`
      );
      return;
    }
    if (file.size === 0) {
      setUploadError("File is empty");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload/memo", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setUploadError(data.error ?? "Upload failed");
        return;
      }
      onChange({
        url: data.url,
        filename: data.filename,
        sizeBytes: data.sizeBytes,
      });
    } catch (err) {
      console.error(err);
      setUploadError("Network error during upload");
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    // Allow re-selecting the same file
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  };

  // Uploaded state — show the file card
  if (uploaded) {
    return (
      <div
        style={{
          background: "white",
          border: "1px solid #D9D9D2",
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 13,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            background: "#FBF3E5",
            border: "1px solid #E8D7AA",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            flex: "0 0 32px",
          }}
        >
          📄
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: "#00183A",
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {uploaded.filename}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#6B6B66",
              marginTop: 2,
              display: "flex",
              gap: 10,
            }}
          >
            <span style={{ ...numeric }}>
              {(uploaded.sizeBytes / 1024).toFixed(0)} KB
            </span>
            <a
              href={uploaded.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#6B6B66", textDecoration: "underline" }}
            >
              Preview
            </a>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          style={{
            background: "none",
            border: "none",
            color: "#7A1F1F",
            fontSize: 12,
            cursor: "pointer",
            padding: "4px 8px",
          }}
          aria-label="Remove memo"
        >
          Remove
        </button>
      </div>
    );
  }

  // Empty state — drop zone + browse button
  return (
    <div>
      <label
        onDragEnter={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 16px",
          background: isDragging ? "#F0EFEA" : "white",
          border: `1px dashed ${isDragging ? "#00183A" : "#C8C8C0"}`,
          borderRadius: 4,
          cursor: uploading ? "wait" : "pointer",
          transition: "all 0.1s",
          textAlign: "center",
        }}
      >
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={handleFileSelect}
          disabled={uploading}
          style={{ display: "none" }}
        />
        <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
        {uploading ? (
          <div style={{ fontSize: 13, color: "#00183A" }}>Uploading…</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "#00183A", marginBottom: 4 }}>
              Drop a PDF here, or{" "}
              <span style={{ textDecoration: "underline" }}>browse</span>
            </div>
            <div style={{ fontSize: 11, color: "#9A9A8E" }}>
              PDF only · max 10 MB
            </div>
          </>
        )}
      </label>
      {uploadError && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "#7A1F1F",
          }}
        >
          {uploadError}
        </div>
      )}
    </div>
  );
}

function ProjectionTable({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#FAFAF7",
        border: "1px solid #E5E5DE",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

function LivePriceStatus({
  priceNative,
  securityCurrency,
  isUsingLive,
  isUsingFallback,
  frozen,
  inKeystrokePause,
  liveUpdatedAt,
}: {
  priceNative: Decimal | null;
  securityCurrency: "GBP" | "USD" | "EUR";
  isUsingLive: boolean;
  isUsingFallback: boolean;
  frozen: boolean;
  inKeystrokePause: boolean;
  liveUpdatedAt: Date | null;
}) {
  const sym =
    securityCurrency === "GBP" ? "£" : securityCurrency === "EUR" ? "€" : "$";

  // Tick once per second to update "Xs ago"
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  let dotColor = "#9A9A8E";
  let label: React.ReactNode;
  if (frozen) {
    dotColor = "#5A3F08";
    label = (
      <>
        Price locked at <strong style={{ fontWeight: 600 }}>{sym}{priceNative?.toFixed(2) ?? "—"}</strong> · will use this on submit
      </>
    );
  } else if (isUsingLive) {
    dotColor = "#1F5C3A";
    const ago = liveUpdatedAt
      ? Math.max(0, Math.floor((Date.now() - liveUpdatedAt.getTime()) / 1000))
      : null;
    label = (
      <>
        Live · current <strong style={{ fontWeight: 600 }}>{sym}{priceNative?.toFixed(2) ?? "—"}</strong>
        {inKeystrokePause ? " · paused while typing" : ago != null ? ` · updated ${ago}s ago` : ""}
      </>
    );
  } else if (isUsingFallback) {
    dotColor = "#7A1F1F";
    label = (
      <>
        Live unavailable · using last close <strong style={{ fontWeight: 600 }}>{sym}{priceNative?.toFixed(2) ?? "—"}</strong>
      </>
    );
  } else {
    label = <>Loading live price…</>;
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: "8px 14px",
        background: frozen ? "#FBF3E5" : "#FAFAF7",
        border: frozen ? "1px solid #E8D7AA" : "1px solid #E5E5DE",
        fontSize: 11,
        color: "#5A3F08",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
        }}
      />
      <span style={{ color: frozen ? "#5A3F08" : "#6B6B66" }}>{label}</span>
    </div>
  );
}

function ShortFeePanel({
  positionNotionalBase,
  baseCurrency,
  annualRateBps,
}: {
  positionNotionalBase: Decimal;
  baseCurrency: "GBP" | "USD" | "EUR";
  annualRateBps: number;
}) {
  const annualRate = new Decimal(annualRateBps).dividedBy(10000);
  const annualFee = positionNotionalBase.times(annualRate);
  const monthlyFee = annualFee.dividedBy(12);
  const dailyFee = annualFee.dividedBy(365);

  return (
    <>
      <ProjectionTable>
        <ExecRow
          label="Assumed annual borrow rate"
          value={`${(annualRateBps / 100).toFixed(2)}% / yr`}
        />
        <ExecRow
          label="Estimated daily fee"
          value={fmtMoney(dailyFee, baseCurrency)}
        />
        <ExecRow
          label="Estimated monthly fee"
          value={fmtMoney(monthlyFee, baseCurrency)}
        />
        <ExecRow
          label="Estimated annual fee"
          value={fmtMoney(annualFee, baseCurrency)}
          emphasis
        />
      </ProjectionTable>
      <div
        style={{
          fontSize: 11,
          marginTop: 10,
          lineHeight: 1.55,
          padding: "10px 14px",
          background: "#FBF3E5",
          border: "1px solid #E8D7AA",
          color: "#5A3F08",
        }}
      >
        <strong style={{ fontWeight: 600 }}>Note on borrow fees: </strong>
        Real borrow rates vary by security. Liquid large-caps cost
        ~0.3–1% / yr; hard-to-borrow names can run 10–50% / yr. The 2% rate
        is a simplifying assumption for paper trading.{" "}
        <strong style={{ fontWeight: 600 }}>Dividends</strong> paid by the
        shorted company will also be debited to cash on the ex-date.{" "}
        <strong style={{ fontWeight: 600 }}>
          Gross exposure
        </strong>{" "}
        rises by the short notional; ensure you stay within fund leverage
        constraints.
      </div>
    </>
  );
}

function ComplianceCheckPanel({
  check,
  checking,
  softOverrideJustification,
  setSoftOverrideJustification,
}: {
  check: ConstraintCheck | null;
  checking: boolean;
  softOverrideJustification: string;
  setSoftOverrideJustification: (s: string) => void;
}) {
  if (!check && checking) {
    return (
      <div
        style={{
          fontSize: 12,
          color: "#6B6B66",
          padding: "10px 14px",
          background: "#FAFAF7",
          border: "1px solid #E5E5DE",
        }}
      >
        Checking against fund constraints…
      </div>
    );
  }
  if (!check) {
    return (
      <div
        style={{
          fontSize: 12,
          color: "#9A9A8E",
          padding: "10px 14px",
          background: "#FAFAF7",
          border: "1px solid #E5E5DE",
        }}
      >
        Enter a trade size to see compliance checks.
      </div>
    );
  }

  const totalViolations =
    check.hardViolations.length + check.softViolations.length;

  // All-clear state
  if (totalViolations === 0) {
    return (
      <div
        style={{
          fontSize: 13,
          padding: "12px 16px",
          background: "#EDF5EE",
          border: "1px solid #B8D4BB",
          color: "#1F5C3A",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#1F5C3A",
            color: "white",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          ✓
        </span>
        <span style={{ fontWeight: 500 }}>
          All constraints satisfied. Trade is within policy.
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {check.hardViolations.map((v) => (
        <ViolationCard key={v.constraintId} violation={v} />
      ))}
      {check.softViolations.map((v) => (
        <ViolationCard key={v.constraintId} violation={v} />
      ))}
      {check.softViolations.length > 0 && (
        <div
          style={{
            marginTop: 6,
            padding: "12px 14px",
            background: "white",
            border: "1px solid #E8D7AA",
          }}
        >
          <label
            style={{
              display: "block",
              fontSize: 11,
              color: "#5A3F08",
              marginBottom: 6,
              fontWeight: 500,
            }}
          >
            Justification for soft-constraint override{" "}
            <span style={{ color: "#9A9A8E", fontWeight: 400 }}>
              (required, min 20 chars —{" "}
              {softOverrideJustification.trim().length}/20)
            </span>
          </label>
          <textarea
            value={softOverrideJustification}
            onChange={(e) => setSoftOverrideJustification(e.target.value)}
            placeholder="Why is this breach justified for this trade?"
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: "1px solid #D9D9D2",
              borderRadius: 3,
              padding: "7px 10px",
              fontSize: 13,
              outline: "none",
              fontFamily: "system-ui, sans-serif",
              color: "#0A0A0A",
              background: "white",
              resize: "vertical",
              lineHeight: 1.5,
            }}
          />
          <div
            style={{
              fontSize: 11,
              color: "#5A3F08",
              marginTop: 6,
            }}
          >
            This justification is recorded on the trade and visible to all
            future reviewers.
          </div>
        </div>
      )}
    </div>
  );
}

function ViolationCard({
  violation,
}: {
  violation: ConstraintViolationResponse;
}) {
  const isHard = violation.isHard;
  const colors = isHard
    ? { bg: "#FAEAEA", border: "#E0B8B8", text: "#7A1F1F", icon: "✕" }
    : { bg: "#FBF3E5", border: "#E8D7AA", text: "#5A3F08", icon: "⚠" };

  // Pretty label for the constraint type
  const labelMap: Record<string, string> = {
    universe_only: "Investable universe",
    long_only: "Long-only",
    max_position_pct: "Max position size",
    min_cash_pct: "Min cash holding",
    max_cash_pct: "Max cash holding",
    max_single_sector_pct: "Max single sector",
    max_position_count: "Max position count",
    max_gross_exposure: "Max gross exposure",
    max_net_exposure: "Max net exposure",
  };
  const label = labelMap[violation.constraintType] ?? violation.constraintType;

  return (
    <div
      style={{
        padding: "12px 14px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          flex: "0 0 20px",
          borderRadius: "50%",
          background: colors.text,
          color: "white",
          fontSize: 11,
          fontWeight: 600,
          marginTop: 1,
        }}
      >
        {colors.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: colors.text,
            fontWeight: 600,
            marginBottom: 3,
          }}
        >
          {isHard ? "Blocked" : "Warning"} · {label}
        </div>
        <div
          style={{
            fontSize: 13,
            color: colors.text,
            lineHeight: 1.45,
          }}
        >
          {violation.message}
        </div>
      </div>
    </div>
  );
}

function ProjectionRow({
  label,
  before,
  after,
  tone,
}: {
  label: string;
  before: string;
  after: string;
  tone?: "ok" | "soft" | "hard";
}) {
  const toneStyle =
    tone === "hard"
      ? { background: "#FAEAEA", borderLeft: "3px solid #7A1F1F" }
      : tone === "soft"
        ? { background: "#FBF3E5", borderLeft: "3px solid #C9A14A" }
        : {};
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 80px 24px 80px",
        alignItems: "center",
        padding: "8px 14px",
        paddingLeft: tone ? 11 : 14,
        borderBottom: "1px solid #E5E5DE",
        ...toneStyle,
      }}
    >
      <div style={{ color: "#6B6B66" }}>{label}</div>
      <div
        style={{
          textAlign: "right",
          ...numeric,
          color: "#9A9A8E",
        }}
      >
        {before}
      </div>
      <div style={{ textAlign: "center", color: "#9A9A8E", fontSize: 10 }}>
        →
      </div>
      <div
        style={{
          textAlign: "right",
          ...numeric,
          color: "#00183A",
        }}
      >
        {after}
      </div>
    </div>
  );
}

function ExecRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        padding: "8px 14px",
        borderBottom: "1px solid #E5E5DE",
        alignItems: "baseline",
      }}
    >
      <div style={{ color: "#6B6B66" }}>{label}</div>
      <div
        style={{
          ...numeric,
          color: emphasis ? "#00183A" : "#0A0A0A",
          fontSize: emphasis ? 14 : 12,
          fontWeight: emphasis ? 600 : 400,
        }}
      >
        {value}
      </div>
    </div>
  );
}

interface ProjectionResult {
  tradeNotionalBase: Decimal;
  feeBase: Decimal;
  totalCashImpact: Decimal;
  newPositionShares: Decimal;
  newPositionWeight: Decimal;
  newPositionWeightSigned: Decimal;
  newCash: Decimal;
  newCashPct: Decimal;
  newSectorWeight: Decimal;
}

interface SubmitPayload {
  securityId: string;
  side: Side;
  shares: number;
  rationale: string;
  expectedPriceNative: string | null;
  memo?: { url: string; filename: string; sizeBytes: number };
  softOverrideJustification?: string;
  updateNote?: string;
}

function ConfirmModal({
  onCancel,
  fund,
  security,
  side,
  size,
  projection,
  priceNative,
  rationale,
  uploadedMemo,
  softViolations,
  softOverrideJustification,
  resolveThesisId,
  thesisInfo,
  submitPayload,
  fundSlug,
}: {
  onCancel: () => void;
  fund: TradeTicketProps["fund"];
  security: TradeTicketProps["security"];
  side: Side;
  size: ComputedSize;
  projection: ProjectionResult;
  priceNative: Decimal | null;
  rationale: string;
  uploadedMemo: UploadedMemo | null;
  softViolations: ConstraintViolationResponse[];
  softOverrideJustification: string;
  resolveThesisId: () => Promise<string | null>;
  thesisInfo: {
    mode: "create" | "link" | "none";
    newSummary: string | null;
    linkedSummary: string | null;
  };
  submitPayload: SubmitPayload;
  fundSlug: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Resolve the thesis link first. For "create" mode this persists the
      // inline thesis and returns its id; for "link"/"none" it's a no-op.
      let thesisId: string | null;
      try {
        thesisId = await resolveThesisId();
      } catch (e) {
        setSubmitError(
          e instanceof Error ? e.message : "Failed to prepare the thesis"
        );
        return;
      }
      const res = await fetch(`/api/funds/${fundSlug}/submit-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...submitPayload, thesisId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSubmitError(data.error ?? "Submission failed");
        return;
      }
      // Hard reload to the fund page so positions/cash/holdings are fresh
      window.location.href = data.redirectTo ?? `/dashboard/funds/${fundSlug}`;
    } catch {
      setSubmitError("Network error during submission");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,24,58,0.32)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          border: "1px solid #C8C8C0",
          borderRadius: 6,
          padding: 0,
          maxWidth: 540,
          width: "100%",
          fontFamily: "system-ui, sans-serif",
          boxShadow: "0 18px 50px rgba(0,24,58,0.22)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #E5E5DE",
            background: "#FAFAF7",
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#6B6B66",
              marginBottom: 4,
              fontWeight: 500,
            }}
          >
            Confirm trade
          </div>
          <div
            style={{
              ...serif,
              fontSize: 19,
              color: "#00183A",
              lineHeight: 1.3,
            }}
          >
            {side.toUpperCase()} {fmtShares(size.shares)} shares of{" "}
            {security.ticker} ({security.exchange})
          </div>
          <div
            style={{
              fontSize: 12,
              color: "#6B6B66",
              marginTop: 4,
            }}
          >
            {security.name} · {fund.name}
          </div>
        </div>

        <div style={{ padding: "18px 24px" }}>
          <ProjectionTable>
            <ExecRow
              label="At price"
              value={fmtMoney(priceNative ?? new Decimal(0), security.currency)}
            />
            <ExecRow
              label="Notional"
              value={fmtMoney(projection.tradeNotionalBase, fund.baseCurrency)}
            />
            <ExecRow
              label={`Fee (${fund.tradingFeesBps} bps)`}
              value={fmtMoney(projection.feeBase, fund.baseCurrency)}
            />
            <ExecRow
              label="Cash impact"
              value={`${projection.totalCashImpact.isNegative() ? "−" : "+"}${fmtMoney(projection.totalCashImpact, fund.baseCurrency)}`}
              emphasis
            />
          </ProjectionTable>

          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "#6B6B66",
                fontWeight: 500,
                marginBottom: 6,
              }}
            >
              Rationale
            </div>
            <div
              style={{
                fontSize: 13,
                color: "#0A0A0A",
                background: "#FAFAF7",
                border: "1px solid #E5E5DE",
                padding: "10px 14px",
                lineHeight: 1.5,
                wordBreak: "break-word",
                overflowWrap: "break-word",
              }}
            >
              {rationale}
            </div>
          </div>

          {(thesisInfo.mode === "create" || thesisInfo.mode === "link") && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Thesis
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "#0A0A0A",
                  background: "#FAFAF7",
                  border: "1px solid #E5E5DE",
                  padding: "10px 14px",
                  lineHeight: 1.5,
                  wordBreak: "break-word",
                  overflowWrap: "break-word",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "#00183A",
                    fontWeight: 600,
                    marginRight: 8,
                  }}
                >
                  {thesisInfo.mode === "create"
                    ? "New thesis"
                    : "Linked thesis"}
                </span>
                {thesisInfo.mode === "create"
                  ? thesisInfo.newSummary
                  : thesisInfo.linkedSummary}
              </div>
            </div>
          )}

          {uploadedMemo && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Attached memo
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "#0A0A0A",
                  background: "#FAFAF7",
                  border: "1px solid #E5E5DE",
                  padding: "8px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ color: "#7A1F1F" }}>📄</span>
                <span style={{ flex: 1 }}>{uploadedMemo.filename}</span>
                <span style={{ ...numeric, color: "#6B6B66", fontSize: 11 }}>
                  {(uploadedMemo.sizeBytes / 1024).toFixed(0)} KB
                </span>
              </div>
            </div>
          )}

          {softViolations.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#5A3F08",
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Soft breaches accepted
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "#0A0A0A",
                  background: "#FBF3E5",
                  border: "1px solid #E8D7AA",
                  padding: "10px 14px",
                  lineHeight: 1.5,
                }}
              >
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 18,
                    fontSize: 12,
                    color: "#5A3F08",
                    marginBottom: 8,
                  }}
                >
                  {softViolations.map((v) => (
                    <li key={v.constraintId}>{v.message}</li>
                  ))}
                </ul>
                <div
                  style={{
                    fontSize: 12,
                    color: "#5A3F08",
                    paddingTop: 6,
                    borderTop: "1px solid #E8D7AA",
                  }}
                >
                  <strong style={{ fontWeight: 600 }}>Justification:</strong>{" "}
                  {softOverrideJustification}
                </div>
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 24px",
            background: "#FAFAF7",
            borderTop: "1px solid #E5E5DE",
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            alignItems: "center",
          }}
        >
          {submitError && (
            <div
              style={{
                flex: 1,
                fontSize: 12,
                color: "#7A1F1F",
                textAlign: "left",
              }}
            >
              {submitError}
            </div>
          )}
          <button
            onClick={onCancel}
            disabled={submitting}
            style={{
              ...secondaryButtonStyle,
              opacity: submitting ? 0.5 : 1,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            ← Back to edit
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              ...primaryButtonStyle,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? "wait" : "pointer",
            }}
          >
            {submitting ? "Submitting…" : "Confirm and submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thesis picker (Phase 2c)
// ---------------------------------------------------------------------------

interface ThesisPickerProps {
  intent: "open" | "add" | "reduce";
  fundSlug: string;
  activeTheses: ThesisOption[];
  thesesLoaded: boolean;
  resolution: {
    mode: "create" | "link" | "none";
    thesisId: string | null;
    valid: boolean;
    required: boolean;
  };
  openModeToggle: "create" | "link";
  setOpenModeToggle: (m: "create" | "link") => void;
  addNoThesisChoice: "create" | "skip";
  setAddNoThesisChoice: (c: "create" | "skip") => void;
  linkedThesisId: string | null;
  setLinkedThesisId: (id: string) => void;
  linkedThesis: ThesisOption | null;
  fullyClosing: boolean;
  security: TradeTicketProps["security"];
  conviction: Conviction;
  setConviction: (c: Conviction) => void;
  holdingPeriod: HoldingPeriod;
  setHoldingPeriod: (p: HoldingPeriod) => void;
  summary: string;
  setSummary: (s: string) => void;
  summaryLen: number;
  targetWeightPct: string;
  setTargetWeightPct: (v: string) => void;
  targetPrice: string;
  setTargetPrice: (v: string) => void;
  memoFile: File | null;
  setMemoFile: (f: File | null) => void;
  updateNote: string;
  setUpdateNote: (s: string) => void;
}

function ThesisPicker(props: ThesisPickerProps) {
  const {
    intent,
    fundSlug,
    activeTheses,
    thesesLoaded,
    resolution,
    openModeToggle,
    setOpenModeToggle,
    addNoThesisChoice,
    setAddNoThesisChoice,
    linkedThesisId,
    setLinkedThesisId,
    linkedThesis,
    fullyClosing,
    security,
    conviction,
    setConviction,
    holdingPeriod,
    setHoldingPeriod,
    summary,
    setSummary,
    summaryLen,
    targetWeightPct,
    setTargetWeightPct,
    targetPrice,
    setTargetPrice,
    memoFile,
    setMemoFile,
    updateNote,
    setUpdateNote,
  } = props;

  const currencySymbol =
    security.currency === "GBP" ? "£" : security.currency === "EUR" ? "€" : "$";
  const summaryValid = summaryLen > 0 && summaryLen <= 500;

  const muted: React.CSSProperties = { fontSize: 12, color: "#9A9A8E" };
  const hint: React.CSSProperties = {
    fontSize: 12,
    color: "#6B6B66",
    marginBottom: 12,
    lineHeight: 1.5,
  };
  const subLabel: React.CSSProperties = {
    display: "block",
    fontSize: 11,
    color: "#6B6B66",
    marginBottom: 6,
  };

  // A compact read-only card for an existing thesis.
  const thesisCard = (t: ThesisOption | null) => {
    if (!t) return null;
    return (
      <div
        style={{
          border: "1px solid #E5E5DE",
          background: "#FAFAF7",
          padding: "10px 14px",
          fontSize: 12,
          color: "#0A0A0A",
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "baseline",
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#00183A",
              fontWeight: 600,
            }}
          >
            {t.conviction} conviction
          </span>
          <span style={{ color: "#C8C8C0" }}>·</span>
          <span style={{ fontSize: 11, color: "#6B6B66" }}>
            {PERIOD_LABELS[t.holdingPeriod as HoldingPeriod] ?? t.holdingPeriod}
          </span>
          {t.direction ? (
            <>
              <span style={{ color: "#C8C8C0" }}>·</span>
              <span style={{ fontSize: 11, color: "#6B6B66" }}>
                {t.direction}
              </span>
            </>
          ) : null}
        </div>
        <div style={{ wordBreak: "break-word", overflowWrap: "break-word" }}>
          {t.summary}
        </div>
        {t.memoBlobUrl ? (
          <div style={{ marginTop: 10 }}>
            <PdfMemoCard
              href={`/api/funds/${fundSlug}/theses/${t.id}/memo`}
              filename={t.memoBlobFilename ?? "memo.pdf"}
            />
          </div>
        ) : null}
      </div>
    );
  };

  // The inline create-thesis form (shared by open→create and add→create).
  const createForm = (
    <div style={{ display: "grid", gap: 18 }}>
      {/* CONVICTION */}
      <div>
        <span style={subLabel}>Conviction</span>
        <div style={{ display: "flex", gap: 0 }}>
          {(["high", "medium", "low"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setConviction(c)}
              style={{
                flex: 1,
                padding: "8px 12px",
                border: "1px solid #D9D9D2",
                marginLeft: "-1px",
                background: conviction === c ? "#00183A" : "white",
                color: conviction === c ? "white" : "#6B6B66",
                fontFamily: "system-ui, sans-serif",
                fontSize: 11,
                fontWeight: conviction === c ? 600 : 400,
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* HOLDING PERIOD */}
      <div>
        <span style={subLabel}>Holding period</span>
        <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
          {(["short", "medium", "long", "indefinite"] as HoldingPeriod[]).map(
            (p) => (
              <button
                key={p}
                type="button"
                onClick={() => setHoldingPeriod(p)}
                style={{
                  flex: 1,
                  minWidth: 120,
                  padding: "8px 10px",
                  border: "1px solid #D9D9D2",
                  marginLeft: "-1px",
                  background: holdingPeriod === p ? "#00183A" : "white",
                  color: holdingPeriod === p ? "white" : "#6B6B66",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 11,
                  fontWeight: holdingPeriod === p ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {PERIOD_LABELS[p]}
              </button>
            )
          )}
        </div>
      </div>

      {/* TARGETS (optional) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <span style={subLabel}>Target weight (%) — optional</span>
          <input
            type="number"
            value={targetWeightPct}
            onChange={(e) => setTargetWeightPct(e.target.value)}
            step="0.1"
            min="0"
            max="50"
            placeholder="e.g. 5"
            style={{ ...inputStyle, ...numeric }}
          />
        </div>
        <div>
          <span style={subLabel}>
            Target price ({currencySymbol}) — optional
          </span>
          <input
            type="number"
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
            step="0.01"
            min="0"
            placeholder="e.g. 150.00"
            style={{ ...inputStyle, ...numeric }}
          />
        </div>
      </div>

      {/* SUMMARY */}
      <div>
        <span style={subLabel}>
          Summary{" "}
          <span
            style={{
              color: summaryValid
                ? "#1F5C3A"
                : summaryLen > 0
                  ? "#7A1F1F"
                  : "#9A9A8E",
            }}
          >
            ({summaryLen}/500)
          </span>
        </span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          placeholder="What you believe, why now, what could prove it wrong."
          style={{
            ...inputStyle,
            resize: "vertical",
            lineHeight: 1.5,
            fontFamily: "system-ui, sans-serif",
          }}
        />
      </div>

      {/* MEMO PDF (optional) */}
      <div>
        <span style={subLabel}>Thesis memo PDF — optional</span>
        <div
          style={{
            border: "1px dashed #D9D9D2",
            padding: "12px",
            background: "#FAFAF7",
            textAlign: "center",
            color: "#6B6B66",
            fontSize: 12,
          }}
        >
          {memoFile ? (
            <div>
              <div
                style={{ fontSize: 13, color: "#00183A", fontWeight: 500 }}
              >
                {memoFile.name}
              </div>
              <div style={{ fontSize: 11, color: "#6B6B66", marginTop: 2 }}>
                {(memoFile.size / 1024).toFixed(0)} KB
              </div>
              <button
                type="button"
                onClick={() => setMemoFile(null)}
                style={{
                  marginTop: 6,
                  background: "none",
                  border: "none",
                  color: "#7A1F1F",
                  cursor: "pointer",
                  fontSize: 11,
                  fontFamily: "system-ui, sans-serif",
                  textDecoration: "underline",
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <label style={{ cursor: "pointer" }}>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setMemoFile(f);
                }}
                style={{ display: "none" }}
              />
              <div>
                Drop a PDF here, or{" "}
                <span
                  style={{ color: "#00183A", textDecoration: "underline" }}
                >
                  browse
                </span>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  PDF only · max 10 MB
                </div>
              </div>
            </label>
          )}
        </div>
      </div>
    </div>
  );

  // A selectable list of active theses (used in open→link mode).
  const linkPicker = (
    <div
      style={{
        border: "1px solid #E5E5DE",
        background: "#FAFAF7",
        maxHeight: 240,
        overflowY: "auto",
      }}
    >
      {activeTheses.map((t) => {
        const selected = t.id === linkedThesisId;
        return (
          <div
            key={t.id}
            onClick={() => setLinkedThesisId(t.id)}
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid #F0EFEA",
              background: selected ? "#E8E4D4" : "transparent",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                marginBottom: 3,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "#00183A",
                  fontWeight: 600,
                }}
              >
                {t.conviction} conviction
              </span>
              <span style={{ color: "#C8C8C0" }}>·</span>
              <span style={{ fontSize: 11, color: "#6B6B66" }}>
                {PERIOD_LABELS[t.holdingPeriod as HoldingPeriod] ??
                  t.holdingPeriod}
              </span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#0A0A0A",
                lineHeight: 1.5,
                wordBreak: "break-word",
                overflowWrap: "break-word",
              }}
            >
              {t.summary}
            </div>
          </div>
        );
      })}
    </div>
  );

  // Create/link toggle used in the OPEN flow.
  const createLinkToggle = (
    <div style={{ display: "flex", gap: 0, marginBottom: 14 }}>
      {(
        [
          ["create", "Create new"],
          ["link", "Link existing"],
        ] as const
      ).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => setOpenModeToggle(mode)}
          style={{
            flex: 1,
            padding: "8px 12px",
            border: "1px solid #D9D9D2",
            marginLeft: "-1px",
            background: openModeToggle === mode ? "#00183A" : "white",
            color: openModeToggle === mode ? "white" : "#6B6B66",
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            fontWeight: openModeToggle === mode ? 600 : 400,
            cursor: "pointer",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (!thesesLoaded) {
    return <div style={muted}>Loading theses…</div>;
  }

  // ----- OPEN -----
  if (intent === "open") {
    return (
      <div>
        <div style={hint}>
          Opening a position requires an investment thesis — the &ldquo;why&rdquo;
          behind the trade. The per-trade rationale below is a short paraphrase;
          this thesis is the durable idea the position lives under.
        </div>
        {activeTheses.length > 0 && createLinkToggle}
        {resolution.mode === "create" ? (
          <>
            {activeTheses.length === 0 && (
              <div style={{ ...muted, marginBottom: 12 }}>
                No existing thesis for {security.ticker} — create one.
              </div>
            )}
            {createForm}
          </>
        ) : (
          linkPicker
        )}
      </div>
    );
  }

  // ----- ADD -----
  if (intent === "add") {
    if (activeTheses.length > 0) {
      return (
        <div>
          <div style={hint}>
            Adding to an existing position — this trade links to the active
            thesis.
          </div>
          {activeTheses.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <span style={subLabel}>Linked thesis</span>
              <select
                value={linkedThesisId ?? ""}
                onChange={(e) => setLinkedThesisId(e.target.value)}
                style={{ ...inputStyle }}
              >
                {activeTheses.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.conviction} · {t.summary.slice(0, 60)}
                    {t.summary.length > 60 ? "…" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {thesisCard(linkedThesis)}
          <div style={{ marginTop: 14 }}>
            <span style={subLabel}>Update note — optional</span>
            <textarea
              value={updateNote}
              onChange={(e) => setUpdateNote(e.target.value)}
              rows={2}
              placeholder="What changed since you opened? (Recorded against the thesis in a later release.)"
              style={{
                ...inputStyle,
                resize: "vertical",
                lineHeight: 1.5,
                fontFamily: "system-ui, sans-serif",
              }}
            />
            <div style={{ ...muted, marginTop: 4, fontSize: 10 }}>
              Recorded against the thesis timeline, alongside this trade.
            </div>
          </div>
        </div>
      );
    }
    // No active thesis on this holding (legacy position).
    return (
      <div>
        <div style={hint}>
          No active thesis exists for this holding — it may have been opened
          before theses were introduced. You can attach one now, or proceed
          without.
        </div>
        <div style={{ display: "flex", gap: 0, marginBottom: 14 }}>
          {(
            [
              ["skip", "Proceed without"],
              ["create", "Create a thesis"],
            ] as const
          ).map(([choice, label]) => (
            <button
              key={choice}
              type="button"
              onClick={() => setAddNoThesisChoice(choice)}
              style={{
                flex: 1,
                padding: "8px 12px",
                border: "1px solid #D9D9D2",
                marginLeft: "-1px",
                background: addNoThesisChoice === choice ? "#00183A" : "white",
                color: addNoThesisChoice === choice ? "white" : "#6B6B66",
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                fontWeight: addNoThesisChoice === choice ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {addNoThesisChoice === "create" ? (
          createForm
        ) : (
          <div style={muted}>
            This trade will be recorded without a thesis link.
          </div>
        )}
      </div>
    );
  }

  // ----- REDUCE / CLOSE -----
  return (
    <div>
      {linkedThesis ? (
        <>
          <div style={{ ...hint, marginBottom: 8 }}>
            {fullyClosing
              ? "This trade fully closes the position. Closing thesis:"
              : "Reducing the position under thesis:"}
          </div>
          {thesisCard(linkedThesis)}
          {fullyClosing && (
            <div style={{ ...muted, marginTop: 8, fontSize: 10 }}>
              A post-mortem prompt for closed theses is coming in a later
              release.
            </div>
          )}
        </>
      ) : (
        <div style={muted}>
          No active thesis is linked to this position (it may predate theses).
          The trade will be recorded without a thesis link.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #D9D9D2",
  borderRadius: 3,
  padding: "7px 10px",
  fontSize: 13,
  outline: "none",
  fontFamily: "system-ui, sans-serif",
  color: "#0A0A0A",
  background: "white",
  boxSizing: "border-box",
  wordBreak: "break-word",
  overflowWrap: "break-word",
};

const sideButtonStyle: React.CSSProperties = {
  padding: "8px 18px",
  border: "1px solid #C8C8C0",
  fontSize: 11,
  letterSpacing: "0.06em",
  cursor: "pointer",
  flex: 1,
  marginLeft: "-1px",
  fontFamily: "system-ui, sans-serif",
};

const stepperButtonStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #C8C8C0",
  color: "#00183A",
  fontSize: 18,
  fontWeight: 400,
  width: 38,
  cursor: "pointer",
  fontFamily: "system-ui, sans-serif",
  padding: 0,
  borderRadius: "3px 0 0 3px",
  lineHeight: 1,
  transition: "background 0.1s",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#00183A",
  color: "white",
  border: "none",
  padding: "9px 16px",
  borderRadius: 3,
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  fontWeight: 500,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "white",
  color: "#00183A",
  border: "1px solid #C8C8C0",
  padding: "9px 16px",
  borderRadius: 3,
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  cursor: "pointer",
};
