export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const isB3 = /^[A-Z]{4}[0-9]{1,2}$/.test(ticker) && !ticker.includes("-");
  const sym = isB3 ? `${ticker}.SA` : ticker;

  try {
    // Busca 200 dias de historico
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=200d`,
      { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) throw new Error(`Yahoo Finance error: ${r.status}`);

    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("No data returned");

    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const highs = result.indicators?.quote?.[0]?.high || [];
    const lows = result.indicators?.quote?.[0]?.low || [];
    const volumes = result.indicators?.quote?.[0]?.volume || [];

    // Remove nulls
    const validData = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().split("T")[0],
      close: closes[i],
      high: highs[i],
      low: lows[i],
      volume: volumes[i],
    })).filter(d => d.close !== null && d.close !== undefined);

    const c = validData.map(d => d.close);
    const h = validData.map(d => d.high);
    const l = validData.map(d => d.low);
    const v = validData.map(d => d.volume);
    const n = c.length;

    // ── RSI (14 periodos) ──────────────────────────────────────
    function calcRSI(prices, period = 14) {
      if (prices.length < period + 1) return null;
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
      }
      let avgGain = gains / period;
      let avgLoss = losses / period;
      for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
      }
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
    }

    // ── EMA ───────────────────────────────────────────────────
    function calcEMA(prices, period) {
      if (prices.length < period) return null;
      const k = 2 / (period + 1);
      let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
      }
      return parseFloat(ema.toFixed(4));
    }

    // ── SMA ───────────────────────────────────────────────────
    function calcSMA(prices, period) {
      if (prices.length < period) return null;
      const slice = prices.slice(-period);
      return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(4));
    }

    // ── MACD (12, 26, 9) ──────────────────────────────────────
    function calcMACD(prices) {
      if (prices.length < 35) return null;
      const ema12 = calcEMA(prices, 12);
      const ema26 = calcEMA(prices, 26);
      if (!ema12 || !ema26) return null;
      const macdLine = parseFloat((ema12 - ema26).toFixed(4));

      // Signal line (EMA 9 do MACD)
      const macdValues = [];
      for (let i = 26; i <= prices.length; i++) {
        const e12 = calcEMA(prices.slice(0, i), 12);
        const e26 = calcEMA(prices.slice(0, i), 26);
        if (e12 && e26) macdValues.push(e12 - e26);
      }
      const signal = calcEMA(macdValues, 9);
      const histogram = signal ? parseFloat((macdLine - signal).toFixed(4)) : null;

      return {
        macd: macdLine,
        signal: signal ? parseFloat(signal.toFixed(4)) : null,
        histogram,
        trend: histogram > 0 ? "ALTA" : "BAIXA",
        crossover: histogram > 0 && macdValues[macdValues.length - 2] < 0 ? "CRUZAMENTO_ALTA" :
                   histogram < 0 && macdValues[macdValues.length - 2] > 0 ? "CRUZAMENTO_BAIXA" : "NENHUM",
      };
    }

    // ── BOLLINGER BANDS (20, 2) ────────────────────────────────
    function calcBollinger(prices, period = 20, stdDev = 2) {
      if (prices.length < period) return null;
      const slice = prices.slice(-period);
      const sma = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
      const sd = Math.sqrt(variance);
      const upper = parseFloat((sma + stdDev * sd).toFixed(4));
      const lower = parseFloat((sma - stdDev * sd).toFixed(4));
      const current = prices[prices.length - 1];
      const bandwidth = parseFloat(((upper - lower) / sma * 100).toFixed(2));
      const pctB = parseFloat(((current - lower) / (upper - lower) * 100).toFixed(2));

      return {
        upper,
        middle: parseFloat(sma.toFixed(4)),
        lower,
        bandwidth,
        pctB,
        position: current > upper ? "ACIMA_BANDA_SUPERIOR" :
                  current < lower ? "ABAIXO_BANDA_INFERIOR" : "DENTRO_DAS_BANDAS",
      };
    }

    // ── ATR (14 periodos) ──────────────────────────────────────
    function calcATR(highs, lows, closes, period = 14) {
      if (highs.length < period + 1) return null;
      const trs = [];
      for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
        trs.push(tr);
      }
      const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
      return parseFloat(atr.toFixed(4));
    }

    // ── VOLUME MEDIO ──────────────────────────────────────────
    function calcVolumeAnalysis(volumes, period = 20) {
      if (volumes.length < period) return null;
      const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
      const current = volumes[volumes.length - 1];
      const ratio = parseFloat((current / avg).toFixed(2));
      return {
        atual: current,
        media20: Math.round(avg),
        ratio,
        status: ratio > 1.5 ? "MUITO_ACIMA" : ratio > 1.0 ? "ACIMA" : ratio > 0.7 ? "NORMAL" : "ABAIXO",
      };
    }

    // ── SUPORTE E RESISTENCIA ─────────────────────────────────
    function calcSupRes(highs, lows, closes, lookback = 20) {
      const recentHighs = highs.slice(-lookback);
      const recentLows = lows.slice(-lookback);
      const current = closes[closes.length - 1];
      const resistencia = parseFloat(Math.max(...recentHighs).toFixed(4));
      const suporte = parseFloat(Math.min(...recentLows).toFixed(4));
      const distResist = parseFloat(((resistencia - current) / current * 100).toFixed(2));
      const distSuport = parseFloat(((current - suporte) / current * 100).toFixed(2));
      return { suporte, resistencia, distResist, distSuport };
    }

    // ── CALCULA TUDO ──────────────────────────────────────────
    const rsi14 = calcRSI(c, 14);
    const rsi9 = calcRSI(c, 9);
    const macd = calcMACD(c);
    const bollinger = calcBollinger(c);
    const atr = calcATR(h, l, c);
    const volume = calcVolumeAnalysis(v);
    const supRes = calcSupRes(h, l, c);

    const mm9 = calcSMA(c, 9);
    const mm21 = calcSMA(c, 21);
    const mm50 = calcSMA(c, 50);
    const mm200 = calcSMA(c, 200);
    const ema9 = calcEMA(c, 9);
    const ema21 = calcEMA(c, 21);

    const precoAtual = meta.regularMarketPrice || c[c.length - 1];
    const prev = meta.chartPreviousClose || c[c.length - 2];
    const varHoje = prev ? parseFloat(((precoAtual - prev) / prev * 100).toFixed(2)) : 0;

    // ── TENDENCIA GERAL ───────────────────────────────────────
    let tendencia = "LATERAL";
    const acimaMM50 = precoAtual > mm50;
    const acimaMM200 = precoAtual > mm200;
    const mm9acimaMM21 = mm9 > mm21;
    const mm21acimaMM50 = mm21 > mm50;

    if (acimaMM50 && acimaMM200 && mm9acimaMM21) tendencia = "ALTA_FORTE";
    else if (acimaMM50 && mm9acimaMM21) tendencia = "ALTA";
    else if (!acimaMM50 && !acimaMM200 && !mm9acimaMM21) tendencia = "BAIXA_FORTE";
    else if (!acimaMM50 && !mm9acimaMM21) tendencia = "BAIXA";

    // ── SINAL TECNICO ─────────────────────────────────────────
    let pontos = 0;
    if (rsi14 < 70 && rsi14 > 30) pontos += 1;
    if (rsi14 < 50 && rsi14 > 35) pontos += 1; // zona de compra ideal
    if (macd?.trend === "ALTA") pontos += 2;
    if (macd?.crossover === "CRUZAMENTO_ALTA") pontos += 2;
    if (tendencia.includes("ALTA")) pontos += 2;
    if (volume?.status === "MUITO_ACIMA" || volume?.status === "ACIMA") pontos += 1;
    if (bollinger?.position === "DENTRO_DAS_BANDAS") pontos += 1;
    if (precoAtual > ema9 && precoAtual > ema21) pontos += 1;

    const sinalTecnico = pontos >= 8 ? "COMPRA_FORTE" :
                         pontos >= 5 ? "COMPRA" :
                         pontos >= 3 ? "NEUTRO" : "VENDA";

    // ── STOP SUGERIDO COM ATR ─────────────────────────────────
    const stopSugerido = atr ? parseFloat((precoAtual - 2 * atr).toFixed(4)) : null;
    const alvoSugerido = atr ? parseFloat((precoAtual + 3 * atr).toFixed(4)) : null;

    return res.status(200).json({
      ticker,
      mercado: isB3 ? "B3" : "NYSE/NASDAQ",
      moeda: isB3 ? "R$" : "US$",
      preco_atual: precoAtual,
      variacao_hoje: varHoje,
      dias_historico: validData.length,
      tendencia,
      sinal_tecnico: sinalTecnico,
      pontuacao_tecnica: pontos,
      indicadores: {
        rsi: { rsi14, rsi9, zona: rsi14 > 70 ? "SOBRECOMPRADO" : rsi14 < 30 ? "SOBREVENDIDO" : "NEUTRO" },
        macd,
        medias: { mm9, mm21, mm50, mm200, ema9, ema21, acimaMM50, acimaMM200 },
        bollinger,
        atr,
        volume,
      },
      suporte_resistencia: supRes,
      gestao_risco: {
        stop_sugerido: stopSugerido,
        alvo_sugerido: alvoSugerido,
        risco_retorno: stopSugerido && alvoSugerido ? "1:1.5" : null,
        atr_pct: atr ? parseFloat((atr / precoAtual * 100).toFixed(2)) : null,
      },
      historico_recente: validData.slice(-10),
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
