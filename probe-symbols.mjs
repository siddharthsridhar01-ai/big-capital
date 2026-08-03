import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance();
const syms = ["AAPL","BRK-B","BRK.B","BRK-A","NOVO-B.CO","NOVO.B","NVO","PHNX.L","PHNX"];
for (const s of syms) {
  try {
    const q = await yf.quote(s, undefined, { validateResult: false });
    console.log(s.padEnd(12), "OK  ", String(q?.regularMarketPrice).padEnd(10), q?.currency, "|", q?.fullExchangeName ?? "", "|", q?.longName ?? "");
  } catch (e) {
    console.log(s.padEnd(12), "FAIL", String(e?.message ?? "").slice(0, 70));
  }
}
