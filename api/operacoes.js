export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: "Database not configured" });

  const KEY = "operacoes_v1";

  async function redisGet() {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["GET", KEY]])
    });
    const d = await r.json();
    const result = d?.[0]?.result;
    if (!result) return [];
    try { return JSON.parse(result); } catch(e) { return []; }
  }

  async function redisSet(data) {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", KEY, JSON.stringify(data)]])
    });
  }

  function calcLucro(op) {
    const qtdVendida = op.saidas.reduce((a, s) => a + s.qtd, 0);
    const totalRecebido = op.saidas.reduce((a, s) => a + s.qtd * s.preco, 0);
    const custoVendido = qtdVendida * op.preco_medio;
    const lucro = totalRecebido - custoVendido;
    const pct = custoVendido > 0 ? (lucro / custoVendido) * 100 : 0;
    return { lucro: parseFloat(lucro.toFixed(2)), pct: parseFloat(pct.toFixed(2)) };
  }

  // GET — retorna todas as operacoes
  if (req.method === "GET") {
    try {
      const ops = await redisGet();
      return res.status(200).json({ operacoes: ops });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === "POST") {
    const { acao } = req.body;

    // ABRIR — nova operacao
    if (acao === "ABRIR") {
      try {
        const { ticker, preco, quantidade, stop, alvo, mercado, score, sinal } = req.body;
        const ops = await redisGet();
        const op = {
          id: Date.now(),
          ticker: ticker.toUpperCase(),
          status: "ABERTA",
          data_entrada: new Date().toISOString().split("T")[0],
          preco_entrada: parseFloat(preco),
          preco_medio: parseFloat(preco),
          quantidade_total: parseFloat(quantidade),
          quantidade_atual: parseFloat(quantidade),
          mercado: mercado || "B3",
          stop_loss: stop ? Math.round(parseFloat(stop) * 100) / 100 : null,
          alvo: alvo ? Math.round(parseFloat(alvo) * 100) / 100 : null,
          score_atlas: score ? parseInt(score) : null,
          sinal_atlas: sinal || null,
          prazo_dias: req.body.prazo_dias ? parseInt(req.body.prazo_dias) : null,
          setup_original: req.body.setup_original || null,
          catalisador: req.body.catalisador || null,
          saidas: [],
          lucro_total: 0,
          resultado_pct: 0,
          atlas_acertou: null,
        };
        ops.push(op);
        await redisSet(ops);
        return res.status(200).json({ ok: true, operacao: op });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // VENDER — parcial ou total
    if (acao === "VENDER") {
      try {
        const { id, quantidade, preco, motivo } = req.body;
        const ops = await redisGet();
        const idx = ops.findIndex(o => o.id === id);
        if (idx < 0) return res.status(404).json({ error: "Operação não encontrada" });
        const op = ops[idx];
        const qtd = parseFloat(quantidade);
        const preco_saida = parseFloat(preco);
        if (qtd > op.quantidade_atual) return res.status(400).json({ error: "Quantidade maior que posição atual" });

        // Registra saida
        op.saidas.push({
          data: new Date().toISOString().split("T")[0],
          qtd,
          preco: preco_saida,
          motivo: motivo || "SAIDA MANUAL",
        });

        // Atualiza quantidade
        op.quantidade_atual = parseFloat((op.quantidade_atual - qtd).toFixed(8));

        // Atualiza status
        op.status = op.quantidade_atual <= 0 ? "ENCERRADA" : "PARCIAL";
        if (op.status === "ENCERRADA") op.quantidade_atual = 0;
        if (req.body.atlas_acertou !== undefined && req.body.atlas_acertou !== null) {
          op.atlas_acertou = req.body.atlas_acertou === true || req.body.atlas_acertou === "true";
        }

        // Recalcula P&L
        const res2 = calcLucro(op);
        op.lucro_total = res2.lucro;
        op.resultado_pct = res2.pct;
        op.atlas_acertou = op.status === "ENCERRADA" ? res2.lucro > 0 : null;

        ops[idx] = op;
        await redisSet(ops);
        return res.status(200).json({ ok: true, operacao: op });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // REFORCAR — aumentar posicao e recalcular preco medio
    if (acao === "REFORCAR") {
      try {
        const { id, quantidade, preco } = req.body;
        const ops = await redisGet();
        const idx = ops.findIndex(o => o.id === id);
        if (idx < 0) return res.status(404).json({ error: "Operação não encontrada" });
        const op = ops[idx];
        const qtdNova = parseFloat(quantidade);
        const precoNovo = parseFloat(preco);

        // Recalcula preco medio ponderado
        const totalAnterior = op.quantidade_atual * op.preco_medio;
        const totalNovo = qtdNova * precoNovo;
        op.preco_medio = parseFloat(((totalAnterior + totalNovo) / (op.quantidade_atual + qtdNova)).toFixed(4));
        op.quantidade_total += qtdNova;
        op.quantidade_atual += qtdNova;
        op.status = "ABERTA";

        ops[idx] = op;
        await redisSet(ops);
        return res.status(200).json({ ok: true, operacao: op });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // GET_RAW / SET_RAW — leitura e escrita de chaves genericas (renda, watchlist, etc)
    if (acao === "GET") {
      try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: "key required" });
        const val = await redis(`GET ${key}`);
        const data = val ? JSON.parse(val) : [];
        return res.status(200).json({ ok: true, data });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (acao === "SET_RAW") {
      try {
        const { key, data } = req.body;
        if (!key) return res.status(400).json({ error: "key required" });
        await redis(`SET ${key} ${JSON.stringify(JSON.stringify(data))}`);
        return res.status(200).json({ ok: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // EDITAR — atualiza campos da operacao
    if (acao === "EDITAR") {
      try {
        const { id, stop, alvo, score, nota, journal } = req.body;
        const ops = await redisGet();
        const idx = ops.findIndex(o => o.id === id);
        if (idx < 0) return res.status(404).json({ error: "Operação não encontrada" });
        if (stop !== undefined) ops[idx].stop_loss = Math.round(parseFloat(stop) * 10000) / 10000;
        if (alvo !== undefined) ops[idx].alvo = Math.round(parseFloat(alvo) * 10000) / 10000;
        if (score !== undefined) ops[idx].score_atlas = parseInt(score);
        if (nota !== undefined) ops[idx].nota = String(nota).slice(0, 200);
        if (journal !== undefined) ops[idx].journal = journal;
        if (req.body.prazo_dias !== undefined) ops[idx].prazo_dias = parseInt(req.body.prazo_dias);
        if (req.body.setup_original !== undefined) ops[idx].setup_original = String(req.body.setup_original).slice(0, 500);
        if (req.body.catalisador !== undefined) ops[idx].catalisador = String(req.body.catalisador).slice(0, 200);
        if (req.body.quantidade_atual !== undefined) ops[idx].quantidade_atual = parseFloat(req.body.quantidade_atual);
        if (req.body.preco_medio !== undefined) ops[idx].preco_medio = Math.round(parseFloat(req.body.preco_medio) * 10000) / 10000;
        if (req.body.data_entrada !== undefined) ops[idx].data_entrada = req.body.data_entrada;
        if (req.body.saidas !== undefined) {
          ops[idx].saidas = req.body.saidas;
          // Recalcula lucro total das saidas
          const entrada = parseFloat(ops[idx].preco_medio)||0;
          ops[idx].lucro_total = ops[idx].saidas.reduce((a,s) => a + (parseFloat(s.preco)-entrada)*s.qtd, 0);
          ops[idx].lucro_total = Math.round(ops[idx].lucro_total * 100) / 100;
        }
        await redisSet(ops);
        return res.status(200).json({ ok: true, operacao: ops[idx] });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
  }

  // DELETE — remove operacao por id
  if (req.method === "DELETE") {
    try {
      const { id } = req.body;
      const ops = await redisGet();
      const filtered = ops.filter(o => o.id !== id);
      await redisSet(filtered);
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
