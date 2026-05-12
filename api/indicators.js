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
    const q0 = result.indicators?.quote?.[0] || {};
    const closes = q0.close || [];
    const highs = q0.high || [];
    const lows = q0.low || [];
    const opens = q0.open || [];
    const volumes = q0.volume || [];

    const validData = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().split("T")[0],
      open: opens[i], close: closes[i],
      high: highs[i], low: lows[i], volume: volumes[i],
    })).filter(d => d.close != null);

    const c = validData.map(d => d.close);
    const h = validData.map(d => d.high);
    const l = validData.map(d => d.low);
    const o = validData.map(d => d.open);
    const v = validData.map(d => d.volume);
    const n = c.length;

    // ── RSI ───────────────────────────────────────────────────
    function calcRSI(prices, period = 14) {
      if (prices.length < period + 1) return null;
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff; else losses += Math.abs(diff);
      }
      let ag = gains / period, al = losses / period;
      for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        ag = (ag * (period - 1) + (diff > 0 ? diff : 0)) / period;
        al = (al * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
      }
      if (al === 0) return 100;
      return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
    }

    // ── RSI PONDERADO TEMPORAL (5d=40%, 9d=35%, 14d=25%) ─────
    function calcRSIPonderado(prices) {
      const r5 = calcRSI(prices, 5);
      const r9 = calcRSI(prices, 9);
      const r14 = calcRSI(prices, 14);
      if (!r5 || !r9 || !r14) return null;
      return parseFloat((r5 * 0.40 + r9 * 0.35 + r14 * 0.25).toFixed(2));
    }

    // ── EMA ───────────────────────────────────────────────────
    function calcEMA(prices, period) {
      if (prices.length < period) return null;
      const k = 2 / (period + 1);
      let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
      return parseFloat(ema.toFixed(4));
    }

    // ── SMA ───────────────────────────────────────────────────
    function calcSMA(prices, period) {
      if (prices.length < period) return null;
      return parseFloat((prices.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(4));
    }

    // ── MACD ──────────────────────────────────────────────────
    function calcMACD(prices) {
      if (prices.length < 35) return null;
      const macdValues = [];
      for (let i = 26; i <= prices.length; i++) {
        const e12 = calcEMA(prices.slice(0, i), 12);
        const e26 = calcEMA(prices.slice(0, i), 26);
        if (e12 && e26) macdValues.push(e12 - e26);
      }
      const macdLine = macdValues[macdValues.length - 1];
      const signal = calcEMA(macdValues, 9);
      const histogram = signal ? macdLine - signal : null;
      const prevHist = macdValues.length > 1 && signal ?
        macdValues[macdValues.length - 2] - (calcEMA(macdValues.slice(0, -1), 9) || 0) : 0;
      return {
        macd: parseFloat(macdLine.toFixed(4)),
        signal: signal ? parseFloat(signal.toFixed(4)) : null,
        histogram: histogram ? parseFloat(histogram.toFixed(4)) : null,
        trend: histogram > 0 ? "ALTA" : "BAIXA",
        crossover: histogram > 0 && prevHist < 0 ? "CRUZAMENTO_ALTA" :
                   histogram < 0 && prevHist > 0 ? "CRUZAMENTO_BAIXA" : "NENHUM",
        acelerando: histogram && prevHist ? Math.abs(histogram) > Math.abs(prevHist) : false,
      };
    }

    // ── BOLLINGER ─────────────────────────────────────────────
    function calcBollinger(prices, period = 20, std = 2) {
      if (prices.length < period) return null;
      const slice = prices.slice(-period);
      const sma = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
      const sd = Math.sqrt(variance);
      const upper = sma + std * sd;
      const lower = sma - std * sd;
      const current = prices[prices.length - 1];
      const pctB = (current - lower) / (upper - lower) * 100;
      return {
        upper: parseFloat(upper.toFixed(4)),
        middle: parseFloat(sma.toFixed(4)),
        lower: parseFloat(lower.toFixed(4)),
        bandwidth: parseFloat(((upper - lower) / sma * 100).toFixed(2)),
        pctB: parseFloat(pctB.toFixed(2)),
        position: current > upper ? "ACIMA_BANDA_SUPERIOR" :
                  current < lower ? "ABAIXO_BANDA_INFERIOR" : "DENTRO_DAS_BANDAS",
        squeeze: ((upper - lower) / sma * 100) < 5,
      };
    }

    // ── ATR ───────────────────────────────────────────────────
    function calcATR(highs, lows, closes, period = 14) {
      if (highs.length < period + 1) return null;
      const trs = [];
      for (let i = 1; i < highs.length; i++) {
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
      }
      return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(4));
    }

    // ── VWAP ──────────────────────────────────────────────────
    function calcVWAP(highs, lows, closes, volumes, period = 20) {
      const n = Math.min(period, highs.length);
      const slice = Array.from({length: n}, (_, i) => ({
        tp: (highs[highs.length-n+i] + lows[lows.length-n+i] + closes[closes.length-n+i]) / 3,
        v: volumes[volumes.length-n+i] || 0,
      }));
      const sumTPV = slice.reduce((a, x) => a + x.tp * x.v, 0);
      const sumV = slice.reduce((a, x) => a + x.v, 0);
      if (!sumV) return null;
      const vwap = parseFloat((sumTPV / sumV).toFixed(4));
      const current = closes[closes.length - 1];
      return {
        vwap,
        diferenca_pct: parseFloat(((current - vwap) / vwap * 100).toFixed(2)),
        acima: current > vwap,
        sinal: current > vwap ? "INSTITUCIONAL_COMPRANDO" : "INSTITUCIONAL_VENDENDO",
      };
    }

    // ── VOLUME ────────────────────────────────────────────────
    function calcVolume(volumes, period = 20) {
      if (volumes.length < period) return null;
      const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
      const current = volumes[volumes.length - 1];
      const ratio = parseFloat((current / avg).toFixed(2));
      return {
        atual: current,
        media20: Math.round(avg),
        ratio,
        status: ratio > 2.0 ? "EXPLOSIVO" : ratio > 1.5 ? "MUITO_ACIMA" : ratio > 1.0 ? "ACIMA" : ratio > 0.7 ? "NORMAL" : "ABAIXO",
      };
    }

    // ── SUPORTE E RESISTENCIA ─────────────────────────────────
    function calcSupRes(highs, lows, closes, lookback = 20) {
      const current = closes[closes.length - 1];
      const resistencia = parseFloat(Math.max(...highs.slice(-lookback)).toFixed(4));
      const suporte = parseFloat(Math.min(...lows.slice(-lookback)).toFixed(4));
      return {
        suporte,
        resistencia,
        distResist: parseFloat(((resistencia - current) / current * 100).toFixed(2)),
        distSuport: parseFloat(((current - suporte) / current * 100).toFixed(2)),
        rr_natural: parseFloat(((resistencia - current) / (current - suporte)).toFixed(2)),
      };
    }

    // ── DETECCAO DE PADROES DE CANDLESTICK ────────────────────
    function detectCandlePattern(opens, highs, lows, closes) {
      const n = closes.length;
      if (n < 3) return { pattern: "NENHUM", bias: "NEUTRO", confianca: 0 };
      const c0 = closes[n-1], o0 = opens[n-1], h0 = highs[n-1], l0 = lows[n-1];
      const c1 = closes[n-2], o1 = opens[n-2], h1 = highs[n-2], l1 = lows[n-2];
      const c2 = closes[n-3], o2 = opens[n-3];
      const body0 = Math.abs(c0 - o0);
      const body1 = Math.abs(c1 - o1);
      const range0 = h0 - l0;
      const upperShadow0 = h0 - Math.max(c0, o0);
      const lowerShadow0 = Math.min(c0, o0) - l0;

      const patterns = [];

      // Martelo (Hammer) - reversao de baixa para alta
      if (c1 < o1 && lowerShadow0 > body0 * 2 && upperShadow0 < body0 * 0.5 && range0 > 0) {
        patterns.push({ name: "MARTELO", bias: "ALTA", confianca: 72 });
      }
      // Shooting Star - reversao de alta para baixa
      if (c1 > o1 && upperShadow0 > body0 * 2 && lowerShadow0 < body0 * 0.5 && range0 > 0) {
        patterns.push({ name: "ESTRELA_CADENTE", bias: "BAIXA", confianca: 70 });
      }
      // Engolfo de Alta (Bullish Engulfing)
      if (c1 < o1 && c0 > o0 && c0 > o1 && o0 < c1) {
        patterns.push({ name: "ENGOLFO_ALTA", bias: "ALTA", confianca: 78 });
      }
      // Engolfo de Baixa (Bearish Engulfing)
      if (c1 > o1 && c0 < o0 && c0 < o1 && o0 > c1) {
        patterns.push({ name: "ENGOLFO_BAIXA", bias: "BAIXA", confianca: 76 });
      }
      // Doji - indecisao
      if (body0 < range0 * 0.1 && range0 > 0) {
        patterns.push({ name: "DOJI", bias: "NEUTRO", confianca: 60 });
      }
      // Morning Star - reversao forte de baixa para alta
      if (c2 < o2 && body1 < Math.abs(c2-o2) * 0.3 && c0 > o0 && c0 > (c2+o2)/2) {
        patterns.push({ name: "MORNING_STAR", bias: "ALTA", confianca: 82 });
      }
      // Evening Star - reversao forte de alta para baixa
      if (c2 > o2 && body1 < Math.abs(c2-o2) * 0.3 && c0 < o0 && c0 < (c2+o2)/2) {
        patterns.push({ name: "EVENING_STAR", bias: "BAIXA", confianca: 80 });
      }
      // Marubozu de Alta - forca compradora
      if (c0 > o0 && upperShadow0 < body0 * 0.05 && lowerShadow0 < body0 * 0.05 && body0 > 0) {
        patterns.push({ name: "MARUBOZU_ALTA", bias: "ALTA", confianca: 75 });
      }
      // Marubozu de Baixa - forca vendedora
      if (c0 < o0 && upperShadow0 < body0 * 0.05 && lowerShadow0 < body0 * 0.05 && body0 > 0) {
        patterns.push({ name: "MARUBOZU_BAIXA", bias: "BAIXA", confianca: 73 });
      }

      if (!patterns.length) return { pattern: "NENHUM", bias: "NEUTRO", confianca: 0 };
      const best = patterns.reduce((a, b) => b.confianca > a.confianca ? b : a);
      return { pattern: best.name, bias: best.bias, confianca: best.confianca, todos: patterns };
    }

    // ── KELLY CRITERION ───────────────────────────────────────
    function calcKelly(taxaAcerto, rr) {
      // f = (p * b - q) / b onde p=acerto, q=erro, b=risco/retorno
      const p = taxaAcerto / 100;
      const q = 1 - p;
      const b = rr;
      const kelly = (p * b - q) / b;
      const kellyPct = Math.max(0, Math.min(kelly * 100, 25)); // cap em 25%
      const halfKelly = kellyPct / 2; // meio Kelly para seguranca
      return {
        kelly_completo: parseFloat(kellyPct.toFixed(2)),
        half_kelly: parseFloat(halfKelly.toFixed(2)),
        recomendado: parseFloat(halfKelly.toFixed(2)),
        explicacao: halfKelly < 5 ? "NAO_OPERAR" : halfKelly < 10 ? "POSICAO_PEQUENA" : halfKelly < 15 ? "POSICAO_MEDIA" : "POSICAO_GRANDE",
      };
    }

    // ── SCORE DE CONFLUENCIA ──────────────────────────────────
    function calcConfluencia(rsiPond, macd, bollinger, volume, vwap, tendencia, candle) {
      const sinais = [];
      let pontosAlta = 0, pontosBaixa = 0;

      // RSI Ponderado
      if (rsiPond) {
        if (rsiPond > 55 && rsiPond < 70) { sinais.push("RSI_ALTA"); pontosAlta++; }
        else if (rsiPond < 45 && rsiPond > 30) { sinais.push("RSI_COMPRA"); pontosAlta += 2; }
        else if (rsiPond >= 70) { sinais.push("RSI_SOBRECOMPRADO"); pontosBaixa++; }
        else if (rsiPond <= 30) { sinais.push("RSI_SOBREVENDIDO_EXTREMO"); pontosAlta += 3; }
      }
      // MACD
      if (macd) {
        if (macd.crossover === "CRUZAMENTO_ALTA") { sinais.push("MACD_CRUZAMENTO_ALTA"); pontosAlta += 3; }
        else if (macd.crossover === "CRUZAMENTO_BAIXA") { sinais.push("MACD_CRUZAMENTO_BAIXA"); pontosBaixa += 3; }
        else if (macd.trend === "ALTA" && macd.acelerando) { sinais.push("MACD_ACELERANDO_ALTA"); pontosAlta += 2; }
        else if (macd.trend === "ALTA") { sinais.push("MACD_ALTA"); pontosAlta++; }
        else if (macd.trend === "BAIXA" && macd.acelerando) { sinais.push("MACD_ACELERANDO_BAIXA"); pontosBaixa += 2; }
        else { sinais.push("MACD_BAIXA"); pontosBaixa++; }
      }
      // Bollinger
      if (bollinger) {
        if (bollinger.position === "ABAIXO_BANDA_INFERIOR") { sinais.push("BOLLINGER_SOBREVENDIDO"); pontosAlta += 2; }
        else if (bollinger.position === "ACIMA_BANDA_SUPERIOR") { sinais.push("BOLLINGER_SOBRECOMPRADO"); pontosBaixa += 2; }
        if (bollinger.squeeze) { sinais.push("BOLLINGER_SQUEEZE"); pontosAlta++; }
      }
      // Volume
      if (volume) {
        if (volume.status === "EXPLOSIVO" || volume.status === "MUITO_ACIMA") { sinais.push("VOLUME_CONFIRMADOR"); pontosAlta++; }
        else if (volume.status === "ABAIXO") { sinais.push("VOLUME_FRACO"); pontosBaixa++; }
      }
      // VWAP
      if (vwap) {
        if (vwap.acima) { sinais.push("ACIMA_VWAP"); pontosAlta += 2; }
        else { sinais.push("ABAIXO_VWAP"); pontosBaixa += 2; }
      }
      // Tendencia
      if (tendencia === "ALTA_FORTE") { sinais.push("TENDENCIA_ALTA_FORTE"); pontosAlta += 3; }
      else if (tendencia === "ALTA") { sinais.push("TENDENCIA_ALTA"); pontosAlta += 2; }
      else if (tendencia === "BAIXA_FORTE") { sinais.push("TENDENCIA_BAIXA_FORTE"); pontosBaixa += 3; }
      else if (tendencia === "BAIXA") { sinais.push("TENDENCIA_BAIXA"); pontosBaixa += 2; }
      // Candlestick
      if (candle && candle.bias === "ALTA") { sinais.push("CANDLE_"+candle.pattern); pontosAlta += Math.round(candle.confianca/25); }
      else if (candle && candle.bias === "BAIXA") { sinais.push("CANDLE_"+candle.pattern); pontosBaixa += Math.round(candle.confianca/25); }

      const total = pontosAlta + pontosBaixa;
      const score = total > 0 ? Math.round((pontosAlta / total) * 100) : 50;
      const direcao = score >= 65 ? "COMPRA_FORTE" : score >= 55 ? "COMPRA" : score <= 35 ? "VENDA_FORTE" : score <= 45 ? "VENDA" : "NEUTRO";

      return {
        score,
        direcao,
        pontos_alta: pontosAlta,
        pontos_baixa: pontosBaixa,
        sinais_confirmadores: sinais.filter(s => s.includes("ALTA") || s.includes("COMPRA") || s.includes("SQUEEZE") || s.includes("ACIMA")),
        sinais_negativos: sinais.filter(s => s.includes("BAIXA") || s.includes("VENDA") || s.includes("FRACO") || s.includes("ABAIXO")),
        total_sinais: sinais.length,
      };
    }

    // ── CALCULA TUDO ──────────────────────────────────────────
    const rsi14 = calcRSI(c, 14);
    const rsi9 = calcRSI(c, 9);
    const rsi5 = calcRSI(c, 5);
    const rsiPonderado = calcRSIPonderado(c);
    const macd = calcMACD(c);
    const bollinger = calcBollinger(c);
    const atr = calcATR(h, l, c);
    const vwap = calcVWAP(h, l, c, v, 20);
    const volume = calcVolume(v);
    const supRes = calcSupRes(h, l, c);
    const candle = detectCandlePattern(o, h, l, c);
    const mm9 = calcSMA(c, 9);
    const mm21 = calcSMA(c, 21);
    const mm50 = calcSMA(c, 50);
    const mm200 = calcSMA(c, 200);
    const ema9 = calcEMA(c, 9);
    const ema21 = calcEMA(c, 21);

    const precoAtual = meta.regularMarketPrice || c[n-1];
    const prev = meta.chartPreviousClose || c[n-2];
    const varHoje = prev ? parseFloat(((precoAtual - prev) / prev * 100).toFixed(2)) : 0;

    // Tendencia
    const acimaMM50 = precoAtual > mm50;
    const acimaMM200 = precoAtual > mm200;
    const mm9acimaMM21 = mm9 > mm21;
    let tendencia = "LATERAL";
    if (acimaMM50 && acimaMM200 && mm9acimaMM21) tendencia = "ALTA_FORTE";
    else if (acimaMM50 && mm9acimaMM21) tendencia = "ALTA";
    else if (!acimaMM50 && !acimaMM200 && !mm9acimaMM21) tendencia = "BAIXA_FORTE";
    else if (!acimaMM50 && !mm9acimaMM21) tendencia = "BAIXA";

    // Confluencia
    const confluencia = calcConfluencia(rsiPonderado, macd, bollinger, volume, vwap, tendencia, candle);

    // Kelly Criterion (usando taxa de acerto historica estimada e RR do ATR)
    const taxaAcertoEstimada = confluencia.score > 60 ? 60 : confluencia.score > 50 ? 55 : 45;
    const rrEstimado = supRes.rr_natural > 0 ? Math.min(supRes.rr_natural, 3) : 1.5;
    const kelly = calcKelly(taxaAcertoEstimada, rrEstimado);

    // Stop e alvo pelo ATR
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
      confluencia,
      candle_pattern: candle,
      indicadores: {
        rsi: {
          rsi5, rsi9, rsi14,
          rsi_ponderado: rsiPonderado,
          zona: rsiPonderado > 70 ? "SOBRECOMPRADO" : rsiPonderado < 30 ? "SOBREVENDIDO" : "NEUTRO",
        },
        macd,
        medias: { mm9, mm21, mm50, mm200, ema9, ema21, acimaMM50, acimaMM200 },
        bollinger,
        atr,
        vwap,
        volume,
      },
      suporte_resistencia: supRes,
      kelly_criterion: kelly,
      gestao_risco: {
        stop_sugerido: stopSugerido,
        alvo_sugerido: alvoSugerido,
        atr_pct: atr ? parseFloat((atr / precoAtual * 100).toFixed(2)) : null,
        tamanho_posicao_recomendado: kelly.recomendado + "% do capital",
      },
      historico_recente: validData,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
