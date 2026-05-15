/**
 * Active intraday data provider binding.
 *
 * Change this import + export to swap data sources. The rest of the system
 * uses `import { activeProvider } from "@/lib/intraday/provider"` and is
 * agnostic to which underlying source is used.
 *
 * To swap to EODHD intraday:
 *   1. Build src/lib/intraday/eodhd.ts implementing IntradayProvider
 *   2. Change the import below to eodhdProvider
 *   3. Update src/lib/intraday/symbols.ts to use the EODHD ticker convention
 *      (which is similar but uses ".LSE" instead of ".L" etc.)
 */

import { yahooProvider } from "./yahoo";
import type { IntradayProvider } from "./types";

export const activeProvider: IntradayProvider = yahooProvider;
