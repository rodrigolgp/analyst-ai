export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

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

      if (!meta?.regularMarketPrice || closes.length < 2) return null;

      // Filtra nulls e ordena
      const valid = timestamps
        .map((t,i) => ({ t, c: closes[i] }))
        .filter(x => x.c !== null && x.c !== undefined);

      if (valid.length < 2) return null;

      const hoje = meta.regularMarketPrice;

      // Ontem = ultimo fechamento disponivel (penultimo ponto, pois o ultimo pode ser hoje ainda aberto)
      const ontem = valid[valid.length - 1]?.c || valid[valid.length - 2]?.c;

      // Variacao do DIA
      const varDia = ontem ? parseFloat(((hoje - ontem) / ontem * 100).toFixed(2)) : 0;

      // Inicio do mes e do ano
      const agora = new Date();
      const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime() / 1000;
      const inicioAno = new Date(agora.getFullYear(), 0, 1).getTime() / 1000;

      // Ultimo fechamento ANTES do inicio do mes
      let fechoMes = null;
      let fechoAno = null;
      for (let i = 0; i < valid.length; i++) {
        if (valid[i].t < inicioMes) fechoMes = valid[i].c;
        if (valid[i].t < inicioAno) fechoAno = valid[i].c;
      }

      const varMes = fechoMes ? parseFloat(((hoje - fechoMes) / fechoMes * 100).toFixed(2)) : 0;
      const varAno = fechoAno ? parseFloat(((hoje - fechoAno) / fechoAno * 100).toFixed(2)) : 0;

      return { valor_atual: hoje, var_dia: varDia, var_mes: varMes, var_ano: varAno };
    } catch(e) { return null; }
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
      },
      ibovespa: ibov ? {
        valor_atual: ibov.valor_atual,
        var_dia: ibov.var_dia,
        var_mes: ibov.var_mes,
        var_ano: ibov.var_ano,
      } : {
        var_dia: 0, var_mes: 0, var_ano: 0,
      },
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
