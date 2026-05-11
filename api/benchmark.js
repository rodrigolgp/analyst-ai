export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // CDI anual atual
  const CDI_ANUAL = 10.75;
  const CDI_MENSAL = parseFloat(((Math.pow(1 + CDI_ANUAL/100, 1/12) - 1) * 100).toFixed(4));
  const CDI_DIA = parseFloat(((Math.pow(1 + CDI_ANUAL/100, 1/252) - 1) * 100).toFixed(4));
  const CDI_ANO = parseFloat(((Math.pow(1 + CDI_MENSAL/100, 12) - 1) * 100).toFixed(2));

  async function fetchIBOV() {
    try {
      const r = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?interval=1d&range=1y",
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      if (!r.ok) return null;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      const meta = result?.meta;
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const timestamps = result?.timestamp || [];

      if (!meta?.regularMarketPrice || !closes.length) return null;

      const hoje = meta.regularMarketPrice;
      const ontem = meta.chartPreviousClose || closes[closes.length - 2];

      // Primeiro dia do mes atual
      const agora = new Date();
      const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
      const inicioAno = new Date(agora.getFullYear(), 0, 1);

      // Acha o fechamento mais proximo do inicio do mes e inicio do ano
      let fechoMes = null;
      let fechoAno = null;
      for (let i = 0; i < timestamps.length; i++) {
        const d = new Date(timestamps[i] * 1000);
        if (!fechoAno && d >= inicioAno) fechoAno = closes[i - 1] || closes[i];
        if (!fechoMes && d >= inicioMes) fechoMes = closes[i - 1] || closes[i];
      }

      const varDia = ontem ? parseFloat(((hoje - ontem) / ontem * 100).toFixed(2)) : 0;
      const varMes = fechoMes ? parseFloat(((hoje - fechoMes) / fechoMes * 100).toFixed(2)) : 0;
      const varAno = fechoAno ? parseFloat(((hoje - fechoAno) / fechoAno * 100).toFixed(2)) : 0;

      return {
        valor_atual: hoje,
        var_dia: varDia,
        var_mes: varMes,
        var_ano: varAno,
      };
    } catch(e) {
      return null;
    }
  }

  try {
    const ibov = await fetchIBOV();

    return res.status(200).json({
      data: new Date().toLocaleDateString("pt-BR"),
      cdi: {
        taxa_anual: CDI_ANUAL,
        var_dia: CDI_DIA,
        var_mes: CDI_MENSAL,
        var_ano: CDI_ANO,
        label: "CDI ("+CDI_ANUAL+"%a.a.)",
      },
      ibovespa: ibov ? {
        valor_atual: ibov.valor_atual,
        var_dia: ibov.var_dia,
        var_mes: ibov.var_mes,
        var_ano: ibov.var_ano,
        label: "IBOVESPA",
      } : {
        var_dia: 0,
        var_mes: 0,
        var_ano: 0,
        label: "IBOVESPA (indisponivel)",
      },
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
