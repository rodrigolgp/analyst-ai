export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  // ── REDIS CACHE FIRST ──────────────────────────────────────
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const rr = await fetch(`${REDIS_URL}/get/ind_${ticker}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      });
      const rd = await rr.json();
      if (rd.result) {
        const cached = JSON.parse(rd.result);
        cached._from_cache = true;
        return res.status(200).json(cached);
      }
    } catch(e) {
      // Cache miss — calcula ao vivo
    }
  }

  // ── CALCULO AO VIVO (fallback) ─────────────────────────────
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

    function calcEMA(prices, period) {
      if (prices.length < period) return null;
      const k = 2 / (period + 1);
      let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
      return parseFloat(ema.toFixed(4));
    }

    function calcSMA(prices, period) {
      if (prices.length < period) return null;
      return parseFloat((prices.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(4));
    }

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

    function calcATR(highs, lows, closes, period = 14) {
      if (highs.length < period + 1) return null;
      const trs = [];
      for (let i = 1; i < highs.length; i++) {
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
      }
      return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(4));
    }

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

    function detectSmartMoney(closes, volumes, highs, lows, lookback = 20) {
      if (closes.length < lookback + 5) return null;
      const recentV = volumes.slice(-lookback);
      const avgVol = recentV.reduce((a,b)=>a+b,0) / lookback;
      const last5Vol = recentV.slice(-5);
      const avgVol5 = last5Vol.reduce((a,b)=>a+b,0) / 5;
      const volRatio5d = parseFloat((avgVol5 / avgVol).toFixed(2));
      let mfPos = 0, mfNeg = 0;
      for (let i = 1; i < lookback; i++) {
        const tp = (highs[highs.length-lookback+i]+lows[lows.length-lookback+i]+closes[closes.length-lookback+i])/3;
        const tpPrev = (highs[highs.length-lookback+i-1]+lows[lows.length-lookback+i-1]+closes[closes.length-lookback+i-1])/3;
        const mf = tp * (volumes[volumes.length-lookback+i]||0);
        if (tp > tpPrev) mfPos += mf; else mfNeg += mf;
      }
      const mfIndex = parseFloat((mfPos/(mfPos+mfNeg)*100).toFixed(2));
      const last3C = closes.slice(-3);
      const last3V = volumes.slice(-3);
      const divergenciaAltista = last3C[2]<last3C[0] && last3V[2]>last3V[0] && mfIndex>55;
      let score = 0;
      if (volRatio5d>=2.0) score+=30; else if (volRatio5d>=1.5) score+=20; else if (volRatio5d>=1.2) score+=10;
      if (mfIndex>65) score+=25; else if (mfIndex>55) score+=15;
      if (divergenciaAltista) score+=25;
      score = Math.min(100, score);
      let sinal = "NEUTRO";
      if (score>=70) sinal="ACUMULACAO_FORTE";
      else if (score>=50) sinal="ACUMULACAO";
      else if (mfIndex<35) sinal="DISTRIBUICAO";
      return { score, sinal, money_flow_index: mfIndex, volume_ratio_5d: volRatio5d, divergencia_altista: divergenciaAltista };
    }

    function detectCandlePattern(opens, highs, lows, closes) {
      const n = closes.length;
      if (n < 3) return { pattern: "NENHUM", bias: "NEUTRO", confianca: 0 };
      const c0=closes[n-1],o0=opens[n-1],h0=highs[n-1],l0=lows[n-1];
      const c1=closes[n-2],o1=opens[n-2];
      const c2=closes[n-3],o2=opens[n-3];
      const body0=Math.abs(c0-o0),range0=h0-l0;
      const upperShadow0=h0-Math.max(c0,o0),lowerShadow0=Math.min(c0,o0)-l0;
      const body1=Math.abs(c1-o1);
      const patterns=[];
      if (c1<o1&&lowerShadow0>body0*2&&upperShadow0<body0*0.5&&range0>0) patterns.push({name:"MARTELO",bias:"ALTA",confianca:72});
      if (c1>o1&&upperShadow0>body0*2&&lowerShadow0<body0*0.5&&range0>0) patterns.push({name:"ESTRELA_CADENTE",bias:"BAIXA",confianca:70});
      if (c1<o1&&c0>o0&&c0>o1&&o0<c1) patterns.push({name:"ENGOLFO_ALTA",bias:"ALTA",confianca:78});
      if (c1>o1&&c0<o0&&c0<o1&&o0>c1) patterns.push({name:"ENGOLFO_BAIXA",bias:"BAIXA",confianca:76});
      if (body0<range0*0.1&&range0>0) patterns.push({name:"DOJI",bias:"NEUTRO",confianca:60});
      if (c2<o2&&body1<Math.abs(c2-o2)*0.3&&c0>o0&&c0>(c2+o2)/2) patterns.push({name:"MORNING_STAR",bias:"ALTA",confianca:82});
      if (!patterns.length) return {pattern:"NENHUM",bias:"NEUTRO",confianca:0};
      const best=patterns.reduce((a,b)=>b.confianca>a.confianca?b:a);
      return {pattern:best.name,bias:best.bias,confianca:best.confianca};
    }

    function calcConfluencia(rsiPond, macd, bollinger, volume, vwap, tendencia, candle) {
      let pontosAlta=0,pontosBaixa=0;
      const sinais=[];
      if (rsiPond) {
        if (rsiPond>55&&rsiPond<70){sinais.push("RSI_ALTA");pontosAlta++;}
        else if (rsiPond<45&&rsiPond>30){sinais.push("RSI_COMPRA");pontosAlta+=2;}
        else if (rsiPond>=70){sinais.push("RSI_SOBRECOMPRADO");pontosBaixa++;}
        else if (rsiPond<=30){sinais.push("RSI_SOBREVENDIDO");pontosAlta+=3;}
      }
      if (macd) {
        if (macd.crossover==="CRUZAMENTO_ALTA"){sinais.push("MACD_CRUZAMENTO_ALTA");pontosAlta+=3;}
        else if (macd.crossover==="CRUZAMENTO_BAIXA"){sinais.push("MACD_CRUZAMENTO_BAIXA");pontosBaixa+=3;}
        else if (macd.trend==="ALTA"&&macd.acelerando){sinais.push("MACD_ACELERANDO");pontosAlta+=2;}
        else if (macd.trend==="ALTA"){sinais.push("MACD_ALTA");pontosAlta++;}
        else{sinais.push("MACD_BAIXA");pontosBaixa++;}
      }
      if (bollinger) {
        if (bollinger.position==="ABAIXO_BANDA_INFERIOR"){sinais.push("BOLLINGER_SOBREVENDIDO");pontosAlta+=2;}
        else if (bollinger.position==="ACIMA_BANDA_SUPERIOR"){sinais.push("BOLLINGER_SOBRECOMPRADO");pontosBaixa+=2;}
        if (bollinger.squeeze){sinais.push("BOLLINGER_SQUEEZE");pontosAlta++;}
      }
      if (volume&&(volume.status==="EXPLOSIVO"||volume.status==="MUITO_ACIMA")){sinais.push("VOLUME_CONFIRMADOR");pontosAlta++;}
      if (vwap){if(vwap.acima){sinais.push("ACIMA_VWAP");pontosAlta+=2;}else{sinais.push("ABAIXO_VWAP");pontosBaixa+=2;}}
      if (tendencia==="ALTA_FORTE"){sinais.push("TENDENCIA_ALTA_FORTE");pontosAlta+=3;}
      else if (tendencia==="ALTA"){sinais.push("TENDENCIA_ALTA");pontosAlta+=2;}
      else if (tendencia==="BAIXA_FORTE"){sinais.push("TENDENCIA_BAIXA_FORTE");pontosBaixa+=3;}
      else if (tendencia==="BAIXA"){sinais.push("TENDENCIA_BAIXA");pontosBaixa+=2;}
      if (candle&&candle.bias==="ALTA"){sinais.push("CANDLE_"+candle.pattern);pontosAlta+=Math.round(candle.confianca/25);}
      else if (candle&&candle.bias==="BAIXA"){sinais.push("CANDLE_"+candle.pattern);pontosBaixa+=Math.round(candle.confianca/25);}
      const total=pontosAlta+pontosBaixa;
      const score=total>0?Math.round((pontosAlta/total)*100):50;
      const direcao=score>=65?"COMPRA_FORTE":score>=55?"COMPRA":score<=35?"VENDA_FORTE":score<=45?"VENDA":"NEUTRO";
      return {
        score,direcao,pontos_alta:pontosAlta,pontos_baixa:pontosBaixa,
        sinais_confirmadores:sinais.filter(s=>s.includes("ALTA")||s.includes("COMPRA")||s.includes("SQUEEZE")||s.includes("ACIMA")),
        sinais_negativos:sinais.filter(s=>s.includes("BAIXA")||s.includes("VENDA")||s.includes("FRACO")||s.includes("ABAIXO")),
        total_sinais:sinais.length,
      };
    }

    // ── HISTORICOS ─────────────────────────────────────────────
    function calcRSIPonderadoHistorico(prices) {
      const result=[];
      for (let i=15;i<prices.length;i++) {
        const slice=prices.slice(0,i+1);
        const r5=calcRSI(slice,5),r9=calcRSI(slice,9),r14=calcRSI(slice,14);
        if (r5&&r9&&r14) result.push({date:validData[i].date,value:parseFloat((r5*0.40+r9*0.35+r14*0.25).toFixed(2))});
      }
      return result;
    }

    function calcMACDHistorico(prices) {
      const macdLine=[];
      for (let i=26;i<prices.length;i++) {
        const e12=calcEMA(prices.slice(0,i+1),12),e26=calcEMA(prices.slice(0,i+1),26);
        if (e12&&e26) macdLine.push({date:validData[i].date,value:parseFloat((e12-e26).toFixed(4))});
      }
      const signalLine=[],histogram=[];
      const macdVals=macdLine.map(d=>d.value);
      for (let i=9;i<macdVals.length;i++) {
        const sig=calcEMA(macdVals.slice(0,i+1),9);
        if (sig) {
          signalLine.push({date:macdLine[i].date,value:parseFloat(sig.toFixed(4))});
          histogram.push({date:macdLine[i].date,value:parseFloat((macdVals[i]-sig).toFixed(4))});
        }
      }
      return {macdLine:macdLine.slice(9),signalLine,histogram};
    }

    function calcMMHistorico(prices,period) {
      const result=[];
      for (let i=period-1;i<prices.length;i++) {
        const sma=prices.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period;
        result.push({date:validData[i].date,value:parseFloat(sma.toFixed(4))});
      }
      return result;
    }

    // ── CALCULOS ───────────────────────────────────────────────
    const rsi14=calcRSI(c,14),rsi9=calcRSI(c,9),rsi5=calcRSI(c,5);
    const rsiPonderado=rsi5&&rsi9&&rsi14?parseFloat((rsi5*0.40+rsi9*0.35+rsi14*0.25).toFixed(2)):null;
    const macd=calcMACD(c);
    const bollinger=calcBollinger(c);
    const atr=calcATR(h,l,c);
    const vwap=calcVWAP(h,l,c,v,20);
    const smartMoney=detectSmartMoney(c,v,h,l,20);
    const candle=detectCandlePattern(o,h,l,c);
    const mm9=calcSMA(c,9),mm21=calcSMA(c,21),mm50=calcSMA(c,50),mm200=calcSMA(c,200);
    const ema9=calcEMA(c,9),ema21=calcEMA(c,21);
    const precoAtual=meta.regularMarketPrice||c[n-1];
    const prev=meta.chartPreviousClose||c[n-2];
    const avgVol=v.slice(-20).reduce((a,b)=>a+b,0)/20;
    const volDiaAtual = v[n-1]; // volume do ultimo candle historico (dia fechado)

    // Se o volume do dia atual (historico) for muito baixo vs media,
    // pode ser que o candle mais recente seja parcial (pregao em andamento).
    // Nao ajustamos aqui — o frontend usa q.volume (ao vivo) para comparar.
    // O ratio aqui e baseado no historico fechado (mais confiavel).
    const volRatio=parseFloat((volDiaAtual/avgVol).toFixed(2));
    const resistencia=parseFloat(Math.max(...h.slice(-20)).toFixed(4));
    const suporte=parseFloat(Math.min(...l.slice(-20)).toFixed(4));
    const distResist=parseFloat(((resistencia-precoAtual)/precoAtual*100).toFixed(2));
    const distSuport=parseFloat(((precoAtual-suporte)/precoAtual*100).toFixed(2));
    const rrNatural=parseFloat(((resistencia-precoAtual)/(precoAtual-suporte)).toFixed(2));
    const acimaMM50=precoAtual>mm50,acimaMM200=precoAtual>mm200,mm9acimaMM21=mm9>mm21;
    let tendencia="LATERAL";
    if (acimaMM50&&acimaMM200&&mm9acimaMM21) tendencia="ALTA_FORTE";
    else if (acimaMM50&&mm9acimaMM21) tendencia="ALTA";
    else if (!acimaMM50&&!acimaMM200&&!mm9acimaMM21) tendencia="BAIXA_FORTE";
    else if (!acimaMM50&&!mm9acimaMM21) tendencia="BAIXA";
    const volume={
      atual:v[n-1],
      media20:Math.round(avgVol),
      ratio:volRatio,
      status:volRatio>2?"EXPLOSIVO":volRatio>1.5?"MUITO_ACIMA":volRatio>1?"ACIMA":volRatio>0.7?"NORMAL":"ABAIXO",
      // dado_suspeito: volume historico do dia fechado muito baixo vs media — indica dado real incorreto
      // Nao marca como suspeito baseado no volume ao vivo (que e parcial durante o pregao)
      dado_suspeito: volRatio < 0.01 && avgVol > 1000000 // threshold mais conservador: apenas casos extremos
    };
    const confluencia=calcConfluencia(rsiPonderado,macd,bollinger,volume,vwap,tendencia,candle);
    const taxaAcerto=confluencia.score>60?60:confluencia.score>50?55:45;
    const rrEst=rrNatural>0?Math.min(rrNatural,3):1.5;
    const p=taxaAcerto/100,q2=1-p,kelly=Math.max(0,Math.min((p*rrEst-q2)/rrEst*100,25));
    const rsiHistorico=calcRSIPonderadoHistorico(c);
    const macdHistorico=calcMACDHistorico(c);
    const mm9Historico=calcMMHistorico(c,9);
    const mm21Historico=calcMMHistorico(c,21);
    const mm50Historico=calcMMHistorico(c,50);

    // Gestao de risco: stop = MENOR RISCO entre 2xATR e suporte tecnico (evita stop arbitrario sem relacao com o grafico)
    // Alvo = MENOR entre 3xATR e resistencia tecnica (evita alvo otimista demais ignorando barreira real)
    let stopSugerido = null, alvoSugerido = null;
    if (atr) {
      const stopATR = precoAtual - 2*atr;
      const alvoATR = precoAtual + 3*atr;
      // Stop final: o MAIOR entre stopATR e suporte (ou seja, o que da MENOR risco/distancia)
      // Mas nao deixa o stop ficar exatamente no suporte (que e zona obvia de stop-hunt) - usa 0.3% abaixo
      const suporteAjustado = suporte ? suporte * 0.997 : null;
      stopSugerido = suporteAjustado && suporteAjustado > stopATR
        ? parseFloat(suporteAjustado.toFixed(4))
        : parseFloat(stopATR.toFixed(4));
      // Alvo final: o MENOR entre alvoATR e resistencia (nao prometer alvo alem de uma barreira real)
      const resistenciaAjustada = resistencia ? resistencia * 0.997 : null; // um pouco antes da resistencia
      alvoSugerido = resistenciaAjustada && resistenciaAjustada < alvoATR
        ? parseFloat(resistenciaAjustada.toFixed(4))
        : parseFloat(alvoATR.toFixed(4));
    }

    const payload = {
      ticker,mercado:isB3?"B3":"NYSE/NASDAQ",moeda:isB3?"R$":"US$",
      preco_atual:precoAtual,
      variacao_hoje:prev?parseFloat(((precoAtual-prev)/prev*100).toFixed(2)):0,
      dias_historico:validData.length,tendencia,confluencia,
      candle_pattern:candle,smart_money:smartMoney,
      indicadores:{
        rsi:{rsi5,rsi9,rsi14,rsi_ponderado:rsiPonderado,zona:rsiPonderado>70?"SOBRECOMPRADO":rsiPonderado<30?"SOBREVENDIDO":"NEUTRO"},
        macd,
        medias:{mm9,mm21,mm50,mm200,ema9,ema21,acimaMM50,acimaMM200},
        bollinger,atr,vwap,volume,
      },
      suporte_resistencia:{suporte,resistencia,distResist,distSuport,rr_natural:rrNatural},
      kelly_criterion:{kelly_completo:parseFloat(kelly.toFixed(2)),half_kelly:parseFloat((kelly/2).toFixed(2)),recomendado:parseFloat((kelly/2).toFixed(2)),explicacao:kelly/2<5?"NAO_OPERAR":kelly/2<10?"POSICAO_PEQUENA":kelly/2<15?"POSICAO_MEDIA":"POSICAO_GRANDE"},
      gestao_risco:{stop_sugerido:stopSugerido,alvo_sugerido:alvoSugerido,atr_pct:atr?parseFloat((atr/precoAtual*100).toFixed(2)):null,tamanho_posicao_recomendado:(kelly/2).toFixed(2)+"% do capital"},
      historico_recente:validData,
      historico_rsi:rsiHistorico,historico_macd:macdHistorico,
      historico_mm9:mm9Historico,historico_mm21:mm21Historico,historico_mm50:mm50Historico,
      cached_at:new Date().toISOString(),
    };

    // Salva no cache para proxima vez
    if (REDIS_URL && REDIS_TOKEN) {
      try {
        await fetch(`${REDIS_URL}/pipeline`, {
          method:"POST",
          headers:{Authorization:`Bearer ${REDIS_TOKEN}`,"Content-Type":"application/json"},
          body:JSON.stringify([["SET",`ind_${ticker}`,JSON.stringify(payload),"EX",86400]])
        });
      } catch(e) {}
    }

    return res.status(200).json(payload);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
