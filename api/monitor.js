export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!REDIS_URL || !REDIS_TOKEN || !TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: "Environment variables not configured" });
  }

  const agora = new Date();
  const horaBrasilia = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hora = horaBrasilia.getHours();
  const minutos = horaBrasilia.getMinutes();
  const diaSemana = horaBrasilia.getDay();

  if (diaSemana === 0 || diaSemana === 6 || hora < 10 || hora >= 18) {
    return res.status(200).json({ ok: true, msg: "Fora do horario de mercado" });
  }

  async function redisGet(key) {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
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
      const isB3 = /^[A-Z]{4}[0-9]{1,2}$/.test(ticker);
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
    // Chave correta — mesma usada pelo operacoes.js
    const operacoes = await redisGet("operacoes_v1");

    // Filtra apenas posicoes ABERTAS ou PARCIAIS (nao encerradas)
    const carteira = operacoes.filter(op =>
      op.status === "ABERTA" || op.status === "PARCIAL"
    );

    if (!carteira.length) {
      return res.status(200).json({ ok: true, msg: "Carteira vazia" });
    }

    const alertas = [];
    const resultados = [];

    for (const p of carteira) {
      const quote = await fetchQuote(p.ticker);
      if (!quote) continue;

      const atual = quote.price;
      const entrada = parseFloat(p.preco_medio) || 0;
      const stop = p.stop_loss ? parseFloat(p.stop_loss) : null;
      const alvo = p.alvo ? parseFloat(p.alvo) : null;
      const varEntrada = entrada > 0 ? (((atual - entrada) / entrada) * 100).toFixed(2) : "0.00";
      const varHoje = parseFloat(quote.change);
      const distStop = stop ? (((atual - stop) / atual) * 100).toFixed(1) : null;

      resultados.push({ ticker: p.ticker, atual, varEntrada, varHoje: quote.change, distStop });

      // Alertas por prioridade
      if (stop && atual <= stop) {
        alertas.push(`🔴 *STOP ATINGIDO — ${p.ticker}*\n\nPreco: ${quote.currency} ${atual.toFixed(2)}\nStop: ${quote.currency} ${stop.toFixed(2)}\nResultado: ${varEntrada}%\n\n⚠️ *VENDER AGORA*`);
      } else if (alvo && atual >= alvo) {
        alertas.push(`🟢 *ALVO ATINGIDO — ${p.ticker}*\n\nPreco: ${quote.currency} ${atual.toFixed(2)}\nAlvo: ${quote.currency} ${alvo.toFixed(2)}\nLucro: +${varEntrada}%\n\n✅ Considere realizar lucro`);
      } else if (stop && distStop && parseFloat(distStop) <= 2) {
        alertas.push(`🟡 *PROXIMO DO STOP — ${p.ticker}*\n\nPreco: ${quote.currency} ${atual.toFixed(2)}\nStop: ${quote.currency} ${stop.toFixed(2)}\nDistancia: ${distStop}%\n\n_Monitore de perto_`);
      } else if (varHoje <= -3) {
        alertas.push(`🟡 *QUEDA FORTE — ${p.ticker}*\n\nQueda de *${quote.change}%* hoje\nPreco: ${quote.currency} ${atual.toFixed(2)}\nStop: ${stop ? quote.currency+" "+stop.toFixed(2) : "nao definido"}`);
      }
    }

    for (const msg of alertas) {
      await sendTelegram(msg);
    }

    // Resumo a cada hora cheia sem alertas urgentes
    const alertasUrgentes = alertas.filter(a => a.includes("STOP ATINGIDO") || a.includes("ALVO ATINGIDO"));
    if (minutos < 15 && alertasUrgentes.length === 0 && resultados.length > 0) {
      const resumo = resultados.map(r =>
        `${parseFloat(r.varHoje) >= 0 ? "🟢" : "🔴"} *${r.ticker}*: hoje ${parseFloat(r.varHoje) >= 0 ? "+" : ""}${r.varHoje}% | entrada ${parseFloat(r.varEntrada) >= 0 ? "+" : ""}${r.varEntrada}%${r.distStop ? " | stop dist "+r.distStop+"%" : ""}`
      ).join("\n");

      await sendTelegram(`📊 *ATLAS WEALTH — ${hora}h*\n\n${resumo}`);
    }

    return res.status(200).json({
      ok: true,
      carteira_monitorada: carteira.length,
      alertas_enviados: alertas.length,
      resultados,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
