export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!REDIS_URL || !REDIS_TOKEN || !TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: "Environment variables not configured" });
  }

  // Horario de mercado Brasilia
  const agora = new Date();
  const horaBrasilia = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hora = horaBrasilia.getHours();
  const minutos = horaBrasilia.getMinutes();
  const diaSemana = horaBrasilia.getDay();

  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  const foraDoHorario = hora < 10 || hora >= 18;

  if (fimDeSemana || foraDoHorario) {
    return res.status(200).json({ ok: true, msg: "Fora do horario de mercado", hora, diaSemana });
  }

  async function redisGet(key) {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([["GET", key]])
    });
    const d = await r.json();
    const result = d?.[0]?.result;
    if (!result) return [];
    try { return JSON.parse(result); } catch(e) { return []; }
  }

  async function sendTelegram(message) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "Markdown" }),
      });
    } catch(e) {}
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
      const prev = meta.chartPreviousClose || meta.regularMarketPrice;
      return {
        price: meta.regularMarketPrice,
        change: (((meta.regularMarketPrice - prev) / prev) * 100).toFixed(2),
        currency: isB3 ? "R$" : "US$",
      };
    } catch(e) { return null; }
  }

  try {
    // Carrega carteira com chave correta
    const portfolio = await redisGet("portfolio_v4");

    if (!portfolio.length) {
      return res.status(200).json({ ok: true, msg: "Carteira vazia" });
    }

    const alertas = [];
    const resultados = [];

    for (const p of portfolio) {
      const quote = await fetchQuote(p.ticker);
      if (!quote) continue;

      const atual = quote.price;
      const entradaNum = parseFloat(p.price) || 0;
      const stopNum = p.stop ? parseFloat(String(p.stop).replace(/[R$US]/g,"").replace(",",".")) : null;
      const alvoNum = p.target ? parseFloat(String(p.target).replace(/[R$US]/g,"").replace(",",".")) : null;
      const varPct = entradaNum > 0 ? (((atual - entradaNum) / entradaNum) * 100).toFixed(2) : "0.00";
      const varHoje = parseFloat(quote.change);

      resultados.push({ ticker: p.ticker, atual, varPct, varHoje: quote.change });

      if (stopNum && atual <= stopNum) {
        alertas.push(`🔴 *ATLAS WEALTH — STOP ATINGIDO*\n\nAtivo: *${p.ticker}*\nPreco atual: ${quote.currency}${atual.toFixed(2)}\nStop loss: ${p.stop}\nVariacao desde entrada: ${varPct}%\n\n⚠️ *VENDA IMEDIATAMENTE* para proteger seu capital.`);
      } else if (alvoNum && atual >= alvoNum) {
        alertas.push(`🟢 *ATLAS WEALTH — ALVO ATINGIDO*\n\nAtivo: *${p.ticker}*\nPreco atual: ${quote.currency}${atual.toFixed(2)}\nAlvo: ${p.target}\nLucro desde entrada: +${varPct}%\n\n✅ Considere realizar o lucro.`);
      } else if (varHoje <= -3) {
        alertas.push(`🟡 *ATLAS WEALTH — ATENCAO*\n\nAtivo: *${p.ticker}*\nQueda de *${quote.change}%* hoje\nPreco atual: ${quote.currency}${atual.toFixed(2)}\nStop loss: ${p.stop || "nao definido"}\n\n_Monitore de perto_`);
      }
    }

    for (const msg of alertas) {
      await sendTelegram(msg);
    }

    // Resumo a cada hora cheia sem alertas
    if (minutos < 30 && alertas.length === 0 && resultados.length > 0) {
      const resumo = resultados.map(r =>
        `${parseFloat(r.varHoje) >= 0 ? "🟢" : "🔴"} *${r.ticker}*: hoje ${parseFloat(r.varHoje) >= 0 ? "+" : ""}${r.varHoje}% | desde entrada ${parseFloat(r.varPct) >= 0 ? "+" : ""}${r.varPct}%`
      ).join("\n");

      await sendTelegram(`📊 *ATLAS WEALTH — RESUMO ${hora}h*\n\n${resumo}\n\n_Nenhum stop ou alvo atingido_`);
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
