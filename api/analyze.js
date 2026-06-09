export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const { prompt, raw } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // Chat usa Haiku — rapido e barato
    // Analise/Guru/Radar usa Sonnet 4.5 — equilibrio qualidade/velocidade
    const model = raw ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-5";
    const max_tokens = raw ? 800 : 2000;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: text });

    const data = JSON.parse(text);
    const responseText = data.content?.[0]?.text || "";
    return res.status(200).json({ text: responseText });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
