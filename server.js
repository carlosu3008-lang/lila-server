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
const LILA_SECRET_KEY = (process.env.LILA_SECRET_KEY || "lila_secret_2026").trim();
let GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
let GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const OWNER_PHONE = (process.env.OWNER_PHONE || "").replace(/\D/g, "");

// Estado en memoria del nodo en la nube
let sock = null;
let latestQrDataUrl = null;
let connectionStatus = "initializing"; // initializing | qr_ready | connected | disconnected
let connectedNumber = null;

// Caché de mensajes enviados para el protocolo Signal de WhatsApp (evita el aviso "Esperando el mensaje...")
const sentMessagesCache = new Map();
function rememberSentMessage(sentMsg) {
  if (sentMsg?.key?.id && sentMsg?.message) {
    sentMessagesCache.set(sentMsg.key.id, sentMsg.message);
    if (sentMessagesCache.size > 200) {
      const firstKey = sentMessagesCache.keys().next().value;
      sentMessagesCache.delete(firstKey);
    }
  }
}

async function safeSendMessage(jid, content) {
  if (!sock) throw new Error("Socket de WhatsApp no inicializado");
  const sent = await sock.sendMessage(jid, content);
  rememberSentMessage(sent);
  return sent;
}

// Bandeja de últimos 50 mensajes recibidos de WhatsApp
const inboxMessages = [];
// Últimos correos recibidos desde Google Apps Script
const recentEmails = [];
// Historial conversacional por usuario en WhatsApp para mantener contexto ("háblame más de eso", "sí", etc.)
const chatHistoryByJid = new Map();
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

// Consulta con memoria conversacional y contexto real a Gemini o Groq
async function askLilaCloudAI(userPrompt, jid = "default") {
  const emailContext =
    recentEmails.length > 0
      ? "\nÚltimos correos reales registrados:\n" +
        recentEmails
          .slice(-5)
          .map((e, i) => `${i + 1}. [${e.account}] De: ${e.from} | Asunto: ${e.subject} | Resumen: ${e.snippet}`)
          .join("\n")
      : "\nNota de correos: Aún no han entrado correos nuevos al vigía de la nube en esta sesión. NUNCA inventes correos ni digas que tienes un resumen listo si esta lista está vacía.";

  const activeScheds = schedules.filter((s) => s.active);
  const schedContext =
    activeScheds.length > 0
      ? "\nRutinas programadas activas:\n" +
        activeScheds.map((s) => `- Para ${s.target} a las ${s.time}: ${s.message}`).join("\n")
      : "\nRutinas programadas activas: Ninguna.";

  const systemPrompt =
    "Eres LILA 2.0 (Núcleo en la Nube 24/7), el asistente personal tipo J.A.R.V.I.S. del Señor Carlos. " +
    "Responde de forma elegante, breve, leal y directa en español. " +
    "Mantén el hilo de la conversación previa y NUNCA digas '¿Desea que se lo presente?' sin entregar la información de inmediato." +
    emailContext +
    schedContext;

  const history = chatHistoryByJid.get(jid) || [];
  let lastError = "";

  if (GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const geminiContents = [
        ...history.map((h) => ({
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text: h.text }],
        })),
        { role: "user", parts: [{ text: userPrompt }] },
      ];
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: geminiContents,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const cleanReply = text.trim();
          if (jid !== "routine") {
            history.push({ role: "user", text: userPrompt });
            history.push({ role: "assistant", text: cleanReply });
            if (history.length > 12) history.splice(0, history.length - 12);
            chatHistoryByJid.set(jid, history);
          }
          return cleanReply;
        }
      } else {
        const errBody = await res.text();
        lastError = `Gemini HTTP ${res.status}: ${errBody.slice(0, 120)}`;
        console.error(lastError);
      }
    } catch (e) {
      lastError = `Gemini Error: ${e.message}`;
      console.error("Error Gemini Cloud:", e.message);
    }
  }

  if (GROQ_API_KEY) {
    try {
      const groqMessages = [
        { role: "system", content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.text })),
        { role: "user", content: userPrompt },
      ];
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: groqMessages,
          max_tokens: 450,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) {
          const cleanReply = text.trim();
          if (jid !== "routine") {
            history.push({ role: "user", text: userPrompt });
            history.push({ role: "assistant", text: cleanReply });
            if (history.length > 12) history.splice(0, history.length - 12);
            chatHistoryByJid.set(jid, history);
          }
          return cleanReply;
        }
      }
    } catch (e) {
      console.error("Error Groq Cloud:", e.message);
    }
  }

  return `Señor Carlos, el nodo en la nube está activo, pero los proveedores de IA devolvieron error (${lastError || "sin llaves"}).`;
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
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // CRÍTICO: Devuelve el mensaje en caché cuando WhatsApp en el teléfono o PC solicita reintentar el descifrado Signal
    getMessage: async (key) => {
      if (key?.id && sentMessagesCache.has(key.id)) {
        return sentMessagesCache.get(key.id);
      }
      return { conversation: "Mensaje de LILA 2.0" };
    },
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

      // Si el Señor Carlos escribe un mensaje que empieza por "Lila," o "Lila "
      const cleanText = text.trim();
      const isCommandForLila = /^lila[,:\s]+/i.test(cleanText);
      const isOwnerOrSelf =
        msg.key.fromMe ||
        (OWNER_PHONE && remoteJid.includes(OWNER_PHONE)) ||
        (connectedNumber && remoteJid.includes(connectedNumber));

      if (isCommandForLila && isOwnerOrSelf) {
        const query = cleanText.replace(/^lila[,:\s]+/i, "").trim();
        if (query && !cleanText.startsWith("🤖 *LILA:*")) {
          const reply = await askLilaCloudAI(query, remoteJid);
          await safeSendMessage(remoteJid, { text: `🤖 *LILA:* ${reply}` });
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
    if (item.time <= currentHHMM && item.lastSentDate !== todayStr) {
      const jid = toWhatsAppJid(item.target);
      if (!jid) continue;

      let finalMessage = item.message;
      if (item.useAI) {
        finalMessage = await askLilaCloudAI(
          `Redacta únicamente el texto del mensaje de WhatsApp para '${item.target}' con esta instrucción: ${item.message}. Sin comillas ni explicaciones extras.`,
          "routine"
        );
      }

      try {
        await safeSendMessage(jid, { text: finalMessage });
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

setInterval(evaluateSchedules, 30 * 1000);

// --- RUTAS DEL SERVIDOR ---

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
    await safeSendMessage(jid, { text: String(message) });
    return res.json({ success: true, to: jid });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/messages", requireAuth, (req, res) => {
  const filter = String(req.query.contact || "").toLowerCase().trim();
  let list = inboxMessages;
  if (filter) {
    list = list.filter((m) => String(m.from || "").toLowerCase().includes(filter));
  }
  res.json(list.slice(-20));
});

app.post("/schedule", requireAuth, (req, res) => {
  const { target, message, time, recurring = false, useAI = false } = req.body;
  if (!target || !message || !time) {
    return res.status(400).json({ success: false, error: "Se requieren 'target', 'message' y 'time' (HH:MM)." });
  }
  const newItem = {
    id: Date.now().toString(36),
    target,
    message,
    time,
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

app.post("/schedule/cancel", requireAuth, (req, res) => {
  const target = String(req.body.target || "").toLowerCase().trim();
  const contact = String(req.body.contact || "").toLowerCase().trim();
  let removed = 0;
  for (const s of schedules) {
    if (!s.active) continue;
    const sTarget = String(s.target || "").toLowerCase();
    if (!target && !contact) {
      s.active = false;
      removed++;
    } else if ((target && sTarget.includes(target)) || (contact && sTarget.includes(contact))) {
      s.active = false;
      removed++;
    }
  }
  saveSchedules();
  res.json({ success: true, removed });
});

app.post("/gmail-alert", requireAuth, async (req, res) => {
  try {
    const { from, subject, snippet, account = "Gmail" } = req.body;
    recentEmails.push({ from, subject, snippet, account, time: new Date().toISOString() });
    if (recentEmails.length > 15) recentEmails.shift();

    const ownerJid = toWhatsAppJid(OWNER_PHONE || connectedNumber);
    if (!ownerJid || connectionStatus !== "connected" || !sock) {
      return res.status(503).json({ success: false, error: "WhatsApp no conectado para enviar alerta." });
    }
    const summary = await askLilaCloudAI(
      `Llegó un correo nuevo a la cuenta '${account}' del Señor Carlos.\nDe: ${from}\nAsunto: ${subject}\nContenido: ${snippet}\nHaz un aviso de máximo 2 líneas para enviárselo por WhatsApp.`,
      "routine"
    );
    await safeSendMessage(ownerJid, {
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
