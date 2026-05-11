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
      // Busca 5 dias para calcular variacao do dia corretamente
      const rDia = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?interval=1d&range=5d",
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      // Busca 1 ano para calcular mes e ano
      const rAno = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?interval=1d&range=1y",
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );

      if (!rDia.ok || !rAno.ok) return null;

      const dDia = await rDia.json();
      const dAno = await rAno.json();

      const metaDia = dDia?.chart?.result?.[0]?.meta;
      const closesDia = dDia?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];

      const metaAno = dAno?.chart?.result?.[0]?.meta;
      const closesAno = dAno?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const timestampsAno = dAno?.chart?.result?.[0]?.timestamp || [];

      if (!metaDia?.regularMarketPrice) return null;

      const hoje = metaDia.regularMarketPrice;

      // Para variacao do dia: pega o penultimo fechamento dos ultimos 5 dias
      const validDia = closesDia.filter(c => c !== null && c !== undefined);
      const ontem = validDia.length >= 2 ? validDia[validDia.length - 2] : validDia[validDia.length - 1];
      const varDia = ontem ? parseFloat(((hoje - ontem) / ontem * 100).toFixed(2)) : 0;

      // Para mes e ano: usa historico de 1 ano
      const validAno = timestampsAno
        .map((t,i) => ({ t, c: closesAno[i] }))
        .filter(x => x.c !== null && x.c !== undefined);

      const agora = new Date();
      const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime() / 1000;
      const inicioAno = new Date(agora.getFullYear(), 0, 1).getTime() / 1000;

      let fechoMes = null;
      let fechoAno = null;
      for (const item of validAno) {
        if (item.t < inicioMes) fechoMes = item.c;
        if (item.t < inicioAno) fechoAno = item.c;
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
