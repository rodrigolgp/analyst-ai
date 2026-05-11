export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: "Database not configured" });

  const KEY = "historico_v2";

  async function redisCall(command, ...args) {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([[command, ...args]])
    });
    const d = await r.json();
    return d?.[0]?.result;
  }

  async function redisGet() {
    const result = await redisCall("GET", KEY);
    if (!result) return [];
    try { return JSON.parse(result); } catch(e) { return []; }
  }

  async function redisSet(data) {
    await redisCall("SET", KEY, JSON.stringify(data));
  }

  if (req.method === "GET") {
    try {
      const historico = await redisGet();
      return res.status(200).json({ historico });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === "POST") {
    try {
      const { operacao } = req.body;
      const historico = await redisGet();
      const idx = historico.findIndex(h => h.id === operacao.id);
      if (idx >= 0) historico[idx] = operacao;
      else historico.push(operacao);
      await redisSet(historico);
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === "DELETE") {
    try {
      const { id } = req.body;
      let historico = await redisGet();
      historico = historico.filter(h => h.id !== id);
      await redisSet(historico);
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
