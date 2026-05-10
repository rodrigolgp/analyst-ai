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

  const KEY = "portfolio_v4";

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

  if (req.method === "GET") {
    try {
      const result = await redisCall("GET", KEY);
      const portfolio = result ? JSON.parse(result) : [];
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
      await redisCall("SET", KEY, JSON.stringify(portfolio));
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
