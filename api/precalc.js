export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: "Redis not configured" });

  const TICKERS = [
    "PETR4","VALE3","ITUB4","BBDC4","WEGE3","BBAS3","ABEV3","ELET3","SUZB3","RENT3",
    "PRIO3","VBBR3","EQTL3","BPAC11","ITSA4","SANB11","KLBN11","EMBR3","RADL3","CSAN3",
    "CMIG4","EGIE3","ENGI11","TAEE11","TIMS3","HAPV3","RDOR3","HYPE3","LREN3","MGLU3",
    "RAIL3","GGBR4","USIM5","CSNA3","BEEF3","SLCE3","SMTO3","BRFS3","JBSS3","CYRE3",
    "MRVE3","FLRY3","QUAL3","ASAI3","BRSR6","CCRO3","TOTVS3","VIVT3","EZTC3","RECV3",
    "KNRI11","HGLG11","XPML11","MXRF11","IRDM11","BTLG11","VISC11","KNCR11","HGRE11","MALL11",
    "GGBR4","ITSA4","BBSE3","PSSA3","NEOE3","AURE3","ENBR3","CPFE3","TRPL4","CPLE6",
    "RRRP3","UGPA3","CMIN3","FESA4","AGRO3","TTEN3","JALL3","CAML3","VIVA3","ARZZ3",
    "SBFG3","ALPA4","NTCO3","DASA3","ODPV3","PNVL3","ONCO3","SMFT3","LWSA3","CASH3",
    "MULT3","ALUP11","GMAT3","MOVI3","BLAU3","RBRF11","BCFF11","HSML11","VILG11","GTWR11"
  ];

  async function redisSet(key, value, ttl) {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value), "EX", ttl]])
    });
  }

  function calcRSI(prices, period) {
    if (prices.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = prices[i] - prices[i-1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    let ag = gains/period, al = losses/period;
    for (let i = period+1; i < prices.length; i++) {
      const d = prices[i] - prices[i-1];
      ag = (ag*(period-1)+(d>0?d:0))/period;
      al = (al*(period-1)+(d<0?Math.abs(d):0))/period;
    }
    return al === 0 ? 100 : parseFloat((100 - 100/(1+ag/al)).toFixed(2));
  }

  function calcEMA(prices, period) {
    if (prices.length < period) return null;
    const k = 2/(period+1);
    let ema = prices.slice(0,period).reduce((a,b)=>a+b,0)/period;
    for (let i = period; i < prices.length; i++) ema = prices[i]*k + ema*(1-k);
    return parseFloat(ema.toFixed(4));
  }

  function calcSMA(prices, period) {
    if (prices.length < period) return null;
    return parseFloat((prices.slice(-period).reduce((a,b)=>a+b,0)/period).toFixed(4));
  }

  async function calcIndicators(ticker) {
    const isB3 = /^[A-Z]{4}[0-9]{1,2}$/.test(ticker);
    const sym = isB3 ? `${ticker}.SA` : ticker;
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=200d`,
        { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } }
      );
      if (!r.ok) return null;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta;
      const q0 = result.indicators?.quote?.[0] || {};
      const timestamps = result.timestamp || [];
      const closes = q0.close || [];
      const highs = q0.high || [];
      const lows = q0.low || [];
      const opens = q0.open || [];
      const volumes = q0.volume || [];

      const validData = timestamps.map((t,i) => ({
        date: new Date(t*1000).toISOString().split("T")[0],
        open: opens[i], close: closes[i],
        high: highs[i], low: lows[i], volume: volumes[i]
      })).filter(d => d.close != null);

      const c = validData.map(d => d.close);
      const h = validData.map(d => d.high);
      const l = validData.map(d => d.low);
      const v = validData.map(d => d.volume);
      const n = c.length;

      if (n < 30) return null;

      const rsi5 = calcRSI(c, 5);
      const rsi9 = calcRSI(c, 9);
      const rsi14 = calcRSI(c, 14);
      const rsiPond = rsi5&&rsi9&&rsi14 ? parseFloat((rsi5*0.40+rsi9*0.35+rsi14*0.25).toFixed(2)) : null;

      // MACD
      const macdVals = [];
      for (let i = 26; i <= c.length; i++) {
        const e12 = calcEMA(c.slice(0,i), 12);
        const e26 = calcEMA(c.slice(0,i), 26);
        if (e12&&e26) macdVals.push(e12-e26);
      }
      const macdLine = macdVals[macdVals.length-1];
      const signal = calcEMA(macdVals, 9);
      const histogram = signal ? macdLine-signal : null;
      const prevHist = macdVals.length>1&&signal ? macdVals[macdVals.length-2]-(calcEMA(macdVals.slice(0,-1),9)||0) : 0;
      const macd = {
        macd: parseFloat((macdLine||0).toFixed(4)),
        signal: signal ? parseFloat(signal.toFixed(4)) : null,
        histogram: histogram ? parseFloat(histogram.toFixed(4)) : null,
        trend: (histogram||0) > 0 ? "ALTA" : "BAIXA",
        crossover: histogram>0&&prevHist<0 ? "CRUZAMENTO_ALTA" : histogram<0&&prevHist>0 ? "CRUZAMENTO_BAIXA" : "NENHUM",
        acelerando: histogram&&prevHist ? Math.abs(histogram)>Math.abs(prevHist) : false,
      };

      // Medias
      const mm9 = calcSMA(c,9), mm21 = calcSMA(c,21), mm50 = calcSMA(c,50), mm200 = calcSMA(c,200);

      // Bollinger
      const period = 20;
      const slice = c.slice(-period);
      const sma20 = slice.reduce((a,b)=>a+b,0)/period;
      const variance = slice.reduce((a,b)=>a+Math.pow(b-sma20,2),0)/period;
      const sd = Math.sqrt(variance);
      const upper = sma20+2*sd, lower = sma20-2*sd;
      const pctB = (c[n-1]-lower)/(upper-lower)*100;
      const bollinger = {
        upper: parseFloat(upper.toFixed(4)),
        middle: parseFloat(sma20.toFixed(4)),
        lower: parseFloat(lower.toFixed(4)),
        pctB: parseFloat(pctB.toFixed(2)),
        position: c[n-1]>upper ? "ACIMA_BANDA_SUPERIOR" : c[n-1]<lower ? "ABAIXO_BANDA_INFERIOR" : "DENTRO_DAS_BANDAS",
        squeeze: ((upper-lower)/sma20*100) < 5,
      };

      // ATR
      const trs = [];
      for (let i = 1; i < h.length; i++) {
        trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
      }
      const atr = parseFloat((trs.slice(-14).reduce((a,b)=>a+b,0)/14).toFixed(4));

      // VWAP
      const vslice = Array.from({length:20},(_,i)=>({
        tp:(h[h.length-20+i]+l[l.length-20+i]+c[c.length-20+i])/3,
        v:v[v.length-20+i]||0
      }));
      const sumTPV = vslice.reduce((a,x)=>a+x.tp*x.v,0);
      const sumV = vslice.reduce((a,x)=>a+x.v,0);
      const vwapVal = sumV ? parseFloat((sumTPV/sumV).toFixed(4)) : null;

      // Volume
      const avgVol = v.slice(-20).reduce((a,b)=>a+b,0)/20;
      const volRatio = parseFloat((v[n-1]/avgVol).toFixed(2));

      // Suporte/Resistencia
      const resistencia = parseFloat(Math.max(...h.slice(-20)).toFixed(4));
      const suporte = parseFloat(Math.min(...l.slice(-20)).toFixed(4));
      const precoAtual = meta.regularMarketPrice || c[n-1];
      const distResist = parseFloat(((resistencia-precoAtual)/precoAtual*100).toFixed(2));
      const distSuport = parseFloat(((precoAtual-suporte)/precoAtual*100).toFixed(2));
      const rrNatural = parseFloat(((resistencia-precoAtual)/(precoAtual-suporte)).toFixed(2));

      // Tendencia
      const acimaMM50 = precoAtual > mm50;
      const acimaMM200 = precoAtual > mm200;
      const mm9acimaMM21 = mm9 > mm21;
      let tendencia = "LATERAL";
      if (acimaMM50&&acimaMM200&&mm9acimaMM21) tendencia = "ALTA_FORTE";
      else if (acimaMM50&&mm9acimaMM21) tendencia = "ALTA";
      else if (!acimaMM50&&!acimaMM200&&!mm9acimaMM21) tendencia = "BAIXA_FORTE";
      else if (!acimaMM50&&!mm9acimaMM21) tendencia = "BAIXA";

      // Smart Money
      let mfPos = 0, mfNeg = 0;
      for (let i = 1; i < Math.min(20, c.length); i++) {
        const tp = (h[h.length-20+i]+l[l.length-20+i]+c[c.length-20+i])/3;
        const tpPrev = (h[h.length-20+i-1]+l[l.length-20+i-1]+c[c.length-20+i-1])/3;
        const mf = tp*(v[v.length-20+i]||0);
        if (tp>tpPrev) mfPos+=mf; else mfNeg+=mf;
      }
      const mfIndex = parseFloat((mfPos/(mfPos+mfNeg)*100).toFixed(2));
      const volRatio5d = parseFloat((v.slice(-5).reduce((a,b)=>a+b,0)/5/avgVol).toFixed(2));
      let smScore = 0;
      if (volRatio5d>=2.0) smScore+=30; else if (volRatio5d>=1.5) smScore+=20; else if (volRatio5d>=1.2) smScore+=10;
      if (mfIndex>65) smScore+=25; else if (mfIndex>55) smScore+=15;
      smScore = Math.min(100, smScore);

      // Confluencia
      let pontosAlta = 0, pontosBaixa = 0;
      if (rsiPond) {
        if (rsiPond>55&&rsiPond<70) pontosAlta++;
        else if (rsiPond<45&&rsiPond>30) pontosAlta+=2;
        else if (rsiPond>=70) pontosBaixa++;
        else if (rsiPond<=30) pontosAlta+=3;
      }
      if (macd.crossover==="CRUZAMENTO_ALTA") pontosAlta+=3;
      else if (macd.crossover==="CRUZAMENTO_BAIXA") pontosBaixa+=3;
      else if (macd.trend==="ALTA"&&macd.acelerando) pontosAlta+=2;
      else if (macd.trend==="ALTA") pontosAlta++;
      else if (macd.trend==="BAIXA") pontosBaixa++;
      if (bollinger.position==="ABAIXO_BANDA_INFERIOR") pontosAlta+=2;
      else if (bollinger.position==="ACIMA_BANDA_SUPERIOR") pontosBaixa+=2;
      if (bollinger.squeeze) pontosAlta++;
      if (volRatio>1.5) pontosAlta++; else if (volRatio<0.7) pontosBaixa++;
      if (vwapVal&&precoAtual>vwapVal) pontosAlta+=2; else if (vwapVal) pontosBaixa+=2;
      if (tendencia==="ALTA_FORTE") pontosAlta+=3;
      else if (tendencia==="ALTA") pontosAlta+=2;
      else if (tendencia==="BAIXA_FORTE") pontosBaixa+=3;
      else if (tendencia==="BAIXA") pontosBaixa+=2;

      const total = pontosAlta+pontosBaixa;
      const confScore = total>0 ? Math.round((pontosAlta/total)*100) : 50;
      const confDirecao = confScore>=65?"COMPRA_FORTE":confScore>=55?"COMPRA":confScore<=35?"VENDA_FORTE":confScore<=45?"VENDA":"NEUTRO";

      // Kelly
      const taxaAcerto = confScore>60?60:confScore>50?55:45;
      const rrEst = rrNatural>0?Math.min(rrNatural,3):1.5;
      const p=taxaAcerto/100, q2=1-p, kelly=Math.max(0,Math.min((p*rrEst-q2)/rrEst*100,25));

      return {
        ticker, tendencia,
        preco_atual: precoAtual,
        variacao_hoje: parseFloat(((precoAtual-(meta.chartPreviousClose||c[n-2]))/((meta.chartPreviousClose||c[n-2]))*100).toFixed(2)),
        confluencia: { score: confScore, direcao: confDirecao, pontos_alta: pontosAlta, pontos_baixa: pontosBaixa },
        smart_money: { score: smScore, money_flow_index: mfIndex, volume_ratio_5d: volRatio5d },
        indicadores: {
          rsi: { rsi5, rsi9, rsi14, rsi_ponderado: rsiPond, zona: rsiPond>70?"SOBRECOMPRADO":rsiPond<30?"SOBREVENDIDO":"NEUTRO" },
          macd,
          medias: { mm9, mm21, mm50, mm200, acimaMM50, acimaMM200 },
          bollinger,
          atr,
          vwap: vwapVal ? { vwap: vwapVal, diferenca_pct: parseFloat(((precoAtual-vwapVal)/vwapVal*100).toFixed(2)), acima: precoAtual>vwapVal, sinal: precoAtual>vwapVal?"INSTITUCIONAL_COMPRANDO":"INSTITUCIONAL_VENDENDO" } : null,
          volume: { atual: v[n-1], media20: Math.round(avgVol), ratio: volRatio, status: volRatio>2?"EXPLOSIVO":volRatio>1.5?"MUITO_ACIMA":volRatio>1?"ACIMA":volRatio>0.7?"NORMAL":"ABAIXO" },
        },
        suporte_resistencia: { suporte, resistencia, distResist, distSuport, rr_natural: rrNatural },
        kelly_criterion: { half_kelly: parseFloat(kelly.toFixed(2)), recomendado: parseFloat((kelly/2).toFixed(2)) },
        gestao_risco: {
          stop_sugerido: parseFloat((precoAtual-2*atr).toFixed(4)),
          alvo_sugerido: parseFloat((precoAtual+3*atr).toFixed(4)),
          atr_pct: parseFloat((atr/precoAtual*100).toFixed(2)),
        },
        historico_recente: validData.slice(-5),
        cached_at: new Date().toISOString(),
      };
    } catch(e) {
      return null;
    }
  }

  // Calcula e salva todos os indicadores
  const results = { success: 0, failed: 0, tickers: [] };

  // Processa em lotes de 5 com delay
  for (let i = 0; i < TICKERS.length; i += 5) {
    const batch = TICKERS.slice(i, i+5);
    await Promise.all(batch.map(async ticker => {
      const ind = await calcIndicators(ticker);
      if (ind) {
        await redisSet(`ind_${ticker}`, ind, 86400); // 24h TTL
        results.success++;
        results.tickers.push(ticker);
      } else {
        results.failed++;
      }
    }));
    // Delay entre lotes
    if (i + 5 < TICKERS.length) await new Promise(r => setTimeout(r, 1000));
  }

  // Salva timestamp do ultimo precalc
  await redisSet('precalc_last', { at: new Date().toISOString(), success: results.success, failed: results.failed }, 86400);

  return res.status(200).json({
    ok: true,
    message: `Precalc completo: ${results.success} calculados, ${results.failed} falhou`,
    success: results.success,
    failed: results.failed,
    tickers: results.tickers,
  });
}
