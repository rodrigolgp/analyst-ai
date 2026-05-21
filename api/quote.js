// v2
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  // B3: exatamente 4 letras + 1-2 numeros (ex: PETR4, VALE3, KNRI11)
  // EUA: qualquer outra coisa (AAPL, DELL, NVDA, BRK-B, etc)
  const isB3 = /^[A-Z]{4}[0-9]{1,2}$/.test(ticker) && !ticker.includes("-");
  const BRAPI_TOKEN = process.env.BRAPI_TOKEN || "";

  // ── Tentativa 1: Brapi (somente B3) ──
  if (isB3) {
    try {
      const url = BRAPI_TOKEN
        ? `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}&range=1d&interval=1d`
        : `https://brapi.dev/api/quote/${ticker}?range=1d&interval=1d`;

      const r = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "AnalystAI/1.0" }
      });

      if (r.ok) {
        const d = await r.json();
        const q = d?.results?.[0];
        if (q?.regularMarketPrice) {
          return res.status(200).json({
            price: q.regularMarketPrice,
            change: q.regularMarketChangePercent?.toFixed(2) ?? "0.00",
            high: q.regularMarketDayHigh,
            low: q.regularMarketDayLow,
            volume: q.regularMarketVolume,
            prevClose: q.regularMarketPreviousClose,
            open: q.regularMarketOpen,
            market: "B3",
            currency: "R$",
            name: q.longName || q.shortName || ticker,
            source: "Brapi",
            time: q.regularMarketTime,
          });
        }
      }
    } catch(e) {}
  }

  // ── Tentativa 2: Yahoo Finance ──
  // Para B3 usa sufixo .SA, para EUA usa ticker direto
  const sym = isB3 ? `${ticker}.SA` : ticker;
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
        const priceDiff = Math.abs((meta.regularMarketPrice - prev) / prev);
        if (priceDiff > 0.5) continue;
        return res.status(200).json({
          price: meta.regularMarketPrice,
          change: (((meta.regularMarketPrice - prev) / prev) * 100).toFixed(2),
          high: meta.regularMarketDayHigh,
          low: meta.regularMarketDayLow,
          volume: meta.regularMarketVolume,
          prevClose: prev,
          open: meta.regularMarketOpen,
          market: isB3 ? "B3" : "NYSE/NASDAQ",
          currency: isB3 ? "R$" : "US$",
          name: meta.longName || meta.shortName || ticker,
          source: `Yahoo Finance`,
        });
      }
    } catch(e) {}
  }

  return res.status(404).json({ error: "Cotacao nao encontrada. Use o campo de preco manual." });
}
