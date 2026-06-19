export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, data } = req.query;
  if (!ticker || !data) return res.status(400).json({ error: "ticker e data (YYYY-MM-DD) sao obrigatorios" });

  try {
    const period1 = Math.floor(new Date(data + "T00:00:00Z").getTime() / 1000);
    const period2 = period1 + 86400 * 10; // janela de 10 dias para garantir pregão

    const sym = ticker.startsWith("%5E") || ticker.startsWith("^") ? ticker.replace("^","%5E") : ticker;

    for (const host of ["query1", "query2"]) {
      try {
        const r = await fetch(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?period1=${period1}&period2=${period2}&interval=1d`,
          { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
        );
        if (!r.ok) continue;
        const d = await r.json();
        const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
        const timestamps = d?.chart?.result?.[0]?.timestamp;
        if (closes && closes.length) {
          const idx = closes.findIndex(c => c != null);
          if (idx !== -1) {
            return res.status(200).json({
              price: closes[idx],
              date: timestamps ? new Date(timestamps[idx] * 1000).toISOString().split("T")[0] : data,
            });
          }
        }
      } catch(e) {}
    }
    return res.status(404).json({ error: "Dados historicos nao encontrados" });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
