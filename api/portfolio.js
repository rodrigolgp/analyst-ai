export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "Database not configured" });
  }

  const KEY = "portfolio_v2";

  async function redisGet() {
    const r = await fetch(`${REDIS_URL}/get/${KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const d = await r.json();
    if (!d.result) return [];
    try { return JSON.parse(d.result); } catch(e) { return []; }
  }

  async function redisSet(data) {
    const value = JSON.stringify(data);
    const r = await fetch(`${REDIS_URL}/set/${KEY}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ value })
    });
    const d = await r.json();
    return d;
  }

  if (req.method === "GET") {
    try {
      const portfolio = await redisGet();
      return res.status(200).json({ portfolio });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { portfolio } = req.body;
      if (!Array.isArray(portfolio)) {
        return res.status(400).json({ error: "portfolio must be an array" });
      }
      const result = await redisSet(portfolio);
      return res.status(200).json({ ok: true, result });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
