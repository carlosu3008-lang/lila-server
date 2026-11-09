const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3001;
const LILA_SECRET_KEY = process.env.LILA_SECRET_KEY || "lila_secret_2026";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const OWNER_PHONE = (process.env.OWNER_PHONE || "").replace(/\D/g, "");

// Estado en memoria del nodo en la nube
let sock = null;
let latestQrDataUrl = null;
let connectionStatus = "initializing"; // initializing | qr_ready | connected | disconnected
let connectedNumber = null;

// Bandeja de últimos 50 mensajes recibidos
const inboxMessages = [];
// Contactos aprendidos automáticamente de conversaciones entrantes { nombre_lower: jid }
const learnedContacts = {};

// Persistencia ligera de recordatorios y rutinas diarias
const SCHEDULES_FILE = path.join(__dirname, "schedules.json");
let schedules = [];
try {
  if (fs.existsSync(SCHEDULES_FILE)) {
    schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf-8"));
  }
} catch (_) {
  schedules = [];
}

function saveSchedules() {
  try {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando schedules:", e.message);
  }
}

// Normaliza un número colombiano o internacional a JID de WhatsApp
function toWhatsAppJid(target) {
  if (!target) return null;
  const raw = String(target).trim();
  if (raw.includes("@s.whatsapp.net") || raw.includes("@g.us")) return raw;

  // Buscar por nombre en contactos aprendidos
  const lower = raw.toLowerCase();
  if (learnedContacts[lower]) return learnedContacts[lower];
  for (const [name, jid] of Object.entries(learnedContacts)) {
    if (name.includes(lower) || lower.includes(name)) return jid;
  }

  let digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("3")) {
    digits = "57" + digits;
  }
  if (digits.length < 10) return null;
  return `${digits}@s.whatsapp.net`;
}

// Consulta rápida a Gemini o Groq cuando el portátil está apagado
async function askLilaCloudAI(userPrompt) {
  const systemPrompt =
    "Eres LILA 2.0 (Núcleo en la Nube 24/7), el asistente personal tipo J.A.R.V.I.S. del Señor Carlos. " +
    "Responde de forma elegante, breve, leal y directa en español.";

  if (GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    } catch (e) {
      console.error("Error Gemini Cloud:", e.message);
    }
  }

  if (GROQ_API_KEY) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 400,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim();
      }
    } catch (e) {
      console.error("Error Groq Cloud:", e.message);
    }
  }

  return "Señor Carlos, el nodo en la nube está activo, pero falta configurar GEMINI_API_KEY o GROQ_API_KEY en las variables de entorno de Render.";
}

// Inicialización de conexión con WhatsApp vía WebSockets (Baileys)
async function startWhatsApp() {
  const authFolder = path.join(__dirname, "auth_info_baileys");
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["LILA 2.0 Cloud", "Chrome", "2.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionStatus = "qr_ready";
      latestQrDataUrl = await QRCode.toDataURL(qr);
      console.log("[LILA Cloud] Nuevo código QR generado. Ábrelo en /qr para vincular.");
    }
    if (connection === "open") {
      connectionStatus = "connected";
      latestQrDataUrl = null;
      connectedNumber = sock.user?.id?.split(":")[0] || "Conectado";
      console.log(`[LILA Cloud] ✅ WhatsApp conectado exitosamente (${connectedNumber})`);
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      console.log(`[LILA Cloud] Conexión cerrada (código ${statusCode}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 4000);
      } else {
        try {
          fs.rmSync(authFolder, { recursive: true, force: true });
        } catch (_) {}
        setTimeout(startWhatsApp, 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid || "";
      if (remoteJid === "status@broadcast") continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";
      if (!text) continue;

      const pushName = msg.pushName || remoteJid.split("@")[0];
      const nowCol = new Date().toLocaleTimeString("es-CO", {
        timeZone: "America/Bogota",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      if (!msg.key.fromMe && pushName) {
        learnedContacts[pushName.toLowerCase().trim()] = remoteJid;
      }

      if (!msg.key.fromMe) {
        inboxMessages.push({
          from: pushName,
          jid: remoteJid,
          body: text,
          time: nowCol,
          timestamp: Date.now(),
        });
        if (inboxMessages.length > 50) inboxMessages.shift();
      }

      // Si el Señor Carlos escribe un mensaje que empieza por "Lila," o "Lila " (incluso a sí mismo con el portátil apagado)
      const cleanText = text.trim();
      const isCommandForLila = /^lila[,:\s]+/i.test(cleanText);
      const isOwnerOrSelf =
        msg.key.fromMe ||
        (OWNER_PHONE && remoteJid.includes(OWNER_PHONE)) ||
        (connectedNumber && remoteJid.includes(connectedNumber));

      if (isCommandForLila && isOwnerOrSelf) {
        const query = cleanText.replace(/^lila[,:\s]+/i, "").trim();
        if (query && !cleanText.startsWith("🤖 *LILA:*")) {
          const reply = await askLilaCloudAI(query);
          await sock.sendMessage(remoteJid, { text: `🤖 *LILA:* ${reply}` });
        }
      }
    }
  });
}

// Middleware de seguridad por Token
function requireAuth(req, res, next) {
  const token =
    req.headers["x-lila-key"] ||
    req.query.key ||
    (req.headers.authorization || "").replace("Bearer ", "");
  if (LILA_SECRET_KEY && token !== LILA_SECRET_KEY) {
    return res.status(401).json({ error: "No autorizado. Token LILA_SECRET_KEY inválido." });
  }
  next();
}

// Motor de tareas programadas y rutinas diarias (hora de Colombia America/Bogota)
async function evaluateSchedules() {
  if (connectionStatus !== "connected" || !sock) return;
  const now = new Date();
  const colFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(colFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
  const currentHHMM = `${parts.hour}:${parts.minute}`;

  let changed = false;
  for (const item of schedules) {
    if (!item.active) continue;
    // Coincidencia de hora HH:MM (o si ya pasó la hora hoy y no se ha enviado hoy)
    if (item.time <= currentHHMM && item.lastSentDate !== todayStr) {
      const jid = toWhatsAppJid(item.target);
      if (!jid) continue;

      let finalMessage = item.message;
      if (item.useAI) {
        finalMessage = await askLilaCloudAI(
          `Redacta únicamente el texto del mensaje de WhatsApp para '${item.target}' con esta instrucción: ${item.message}. Sin comillas ni explicaciones extras.`
        );
      }

      try {
        await sock.sendMessage(jid, { text: finalMessage });
        item.lastSentDate = todayStr;
        if (!item.recurring) {
          item.active = false;
        }
        changed = true;
        console.log(`[LILA Cloud] ✅ Rutina ejecutada hacia ${jid}: ${finalMessage}`);
      } catch (e) {
        console.error("Error ejecutando rutina:", e.message);
      }
    }
  }
  if (changed) saveSchedules();
}

setInterval(evaluateSchedules, 45 * 1000);

// --- RUTAS DEL SERVIDOR ---

// 1. Latido / Marcapasos (mantiene despierto a Render 24/7 y evalúa rutinas)
app.get("/ping", async (req, res) => {
  await evaluateSchedules();
  res.json({
    ok: true,
    service: "LILA 2.0 Cloud Node",
    whatsapp: connectionStatus,
    connectedNumber,
    inboxCount: inboxMessages.length,
    activeSchedules: schedules.filter((s) => s.active).length,
  });
});

// 2. Vista web para escanear el código QR cómodamente desde el navegador
app.get("/qr", requireAuth, (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`
      <html><body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;">
        <h1 style="color:#4ade80;">✅ LILA 2.0 Cloud WhatsApp Conectado 24/7</h1>
        <p>Número vinculado: <b>+${connectedNumber}</b></p>
        <p>Ya puedes cerrar esta ventana. Tu portátil gastará 0 MB de RAM y nunca se abrirán ventanas al enviar mensajes.</p>
      </body></html>
    `);
  }
  if (latestQrDataUrl) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="15"></head>
      <body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:40px;">
        <h2 style="color:#ec4899;">📱 Vincula tu WhatsApp con LILA 2.0 Cloud</h2>
        <p>Abre WhatsApp en tu celular ➔ Dispositivos vinculados ➔ Vincular un dispositivo</p>
        <img src="${latestQrDataUrl}" style="border:8px solid white;border-radius:12px;width:280px;height:280px;"/>
        <p style="color:#aaa;font-size:13px;">(Esta página se actualiza sola cada 15 segundos)</p>
      </body></html>
    `);
  }
  res.send(`
    <html><head><meta http-equiv="refresh" content="4"></head>
    <body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;">
      <h2>⏳ Generando código QR de WhatsApp... espera 4 segundos.</h2>
    </body></html>
  `);
});

// 3. Enviar mensaje de WhatsApp en segundo plano (0 ventanas en el PC)
app.post("/send", requireAuth, async (req, res) => {
  try {
    if (connectionStatus !== "connected" || !sock) {
      return res.status(503).json({
        success: false,
        error: `WhatsApp en la nube aún no está vinculado (estado: ${connectionStatus}). Entra a /qr para escanear el código.`,
      });
    }
    const target = req.body.number || req.body.contact;
    const message = req.body.message;
    if (!target || !message) {
      return res.status(400).json({ success: false, error: "Faltan parámetros 'number'/'contact' o 'message'." });
    }
    const jid = toWhatsAppJid(target);
    if (!jid) {
      return res.status(400).json({
        success: false,
        error: `No se pudo resolver el número o contacto '${target}'.`,
      });
    }
    await sock.sendMessage(jid, { text: String(message) });
    return res.json({ success: true, to: jid });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Leer últimos mensajes recibidos
app.get("/messages", requireAuth, (req, res) => {
  const filter = String(req.query.contact || "").toLowerCase().trim();
  let list = inboxMessages;
  if (filter) {
    list = list.filter((m) => String(m.from || "").toLowerCase().includes(filter));
  }
  res.json(list.slice(-20));
});

// 5. Programar recordatorio o rutina diaria (funciona con el portátil apagado)
app.post("/schedule", requireAuth, (req, res) => {
  const { target, message, time, recurring = true, useAI = false } = req.body;
  if (!target || !message || !time) {
    return res.status(400).json({ success: false, error: "Se requieren 'target', 'message' y 'time' (HH:MM)." });
  }
  const newItem = {
    id: Date.now().toString(36),
    target,
    message,
    time, // Formato "08:00" (Hora Colombia)
    recurring: Boolean(recurring),
    useAI: Boolean(useAI),
    active: true,
    lastSentDate: null,
  };
  schedules.push(newItem);
  saveSchedules();
  res.json({ success: true, schedule: newItem });
});

app.get("/schedules", requireAuth, (req, res) => {
  res.json(schedules.filter((s) => s.active));
});

// 6. Alerta de correo importante recibida desde el vigía de Google Apps Script
app.post("/gmail-alert", requireAuth, async (req, res) => {
  try {
    const { from, subject, snippet, account = "Gmail" } = req.body;
    const ownerJid = toWhatsAppJid(OWNER_PHONE || connectedNumber);
    if (!ownerJid || connectionStatus !== "connected" || !sock) {
      return res.status(503).json({ success: false, error: "WhatsApp no conectado para enviar alerta." });
    }
    const summary = await askLilaCloudAI(
      `Llegó un correo nuevo a la cuenta '${account}' del Señor Carlos.\nDe: ${from}\nAsunto: ${subject}\nContenido: ${snippet}\nHaz un aviso de máximo 2 líneas para enviárselo por WhatsApp.`
    );
    await sock.sendMessage(ownerJid, {
      text: `📧 *Alerta de Correo (${account})*\n*De:* ${from}\n*Asunto:* ${subject}\n\n🤖 *LILA:* ${summary}`,
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[LILA Cloud] 🚀 Servidor activo en el puerto ${PORT}`);
  startWhatsApp().catch((err) => console.error("Error iniciando WhatsApp:", err));
});
