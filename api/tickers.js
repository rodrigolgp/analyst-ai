export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Top ativos mais negociados B3 + NYSE/NASDAQ
  const TICKERS = [
    // B3 mais negociados
    { t: "PETR4.SA", n: "PETR4", label: "Petrobras" },
    { t: "VALE3.SA", n: "VALE3", label: "Vale" },
    { t: "ITUB4.SA", n: "ITUB4", label: "Itau" },
    { t: "BBDC4.SA", n: "BBDC4", label: "Bradesco" },
    { t: "BBAS3.SA", n: "BBAS3", label: "Banco do Brasil" },
    { t: "WEGE3.SA", n: "WEGE3", label: "WEG" },
    { t: "ABEV3.SA", n: "ABEV3", label: "Ambev" },
    { t: "RENT3.SA", n: "RENT3", label: "Localiza" },
    { t: "PRIO3.SA", n: "PRIO3", label: "PRIO" },
    { t: "VBBR3.SA", n: "VBBR3", label: "Vibra" },
    { t: "BPAC11.SA", n: "BPAC11", label: "BTG Pactual" },
    { t: "RDOR3.SA", n: "RDOR3", label: "Rede D'Or" },
    // NYSE/NASDAQ mais negociados
    { t: "AAPL", n: "AAPL", label: "Apple" },
    { t: "NVDA", n: "NVDA", label: "Nvidia" },
    { t: "MSFT", n: "MSFT", label: "Microsoft" },
    { t: "AMZN", n: "AMZN", label: "Amazon" },
    { t: "META", n: "META", label: "Meta" },
    { t: "GOOGL", n: "GOOGL", label: "Google" },
    { t: "TSLA", n: "TSLA", label: "Tesla" },
    { t: "JPM", n: "JPM", label: "JPMorgan" },
  ];

  async function fetchPrice(ticker) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      if (!r.ok) return null;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return null;
      const prev = meta.chartPreviousClose || meta.regularMarketPrice;
      const change = (((meta.regularMarketPrice - prev) / prev) * 100).toFixed(2);
      return { price: meta.regularMarketPrice, change };
    } catch(e) { return null; }
  }

  try {
    const results = await Promise.all(
      TICKERS.map(async tk => {
        const q = await fetchPrice(tk.t);
        if (!q) return null;
        const isB3 = tk.t.endsWith(".SA");
        return {
          ticker: tk.n,
          label: tk.label,
          price: q.price,
          change: q.change,
          currency: isB3 ? "R$" : "US$",
          up: parseFloat(q.change) >= 0,
        };
      })
    );

    const valid = results.filter(Boolean);
    return res.status(200).json({ tickers: valid });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
