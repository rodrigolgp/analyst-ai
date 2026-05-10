export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: "Telegram not configured" });
  }

  try {
    const { type, data } = req.body;
    let message = "";

    if (type === "STOP_ATINGIDO") {
      message = `🔴 *ATLAS WEALTH — STOP ATINGIDO*\n\n`
        + `Ativo: *${data.ticker}*\n`
        + `Preco atual: ${data.preco}\n`
        + `Stop loss: ${data.stop}\n\n`
        + `⚠️ *VENDA IMEDIATAMENTE* para proteger seu capital.`;

    } else if (type === "ALVO_ATINGIDO") {
      message = `🟢 *ATLAS WEALTH — ALVO ATINGIDO*\n\n`
        + `Ativo: *${data.ticker}*\n`
        + `Preco atual: ${data.preco}\n`
        + `Alvo: ${data.alvo}\n`
        + `Lucro estimado: ${data.lucro}\n\n`
        + `✅ Considere realizar o lucro parcial ou total.`;

    } else if (type === "BRIEFING") {
      message = `📊 *ATLAS WEALTH — BRIEFING DO DIA*\n\n`
        + `Situacao: *${data.situacao}*\n\n`
        + `${data.resumo}\n\n`
        + `💬 _${data.mensagem}_\n\n`
        + `_${new Date().toLocaleDateString("pt-BR", { weekday:"long", day:"2-digit", month:"long" })}_`;

    } else if (type === "OPORTUNIDADE") {
      message = `💡 *ATLAS WEALTH — OPORTUNIDADE IDENTIFICADA*\n\n`
        + `Ativo: *${data.ticker}*\n`
        + `Sinal: ${data.sinal}\n`
        + `Score: ${data.score}/100\n`
        + `Preco: ${data.preco}\n`
        + `Alvo: ${data.alvo}\n`
        + `Stop: ${data.stop}\n`
        + `Upside: ${data.upside}\n\n`
        + `📋 ${data.motivo}`;

    } else if (type === "RADAR") {
      message = `🔍 *ATLAS WEALTH — RADAR DE OPORTUNIDADES*\n\n`
        + `${data.macro}\n\n`
        + (data.ops || []).map((op, i) =>
            `*#${i+1} ${op.ticker}* — ${op.up} upside\n`
          + `Ref: ${op.ref} | Alvo: ${op.alvo} | Stop: ${op.stop}\n`
          + `_${op.razao}_`
        ).join("\n\n")
        + `\n\n_Acesse o app para analise completa_`;

    } else if (type === "TESTE") {
      message = `✅ *ATLAS WEALTH*\n\nBot configurado com sucesso!\nVoce receberá alertas de:\n• Stop loss atingido\n• Alvo atingido\n• Briefing diario\n• Novas oportunidades\n\n_Bem-vindo ao ATLAS WEALTH_ 🏆`;

    } else {
      message = `📨 *ATLAS WEALTH*\n\n${data.texto || "Notificacao do sistema."}`;
    }

    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );

    const result = await r.json();
    if (!result.ok) {
      return res.status(500).json({ error: result.description });
    }

    return res.status(200).json({ ok: true, message_id: result.result.message_id });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
