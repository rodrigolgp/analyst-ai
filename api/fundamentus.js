export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  // Remove sufixo .SA se vier
  const t = ticker.replace(".SA","").toUpperCase();

  try {
    // Tenta brapi.dev primeiro (API brasileira gratuita)
    const brapiUrl = `https://brapi.dev/api/quote/${t}?modules=summaryProfile,defaultKeyStatistics,financialData`;
    const r = await fetch(brapiUrl, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });

    if (r.ok) {
      const d = await r.json();
      const q = d?.results?.[0];
      if (q) {
        const stats = q.defaultKeyStatistics || {};
        const fin = q.financialData || {};
        const profile = q.summaryProfile || {};

        return res.status(200).json({
          ticker: t,
          fonte: "brapi.dev",
          // Valuation
          pl: stats.trailingPE ? parseFloat(stats.trailingPE.toFixed(2)) : null,
          pvp: stats.priceToBook ? parseFloat(stats.priceToBook.toFixed(2)) : null,
          ev_ebitda: stats.enterpriseToEbitda ? parseFloat(stats.enterpriseToEbitda.toFixed(2)) : null,
          // Rentabilidade
          roe: fin.returnOnEquity ? parseFloat((fin.returnOnEquity*100).toFixed(2)) : null,
          roa: fin.returnOnAssets ? parseFloat((fin.returnOnAssets*100).toFixed(2)) : null,
          margem_liquida: fin.profitMargins ? parseFloat((fin.profitMargins*100).toFixed(2)) : null,
          margem_ebitda: fin.ebitdaMargins ? parseFloat((fin.ebitdaMargins*100).toFixed(2)) : null,
          // Dividendos
          dy: stats.dividendYield ? parseFloat((stats.dividendYield*100).toFixed(2)) : null,
          // Divida
          divida_pl: stats.debtToEquity ? parseFloat((stats.debtToEquity/100).toFixed(2)) : null,
          // Crescimento
          crescimento_receita: fin.revenueGrowth ? parseFloat((fin.revenueGrowth*100).toFixed(2)) : null,
          crescimento_lucro: fin.earningsGrowth ? parseFloat((fin.earningsGrowth*100).toFixed(2)) : null,
          // Setor
          setor: profile.sector || null,
          industria: profile.industry || null,
          descricao: profile.longBusinessSummary ? profile.longBusinessSummary.slice(0,200) : null,
        });
      }
    }

    // Fallback: Fundamentus scraping
    const fUrl = `https://www.fundamentus.com.br/detalhes.php?papel=${t}`;
    const fr = await fetch(fUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html",
      }
    });

    if (fr.ok) {
      const html = await fr.text();

      function extractVal(label) {
        const re = new RegExp(label + '[^<]*<[^>]+>([\\d.,%-]+)', 'i');
        const m = html.match(re);
        if (!m) return null;
        const v = m[1].replace('.','').replace(',','.');
        return parseFloat(v) || null;
      }

      return res.status(200).json({
        ticker: t,
        fonte: "fundamentus.com.br",
        pl: extractVal('P/L'),
        pvp: extractVal('P/VP'),
        roe: extractVal('ROE'),
        margem_liquida: extractVal('Mrg Liq'),
        margem_ebitda: extractVal('Mrg Ebit'),
        dy: extractVal('Div.Yield'),
        divida_pl: extractVal('Div.Brut/ Patrim'),
        crescimento_receita: null,
        setor: null,
      });
    }

    return res.status(404).json({ error: "Dados fundamentalistas nao encontrados", ticker: t });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
