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

  const KEY = "analyst_ai_portfolio";

  async function redisGet() {
    const r = await fetch(`${REDIS_URL}/get/${KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : [];
  }

  async function redisSet(data) {
    // Formato correto do Upstash REST API
    const encoded = encodeURIComponent(JSON.stringify(data));
    const r = await fetch(`${REDIS_URL}/set/${KEY}/${encoded}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return r.ok;
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
      await redisSet(portfolio);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
