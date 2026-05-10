export default async function handler(req, res) {
  // Aceita chamadas do cron do Vercel e chamadas manuais
  res.setHeader("Access-Control-Allow-Origin", "*");

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!REDIS_URL || !REDIS_TOKEN || !TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: "Environment variables not configured" });
  }

  // Horario de mercado: B3 10h-18h, NYSE 10h-17h (horario Brasilia)
  const agora = new Date();
  const horaBrasilia = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hora = horaBrasilia.getHours();
  const diaSemana = horaBrasilia.getDay(); // 0=domingo, 6=sabado

  // Fora do horario de mercado nao monitora
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  const foraDoHorario = hora < 10 || hora >= 18;

  if (fimDeSemana || foraDoHorario) {
    return res.status(200).json({ ok: true, msg: "Fora do horario de mercado", hora, diaSemana });
  }

  async function sendTelegram(message) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
  }

  async function fetchQuote(ticker) {
    try {
      const isB3 = /^[A-Z]{4}[0-9]{1,2}$/.test(ticker) && !ticker.includes("-");
      const sym = isB3 ? `${ticker}.SA` : ticker;
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      if (!r.ok) return null;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return null;
      return {
        price: meta.regularMarketPrice,
        currency: isB3 ? "R$" : "US$",
      };
    } catch(e) { return null; }
  }

  try {
    // Carrega carteira do Redis
    const r = await fetch(`${REDIS_URL}/get/analyst_ai_portfolio`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const d = await r.json();
    const portfolio = d.result ? JSON.parse(d.result) : [];

    if (!portfolio.length) {
      return res.status(200).json({ ok: true, msg: "Carteira vazia" });
    }

    const alertas = [];
    const resultados = [];

    for (const p of portfolio) {
      const quote = await fetchQuote(p.ticker);
      if (!quote) continue;

      const atual = quote.price;
      const stopNum = p.stop ? parseFloat(String(p.stop).replace("R$","").replace("US$","").replace(",",".")) : null;
      const alvoNum = p.target ? parseFloat(String(p.target).replace("R$","").replace("US$","").replace(",",".")) : null;
      const varPct = (((atual - p.price) / p.price) * 100).toFixed(2);

      resultados.push({ ticker: p.ticker, atual, varPct });

      // Verifica stop
      if (stopNum && atual <= stopNum) {
        alertas.push({
          tipo: "STOP",
          msg: `🔴 *ATLAS WEALTH — STOP ATINGIDO*\n\nAtivo: *${p.ticker}*\nPreco atual: ${quote.currency}${atual.toFixed(2)}\nStop loss: ${p.stop}\nVariacao: ${varPct}%\n\n⚠️ *VENDA IMEDIATAMENTE* para proteger seu capital.`
        });
      }
      // Verifica alvo
      else if (alvoNum && atual >= alvoNum) {
        const lucro = (((atual - p.price) / p.price) * 100).toFixed(2);
        alertas.push({
          tipo: "ALVO",
          msg: `🟢 *ATLAS WEALTH — ALVO ATINGIDO*\n\nAtivo: *${p.ticker}*\nPreco atual: ${quote.currency}${atual.toFixed(2)}\nAlvo: ${p.target}\nLucro: +${lucro}%\n\n✅ Considere realizar o lucro.`
        });
      }
      // Alerta se cair mais de 3% no dia
      else if (parseFloat(varPct) <= -3) {
        alertas.push({
          tipo: "ATENCAO",
          msg: `🟡 *ATLAS WEALTH — ATENCAO*\n\nAtivo: *${p.ticker}*\nQueda de *${varPct}%* hoje\nPreco atual: ${quote.currency}${atual.toFixed(2)}\nStop loss: ${p.stop || "nao definido"}\n\n_Fique de olho — stop em ${p.stop || "indefinido"}_`
        });
      }
    }

    // Envia alertas
    for (const alerta of alertas) {
      await sendTelegram(alerta.msg);
    }

    // A cada hora cheia envia resumo da carteira (ex: 10h, 11h, 12h...)
    const minutos = horaBrasilia.getMinutes();
    if (minutos < 30 && alertas.length === 0 && resultados.length > 0) {
      const resumo = resultados.map(r =>
        `${r.varPct >= 0 ? "🟢" : "🔴"} *${r.ticker}*: ${r.varPct >= 0 ? "+" : ""}${r.varPct}%`
      ).join("\n");

      await sendTelegram(
        `📊 *ATLAS WEALTH — RESUMO ${hora}h*\n\n${resumo}\n\n_Nenhum stop ou alvo atingido_`
      );
    }

    return res.status(200).json({
      ok: true,
      ativos_monitorados: portfolio.length,
      alertas_enviados: alertas.length,
      resultados,
      hora: `${hora}:${minutos}`,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
