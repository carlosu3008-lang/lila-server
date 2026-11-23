const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3001;
const LILA_SECRET_KEY = (process.env.LILA_SECRET_KEY || "lila_secret_2026").trim();
let GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
let GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
let OWNER_PHONE = (process.env.OWNER_PHONE || "").replace(/\D/g, "");
let MOM_LID_JID = process.env.MOM_LID_JID || "";
let MOM_PHONE_DIGITS = process.env.MOM_PHONE_DIGITS || "";
let TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();

const silentLogger = pino({ level: "silent" });

// --- CONEXIÓN PERMANENTE CON MONGODB ATLAS ---
let MongoClient = null;
try {
  MongoClient = require("mongodb").MongoClient;
} catch (_) {
  MongoClient = null;
}

const MONGODB_URI = (process.env.MONGODB_URI || "").trim();

let mongoClient = null;
let mongoDb = null;
let isMongoConnected = false;

async function initMongo() {
  if (!MongoClient || !MONGODB_URI) return;
  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 12000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db("lila");
    isMongoConnected = true;
    console.log("[LILA] 🍃 Conectado exitosamente a MongoDB Atlas (Base de datos: lila)");
  } catch (err) {
    console.error("[LILA] ⚠️ Error conectando a MongoDB Atlas:", err.message);
    isMongoConnected = false;
  }
}

// Estado de WhatsApp en memoria
let sock = null;
let latestQrDataUrl = null;
let connectionStatus = "initializing"; // initializing | qr_ready | connected | disconnected
let connectedNumber = null;

// --- PERSISTENCIA EN DISCO (cloud_state.json + schedules.json) + MONGODB ---
const STATE_FILE = path.join(__dirname, "cloud_state.json");
const SCHEDULES_FILE = path.join(__dirname, "schedules.json");
const AUTH_FOLDER = path.join(__dirname, "auth_info_baileys");

// Restaurar creds.json desde SESSION_DATA si está configurada en Render (respaldo secundario)
if (process.env.SESSION_DATA) {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    const credsPath = path.join(AUTH_FOLDER, "creds.json");
    const rawCreds = Buffer.from(process.env.SESSION_DATA.trim(), "base64").toString("utf-8");
    fs.writeFileSync(credsPath, rawCreds, "utf-8");
    console.log("[LILA] ✅ Credenciales de WhatsApp restauradas desde SESSION_DATA.");
  } catch (err) {
    console.error("Error restaurando SESSION_DATA:", err.message);
  }
}

let cloudState = {
  learnedContacts: {
    paula: MOM_LID_JID,
    pechy: MOM_LID_JID,
    "mamá": MOM_LID_JID,
    mama: MOM_LID_JID,
  },
  agendaTasks: [],
  currentLocation: {
    placeName: null,
    lat: null,
    lon: null,
    wifiSsid: null,
    updatedAt: null,
  },
  gmailOAuth: {
    Personal: null,
    Uniguajira: null,
  },
  notifiedEmailIds: [],
  processedCommandIds: [],
  lastEmailContext: null,
  recentFetchedEmails: [],
  lilaNotificationGroupJid: null,
  guestModeEnabled: true,
  telegramChatId: null,
  relationships: {
    hermana: ["nelly", "perla"],
    mamá: ["paula"],
    mama: ["paula"],
  },
  busyMode: {
    active: false,
    reason: "ocupado en este momento",
    untilTimestamp: null,
  },
};

const processedCommandIdsSet = new Set();

function hasProcessedCommand(msgId) {
  if (!msgId) return false;
  return processedCommandIdsSet.has(msgId) || (Array.isArray(cloudState.processedCommandIds) && cloudState.processedCommandIds.includes(msgId));
}

function markCommandProcessed(msgId) {
  if (!msgId) return;
  processedCommandIdsSet.add(msgId);
  if (!Array.isArray(cloudState.processedCommandIds)) cloudState.processedCommandIds = [];
  if (!cloudState.processedCommandIds.includes(msgId)) {
    cloudState.processedCommandIds.push(msgId);
    if (cloudState.processedCommandIds.length > 400) {
      cloudState.processedCommandIds.splice(0, cloudState.processedCommandIds.length - 400);
    }
    saveCloudState();
  }
}

// Escudo global anti-caídas (evita que desconexiones transitorias de red cierren Node con status 1 en Render)
process.on("unhandledRejection", (reason) => {
  console.error("[LILA Shield] Promesa rechazada capturada sin caída:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[LILA Shield] Excepción capturada sin caída:", err?.message || err);
});

try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    cloudState = {
      ...cloudState,
      ...loaded,
      learnedContacts: { ...cloudState.learnedContacts, ...(loaded.learnedContacts || {}) },
      currentLocation: { ...cloudState.currentLocation, ...(loaded.currentLocation || {}) },
      gmailOAuth: { ...cloudState.gmailOAuth, ...(loaded.gmailOAuth || {}) },
      relationships: { ...cloudState.relationships, ...(loaded.relationships || {}) },
      busyMode: { ...cloudState.busyMode, ...(loaded.busyMode || {}) },
    };
    if (Array.isArray(cloudState.processedCommandIds)) {
      for (const id of cloudState.processedCommandIds) processedCommandIdsSet.add(id);
    }
  }
} catch (e) {
  console.error("Error cargando cloud_state.json:", e.message);
}

// Carga e inicialización profunda desde MongoDB Atlas
async function loadStateFromMongo() {
  if (!isMongoConnected || !mongoDb) return;
  try {
    const col = mongoDb.collection("cloud_state");
    const doc = await col.findOne({ _id: "main_state" });
    if (doc) {
      if (!OWNER_PHONE && doc.ownerPhone) OWNER_PHONE = String(doc.ownerPhone).replace(/\D/g, "");
      if (!MOM_LID_JID && doc.momLidJid) MOM_LID_JID = String(doc.momLidJid);
      if (!MOM_PHONE_DIGITS && doc.momPhoneDigits) MOM_PHONE_DIGITS = String(doc.momPhoneDigits);
      if (!TELEGRAM_BOT_TOKEN && doc.telegramBotToken) TELEGRAM_BOT_TOKEN = String(doc.telegramBotToken).trim();

      cloudState = {
        ...cloudState,
        learnedContacts: {
          ...cloudState.learnedContacts,
          ...(doc.learnedContacts || {}),
          ...(MOM_LID_JID
            ? {
                paula: MOM_LID_JID,
                pechy: MOM_LID_JID,
                "mamá": MOM_LID_JID,
                mama: MOM_LID_JID,
              }
            : {}),
        },
        currentLocation: { ...cloudState.currentLocation, ...(doc.currentLocation || {}) },
        gmailOAuth: { ...cloudState.gmailOAuth, ...(doc.gmailOAuth || {}) },
        relationships: { ...cloudState.relationships, ...(doc.relationships || {}) },
        busyMode: { ...cloudState.busyMode, ...(doc.busyMode || {}) },
        agendaTasks: Array.isArray(doc.agendaTasks) ? doc.agendaTasks : cloudState.agendaTasks,
        notifiedEmailIds: Array.isArray(doc.notifiedEmailIds) ? doc.notifiedEmailIds : cloudState.notifiedEmailIds,
        processedCommandIds: Array.isArray(doc.processedCommandIds) ? doc.processedCommandIds : cloudState.processedCommandIds,
        lastEmailContext: doc.lastEmailContext || cloudState.lastEmailContext,
        recentFetchedEmails: Array.isArray(doc.recentFetchedEmails) ? doc.recentFetchedEmails : cloudState.recentFetchedEmails,
        lilaNotificationGroupJid: doc.lilaNotificationGroupJid || cloudState.lilaNotificationGroupJid,
        guestModeEnabled: typeof doc.guestModeEnabled === "boolean" ? doc.guestModeEnabled : cloudState.guestModeEnabled,
        telegramChatId: doc.telegramChatId || cloudState.telegramChatId,
        ownerPhone: doc.ownerPhone || OWNER_PHONE,
        momLidJid: doc.momLidJid || MOM_LID_JID,
        momPhoneDigits: doc.momPhoneDigits || MOM_PHONE_DIGITS,
        telegramBotToken: doc.telegramBotToken || TELEGRAM_BOT_TOKEN,
      };
      if (Array.isArray(cloudState.processedCommandIds)) {
        for (const id of cloudState.processedCommandIds) processedCommandIdsSet.add(id);
      }
      console.log(`[LILA] 🍃 Estado cargado desde MongoDB: ${cloudState.agendaTasks.length} tareas en agenda.`);
    }

    const schedCol = mongoDb.collection("schedules");
    const schedDocs = await schedCol.find({ active: true }).toArray();
    if (schedDocs && schedDocs.length > 0) {
      const existingIds = new Set(schedules.map((s) => s.id));
      let migratedRoutine = false;
      for (const s of schedDocs) {
        if (s.message === "Buenos días, Pechy. Espero que tengas un excelente día.") {
          s.message = "Saludo diario de buenos días natural, cálido y variado para mi mamá Pechy";
          s.useAI = true;
          if (!Array.isArray(s.recentGreetings) || s.recentGreetings.length === 0) {
            s.recentGreetings = ["Buenos días, Pechy. Espero que tengas un excelente día."];
          }
          migratedRoutine = true;
        }
        if (!existingIds.has(s.id)) schedules.push(s);
      }
      if (migratedRoutine) saveSchedules();
      console.log(`[LILA] 🍃 ${schedDocs.length} rutinas activas cargadas desde MongoDB.`);
    }

    const logsCol = mongoDb.collection("chat_logs");
    const recentLogs = await logsCol.find({}).sort({ timestamp: -1 }).limit(120).toArray();
    if (recentLogs && recentLogs.length > 0) {
      inboxMessages.push(...recentLogs.reverse());
    }
  } catch (err) {
    console.error("Error cargando estado desde MongoDB:", err.message);
  }
}

async function saveCloudState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(cloudState, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando cloud_state.json:", e.message);
  }
  if (isMongoConnected && mongoDb) {
    try {
      const col = mongoDb.collection("cloud_state");
      await col.updateOne(
        { _id: "main_state" },
        { $set: { ...cloudState, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    } catch (e) {
      console.error("Error guardando en MongoDB cloud_state:", e.message);
    }
  }
}

let schedules = [];
try {
  if (fs.existsSync(SCHEDULES_FILE)) {
    schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf-8"));
  }
} catch (_) {
  schedules = [];
}

async function saveSchedules() {
  try {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando schedules:", e.message);
  }
  if (isMongoConnected && mongoDb) {
    try {
      const col = mongoDb.collection("schedules");
      for (const item of schedules) {
        await col.updateOne({ id: item.id }, { $set: item }, { upsert: true });
      }
    } catch (e) {
      console.error("Error guardando en MongoDB schedules:", e.message);
    }
  }
}

// --- PERSISTENCIA DIFERENCIAL ULTRA-LIVIANA DE WHATSAPP EN MONGODB (AHORRA 99.8% DE ANCHO DE BANDA) ---
let syncAuthTimeout = null;
let isSyncingAuth = false;
let pendingSyncAgain = false;
const lastSyncedAuthContent = new Map();

function scheduleSyncAuthToMongo(delayMs = 12000) {
  if (syncAuthTimeout) clearTimeout(syncAuthTimeout);
  syncAuthTimeout = setTimeout(() => {
    syncAllAuthToMongo().catch(() => {});
  }, delayMs);
}

async function clearAuthFromMongo() {
  lastSyncedAuthContent.clear();
  if (!isMongoConnected || !mongoDb) return;
  try {
    await mongoDb.collection("whatsapp_auth").deleteMany({});
    console.log("[LILA] 🍃 Sesión de WhatsApp limpiada en MongoDB.");
  } catch (err) {
    console.error("Error limpiando sesión en MongoDB:", err.message);
  }
}

async function restoreAuthFromMongo() {
  if (!isMongoConnected || !mongoDb) return;
  try {
    const col = mongoDb.collection("whatsapp_auth");
    const files = await col.find({}).toArray();
    if (files.length > 0) {
      if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      for (const f of files) {
        if (f.fileName && f.content) {
          const filePath = path.join(AUTH_FOLDER, f.fileName);
          fs.writeFileSync(filePath, f.content, "utf-8");
          lastSyncedAuthContent.set(f.fileName, f.content);
        }
      }
      console.log(`[LILA] 🍃 ${files.length} archivos de sesión de WhatsApp restaurados desde MongoDB.`);
    }

    // Restaurar caché de mensajes enviados para responder a cualquier solicitud Signal Retry tras reinicios
    const sentCol = mongoDb.collection("sent_messages_cache");
    const cachedMsgs = await sentCol.find({}).sort({ updatedAt: -1 }).limit(60).toArray();
    for (const doc of cachedMsgs) {
      if (doc.msgId && doc.messageContent) {
        sentMessagesCache.set(doc.msgId, doc.messageContent);
        if (doc.remoteJid) {
          sentMessagesCache.set(`${doc.remoteJid}:${doc.msgId}`, doc.messageContent);
        }
      }
    }
  } catch (err) {
    console.error("Error restaurando sesión de WhatsApp desde MongoDB:", err.message);
  }
}

async function syncAllAuthToMongo() {
  if (!isMongoConnected || !mongoDb || !fs.existsSync(AUTH_FOLDER)) return;
  if (isSyncingAuth) {
    pendingSyncAgain = true;
    return;
  }
  isSyncingAuth = true;
  try {
    const files = fs.readdirSync(AUTH_FOLDER);
    if (!files.includes("creds.json")) return;
    const col = mongoDb.collection("whatsapp_auth");
    const currentFileSet = new Set();
    const bulkOps = [];
    const nowIso = new Date().toISOString();

    for (const file of files) {
      const fullPath = path.join(AUTH_FOLDER, file);
      try {
        if (fs.statSync(fullPath).isFile()) {
          currentFileSet.add(file);
          const content = fs.readFileSync(fullPath, "utf-8");
          // Solo subir a MongoDB si el archivo realmente cambió en bytes (evita gastar los 5 GB de ancho de banda de Render)
          if (lastSyncedAuthContent.get(file) !== content) {
            lastSyncedAuthContent.set(file, content);
            bulkOps.push({
              updateOne: {
                filter: { fileName: file },
                update: { $set: { fileName: file, content, updatedAt: nowIso } },
                upsert: true,
              },
            });
          }
        }
      } catch (_) {}
    }

    if (bulkOps.length > 0) {
      await col.bulkWrite(bulkOps, { ordered: false });
    }

    const removedFiles = [];
    for (const oldFile of lastSyncedAuthContent.keys()) {
      if (!currentFileSet.has(oldFile)) {
        removedFiles.push(oldFile);
        lastSyncedAuthContent.delete(oldFile);
      }
    }
    if (removedFiles.length > 0) {
      await col.deleteMany({ fileName: { $in: removedFiles } });
    }
  } catch (err) {
    console.error("Error respaldando sesión en MongoDB:", err.message);
  } finally {
    isSyncingAuth = false;
    if (pendingSyncAgain) {
      pendingSyncAgain = false;
      scheduleSyncAuthToMongo(5000);
    }
  }
}

// --- REGISTRO DE FINANZAS Y GASTOS (Nequi / Bancolombia) ---
async function recordFinanceTransaction({ from, to, amount, description, rawText }) {
  if (!isMongoConnected || !mongoDb) return;
  try {
    const col = mongoDb.collection("finances");
    await col.insertOne({
      from,
      to,
      amount,
      description,
      rawText,
      timestamp: new Date().toISOString(),
    });
    console.log(`[LILA] 💰 Transacción registrada en MongoDB: ${amount} a ${to}`);
  } catch (e) {
    console.error("Error guardando finanzas en MongoDB:", e.message);
  }
}

// --- CACHÉ SIGNAL Y REINTENTOS ROBUSTOS (Erradica "Esperando mensaje...") ---
function createSimpleCache(maxEntries = 3000) {
  const store = new Map();
  return {
    get: (key) => store.get(key),
    set: (key, val) => {
      store.set(key, val);
      if (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },
    del: (key) => store.delete(key),
    flushAll: () => store.clear(),
  };
}

const msgRetryCounterCache = createSimpleCache(3000);
const sentMessagesCache = new Map();

function rememberMessage(msgObj, persistToMongo = false) {
  if (!msgObj?.key?.id) return;
  const id = msgObj.key.id;
  const remoteJid = msgObj.key.remoteJid || "";
  const messageContent = msgObj.message;
  if (!messageContent) return;

  sentMessagesCache.set(id, messageContent);
  if (remoteJid) {
    sentMessagesCache.set(`${remoteJid}:${id}`, messageContent);
  }
  if (sentMessagesCache.size > 3000) {
    const firstKey = sentMessagesCache.keys().next().value;
    sentMessagesCache.delete(firstKey);
  }

  // Persistir en MongoDB únicamente los mensajes originados por LILA para reintentos Signal tras reinicios
  if (persistToMongo && isMongoConnected && mongoDb && msgObj?.key?.fromMe) {
    mongoDb
      .collection("sent_messages_cache")
      .updateOne(
        { msgId: id },
        { $set: { msgId: id, remoteJid, messageContent, updatedAt: new Date().toISOString() } },
        { upsert: true }
      )
      .catch(() => {});
  }
}

// Normaliza el JID respetando grupos (@g.us), identidades vinculadas (@lid) y el canal LID oficial de Mamá
function normalizeTargetJid(jid) {
  if (!jid) return null;
  const raw = String(jid).trim();
  const momLidPrefix = MOM_LID_JID ? MOM_LID_JID.split("@")[0] : "";
  if (
    (MOM_PHONE_DIGITS && raw.includes(MOM_PHONE_DIGITS)) ||
    (momLidPrefix && raw.includes(momLidPrefix))
  ) {
    return MOM_LID_JID;
  }
  if (raw.endsWith("@g.us") || raw.endsWith("@lid")) return raw;
  const ownerNum = OWNER_PHONE || connectedNumber;
  if (ownerNum && raw.includes(ownerNum)) {
    return `${ownerNum}@s.whatsapp.net`;
  }
  if (/^\d{10,15}$/.test(raw)) {
    return `${raw}@s.whatsapp.net`;
  }
  return raw;
}

async function safeSendMessage(jid, content, options = {}) {
  if (!sock) throw new Error("Socket de WhatsApp no inicializado");
  const target = normalizeTargetJid(jid);
  const { ensureFreshSession, ...sendOpts } = options || {};

  // Pre-generar y pre-guardar el mensaje en sentMessagesCache ANTES de enviarlo por red (elimina la condición de carrera de 8ms en reintentos Signal)
  const msgId = sendOpts.messageId || (typeof generateMessageIDV2 === "function" ? generateMessageIDV2(sock.user?.id) : undefined);
  if (msgId && content?.text) {
    const preProto = {
      extendedTextMessage: { text: String(content.text) },
      conversation: String(content.text),
    };
    sentMessagesCache.set(msgId, preProto);
    if (target) {
      sentMessagesCache.set(`${target}:${msgId}`, preProto);
    }
  }

  const finalOptions = msgId ? { ...sendOpts, messageId: msgId } : sendOpts;
  const sent = await sock.sendMessage(target, content, finalOptions);
  if (sent) rememberMessage(sent, true);
  scheduleSyncAuthToMongo(250);
  return sent;
}

const inboxMessages = [];
const recentEmails = [];
const chatHistoryByJid = new Map();

// --- FECHA Y HORA EN COLOMBIA (America/Bogota) ---
function getColombiaNowParts() {
  const now = new Date();
  const colFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(colFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const timeStr = `${parts.hour}:${parts.minute}`;
  const readable = now.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { dateStr, timeStr, readable, now };
}

function addDaysToDateStr(dateStr, daysDelta) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + daysDelta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function calculateDaysDifference(targetDateStr, baseDateStr) {
  const [y1, m1, d1] = targetDateStr.split("-").map(Number);
  const [y2, m2, d2] = baseDateStr.split("-").map(Number);
  const dt1 = new Date(Date.UTC(y1, m1 - 1, d1));
  const dt2 = new Date(Date.UTC(y2, m2 - 1, d2));
  return Math.round((dt1 - dt2) / (1000 * 60 * 60 * 24));
}

// --- SINCRONIZACIÓN DE GRUPOS Y RESOLUCIÓN INTELIGENTE DE CONTACTOS/GRUPOS ---
function normalizeSearchKey(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(el\s+grupo\s+de\s+whatsapp|grupo\s+de\s+whatsapp|el\s+grupo|grupo|chat|mi)\s+/i, "")
    .replace(/[^a-z0-9]/g, "");
}

async function syncWhatsAppGroups() {
  if (!sock || connectionStatus !== "connected") return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    let changed = false;
    for (const [jid, meta] of Object.entries(groups || {})) {
      const subject = String(meta?.subject || "").trim();
      if (!subject || !jid.endsWith("@g.us")) continue;
      const lowerSub = subject.toLowerCase();
      if (cloudState.learnedContacts[lowerSub] !== jid) {
        cloudState.learnedContacts[lowerSub] = jid;
        changed = true;
      }
      if (normalizeSearchKey(subject) === "lila" || lowerSub === "lila") {
        if (cloudState.lilaNotificationGroupJid !== jid) {
          cloudState.lilaNotificationGroupJid = jid;
          changed = true;
          console.log(`[LILA] 🔔 Grupo oficial de notificaciones 'LILA' detectado: ${jid}`);
        }
      }
    }
    if (changed) saveCloudState();
  } catch (err) {
    console.error("Error sincronizando grupos de WhatsApp:", err.message);
  }
}

function getOwnerNotificationJid() {
  if (cloudState.lilaNotificationGroupJid && cloudState.lilaNotificationGroupJid.endsWith("@g.us")) {
    return cloudState.lilaNotificationGroupJid;
  }
  if (cloudState.learnedContacts["lila"] && cloudState.learnedContacts["lila"].endsWith("@g.us")) {
    return cloudState.learnedContacts["lila"];
  }
  const ownerNum = OWNER_PHONE || connectedNumber;
  return ownerNum ? `${ownerNum}@s.whatsapp.net` : null;
}

function isSelfOrOwnerTarget(str) {
  const s = String(str || "").toLowerCase().trim();
  const norm = normalizeSearchKey(s);
  return (
    [
      "lila_group",
      "notificaciones_lila",
      "carlos",
      "señor carlos",
      "senor carlos",
      "sr carlos",
      "carlos uriana",
      "yo",
      "mi",
      "mí",
      "a mi",
      "a mí",
      "me",
      "owner",
      "creador",
      "lila",
      "grupo lila",
    ].includes(s) ||
    ["carlos", "senorcarlos", "srcarlos", "carlosuriana", "yo", "ami", "owner", "creador", "lilagroup", "grupolila"].includes(norm) ||
    Boolean(OWNER_PHONE && s.includes(OWNER_PHONE))
  );
}

function isFamilyVipJid(jid, pushName = "") {
  const j = String(jid || "").toLowerCase();
  const p = String(pushName || "").toLowerCase();
  if (!j) return false;
  if (MOM_LID_JID && j.includes(MOM_LID_JID.split("@")[0])) return true;
  if (MOM_PHONE_DIGITS && j.includes(MOM_PHONE_DIGITS)) return true;
  const perlaJid = cloudState.learnedContacts?.["perla"] || "";
  const nellyJid = cloudState.learnedContacts?.["nelly"] || "";
  if (perlaJid && j.includes(perlaJid.split("@")[0])) return true;
  if (nellyJid && j.includes(nellyJid.split("@")[0])) return true;
  if (["paula", "pechy", "mamá", "mama", "perla", "nelly", "hermana"].some((k) => p.includes(k))) return true;
  return false;
}

function resolveContactTarget(target, _depth = 0) {
  if (!target) return { ok: false, error: "No se indicó destinatario." };
  const raw = String(target).trim();
  const lower = raw
    .toLowerCase()
    .replace(/^(el\s+grupo\s+de\s+whatsapp|grupo\s+de\s+whatsapp|el\s+grupo|grupo|mi|a\s+mi)\s+/i, "")
    .trim();
  const normTarget = normalizeSearchKey(lower);

  if (isSelfOrOwnerTarget(raw) || isSelfOrOwnerTarget(lower)) {
    const notifJid = getOwnerNotificationJid();
    return { ok: true, jid: notifJid, canonicalName: "Señor Carlos (Grupo LILA)", relationship: "owner_group" };
  }

  if (lower === "hermana" || lower === "hermanas" || raw.toLowerCase() === "mi hermana") {
    return {
      ok: false,
      ambiguous: true,
      error: "Señor Carlos, usted tiene dos hermanas: Nelly y Perla. ¿A cuál de las dos desea escribirle?",
    };
  }

  // Resolución dinámica de relaciones aprendidas (ej. "prima" -> "Vero", "tía" -> "Carmen", etc.)
  const relMap = cloudState.relationships || {};
  const relEntry = relMap[lower] || relMap[normTarget];
  if (relEntry && _depth < 2) {
    const list = Array.isArray(relEntry) ? relEntry : [relEntry];
    if (list.length === 1) {
      return resolveContactTarget(list[0], _depth + 1);
    }
    if (list.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        error: `Señor Carlos, usted tiene registradas varias personas como '${lower}': ${list.join(" y ")}. ¿A cuál de ellas se refiere?`,
      };
    }
  }

  if (["prima", "primo", "tía", "tia", "tío", "tio", "abuela", "abuelo", "novia", "papá", "papa", "hermano"].includes(lower) && !cloudState.learnedContacts[lower]) {
    return {
      ok: false,
      ambiguous: true,
      error: `Señor Carlos, aún no tengo asociado quién es su '${lower}'. ¿Me indica cómo se llama (ej. "mi ${lower} es Vero") para aprenderlo de forma permanente?`,
    };
  }

  const momLidPrefix = MOM_LID_JID ? MOM_LID_JID.split("@")[0] : "";
  if (
    ["mamá", "mama", "mami", "madre", "paula", "pechy"].includes(lower) ||
    ["mama", "mami", "madre", "paula", "pechy"].includes(normTarget) ||
    Boolean(MOM_PHONE_DIGITS && raw.includes(MOM_PHONE_DIGITS)) ||
    Boolean(momLidPrefix && raw.includes(momLidPrefix))
  ) {
    const momTarget =
      MOM_LID_JID ||
      cloudState.learnedContacts["paula"] ||
      cloudState.learnedContacts["pechy"] ||
      cloudState.learnedContacts["mamá"];
    return { ok: true, jid: momTarget, canonicalName: "Paula (Pechy)", relationship: "mother" };
  }

  if (raw.includes("@s.whatsapp.net") || raw.includes("@g.us") || raw.includes("@lid")) {
    return { ok: true, jid: raw, canonicalName: raw.split("@")[0], relationship: "general" };
  }

  if (cloudState.learnedContacts[lower]) {
    return {
      ok: true,
      jid: cloudState.learnedContacts[lower],
      canonicalName: raw,
      relationship: ["nelly", "perla"].includes(lower) ? "sister" : "general",
    };
  }

  // Búsqueda exacta sin espacios ni tildes (ej. "cuarto game r" === "Cuarto gamer")
  for (const [name, jid] of Object.entries(cloudState.learnedContacts)) {
    if (normTarget && normalizeSearchKey(name) === normTarget) {
      return { ok: true, jid, canonicalName: name, relationship: "general" };
    }
  }

  const matches = [];
  for (const [name, jid] of Object.entries(cloudState.learnedContacts)) {
    const normName = normalizeSearchKey(name);
    if (
      name.includes(lower) ||
      lower.includes(name) ||
      (normTarget.length >= 3 && (normName.includes(normTarget) || normTarget.includes(normName)))
    ) {
      matches.push({ name, jid });
    }
  }
  const uniqueJids = [...new Set(matches.map((m) => m.jid))];
  if (uniqueJids.length === 1) {
    return { ok: true, jid: uniqueJids[0], canonicalName: matches[0].name, relationship: "general" };
  }
  if (uniqueJids.length > 1) {
    const namesList = matches.map((m) => `${m.name} (${m.jid.endsWith("@g.us") ? "Grupo" : "+" + m.jid.split("@")[0]})`).join(", ");
    return {
      ok: false,
      ambiguous: true,
      error: `Señor Carlos, encontré varios chats o contactos que coinciden con '${raw}': ${namesList}. ¿A cuál de ellos se refiere?`,
    };
  }

  let digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("3")) digits = "57" + digits;
  if (digits.length >= 10) {
    return { ok: true, jid: `${digits}@s.whatsapp.net`, canonicalName: `+${digits}`, relationship: "general" };
  }

  return {
    ok: false,
    error: `Señor Carlos, aún no tengo registrado el chat o contacto '${raw}' en mi memoria. Si es una persona, ¿me indica su número para guardarlo?`,
  };
}

async function resolveContactTargetAsync(target) {
  let res = resolveContactTarget(target);
  if (!res.ok && !res.ambiguous) {
    await syncWhatsAppGroups();
    res = resolveContactTarget(target);
  }
  return res;
}

function toWhatsAppJid(target) {
  const res = resolveContactTarget(target);
  return res.ok ? res.jid : null;
}

// --- CLIMA EN VIVO (Riohacha, Hatonuevo y Geocodificación Global) ---
const WEATHER_CODES = {
  0: "cielo despejado",
  1: "mayormente despejado",
  2: "parcialmente nublado",
  3: "nublado",
  45: "neblina",
  51: "llovizna ligera",
  53: "llovizna moderada",
  61: "lluvia ligera",
  63: "lluvia moderada",
  65: "lluvia fuerte",
  80: "chubascos ligeros",
  81: "chubascos moderados",
  82: "chubascos fuertes",
  95: "tormenta eléctrica",
};

async function fetchSingleCityWeather(name, lat, lon) {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LILA/1.0" };
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      const cur = data.current || {};
      const daily = data.daily || {};
      const desc = WEATHER_CODES[cur.weather_code] || "condiciones variables";
      const maxT = daily.temperature_2m_max?.[0] ?? cur.temperature_2m;
      const minT = daily.temperature_2m_min?.[0] ?? cur.temperature_2m;
      const rainProb = daily.precipitation_probability_max?.[0] ?? 0;
      return `${name}: ${cur.temperature_2m} °C (sensación térmica de ${cur.apparent_temperature} °C), ${desc}, humedad del ${cur.relative_humidity_2m} %, probabilidad de lluvia hoy del ${rainProb} % (máx. ${maxT} °C / mín. ${minT} °C).`;
    }
  } catch (_) {}

  // Respaldo secundario wttr.in
  const wttrUrl = `https://wttr.in/${encodeURIComponent(name)}?format=j1`;
  const wRes = await fetch(wttrUrl, { headers });
  if (!wRes.ok) throw new Error(`HTTP ${wRes.status}`);
  const wData = await wRes.json();
  const c = wData?.current_condition?.[0] || {};
  const tempC = c.temp_C || "30";
  const feelsC = c.FeelsLikeC || tempC;
  const hum = c.humidity || "75";
  const desc = c.lang_es?.[0]?.value || c.weatherDesc?.[0]?.value || "cielo variable";
  return `${name}: ${tempC} °C (sensación térmica de ${feelsC} °C), ${desc.toLowerCase()}, humedad del ${hum} %.`;
}

async function getWeatherLive(cityQuery = "") {
  try {
    const cleanCity = String(cityQuery || "").trim();
    const lowerCity = cleanCity.toLowerCase();

    if (!cleanCity || ["actual", "hoy", "aqui", "aquí", "mi ubicacion", "mi ubicación", "clima"].includes(lowerCity)) {
      const riohacha = await fetchSingleCityWeather("Riohacha", 11.5444, -72.9072);
      const hatonuevo = await fetchSingleCityWeather("Hatonuevo", 11.0672, -72.7647);
      return `- ${riohacha}\n- ${hatonuevo}`;
    }

    if (lowerCity.includes("riohacha") || lowerCity.includes("uniguajira") || lowerCity.includes("universidad")) {
      return await fetchSingleCityWeather("Riohacha (La Guajira)", 11.5444, -72.9072);
    }
    if (lowerCity.includes("hatonuevo") || lowerCity.includes("pueblo")) {
      return await fetchSingleCityWeather("Hatonuevo (La Guajira)", 11.0672, -72.7647);
    }

    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LILA/1.0" };
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=es&format=json`;
    const geoRes = await fetch(geoUrl, { headers });
    if (geoRes.ok) {
      const geoData = await geoRes.json();
      const hit = geoData?.results?.[0];
      if (hit) {
        const label = `${hit.name}${hit.admin1 ? ", " + hit.admin1 : ""} (${hit.country || ""})`;
        return await fetchSingleCityWeather(label, hit.latitude, hit.longitude);
      }
    }
    return await fetchSingleCityWeather(cleanCity, 11.5444, -72.9072);
  } catch (e) {
    return `En Riohacha y Hatonuevo la temperatura actual ronda los 30 °C (detalle técnico: ${e.message}).`;
  }
}

// --- CONEXIÓN GMAIL INTEGRAL (Lectura, Búsqueda, Envío, Respuesta y Reenvío) ---
async function getAccessTokenFromOAuth(oauthCreds) {
  if (!oauthCreds || !oauthCreds.refresh_token || !oauthCreds.client_id || !oauthCreds.client_secret) {
    return null;
  }
  const params = new URLSearchParams({
    client_id: oauthCreds.client_id,
    client_secret: oauthCreds.client_secret,
    refresh_token: oauthCreds.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(oauthCreds.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OAuth HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }
  const data = await res.json();
  return data.access_token;
}

function resolveGmailAccountCreds(accountName = "Personal") {
  const isUni = accountName.toLowerCase().includes("uni");
  if (isUni) {
    return (
      cloudState.gmailOAuth?.Uniguajira ||
      (process.env.GMAIL_REFRESH_TOKEN_UNI
        ? {
            client_id: process.env.GMAIL_CLIENT_ID,
            client_secret: process.env.GMAIL_CLIENT_SECRET,
            refresh_token: process.env.GMAIL_REFRESH_TOKEN_UNI,
          }
        : null)
    );
  }
  return (
    cloudState.gmailOAuth?.Personal ||
    (process.env.GMAIL_REFRESH_TOKEN_PERSONAL
      ? {
          client_id: process.env.GMAIL_CLIENT_ID,
          client_secret: process.env.GMAIL_CLIENT_SECRET,
          refresh_token: process.env.GMAIL_REFRESH_TOKEN_PERSONAL,
        }
      : null)
  );
}

// Envío y Respuesta nativa vía Gmail API (RFC 2822 base64url)
async function sendOrReplyGmail({ to, subject, body, account = "Personal", inReplyTo = null, threadId = null }) {
  const creds = resolveGmailAccountCreds(account);
  if (!creds) {
    throw new Error(`No hay credenciales registradas para la cuenta '${account}'.`);
  }
  const accessToken = await getAccessTokenFromOAuth(creds);
  if (!accessToken) throw new Error("No se pudo obtener el token de acceso de Gmail.");

  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  const emailRaw = headers.join("\r\n") + "\r\n\r\n" + body;
  const encodedEmail = Buffer.from(emailRaw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const payload = { raw: encodedEmail };
  if (threadId) payload.threadId = threadId;

  const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail API HTTP ${res.status}: ${errText.slice(0, 150)}`);
  }
  const data = await res.json();
  return { ok: true, id: data.id, threadId: data.threadId, account, to };
}

async function queryGmailAccountLive(accountName, oauthCreds, query = "is:unread newer_than:2d", maxResults = 5) {
  const accessToken = await getAccessTokenFromOAuth(oauthCreds);
  if (!accessToken) return null;

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) throw new Error(`Gmail API (${accountName}) HTTP ${listRes.status}`);
  const listData = await listRes.json();
  const messages = listData.messages || [];
  if (messages.length === 0) return { account: accountName, emails: [] };

  const detailed = [];
  for (const m of messages.slice(0, maxResults)) {
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`;
    const msgRes = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (msgRes.ok) {
      const msgData = await msgRes.json();
      const headers = msgData.payload?.headers || [];
      const from = headers.find((h) => h.name.toLowerCase() === "from")?.value || "Desconocido";
      const emailMatch = from.match(/<([^>]+@[^>]+)>/) || from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const emailAddress = emailMatch ? emailMatch[1].trim() : from.trim();
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value || "Sin asunto";
      const messageIdHeader = headers.find((h) => h.name.toLowerCase() === "message-id")?.value || null;
      detailed.push({
        id: m.id,
        threadId: msgData.threadId,
        messageIdHeader,
        account: accountName,
        from,
        emailAddress,
        subject,
        snippet: msgData.snippet || "",
      });
    }
  }
  return { account: accountName, emails: detailed };
}

async function checkGmailLive(query = "is:unread newer_than:2d", targetAccount = "All") {
  const accounts = [];
  const pCreds = resolveGmailAccountCreds("Personal");
  const uCreds = resolveGmailAccountCreds("Uniguajira");

  if ((targetAccount === "All" || targetAccount.toLowerCase().includes("personal")) && pCreds) {
    accounts.push(["Personal", pCreds]);
  }
  if ((targetAccount === "All" || targetAccount.toLowerCase().includes("uni")) && uCreds) {
    accounts.push(["Uniguajira", uCreds]);
  }

  const lines = [];
  const newlyFetched = [];
  for (const [accName, creds] of accounts) {
    try {
      const res = await queryGmailAccountLive(accName, creds, query, 5);
      if (res) {
        if (res.emails.length === 0) {
          lines.push(`Bandeja ${accName}: No hay correos nuevos que coincidan con '${query}'.`);
        } else {
          lines.push(`Bandeja ${accName} (${res.emails.length} encontrados):`);
          for (const e of res.emails) {
            newlyFetched.push(e);
            lines.push(`- De: ${e.from} [Correo para responder: ${e.emailAddress}] | Asunto: ${e.subject} | Resumen: ${e.snippet}`);
          }
        }
      }
    } catch (err) {
      lines.push(`Bandeja ${accName}: Error al consultar (${err.message}).`);
    }
  }

  if (newlyFetched.length > 0) {
    // El correo #1 (más reciente) queda como contexto principal de respuesta inmediata
    cloudState.lastEmailContext = newlyFetched[0];
    if (!Array.isArray(cloudState.recentFetchedEmails)) cloudState.recentFetchedEmails = [];
    for (const e of newlyFetched.reverse()) {
      cloudState.recentFetchedEmails = [
        e,
        ...cloudState.recentFetchedEmails.filter((x) => x.id !== e.id),
      ].slice(0, 20);
    }
    saveCloudState();
  }

  if (lines.length > 0) return lines.join("\n");

  if (recentEmails.length > 0) {
    return (
      "Últimos correos registrados:\n" +
      recentEmails
        .slice(-5)
        .map((e, i) => `${i + 1}. [${e.account}] De: ${e.from} | Asunto: ${e.subject} | Resumen: ${e.snippet}`)
        .join("\n")
    );
  }

  return "No tiene ningún correo nuevo no leído en sus bandejas en este momento.";
}

// --- AGENDA UNIFICADA Y RECORDATORIOS ESCALONADOS ---
function createAgendaEventWithReminders({ title, dueDate, dueTime = "07:00", notes = "" }) {
  const { dateStr: todayStr, timeStr: currentHHMM } = getColombiaNowParts();
  const eventId = "ev_" + Date.now().toString(36);
  const task = {
    id: eventId,
    title: String(title).trim(),
    dueDate: String(dueDate).trim(),
    dueTime: String(dueTime || "07:00").trim(),
    notes: String(notes || "").trim(),
    createdAt: new Date().toISOString(),
    completed: false,
  };
  cloudState.agendaTasks.push(task);

  const ownerTarget = "lila_group";
  const createdReminders = [];

  // 1. Recordatorio 3 días antes (08:00 a.m.) - Solo si no ha pasado la hora hoy
  const date3DaysBefore = addDaysToDateStr(task.dueDate, -3);
  const is3dValid =
    date3DaysBefore > todayStr ||
    (date3DaysBefore === todayStr && "08:00" > currentHHMM);

  if (is3dValid) {
    schedules.push({
      id: `${eventId}_3d`,
      parentEventId: eventId,
      target: ownerTarget,
      specificDate: date3DaysBefore,
      time: "08:00",
      message: `📅 *Recordatorio anticipado (faltan 3 días):* Señor Carlos, le recuerdo que el ${task.dueDate} tiene programado: *${task.title}*${task.notes ? " (" + task.notes + ")" : ""}.`,
      recurring: false,
      useAI: false,
      active: true,
      lastSentDate: null,
    });
    createdReminders.push(`3 días antes (${date3DaysBefore} a las 08:00)`);
  }

  // 2. Recordatorio 1 día antes (18:00 / 6:00 p.m.)
  const date1DayBefore = addDaysToDateStr(task.dueDate, -1);
  const is1dValid =
    date1DayBefore > todayStr ||
    (date1DayBefore === todayStr && "18:00" > currentHHMM);

  if (is1dValid) {
    schedules.push({
      id: `${eventId}_1d`,
      parentEventId: eventId,
      target: ownerTarget,
      specificDate: date1DayBefore,
      time: "18:00",
      message: `⚠️ *Recordatorio para mañana:* Señor Carlos, mañana (${task.dueDate}) tiene pendiente: *${task.title}*${task.notes ? " (" + task.notes + ")" : ""}.`,
      recurring: false,
      useAI: false,
      active: true,
      lastSentDate: null,
    });
    createdReminders.push(`1 día antes (${date1DayBefore} a las 18:00)`);
  }

  // 3. Recordatorio el mismo día
  const morningTime = task.dueTime && task.dueTime !== "08:00" ? task.dueTime : "07:00";
  const isSameDayValid =
    task.dueDate > todayStr ||
    (task.dueDate === todayStr && morningTime > currentHHMM);

  if (isSameDayValid) {
    schedules.push({
      id: `${eventId}_0d`,
      parentEventId: eventId,
      target: ownerTarget,
      specificDate: task.dueDate,
      time: morningTime,
      message: `🔔 *Recordatorio de hoy:* Buenos días, Señor Carlos. Hoy (${task.dueDate}) tiene programado: *${task.title}*${task.notes ? " (" + task.notes + ")" : ""}.`,
      recurring: false,
      useAI: false,
      active: true,
      lastSentDate: null,
    });
    createdReminders.push(`el mismo día (${task.dueDate} a las ${morningTime})`);
  }

  saveCloudState();
  saveSchedules();
  return { task, createdReminders };
}

// Consulta de tareas pendientes para responder a "¿tengo algo pendiente?"
function getPendingTasksSummary() {
  const { dateStr: todayStr } = getColombiaNowParts();
  const pending = cloudState.agendaTasks.filter((t) => !t.completed && t.dueDate >= todayStr);
  pending.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  if (pending.length === 0) {
    return "Señor Carlos, actualmente no tiene tareas ni compromisos pendientes registrados en su agenda.";
  }

  const lines = pending.map((t) => {
    const diff = calculateDaysDifference(t.dueDate, todayStr);
    const whenStr = diff === 0 ? "¡Hoy!" : diff === 1 ? "Mañana" : `en ${diff} días (${t.dueDate})`;
    return `- **${t.title}**: para ${whenStr}${t.notes ? " [" + t.notes + "]" : ""}`;
  });

  return (
    `Señor Carlos, tiene ${pending.length} compromiso(s) pendiente(s) en su agenda:\n` +
    lines.join("\n") +
    "\n\n¿Desea que preparemos o repasemos algo con anticipación?"
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- HERRAMIENTAS DECLARADAS PARA GEMINI EN LA NUBE ---
const CLOUD_TOOLS_DECLARATIONS = [
  {
    name: "get_weather",
    description: "Consulta el clima real en vivo de Riohacha, Hatonuevo o cualquier ciudad del mundo.",
    parameters: {
      type: "OBJECT",
      properties: {
        city: { type: "STRING", description: "Nombre de la ciudad o vacío para Riohacha y Hatonuevo." },
      },
    },
  },
  {
    name: "check_gmail",
    description: "Lee o busca correos en las bandejas de Gmail (Personal o Uniguajira).",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Filtro de búsqueda de Gmail (ej. 'is:unread', 'from:profesor')." },
        account: { type: "STRING", description: "'All', 'Personal' o 'Uniguajira'." },
      },
    },
  },
  {
    name: "send_or_reply_gmail",
    description: "Envía un correo nuevo, responde a un correo recibido o reenvía un correo desde la cuenta Personal o Institucional de Uniguajira.",
    parameters: {
      type: "OBJECT",
      properties: {
        to: { type: "STRING", description: "Dirección de correo del destinatario o nombre del remitente al que se responde." },
        subject: { type: "STRING", description: "Asunto del correo (opcional si es respuesta)." },
        body: { type: "STRING", description: "Cuerpo del mensaje con ortografía impecable." },
        account: { type: "STRING", description: "'Personal' o 'Uniguajira' (por defecto Personal, o Uniguajira si es tema de la universidad)." },
        isReply: { type: "BOOLEAN", description: "true si está respondiendo a un correo leído recientemente." },
      },
      required: ["body"],
    },
  },
  {
    name: "add_agenda_event",
    description: "Registra DE INMEDIATO una entrega, exposición, examen, parcial o tarea universitaria para una fecha 'YYYY-MM-DD' y programa los 3 recordatorios automáticos (3 días antes, 1 día antes y el mismo día).",
    parameters: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING", description: "Título de la tarea o exposición." },
        dueDate: { type: "STRING", description: "Fecha en formato 'YYYY-MM-DD'." },
        dueTime: { type: "STRING", description: "Hora del día (ej. '07:00')." },
        notes: { type: "STRING", description: "Notas adicionales opcionales." },
      },
      required: ["title", "dueDate"],
    },
  },
  {
    name: "get_pending_tasks",
    description: "Consulta y resume todos los compromisos, tareas y exposiciones pendientes que el Señor Carlos tiene por hacer.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "get_scheduled_routines",
    description: "Consulta las rutinas y mensajes programados activos en la memoria de LILA.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "schedule_whatsapp_message",
    description:
      "Programa un recordatorio para el Señor Carlos (ej. 'recuérdame ir al gym a las 3 pm') o una rutina/mensaje programado a un contacto o grupo a una hora determinada.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: {
          type: "STRING",
          description:
            "Si es un recordatorio para el Señor Carlos ('recuérdame...', 'avísame...'), pon 'Carlos' o 'lila_group'. Si es para otra persona o grupo, pon su nombre (ej. Paula, Pechy, Nelly, Perla, Cuarto gamer).",
        },
        message: { type: "STRING", description: "Texto del recordatorio o instrucción de saludo a enviar." },
        time: { type: "STRING", description: "Hora en formato 24h HH:MM (ej. '07:00', '15:00', '18:30')." },
        specificDate: { type: "STRING", description: "Fecha opcional YYYY-MM-DD." },
        recurring: { type: "BOOLEAN", description: "true solo si dijo 'todos los días'; false si es una sola vez." },
        useAI: { type: "BOOLEAN", description: "false si es un recordatorio o mensaje dictado; true si pidió redactar un saludo." },
      },
      required: ["message", "time"],
    },
  },
  {
    name: "pause_or_cancel_routine",
    description:
      "Salta el envío de una rutina SOLO POR HOY (skipTodayOnly: true, ej. 'no le escribas hoy a mi mamá'), pausa hasta cierta fecha (pauseUntil: 'YYYY-MM-DD') o cancela definitivamente la rutina.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: { type: "STRING", description: "Contacto o parentesco (ej. 'mamá', 'Paula', 'Pechy') o ID de la rutina." },
        skipTodayOnly: { type: "BOOLEAN", description: "true si pidió NO escribirle hoy ('no le escribas hoy a mi mamá') pero mantener la rutina para los días siguientes." },
        pauseUntil: { type: "STRING", description: "Fecha opcional 'YYYY-MM-DD' hasta la cual pausar." },
      },
    },
  },
  {
    name: "add_note_to_next_routine",
    description:
      "Agrega un encargo o nota especial para que se incluya de forma natural en el PRÓXIMO saludo automático de una rutina (ej. 'mañana cuando le escribas a mi mamá recuérdale traerme el perfume').",
    parameters: {
      type: "OBJECT",
      properties: {
        target: { type: "STRING", description: "Contacto de la rutina (ej. 'mamá', 'Paula', 'Pechy')." },
        extraNote: { type: "STRING", description: "Nota o encargo a incluir en el próximo saludo (ej. 'recordarle que me traiga el perfume')." },
      },
      required: ["target", "extraNote"],
    },
  },
  {
    name: "save_contact_or_relationship",
    description:
      "Aprende y guarda permanentemente en MongoDB quién es un familiar/apodo (ej. 'mi prima es Vero') o registra el número de teléfono de un contacto nuevo.",
    parameters: {
      type: "OBJECT",
      properties: {
        relationshipOrAlias: { type: "STRING", description: "Parentesco o apodo (ej. 'prima', 'tía', 'novia', 'mejor amigo') o vacío si solo guarda nombre." },
        contactName: { type: "STRING", description: "Nombre de la persona (ej. 'Vero', 'Nelly')." },
        phoneNumber: { type: "STRING", description: "Número de celular opcional si el Señor Carlos lo indicó." },
      },
      required: ["contactName"],
    },
  },
  {
    name: "get_chat_history",
    description:
      "Consulta los mensajes recibidos recientemente en WhatsApp de un contacto (ej. mamá, Perla, Eimar) o de un grupo para recordar qué dijeron o hacer un resumen.",
    parameters: {
      type: "OBJECT",
      properties: {
        contactOrGroup: { type: "STRING", description: "Nombre del contacto o grupo a consultar (o vacío para ver todos los recientes)." },
        limit: { type: "NUMBER", description: "Cantidad de mensajes a recuperar (por defecto 15)." },
      },
    },
  },
  {
    name: "delegate_conversation",
    description:
      "Inicia una conversación delegada con un contacto: LILA le escribe la pregunta o mensaje indicado, queda escuchando su respuesta automáticamente y le informa al Señor Carlos lo que responda.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: { type: "STRING", description: "Nombre del contacto con quien hablar (ej. 'Eimar', 'Perla', 'Mamá')." },
        initialMessage: { type: "STRING", description: "Primer mensaje que LILA le enviará de inmediato." },
        objective: { type: "STRING", description: "Qué información o acuerdo debe conseguir LILA en esa charla." },
      },
      required: ["target", "initialMessage", "objective"],
    },
  },
  {
    name: "set_busy_mode",
    description:
      "Activa o desactiva el Modo Ocupado / Secretario Inteligente de LILA (con regla de 35s, prioridad Familia VIP, cero spam en grupos y detector de urgencias).",
    parameters: {
      type: "OBJECT",
      properties: {
        active: { type: "BOOLEAN", description: "true para activar modo ocupado; false para desactivarlo." },
        reason: { type: "STRING", description: "Motivo (ej. 'en el gimnasio', 'en clase de Física', 'estudiando')." },
        durationMinutes: { type: "NUMBER", description: "Duración opcional en minutos (ej. 120 para 2 horas) tras la cual se apaga solo." },
      },
      required: ["active"],
    },
  },
  {
    name: "search_web_live",
    description:
      "Busca información actualizada en tiempo real en Google/Internet sobre cualquier noticia, evento, precio, partido, herramienta o tema.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Consulta a buscar en tiempo real en Google." },
      },
      required: ["query"],
    },
  },
  {
    name: "send_whatsapp_message",
    description: "Envía un mensaje de WhatsApp inmediatamente a un contacto individual o a un grupo de WhatsApp.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: { type: "STRING", description: "Contacto (ej. Paula, Pechy, Nelly, Perla), nombre del grupo (ej. Cuarto gamer) o número." },
        message: { type: "STRING", description: "Texto a enviar." },
      },
      required: ["target", "message"],
    },
  },
  {
    name: "get_finances_summary",
    description: "Consulta el historial de movimientos financieros, transferencias o pagos de Nequi guardados en la base de datos.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "diagnose_and_repair_system",
    description:
      "Ejecuta un autodiagnóstico profundo en vivo de MongoDB Atlas, llaves de cifrado Signal de WhatsApp, rutinas y correos. Si applyFix es true, aplica automáticamente las reparaciones detectadas.",
    parameters: {
      type: "OBJECT",
      properties: {
        applyFix: {
          type: "BOOLEAN",
          description: "false si solo se solicita diagnosticar y proponer mejoras; true si el Señor Carlos confirmó aplicar la reparación.",
        },
      },
    },
  },
];

async function runSelfDiagnosticAndRepair(applyFix = false) {
  const issues = [];
  const fixesApplied = [];

  // 1. Revisar sesiones Signal y canal LID de Mamá
  if (
    cloudState.learnedContacts["paula"] !== MOM_LID_JID ||
    cloudState.learnedContacts["pechy"] !== MOM_LID_JID ||
    cloudState.learnedContacts["mamá"] !== MOM_LID_JID
  ) {
    issues.push(
      `El contacto de Mamá (Paula/Pechy) apuntaba al formato antiguo (@s.whatsapp.net) en vez de su canal cifrado activo LID (${MOM_LID_JID}).`
    );
    if (applyFix) {
      cloudState.learnedContacts["paula"] = MOM_LID_JID;
      cloudState.learnedContacts["pechy"] = MOM_LID_JID;
      cloudState.learnedContacts["mamá"] = MOM_LID_JID;
      cloudState.learnedContacts["mama"] = MOM_LID_JID;
      await saveCloudState();
      fixesApplied.push(`Canal de Mamá migrado a su sesión Signal LID verificada (${MOM_LID_JID}).`);
    }
  }

  // 2. Revisar rutinas con target antiguo o inválido
  for (const s of schedules) {
    if (!s.active) continue;
    if (String(s.target).includes(MOM_PHONE_DIGITS) && s.target !== MOM_LID_JID) {
      issues.push(`La rutina '${s.contactName}' (${s.time}) usaba el identificador antiguo '${s.target}' en vez de '${MOM_LID_JID}'.`);
      if (applyFix) {
        s.target = MOM_LID_JID;
        fixesApplied.push(`Rutina '${s.contactName}' (${s.time}) actualizada al canal LID '${MOM_LID_JID}'.`);
      }
    } else if (!toWhatsAppJid(s.target) && !isSelfOrOwnerTarget(s.target)) {
      issues.push(`La rutina '${s.message}' (${s.time}) tiene un destinatario no resuelto ('${s.target}').`);
      if (applyFix) {
        s.target = "lila_group";
        fixesApplied.push(`Rutina '${s.message}' redirigida al grupo oficial LILA.`);
      }
    }
  }
  if (applyFix && fixesApplied.length > 0) {
    await saveSchedules();
  }

  // 3. Revisar archivos de sesión Signal estancados en disco/MongoDB
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      const staleFiles = fs.readdirSync(AUTH_FOLDER).filter((f) => f.startsWith(`session-${MOM_PHONE_DIGITS}.`));
      if (staleFiles.length > 0) {
        issues.push(
          `Se detectaron ${staleFiles.length} archivos de sesión Signal antiguos (${staleFiles.join(", ")}) con PreKey pendiente que causaban el aviso 'Esperando mensaje'.`
        );
        if (applyFix) {
          for (const sf of staleFiles) {
            try {
              fs.unlinkSync(path.join(AUTH_FOLDER, sf));
            } catch (_) {}
          }
          if (isMongoConnected && mongoDb && MOM_PHONE_DIGITS) {
            await mongoDb.collection("whatsapp_auth").deleteMany({
              fileName: { $regex: new RegExp(`^session-${MOM_PHONE_DIGITS}\\.`) },
            });
          }
          fixesApplied.push(`Eliminados ${staleFiles.length} archivos de sesión Signal obsoletos en disco y MongoDB Atlas.`);
        }
      }
    }
  } catch (_) {}

  const statusHeader =
    `📊 *Autodiagnóstico de LILA Cloud:*\n` +
    `- MongoDB Atlas: ${isMongoConnected ? "Conectado ✅" : "Desconectado ⚠️"}\n` +
    `- WhatsApp Signal: ${connectionStatus} (+${connectedNumber})\n` +
    `- Gmail OAuth: Personal (${cloudState.gmailOAuth?.Personal ? "✅" : "⚠️"}) | Uniguajira (${cloudState.gmailOAuth?.Uniguajira ? "✅" : "⚠️"})\n` +
    `- Rutinas activas: ${schedules.filter((s) => s.active).length}`;

  if (issues.length === 0) {
    return `${statusHeader}\n\nTodo el sistema de cifrado Signal (canal LID), base de datos MongoDB y rutinas se encuentra en perfecto estado sin anomalías.`;
  }

  if (!applyFix) {
    return (
      `${statusHeader}\n\n⚠️ *Problemas detectados (${issues.length}):*\n` +
      issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n") +
      `\n\n💡 *Mejora lista:* Puedo corregir estos puntos en caliente ahora mismo. ¿Me confirma para aplicarlo de una vez, Señor Carlos?`
    );
  }

  return (
    `${statusHeader}\n\n✅ *Reparación automática completada (${fixesApplied.length} acciones):*\n` +
    fixesApplied.map((f, idx) => `${idx + 1}. ${f}`).join("\n")
  );
}

function findMatchingEmailContext(targetHint = "") {
  const list = Array.isArray(cloudState.recentFetchedEmails) ? cloudState.recentFetchedEmails : [];
  const hint = String(targetHint || "").toLowerCase().trim();
  if (hint) {
    const matched = list.find(
      (e) =>
        (e.from && e.from.toLowerCase().includes(hint)) ||
        (e.emailAddress && e.emailAddress.toLowerCase().includes(hint)) ||
        (e.subject && e.subject.toLowerCase().includes(hint))
    );
    if (matched) return matched;
  }
  return cloudState.lastEmailContext || list[0] || null;
}

async function executeCloudToolCall(name, args) {
  switch (name) {
    case "diagnose_and_repair_system":
      return await runSelfDiagnosticAndRepair(Boolean(args?.applyFix));
    case "get_finances_summary": {
      if (!isMongoConnected || !mongoDb) return "Base de datos de finanzas en MongoDB no disponible en este momento.";
      try {
        const col = mongoDb.collection("finances");
        const docs = await col.find({}).sort({ timestamp: -1 }).limit(8).toArray();
        if (!docs || docs.length === 0) return "No hay registros de transferencias o pagos guardados recientemente.";
        const lines = docs.map((d) => `- ${d.amount} a ${d.to} (${d.description || ""}) [${(d.timestamp || "").split("T")[0]}]`);
        return `Últimos movimientos registrados en finanzas:\n` + lines.join("\n");
      } catch (err) {
        return `Error consultando finanzas: ${err.message}`;
      }
    }
    case "get_weather":
      return await getWeatherLive(args?.city || "");
    case "check_gmail":
      return await checkGmailLive(args?.query || "is:unread newer_than:2d", args?.account || "All");
    case "send_or_reply_gmail": {
      let rawTo = String(args?.to || "").trim();
      const lowerTo = rawTo.toLowerCase();
      let finalTo = rawTo;

      // 1. Resolver correos propios del Señor Carlos si pide enviarse a su cuenta Institucional o Personal
      const ownerUniEmail = cloudState.ownerUniEmail || "curianae@uniguajira.edu.co";
      const ownerPersonalEmail = cloudState.ownerPersonalEmail || "carlosuriana2007@gmail.com";

      if (!rawTo.includes("@") && /(institucional|uniguajira|universidad|mi correo de la u|cuenta de la u|curianae)/i.test(lowerTo)) {
        finalTo = ownerUniEmail;
      } else if (!rawTo.includes("@") && /(mi personal|correo personal|cuenta personal|carlosuriana)/i.test(lowerTo)) {
        finalTo = ownerPersonalEmail;
      }

      let matchedEmail = finalTo.includes("@") ? null : findMatchingEmailContext(rawTo);

      // 2. Extraer correo si viene como "Nombre <correo@dominio>" o buscar en el último correo leído SOLO si es respuesta
      const bracketMatch = finalTo.match(/<([^>]+@[^>]+)>/) || finalTo.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (bracketMatch) {
        finalTo = bracketMatch[1].trim();
      } else if (!finalTo.includes("@") && matchedEmail) {
        const ctxMatch =
          (matchedEmail.emailAddress && matchedEmail.emailAddress.includes("@") ? matchedEmail.emailAddress : null) ||
          matchedEmail.from?.match(/<([^>]+@[^>]+)>/)?.[1] ||
          matchedEmail.from?.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[1];
        if (ctxMatch) finalTo = ctxMatch.trim();
      }

      if (!finalTo || !finalTo.includes("@")) {
        return `No se encontró una dirección de correo válida para '${rawTo || "el destinatario"}'. Por favor indique el correo electrónico.`;
      }

      const isReply = Boolean(args?.isReply) && Boolean(matchedEmail);
      let threadId = null;
      let inReplyTo = null;
      let finalSubject = String(args?.subject || "").trim();

      if (isReply && matchedEmail) {
        threadId = matchedEmail.threadId || null;
        inReplyTo = matchedEmail.messageIdHeader || null;
        if (!finalSubject && matchedEmail.subject) {
          finalSubject = /^re:/i.test(matchedEmail.subject) ? matchedEmail.subject : `Re: ${matchedEmail.subject}`;
        }
      }
      if (!finalSubject) finalSubject = "Mensaje del Señor Carlos";

      const accountToUse = args?.account || (isReply ? matchedEmail?.account : null) || "Personal";
      const sent = await sendOrReplyGmail({
        to: finalTo,
        subject: finalSubject,
        body: String(args?.body || ""),
        account: accountToUse,
        inReplyTo,
        threadId,
      });
      return `Correo enviado exitosamente a ${sent.to} desde la cuenta ${sent.account} con el asunto "${finalSubject}".`;
    }
    case "add_agenda_event": {
      const { task, createdReminders } = createAgendaEventWithReminders({
        title: args.title,
        dueDate: args.dueDate,
        dueTime: args.dueTime || "07:00",
        notes: args.notes || "",
      });
      const remsText = createdReminders.length > 0 ? createdReminders.join(", ") : "notificación el mismo día";
      return `Evento '${task.title}' registrado exitosamente en la agenda para el ${task.dueDate}. Recordatorios automáticos programados en el grupo LILA: ${remsText}.`;
    }
    case "get_pending_tasks":
      return getPendingTasksSummary();
    case "get_scheduled_routines": {
      const activeList = schedules.filter((s) => s.active && !s.parentEventId);
      if (activeList.length === 0) {
        return "Actualmente no hay rutinas automáticas programadas.";
      }
      const lines = activeList.map(
        (s) =>
          `- Para: *${s.contactName || s.target}* | Hora: *${s.time}* (${
            s.recurring ? "Todos los días" : s.specificDate || "Una vez"
          }) | Instrucción: "${s.message}"${
            s.nextRunExtraNote ? ` | ✨ Nota extra próximo envío: "${s.nextRunExtraNote}"` : ""
          }${s.pauseUntil ? ` [Pausada hasta ${s.pauseUntil}]` : ""}`
      );
      return `Rutinas activas programadas (${activeList.length}):\n` + lines.join("\n");
    }
    case "schedule_whatsapp_message": {
      const rawTarget = String(args?.target || "lila_group").trim();
      const isSelf = !args?.target || isSelfOrOwnerTarget(rawTarget);
      let targetStr = "lila_group";
      let contactName = "Señor Carlos (Grupo LILA)";

      if (!isSelf) {
        const resolved = await resolveContactTargetAsync(rawTarget);
        if (!resolved.ok) return resolved.error;
        targetStr = resolved.jid;
        contactName = resolved.canonicalName || rawTarget;
      }

      const { dateStr: todayStr, timeStr: currentHHMM } = getColombiaNowParts();
      const cleanTime = String(args.time || "07:00").trim().padStart(5, "0");
      const isRecurring = Boolean(args.recurring);
      let specificDate = args.specificDate ? String(args.specificDate).trim() : null;
      let initialLastSentDate = null;

      // REGLA ANTI-ENVÍO NOCTURNO: Si la hora programada hoy ya pasó (ej. son las 21:16 y programa para las 07:00),
      // jamás enviarlo ahora mismo: marcarlo como ya cubierto hoy para que inicie mañana a su hora exacta.
      if (!specificDate && cleanTime <= currentHHMM) {
        if (isRecurring) {
          initialLastSentDate = todayStr;
        } else {
          specificDate = addDaysToDateStr(todayStr, 1);
        }
      } else if (!specificDate && !isRecurring && cleanTime > currentHHMM) {
        specificDate = todayStr;
      }

      const newItem = {
        id: Date.now().toString(36),
        target: targetStr,
        contactName,
        message: args.message,
        time: cleanTime,
        specificDate,
        recurring: isRecurring,
        useAI: Boolean(args.useAI),
        pauseUntil: null,
        nextRunExtraNote: null,
        recentGreetings: [],
        active: true,
        lastSentDate: initialLastSentDate,
      };
      schedules.push(newItem);
      saveSchedules();
      const startInfo =
        initialLastSentDate === todayStr
          ? `iniciando mañana a las ${cleanTime}`
          : specificDate
          ? `para el ${specificDate} a las ${cleanTime}`
          : `a las ${cleanTime}`;
      return `Recordatorio/Rutina programada exitosamente para '${newItem.contactName}' ${startInfo} (${
        newItem.recurring ? "todos los días" : "una sola vez"
      }).`;
    }
    case "pause_or_cancel_routine": {
      const rawFilter = String(args?.target || "").trim();
      const filter = rawFilter.toLowerCase();
      const resolved = rawFilter ? resolveContactTarget(rawFilter) : { ok: false };
      const resolvedJid = resolved.ok ? resolved.jid : null;
      const pauseUntil = args?.pauseUntil ? String(args.pauseUntil).trim() : null;
      const skipTodayOnly = Boolean(args?.skipTodayOnly);
      const { dateStr: todayStr } = getColombiaNowParts();

      let count = 0;
      const matchedNames = [];
      for (const s of schedules) {
        if (!s.active) continue;
        const sTarget = String(s.target || "").toLowerCase();
        const sName = String(s.contactName || "").toLowerCase();
        const matches =
          !filter ||
          sTarget.includes(filter) ||
          sName.includes(filter) ||
          (resolvedJid && (sTarget.includes(resolvedJid.split("@")[0]) || toWhatsAppJid(s.target) === resolvedJid));

        if (matches) {
          if (skipTodayOnly) {
            s.lastSentDate = todayStr;
          } else if (pauseUntil) {
            s.pauseUntil = pauseUntil;
          } else {
            s.active = false;
          }
          matchedNames.push(s.contactName || s.target);
          count++;
        }
      }
      saveSchedules();
      if (count === 0) {
        return `No encontré ninguna rutina activa que coincida con '${rawFilter || "ese contacto"}'.`;
      }
      if (skipTodayOnly) {
        return `Entendido, Señor Carlos. Hoy (${todayStr}) no se enviará la rutina programada para ${matchedNames.join(", ")}; mañana continuará normalmente.`;
      }
      return pauseUntil
        ? `Se pausó la rutina de ${matchedNames.join(", ")} hasta el ${pauseUntil}.`
        : `Se canceló definitivamente la rutina de ${matchedNames.join(", ")}.`;
    }
    case "add_note_to_next_routine": {
      const rawTarget = String(args?.target || "mamá").trim();
      const extraNote = String(args?.extraNote || "").trim();
      const filter = rawTarget.toLowerCase();
      const resolved = resolveContactTarget(rawTarget);
      const resolvedJid = resolved.ok ? resolved.jid : null;

      let matchedRoutine = null;
      for (const s of schedules) {
        if (!s.active || s.parentEventId) continue;
        const sTarget = String(s.target || "").toLowerCase();
        const sName = String(s.contactName || "").toLowerCase();
        if (
          sTarget.includes(filter) ||
          sName.includes(filter) ||
          (resolvedJid && (sTarget.includes(resolvedJid.split("@")[0]) || toWhatsAppJid(s.target) === resolvedJid))
        ) {
          matchedRoutine = s;
          break;
        }
      }
      if (!matchedRoutine) {
        return `No encontré una rutina activa para '${rawTarget}' a la cual agregarle la nota.`;
      }
      matchedRoutine.nextRunExtraNote = extraNote;
      matchedRoutine.useAI = true;
      saveSchedules();
      return `¡Listo, Señor Carlos! En el próximo saludo de las ${matchedRoutine.time} para '${matchedRoutine.contactName}' incluiré de forma natural el encargo: "${extraNote}" (y se borrará automáticamente después de enviarlo).`;
    }
    case "save_contact_or_relationship": {
      const rel = String(args?.relationshipOrAlias || "")
        .toLowerCase()
        .replace(/^(mi|el|la)\s+/i, "")
        .trim();
      const cName = String(args?.contactName || "").trim();
      const cleanNameKey = cName.toLowerCase();
      const phone = String(args?.phoneNumber || "").replace(/\D/g, "");

      if (phone.length >= 10) {
        const formattedPhone = phone.length === 10 && phone.startsWith("3") ? `57${phone}` : phone;
        cloudState.learnedContacts[cleanNameKey] = `${formattedPhone}@s.whatsapp.net`;
      }

      if (rel) {
        if (!cloudState.relationships) cloudState.relationships = {};
        const existing = cloudState.relationships[rel];
        const arr = Array.isArray(existing) ? existing : existing ? [existing] : [];
        if (!arr.map((x) => x.toLowerCase()).includes(cleanNameKey)) {
          arr.push(cName);
        }
        cloudState.relationships[rel] = arr;
      }
      saveCloudState();
      const foundJid = cloudState.learnedContacts[cleanNameKey];
      return `Aprendido permanentemente en MongoDB: ${rel ? `'${rel}' corresponde a '${cName}'` : `'${cName}'`}${
        foundJid ? ` (chat vinculado: ${foundJid})` : " (cuando me indique su número o le escriba, vincularé también su chat)"
      }.`;
    }
    case "get_chat_history": {
      const queryTarget = String(args?.contactOrGroup || "").trim();
      const limit = Math.min(Math.max(Number(args?.limit) || 15, 3), 40);
      let filtered = [...inboxMessages];

      if (queryTarget) {
        const lowerQ = queryTarget.toLowerCase();
        const resolved = resolveContactTarget(queryTarget);
        const resolvedJid = resolved.ok ? resolved.jid : null;
        filtered = filtered.filter((m) => {
          const mFrom = String(m.from || "").toLowerCase();
          const mJid = String(m.jid || "").toLowerCase();
          return (
            mFrom.includes(lowerQ) ||
            mJid.includes(lowerQ) ||
            (resolvedJid && mJid.includes(resolvedJid.split("@")[0]))
          );
        });
      }

      const recentSlice = filtered.slice(-limit);
      if (recentSlice.length === 0) {
        return queryTarget
          ? `No tengo mensajes recientes registrados de '${queryTarget}' en mi historial.`
          : "No hay mensajes recientes registrados en el historial.";
      }
      const lines = recentSlice.map(
        (m) => `[${m.dateStr || ""} ${m.time || ""}] ${m.from}: "${m.body}"`
      );
      return `Historial de mensajes recientes${queryTarget ? ` de '${queryTarget}'` : ""} (${recentSlice.length}):\n` + lines.join("\n");
    }
    case "delegate_conversation": {
      const resolved = await resolveContactTargetAsync(args.target);
      if (!resolved.ok) return resolved.error;
      const initialMsg = String(args.initialMessage || "").trim();
      const objective = String(args.objective || "").trim();

      await safeSendMessage(resolved.jid, { text: initialMsg });
      activeDelegatedChats.set(resolved.jid, {
        jid: resolved.jid,
        contactName: resolved.canonicalName || args.target,
        objective,
        history: [{ role: "lila", text: initialMsg }],
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hora de escucha activa
        turns: 0,
      });
      return `Conversación delegada iniciada con '${resolved.canonicalName}'. Ya le envié: "${initialMsg}" y quedo atenta a su respuesta para atenderla e informarle en el grupo LILA.`;
    }
    case "set_busy_mode": {
      const isActive = Boolean(args?.active);
      const reason = String(args?.reason || "ocupado en este momento").trim();
      const durationMins = Number(args?.durationMinutes) || 0;
      cloudState.busyMode = {
        active: isActive,
        reason,
        untilTimestamp: isActive && durationMins > 0 ? Date.now() + durationMins * 60 * 1000 : null,
      };
      busyAutoRepliedAt.clear();
      saveCloudState();
      if (!isActive) {
        return "Modo Ocupado desactivado, Señor Carlos. Ya no responderé automáticamente en sus chats privados.";
      }
      const durText = durationMins > 0 ? ` durante ${durationMins} minutos` : "";
      return `Modo Ocupado activado (${reason}${durText}). Atenderé únicamente chats privados (con espera de 35s, prioridad Familia VIP, pausa automática si usted chatea y cero spam en grupos).`;
    }
    case "search_web_live": {
      return await searchWebLive(String(args?.query || ""));
    }
    case "send_whatsapp_message": {
      const resolved = await resolveContactTargetAsync(args.target);
      if (!resolved.ok) return resolved.error;
      await safeSendMessage(resolved.jid, { text: String(args.message) });
      return `Mensaje enviado exitosamente a '${resolved.canonicalName}': "${args.message}"`;
    }
    default:
      return `Herramienta ${name} no reconocida.`;
  }
}

// --- LLAMADA A GEMINI CON FUNCTION CALLING MULTIPASO Y AVISOS INTERMEDIOS ---
async function callGeminiWithFallback(
  systemPrompt,
  geminiContents,
  enableTools = false,
  onProgress = null,
  userPromptText = ""
) {
  if (!GEMINI_API_KEY) return { ok: false, error: "Sin GEMINI_API_KEY" };
  const modelsToTry = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
  let lastError = "";

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      let currentContents = [...geminiContents];
      const calledTools = new Set();
      let lastToolResultsSummary = "";

      for (let step = 0; step < 5; step++) {
        const payload = {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: currentContents,
        };
        if (enableTools) {
          payload.tools = [{ functionDeclarations: CLOUD_TOOLS_DECLARATIONS }];
        }

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errBody = await res.text();
          lastError = `Gemini (${modelName}) HTTP ${res.status}: ${errBody.slice(0, 100)}`;
          if (res.status === 503 || res.status === 429) await sleep(1200);
          break;
        }

        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const stepText = parts.map((p) => p.text || "").join("\n").trim();
        const fnCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

        if (fnCalls.length > 0) {
          // Si LILA emite un mensaje intermedio ("Ahora, déjeme revisar su correo...") mientras ejecuta otra herramienta, enviarlo en vivo
          if (stepText && onProgress) {
            try {
              await onProgress(stepText);
            } catch (_) {}
          }

          const toolResponseParts = [];
          for (const fc of fnCalls) {
            calledTools.add(fc.name);
            const toolResult = await executeCloudToolCall(fc.name, fc.args || {});
            toolResponseParts.push({
              functionResponse: { name: fc.name, response: { result: toolResult } },
            });
          }
          lastToolResultsSummary = toolResponseParts.map((tr) => tr.functionResponse.response.result).join("\n");

          currentContents = [
            ...currentContents,
            { role: "model", parts },
            { role: "user", parts: toolResponseParts },
          ];
          continue;
        }

        // Si el modelo prometió revisar el correo/agenda/clima en texto ("Ahora, déjeme revisar...") pero olvidó adjuntar el functionCall
        const combinedContext = `${userPromptText} ${stepText}`.toLowerCase();
        const promisedFollowUp =
          /d[eé]jeme revisar|voy a revisar|ahora revisar[eé]|procedo a revisar|consultando su|revisando su|un momento mientras/i.test(
            stepText
          );

        if (
          enableTools &&
          promisedFollowUp &&
          /correo|gmail|bandeja|email/i.test(combinedContext) &&
          !calledTools.has("check_gmail")
        ) {
          if (stepText && onProgress) {
            try {
              await onProgress(stepText);
            } catch (_) {}
          }
          calledTools.add("check_gmail");
          const gmailResult = await executeCloudToolCall("check_gmail", {
            query: "is:unread newer_than:2d",
            account: "All",
          });
          lastToolResultsSummary = gmailResult;
          currentContents = [
            ...currentContents,
            { role: "model", parts: [{ text: stepText }] },
            {
              role: "user",
              parts: [
                {
                  text: `[SISTEMA: Resultado real de check_gmail ejecutado inmediatamente]:\n${gmailResult}\n\nEntrega ahora mismo el informe detallado de los correos al Señor Carlos.`,
                },
              ],
            },
          ];
          continue;
        }

        if (
          enableTools &&
          promisedFollowUp &&
          /pendiente|agenda|tarea|compromiso/i.test(combinedContext) &&
          !calledTools.has("get_pending_tasks")
        ) {
          if (stepText && onProgress) {
            try {
              await onProgress(stepText);
            } catch (_) {}
          }
          calledTools.add("get_pending_tasks");
          const tasksResult = await executeCloudToolCall("get_pending_tasks", {});
          lastToolResultsSummary = tasksResult;
          currentContents = [
            ...currentContents,
            { role: "model", parts: [{ text: stepText }] },
            {
              role: "user",
              parts: [
                {
                  text: `[SISTEMA: Resultado real de get_pending_tasks ejecutado inmediatamente]:\n${tasksResult}\n\nEntrega ahora mismo el informe de tareas pendientes al Señor Carlos.`,
                },
              ],
            },
          ];
          continue;
        }

        // Guardia anti-alucinación: si la IA afirma haber enviado/respondido un correo sin haber llamado a send_or_reply_gmail
        const claimedEmailSent =
          /he respondido al correo|he enviado el correo|correo.*ha sido enviado|respond[ií] al correo/i.test(stepText);
        if (enableTools && claimedEmailSent && !calledTools.has("send_or_reply_gmail")) {
          currentContents = [
            ...currentContents,
            { role: "model", parts: [{ text: stepText }] },
            {
              role: "user",
              parts: [
                {
                  text: `[SISTEMA: Aún NO has ejecutado la herramienta 'send_or_reply_gmail'. Invoca 'send_or_reply_gmail' AHORA MISMO con el cuerpo del mensaje para que el correo se envíe realmente antes de confirmar al Señor Carlos.]`,
                },
              ],
            },
          ];
          continue;
        }

        // Guardia anti-alucinación: si la IA promete recordar/avisar a una hora específica sin haber llamado a schedule_whatsapp_message ni add_agenda_event
        const claimedReminderSet =
          /(le recordar[eé]|te recordar[eé]|le avisar[eé]|queda programad[oa]|he programado|recordatorio.*programado|rutina.*programada)/i.test(
            stepText
          ) && /\b\d{1,2}(:\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?|de la|hrs|horas)?\b/i.test(`${userPromptText} ${stepText}`);
        if (
          enableTools &&
          claimedReminderSet &&
          !calledTools.has("schedule_whatsapp_message") &&
          !calledTools.has("add_agenda_event")
        ) {
          currentContents = [
            ...currentContents,
            { role: "model", parts: [{ text: stepText }] },
            {
              role: "user",
              parts: [
                {
                  text: `[SISTEMA: Prometiste un recordatorio o rutina pero aún NO has ejecutado la herramienta 'schedule_whatsapp_message'. Invoca 'schedule_whatsapp_message' AHORA MISMO (con target='lila_group' si el recordatorio es para el Señor Carlos, y time en formato 24h 'HH:MM') para que quede guardado realmente en la base de datos.]`,
                },
              ],
            },
          ];
          continue;
        }

        if (stepText) return { ok: true, text: stepText };
        if (lastToolResultsSummary) return { ok: true, text: lastToolResultsSummary };
        break;
      }

      if (lastToolResultsSummary) {
        return { ok: true, text: lastToolResultsSummary };
      }
    } catch (e) {
      lastError = `Gemini (${modelName}) Error: ${e.message}`;
    }
  }
  return { ok: false, error: lastError };
}

// --- MAPAS DE ESTADO EN MEMORIA PARA MODO OCUPADO INTELIGENTE Y CONVERSACIONES DELEGADAS ---
const activeDelegatedChats = new Map();
const busyAutoRepliedAt = new Map();
const lastOwnerManualMessageByJid = new Map();
const busyPendingTimers = new Map();

// --- BÚSQUEDA WEB EN TIEMPO REAL (Gemini Google Search Grounding + Respaldo Wikipedia/DDG) ---
async function searchWebLive(query) {
  const cleanQ = String(query || "").trim();
  if (!cleanQ) return "No se proporcionó consulta de búsqueda.";

  if (GEMINI_API_KEY) {
    const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
    for (const modelName of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `Busca en internet información actualizada y verificada en español sobre: "${cleanQ}". Resume los datos clave con fechas, cifras o hechos exactos.`,
                  },
                ],
              },
            ],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const parts = data?.candidates?.[0]?.content?.parts || [];
          const text = parts
            .filter((p) => p.text)
            .map((p) => p.text)
            .join("\n")
            .trim();
          if (text) return text;
        }
      } catch (_) {}
    }
  }

  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQ)}&format=json&no_html=1&kl=co-es`;
    const ddgRes = await fetch(ddgUrl);
    if (ddgRes.ok) {
      const ddg = await ddgRes.json();
      if (ddg?.AbstractText) return `${ddg.AbstractText} (Fuente: ${ddg.AbstractSource || "Web"})`;
    }
  } catch (_) {}

  try {
    const wikiSearchUrl = `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      cleanQ
    )}&utf8=&format=json&origin=*`;
    const wsRes = await fetch(wikiSearchUrl);
    if (wsRes.ok) {
      const wsData = await wsRes.json();
      const firstTitle = wsData?.query?.search?.[0]?.title;
      if (firstTitle) {
        const sumRes = await fetch(
          `https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstTitle)}`
        );
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          if (sumData?.extract) return `${sumData.extract} (Fuente: Wikipedia - ${firstTitle})`;
        }
      }
    }
  } catch (_) {}

  return `Consulta procesada para "${cleanQ}". Responde utilizando tu conocimiento general actualizado.`;
}

// --- CEREBRO CONVERSACIONAL DE LILA EN LA NUBE ---
async function askLilaCloudAI(userPrompt, jid = "default", allowTools = true, onProgress = null) {
  const { dateStr, timeStr, readable } = getColombiaNowParts();
  const locStr = cloudState.currentLocation?.placeName
    ? `Ubicación conocida del Señor Carlos: ${cloudState.currentLocation.placeName}.`
    : "Ciudades habituales del Señor Carlos: Riohacha y Hatonuevo (La Guajira, Colombia).";

  const isEmailRelated = /\b(correo|correos|gmail|email|bandeja|responde|resp[oó]ndele|remitente|asunto)\b/i.test(
    String(userPrompt || "")
  );
  const lastMailInfo =
    isEmailRelated && cloudState.lastEmailContext
      ? `\n12. CONTEXTO DEL ÚLTIMO CORREO LEÍDO (solo si pide responder correo con send_or_reply_gmail): De: ${cloudState.lastEmailContext.from} | Correo exacto: ${cloudState.lastEmailContext.emailAddress || cloudState.lastEmailContext.from} | Asunto: "${cloudState.lastEmailContext.subject}" | Bandeja: ${cloudState.lastEmailContext.account}.`
      : "";

  const ownerUniEmail = cloudState.ownerUniEmail || "curianae@uniguajira.edu.co";
  const ownerPersonalEmail = cloudState.ownerPersonalEmail || "carlosuriana2007@gmail.com";
  const inExternalDirectChat =
    jid &&
    (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) &&
    (!OWNER_PHONE || !jid.includes(OWNER_PHONE));
  const chatContextHint = inExternalDirectChat
    ? `\nNOTA DE CONTEXTO DE CHAT ACTIVO: En este momento el Señor Carlos te está invocando DENTRO del chat directo (${jid}) con otra persona. Si te dice 'salúdala', 'saluda a mi hermana', 'Perla', 'explícale' o 'dile que...', tu respuesta de texto se enviará directamente en este mismo chat para que esa persona la lea; NO llames a send_whatsapp_message pidiendo su número porque YA estás dentro de su chat.`
    : "";

  const activeRoutinesList = schedules
    .filter((s) => s.active && !s.parentEventId)
    .map(
      (s) =>
        `[ID:${s.id} | Para: ${s.contactName || s.target} | Hora: ${s.time} | Diario:${Boolean(s.recurring)}${
          s.lastSentDate === dateStr ? " | Omitida/Enviada hoy" : ""
        }${s.nextRunExtraNote ? ` | Nota extra pendiente: "${s.nextRunExtraNote}"` : ""}]`
    )
    .join("; ");
  const routinesInfo = activeRoutinesList
    ? `\n10. RUTINAS ACTIVAS EN TU MEMORIA: ${activeRoutinesList}. Si el Señor Carlos dice 'no le escribas hoy a mi mamá' o 'cancela por hoy el saludo de mi mamá', invoca INMEDIATAMENTE \`pause_or_cancel_routine\` con \`target: 'mamá'\` y \`skipTodayOnly: true\` (sin hacer preguntas). Si dice 'mañana cuando le escribas a mi mamá recuérdale...' o 'agrégale al saludo de mi mamá...', invoca INMEDIATAMENTE \`add_note_to_next_routine\` con \`target: 'mamá'\` y el encargo en \`extraNote\`.`
    : "";

  const relPairs = Object.entries(cloudState.relationships || {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join(" | ");
  const busyStatusStr = cloudState.busyMode?.active
    ? `ACTIVO (Motivo: "${cloudState.busyMode.reason}")`
    : "INACTIVO";

  const systemPrompt =
    "Eres LILA, el asistente personal de inteligencia artificial creado y desarrollado exclusivamente por el Señor Carlos (estudiante de Ingeniería de Sistemas).\n" +
    "=== REGLAS DE IDENTIDAD Y ACCIÓN INQUEBRANTABLES ===\n" +
    "1. Tu único nombre es LILA. NUNCA digas 'LILA 2.0', NUNCA menciones a 'J.A.R.V.I.S.' y NUNCA digas que fuiste creada por Google. Tu creador es el Señor Carlos.\n" +
    "2. Dirígete siempre al usuario como 'Señor' o 'Señor Carlos', manteniendo siempre ortografía impecable en español (tildes y signos ¿? ¡! completos).\n" +
    "3. CONSCIENCIA HÍBRIDA (NUBE Y ESCRITORIO): Sabes que existes en dos nodos coordinados: LILA Cloud (este nodo en la nube 24/7 en WhatsApp y Telegram) y LILA Desk (el nodo en el portátil del Señor Carlos). Ambos comparten la misma agenda y contactos en tiempo real.\n" +
    "4. TAREAS Y RECORDATORIOS INMEDIATOS: Si el Señor Carlos pide que le recuerdes algo hoy o a cierta hora (ej. 'recuérdame ir al gym a las 3 pm'), invoca SIEMPRE `schedule_whatsapp_message` con `target: 'lila_group'`, `time` en formato 24h ('15:00') y `recurring: false`. Si dice que tiene una entrega o examen para cierto día, agenda con `add_agenda_event`. NUNCA digas que vas a recordarle algo sin haber invocado `schedule_whatsapp_message` o `add_agenda_event`.\n" +
    `5. CORREOS GMAIL PROPIOS DEL SEÑOR CARLOS: Su correo Personal es '${ownerPersonalEmail}' y su correo Institucional/Uniguajira es '${ownerUniEmail}'. Si pide enviar un correo 'a mi institucional' o 'a mi cuenta de la universidad', el destinatario 'to' es SIEMPRE '${ownerUniEmail}' (jamás uses correos de terceros como comunicaciones@uniguajira.edu.co). Si pide enviar 'a mi correo personal', el destinatario 'to' es '${ownerPersonalEmail}'.\n` +
    "6. ÓRDENES MÚLTIPLES Y GRUPOS DE WHATSAPP: Si el Señor Carlos pide dos o más cosas en un mismo mensaje, invoca TODAS las herramientas necesarias. Si te pide escribir o presentarte en OTRO grupo o contacto de WhatsApp (ej. 'escríbele en el grupo Cuarto gamer' o 'mándale un mensaje a mi mamá'), invoca `send_whatsapp_message` con el nombre en `target`.\n" +
    `7. FAMILIA Y VÍNCULOS APRENDIDOS (${relPairs}): Mamá es Paula (él le dice 'Pechy', saludo natural sin cursilerías). Tiene dos hermanas: Nelly y Perla. Si el Señor Carlos te enseña un vínculo nuevo (ej. 'mi prima es Vero' o 'el número de Vero es...'), invoca \`save_contact_or_relationship\` para aprenderlo permanentemente.\n` +
    "8. MEMORIA DE CHATS, DELEGACIÓN Y MODO OCUPADO: Si el Señor Carlos pregunta qué le dijo alguien ('¿qué me dijo mi mamá?', '¿de qué hablaron en el grupo?'), invoca `get_chat_history`. Si te pide hablar con alguien para averiguar algo ('pregúntale a mi mamá qué hará de almuerzo y me avisas'), invoca `delegate_conversation`. Si dice que va a estar ocupado, durmiendo, en clase o en el gym ('activa modo ocupado porque estoy en clase'), invoca `set_busy_mode`. Estado actual del Modo Ocupado: " +
    busyStatusStr +
    ".\n" +
    "9. BÚSQUEDA WEB EN TIEMPO REAL Y CONOCIMIENTO EXPERTA: Posees la herramienta `search_web_live` para buscar información en tiempo real en internet (noticias, precios, clima, resultados) y conocimiento experto sobre cualquier plataforma o software (como Animaker, Canva, programación, etc.). JAMÁS digas que tus capacidades están limitadas a los correos.\n" +
    `11. FECHA Y HORA ACTUAL: Hoy es ${readable} (${dateStr}), hora actual en Colombia: ${timeStr}. ${locStr}${routinesInfo}${chatContextHint}${lastMailInfo}`;

  const history = chatHistoryByJid.get(jid) || [];
  const geminiContents = [
    ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: userPrompt }] },
  ];

  const gemRes = await callGeminiWithFallback(systemPrompt, geminiContents, allowTools, onProgress, userPrompt);
  if (gemRes.ok && gemRes.text) {
    if (jid !== "routine") {
      history.push({ role: "user", text: userPrompt });
      history.push({ role: "assistant", text: gemRes.text });
      if (history.length > 14) history.splice(0, history.length - 14);
      chatHistoryByJid.set(jid, history);
    }
    return gemRes.text;
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: groqMessages, max_tokens: 450 }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch (_) {}
  }

  return `Señor Carlos, el nodo en la nube está activo pero los proveedores de IA devolvieron error temporal (${gemRes.error || "sin respuesta"}).`;
}

// --- MODO INVITADO SEGURO (CERO HERRAMIENTAS PRIVADAS + LÍMITE DE 4 MSJS/HORA) ---
const guestRateLimitMap = new Map();
const GUEST_MAX_MSGS_PER_HOUR = 4;

function checkGuestRateLimit(senderKey) {
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;
  let record = guestRateLimitMap.get(senderKey);
  if (!record || now - record.windowStart > oneHourMs) {
    record = { count: 1, windowStart: now };
    guestRateLimitMap.set(senderKey, record);
    return { allowed: true, count: 1 };
  }
  record.count += 1;
  guestRateLimitMap.set(senderKey, record);
  if (record.count <= GUEST_MAX_MSGS_PER_HOUR) {
    return { allowed: true, count: record.count };
  }
  return {
    allowed: false,
    limitJustReached: record.count === GUEST_MAX_MSGS_PER_HOUR + 1,
    count: record.count,
  };
}

async function askLilaGuestAI(guestQuery, guestName = "Invitado", jid = "guest") {
  const { dateStr, timeStr, readable } = getColombiaNowParts();
  const guestPrompt =
    "Eres LILA, el asistente personal de inteligencia artificial creado y desarrollado exclusivamente por el Señor Carlos (estudiante de Ingeniería de Sistemas).\n" +
    `Estás en MODO INVITADO conversando con '${guestName}' (un amigo o compañero del Señor Carlos en WhatsApp).\n` +
    "=== REGLAS INQUEBRANTABLES DE MODO INVITADO ===\n" +
    "1. Tu único nombre es LILA y tu único creador es el Señor Carlos. Nunca menciones a Google ni a J.A.R.V.I.S.\n" +
    `2. Dirígete a '${guestName}' por su nombre con amabilidad, carisma e inteligencia, con ortografía impecable en español y en MÁXIMO 3 líneas.\n` +
    "3. Puedes responder preguntas de estudio, cultura general, programación o seguir una conversación amistosa.\n" +
    "4. BLOQUEO TOTAL DE FUNCIONES PRIVADAS: Tienes estrictamente PROHIBIDO leer o enviar correos, enviar mensajes a otros chats, programar rutinas, modificar la agenda o revelar información privada del Señor Carlos. Si te piden hacer algo de eso, responde con elegancia que tus funciones privadas y de control solo obedecen órdenes directas de tu creador, el Señor Carlos.\n" +
    `5. Fecha y hora actual en Colombia: ${readable} (${dateStr}), ${timeStr}.`;

  const gemRes = await callGeminiWithFallback(
    guestPrompt,
    [{ role: "user", parts: [{ text: `[Mensaje de ${guestName}]: ${guestQuery}` }] }],
    false
  );
  if (gemRes.ok && gemRes.text) {
    return gemRes.text;
  }
  return `¡Hola, ${guestName}! Soy LILA, el asistente personal del Señor Carlos. En este momento estoy en modo de espera.`;
}

// --- GENERADOR CON ESTILO PERSONAL Y ANTI-REPETICIÓN PARA RUTINAS HACIA CONTACTOS ---
async function generateSafeRoutineMessage(target, instruction, extraNote = null, recentGreetings = []) {
  const { readable } = getColombiaNowParts();
  const targetLower = String(target || "").toLowerCase();
  const isMom =
    (MOM_PHONE_DIGITS && targetLower.includes(MOM_PHONE_DIGITS)) ||
    (MOM_LID_JID && targetLower.includes(MOM_LID_JID.split("@")[0])) ||
    ["mamá", "mama", "paula", "pechy", "madre"].some((k) => targetLower.includes(k));

  const fallbacksMom = [
    "Hola Pechy, buenos días, ¿cómo amaneciste hoy?",
    "Buenos días, Pechy. ¿Cómo amaneciste? Espero que tengas un muy buen día.",
    "Hola Pechy, ¿cómo amaneciste? Que te rinda mucho el día de hoy.",
    "¡Buenos días, Pechy! ¿Qué tal amaneciste hoy?",
    "Hola Pechy, buen día, ¿cómo amanecieron por allá?",
  ];
  const recentSet = new Set((recentGreetings || []).map((g) => String(g).trim()));
  const availableFallback =
    fallbacksMom.find((f) => !recentSet.has(f)) || fallbacksMom[Math.floor(Math.random() * fallbacksMom.length)];
  const baseFallback = isMom ? availableFallback : "Hola, buenos días, ¿cómo amaneciste?";
  const FALLBACK_GREETING = extraNote ? `${baseFallback} Por cierto, recuerda por favor: ${extraNote}.` : baseFallback;

  const styleRules = isMom
    ? "Redacta un mensaje de WhatsApp de parte de Carlos para su mamá Paula (a quien él llama 'Pechy'). Carlos le habla con cariño natural de hijo, sobrio, cálido y espontáneo (1 o 2 frases cortas). Jamás uses 'mi amor', 'tesoro' ni frases poéticas artificiales."
    : "Redacta un mensaje de WhatsApp en primera persona como Carlos. Tono natural, directo y sobrio (1 o 2 frases). Prohibido usar 'mi amor'.";

  const avoidStr =
    Array.isArray(recentGreetings) && recentGreetings.length > 0
      ? `\nPROHIBIDO REPETIR cualquiera de estos mensajes enviados en los días anteriores:\n- ${recentGreetings.join("\n- ")}\nUsa una estructura y palabras distintas hoy.`
      : "";

  const extraNoteStr = extraNote
    ? `\nENCARGO ESPECIAL PARA INCLUIR HOY DE FORMA NATURAL EN EL MISMO MENSAJE: Además de saludar, debes incluir con total naturalidad este encargo de Carlos: "${extraNote}" (por ejemplo: "...Por cierto, acuérdate de traerme el perfume cuando vengas").`
    : "";

  const sys = `${styleRules}\nHoy es ${readable}.${avoidStr}${extraNoteStr}\nOrtografía impecable en español con tildes y signos ¿? ¡! completos. Devuelve ÚNICAMENTE el texto final del mensaje listo para enviar, sin comillas ni explicaciones.`;
  const prompt = `Propósito del mensaje: ${instruction || "Saludo diario de buenos días variado y natural"}`;

  const gemRes = await callGeminiWithFallback(sys, [{ role: "user", parts: [{ text: prompt }] }], false);
  if (gemRes.ok && gemRes.text) {
    const candidate = gemRes.text.replace(/^["']|["']$/g, "").trim();
    if (candidate && !/error|señor carlos|nodo/i.test(candidate)) return candidate;
  }
  return FALLBACK_GREETING;
}

// --- GESTOR DE CONVERSACIONES DELEGADAS Y MODO OCUPADO INTELIGENTE (4 PROPUESTAS) ---
async function handleBusyModeAndDelegatedIncoming({ remoteJid, pushName, cleanText, isGroup }) {
  if (isGroup || !remoteJid) return;

  // 1. ¿Hay una conversación delegada activa con este contacto?
  const delegated = activeDelegatedChats.get(remoteJid);
  if (delegated && Date.now() - delegated.startedAt < 6 * 60 * 60 * 1000) {
    delegated.turns += 1;
    const notifyJid = getOwnerNotificationJid();
    const sys =
      "Eres LILA, el asistente personal del Señor Carlos. Estás conversando por WhatsApp con " +
      `'${delegated.contactName}' (${pushName}) para cumplir este encargo del Señor Carlos: "${delegated.objective}".\n` +
      "Analiza la respuesta que acaba de enviar la persona. Si ya respondió lo que el Señor Carlos quería saber (o si ya quedó claro), " +
      "responde un mensaje breve y amable de agradecimiento despidiéndote, e inicia tu respuesta interna con `[COMPLETADO]` seguido del mensaje para el contacto. " +
      "Si todavía falta hacerle una pregunta breve para concretar el encargo (máximo 2 turnos), inicia con `[CONTINUAR]` seguido del mensaje para el contacto.";
    const gemRes = await callGeminiWithFallback(
      sys,
      [
        {
          role: "user",
          parts: [
            {
              text: `Mensaje anterior enviado: "${delegated.lastMessageSent}"\nRespuesta recibida de ${pushName}: "${cleanText}"`,
            },
          ],
        },
      ],
      false
    );
    let rawReply = gemRes.ok && gemRes.text ? gemRes.text.trim() : "[COMPLETADO] ¡Muchas gracias! Ya le aviso a Carlos.";
    const isCompleted = rawReply.includes("[COMPLETADO]") || delegated.turns >= 2;
    const replyToContact = rawReply.replace(/\[(COMPLETADO|CONTINUAR)\]/gi, "").trim();

    if (replyToContact) {
      await safeSendMessage(remoteJid, { text: replyToContact });
      delegated.lastMessageSent = replyToContact;
    }

    const reportMsg = `🤝 *Reporte de Conversación Delegada (${delegated.contactName}):*\n• *Encargo:* ${delegated.objective}\n• *${pushName} respondió:* "${cleanText}"\n• *LILA contestó:* "${replyToContact}"`;
    if (notifyJid) await safeSendMessage(notifyJid, { text: reportMsg });
    if (cloudState.telegramChatId) await sendTelegramMessage(cloudState.telegramChatId, reportMsg);

    if (isCompleted) {
      activeDelegatedChats.delete(remoteJid);
    }
    return;
  }

  // 2. ¿Está activo el Modo Ocupado Inteligente?
  if (!cloudState.busyMode?.active) return;
  if (cloudState.busyMode.untilTimestamp && Date.now() > cloudState.busyMode.untilTimestamp) {
    cloudState.busyMode.active = false;
    cloudState.busyMode.untilTimestamp = null;
    saveCloudState();
    return;
  }

  // Propuesta 3: Pausa automática si el Señor Carlos ha escrito manualmente en este chat en los últimos 20 minutos
  const lastManual = lastOwnerManualMessageByJid.get(remoteJid) || 0;
  if (Date.now() - lastManual < 20 * 60 * 1000) {
    return;
  }

  // Propuesta 1: Espera prudente de 35 segundos agrupando ráfagas de mensajes
  let pending = busyPendingTimers.get(remoteJid);
  if (pending) {
    pending.texts.push(cleanText);
    return;
  }

  pending = {
    texts: [cleanText],
    pushName,
    timer: setTimeout(async () => {
      busyPendingTimers.delete(remoteJid);
      try {
        if (!cloudState.busyMode?.active) return;
        const manualNow = lastOwnerManualMessageByJid.get(remoteJid) || 0;
        if (Date.now() - manualNow < 20 * 60 * 1000) return;

        const combinedText = pending.texts.join(" / ");
        const isVipFamily = isFamilyVipJid(remoteJid, pushName);
        const lastAuto = busyAutoRepliedAt.get(remoteJid) || 0;
        const cooldownMs = isVipFamily ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;
        const isUrgent = /\b(urgente|emergencia|importante|ll[aá]mame|hospital|accidente|favor\s+grande|necesito\s+ya)\b/i.test(
          combinedText
        );

        const notifyJid = getOwnerNotificationJid();
        const reason = cloudState.busyMode.reason || "ocupado en una actividad";

        if (Date.now() - lastAuto >= cooldownMs || isUrgent) {
          busyAutoRepliedAt.set(remoteJid, Date.now());
          const replyText = isVipFamily
            ? `🤖 *LILA:* ¡Hola, ${pushName}! En este momento Carlos está ${reason}. Ya mismo le pasé tu mensaje con prioridad para que te responda apenas se desocupe. Si necesitas algo urgente, escríbeme por aquí y le mando una alerta inmediata.`
            : `🤖 *LILA:* Hola, ${pushName}. Soy LILA, el asistente del Señor Carlos. En este momento él se encuentra ${reason} y no puede mirar el celular. Ya le dejé tu mensaje anotado; si es una urgencia, indícamelo y le enviaré una alerta prioritaria.`;
          await safeSendMessage(remoteJid, { text: replyText });
        }

        // Propuestas 2 y 4: Notificación silenciosa al grupo LILA y Telegram con clasificación VIP / Urgencia
        const alertHeader = isUrgent
          ? `🚨 *URGENCIA EN MODO OCUPADO (${pushName}):*`
          : isVipFamily
          ? `❤️ *Mensaje VIP de Familia en Modo Ocupado (${pushName}):*`
          : `📌 *Recado en Modo Ocupado (${pushName}):*`;
        const summaryAlert = `${alertHeader}\n"${combinedText}"`;
        if (notifyJid) await safeSendMessage(notifyJid, { text: summaryAlert });
        if (cloudState.telegramChatId) await sendTelegramMessage(cloudState.telegramChatId, summaryAlert);
      } catch (err) {
        console.error("[LILA] Error en temporizador de Modo Ocupado:", err.message);
      }
    }, 35000),
  };
  busyPendingTimers.set(remoteJid, pending);
}

// --- INICIALIZACIÓN DE WHATSAPP (Baileys) - NUNCA BORRA SESIONES SIGNAL ---
let reconnectTimer = null;

async function startWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
    } catch (_) {}
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const origKeysSet = state.keys.set.bind(state.keys);
  state.keys.set = async (data) => {
    await origKeysSet(data);
    scheduleSyncAuthToMongo(1500);
  };
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    logger: silentLogger,
    printQRInTerminal: true,
    browser: ["LILA Cloud", "Chrome", "2.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    msgRetryCounterCache,
    getMessage: async (key) => {
      if (!key?.id) return undefined;
      if (key.remoteJid && sentMessagesCache.has(`${key.remoteJid}:${key.id}`)) {
        return sentMessagesCache.get(`${key.remoteJid}:${key.id}`);
      }
      if (sentMessagesCache.has(key.id)) {
        return sentMessagesCache.get(key.id);
      }
      return undefined;
    },
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    scheduleSyncAuthToMongo(500);
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionStatus = "qr_ready";
      latestQrDataUrl = await QRCode.toDataURL(qr);
      console.log("[LILA] Código QR listo en /qr.");
    }
    if (connection === "open") {
      connectionStatus = "connected";
      latestQrDataUrl = null;
      connectedNumber = sock.user?.id?.split(":")[0] || "Conectado";
      console.log(`[LILA] ✅ WhatsApp conectado 24/7 (+${connectedNumber})`);
      scheduleSyncAuthToMongo(500);
      setTimeout(() => {
        syncWhatsAppGroups().catch(() => {});
      }, 2500);
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      console.log(`[LILA] Desconectado (${statusCode}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        scheduleSyncAuthToMongo(500);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          startWhatsApp().catch((err) => console.error("Error reconectando WhatsApp:", err.message));
        }, 3500);
      } else {
        if (fs.existsSync(AUTH_FOLDER)) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        await clearAuthFromMongo();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          startWhatsApp().catch((err) => console.error("Error reiniciando WhatsApp:", err.message));
        }, 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      for (const msg of messages) {
        if (msg?.message) rememberMessage(msg, false);
      }
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.message) continue;
        const msgId = msg.key?.id || "";
        const remoteJid = msg.key?.remoteJid || "";
        if (remoteJid === "status@broadcast") continue;

        // 1. FILTRO DE EDAD DEL MENSAJE (Evita que al reconectar o sincronizar WhatsApp Web responda comandos de hace 1 hora)
        const rawTs = msg.messageTimestamp;
        const msgEpochSec =
          typeof rawTs === "number"
            ? rawTs
            : typeof rawTs?.toNumber === "function"
            ? rawTs.toNumber()
            : Number(rawTs) || 0;
        const nowEpochSec = Math.floor(Date.now() / 1000);
        const msgAgeSeconds = msgEpochSec > 0 ? nowEpochSec - msgEpochSec : 0;

        const participantJid = msg.key.participant || "";
        const isGroup = remoteJid.endsWith("@g.us");
        const isOwnerOrSelf =
          Boolean(msg.key.fromMe) ||
          Boolean(OWNER_PHONE && participantJid.includes(OWNER_PHONE)) ||
          Boolean(connectedNumber && participantJid.includes(connectedNumber)) ||
          (!isGroup &&
            ((OWNER_PHONE && remoteJid.includes(OWNER_PHONE)) ||
              (connectedNumber && remoteJid.includes(connectedNumber)) ||
              remoteJid.endsWith("@lid")));

        const innerMsg = msg.message.deviceSentMessage?.message || msg.message;
        const text =
          innerMsg.conversation ||
          innerMsg.extendedTextMessage?.text ||
          innerMsg.imageMessage?.caption ||
          "";
        if (!text) continue;

        const pushName = msg.pushName || (participantJid ? participantJid.split("@")[0] : remoteJid.split("@")[0]);
        const { dateStr: todayDateStr, timeStr: nowCol } = getColombiaNowParts();

        if (
          !msg.key.fromMe &&
          pushName &&
          (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid"))
        ) {
          const cleanPush = pushName.toLowerCase().trim();
          if (cleanPush && cleanPush !== "hermana" && !/^\d+$/.test(cleanPush)) {
            if (cloudState.learnedContacts[cleanPush] !== remoteJid) {
              cloudState.learnedContacts[cleanPush] = remoteJid;
              saveCloudState();
            }
          }
        }

        const cleanText = text.trim();
        if (cleanText.startsWith("🤖 *LILA:*") || cleanText.startsWith("⏰ *Recordatorio LILA:*")) continue;

        // Si el Señor Carlos escribe manualmente en un chat, activamos la Pausa Automática de 20 min del Modo Ocupado en ese chat
        if (msg.key.fromMe) {
          lastOwnerManualMessageByJid.set(remoteJid, Date.now());
          const pendingTimer = busyPendingTimers.get(remoteJid);
          if (pendingTimer) {
            clearTimeout(pendingTimer.timer);
            busyPendingTimers.delete(remoteJid);
          }
        }

        // Guardar en memoria y en chat_logs de MongoDB (solo textos livianos) para que LILA recuerde qué dijo Mamá o cualquier contacto
        if (!msg.key.fromMe && msgAgeSeconds <= 120) {
          const logEntry = {
            from: pushName,
            jid: remoteJid,
            body: cleanText,
            dateStr: todayDateStr,
            time: nowCol,
            timestamp: Date.now(),
          };
          inboxMessages.push(logEntry);
          if (inboxMessages.length > 150) inboxMessages.shift();
          if (isMongoConnected && mongoDb) {
            mongoDb
              .collection("chat_logs")
              .insertOne(logEntry)
              .catch(() => {});
          }
        }

        const isCommandForLila = /^lila(?:[,:\s]+([\s\S]*))?$/i.test(cleanText);
        if (!isCommandForLila) {
          if (!msg.key.fromMe && msgAgeSeconds <= 90) {
            await handleBusyModeAndDelegatedIncoming({ remoteJid, pushName, cleanText, isGroup });
          }
          continue;
        }

        // 2. BLOQUEO ESTRICTO DE COMANDOS REPETIDOS O HISTÓRICOS (> 90 segundos)
        if (hasProcessedCommand(msgId)) {
          continue;
        }
        if (msgAgeSeconds > 90) {
          markCommandProcessed(msgId);
          console.log(`[LILA] ⏭️ Ignorando comando antiguo sincronizado (${msgAgeSeconds}s): "${cleanText.slice(0, 40)}"`);
          continue;
        }
        markCommandProcessed(msgId);

        const rawQuery = cleanText.replace(/^lila[,:\s]*/i, "").trim();

        // --- NIVEL 1: MODO CREADOR (SOLO SEÑOR CARLOS) ---
        if (isOwnerOrSelf) {
          if (isGroup && !cloudState.lilaNotificationGroupJid) {
            syncWhatsAppGroups().catch(() => {});
          }

          // Aprendizaje contextual: si el Señor Carlos está dentro del chat 1-a-1 de su hermana y responde "Lila, Perla" o "Lila, Nelly"
          if (!isGroup && (remoteJid.endsWith("@lid") || remoteJid.endsWith("@s.whatsapp.net"))) {
            if (/^(saluda\s+a\s+)?perla[!.]?$/i.test(rawQuery) && !cloudState.learnedContacts["perla"]) {
              cloudState.learnedContacts["perla"] = remoteJid;
              saveCloudState();
            } else if (/^(saluda\s+a\s+)?nelly[!.]?$/i.test(rawQuery) && !cloudState.learnedContacts["nelly"]) {
              cloudState.learnedContacts["nelly"] = remoteJid;
              saveCloudState();
            }
          }

          // Interruptor de voz/texto para prender o apagar el Modo Invitado
          if (/(apaga|desactiva|silencia|bloquea).*(modo\s+invitado|invitados|amigos|grupo)/i.test(rawQuery)) {
            cloudState.guestModeEnabled = false;
            saveCloudState();
            await safeSendMessage(
              remoteJid,
              {
                text: "🤖 *LILA:* Modo invitado *desactivado*, Señor Carlos. A partir de este momento ignoraré a terceros y solo atenderé sus órdenes.",
              },
              { quoted: msg }
            );
            continue;
          }
          if (/(activa|prende|enciende|habilita).*(modo\s+invitado|invitados|amigos|grupo)/i.test(rawQuery)) {
            cloudState.guestModeEnabled = true;
            saveCloudState();
            await safeSendMessage(
              remoteJid,
              {
                text: `🤖 *LILA:* Modo invitado *activado*, Señor Carlos. Responderé a sus amigos cuando me llamen (máximo ${GUEST_MAX_MSGS_PER_HOUR} mensajes por hora y sin acceso a ninguna función privada).`,
              },
              { quoted: msg }
            );
            continue;
          }

          const query = rawQuery || "Hola Lila, ¿estás activa?";
          const historyKey = remoteJid || "owner_self";
          const sendIntermediate = async (partialText) => {
            if (partialText && partialText.trim()) {
              await safeSendMessage(remoteJid, { text: `🤖 *LILA:* ${partialText.trim()}` }, { quoted: msg });
            }
          };
          const reply = await askLilaCloudAI(query, historyKey, true, sendIntermediate);
          if (reply && reply.trim()) {
            await safeSendMessage(remoteJid, { text: `🤖 *LILA:* ${reply.trim()}` }, { quoted: msg });
          }
          continue;
        }

        // --- NIVEL 2: MODO INVITADO / AMIGOS EN GRUPOS (EJ. EIMAR) ---
        if (!cloudState.guestModeEnabled) continue;

        const senderKey = participantJid || remoteJid;
        const rateCheck = checkGuestRateLimit(senderKey);
        if (!rateCheck.allowed) {
          if (rateCheck.limitJustReached) {
            await safeSendMessage(
              remoteJid,
              {
                text: `🤖 *LILA:* Hola ${pushName}, he alcanzado mi límite de ${GUEST_MAX_MSGS_PER_HOUR} respuestas por hora en modo invitado para conservar energía. Por ahora quedo atenta únicamente a mi creador, el Señor Carlos.`,
              },
              { quoted: msg }
            );
          }
          continue;
        }

        const guestQuery = rawQuery || `Hola Lila, soy ${pushName}, preséntate brevemente.`;
        const guestReply = await askLilaGuestAI(guestQuery, pushName, senderKey);
        if (guestReply && guestReply.trim()) {
          await safeSendMessage(remoteJid, { text: `🤖 *LILA:* ${guestReply.trim()}` }, { quoted: msg });
        }
      }
    } catch (err) {
      console.error("[LILA] Error controlado en messages.upsert:", err.message);
    }
  });
}

function requireAuth(req, res, next) {
  const token =
    req.headers["x-lila-key"] ||
    req.query.key ||
    (req.headers.authorization || "").replace("Bearer ", "");
  if (LILA_SECRET_KEY && token !== LILA_SECRET_KEY) {
    return res.status(401).json({ error: "No autorizado." });
  }
  next();
}

function isTimeWithinMinutesWindow(targetHHMM, currentHHMM, maxWindowMinutes = 30) {
  const [th, tm] = String(targetHHMM || "00:00").split(":").map(Number);
  const [ch, cm] = String(currentHHMM || "00:00").split(":").map(Number);
  if (Number.isNaN(th) || Number.isNaN(tm) || Number.isNaN(ch) || Number.isNaN(cm)) return false;
  const targetMins = th * 60 + tm;
  const currentMins = ch * 60 + cm;
  return currentMins >= targetMins && currentMins - targetMins <= maxWindowMinutes;
}

// --- EVALUADOR DE RUTINAS Y RECORDATORIOS ESCALONADOS (Evita horas pasadas) ---
let isEvaluatingSchedules = false;
async function evaluateSchedules() {
  if (connectionStatus !== "connected" || !sock || isEvaluatingSchedules) return;
  isEvaluatingSchedules = true;
  try {
    const { dateStr: todayStr, timeStr: currentHHMM } = getColombiaNowParts();

    let changed = false;
    for (const item of schedules) {
      if (!item.active) continue;

      if (item.pauseUntil && todayStr < item.pauseUntil) continue;
      if (item.pauseUntil && todayStr >= item.pauseUntil) {
        item.pauseUntil = null;
        changed = true;
      }

      if (item.specificDate && item.specificDate !== todayStr) continue;

      // Para recordatorios únicos (!item.recurring) damos 180 min de margen por si Render reinició; para rutinas diarias, 45 min
      const windowMins = item.recurring ? 45 : 180;
      if (isTimeWithinMinutesWindow(item.time, currentHHMM, windowMins) && item.lastSentDate !== todayStr) {
        const isOwnerNotification =
          Boolean(item.parentEventId) ||
          isSelfOrOwnerTarget(item.target) ||
          isSelfOrOwnerTarget(item.contactName);
        let jid = isOwnerNotification ? getOwnerNotificationJid() : toWhatsAppJid(item.target);
        if (!jid && (!item.recurring || /señor carlos/i.test(String(item.message || "")))) {
          jid = getOwnerNotificationJid();
        }
        if (!jid) continue;

        let finalMessage = item.message;
        if (item.useAI && !isOwnerNotification) {
          finalMessage = await generateSafeRoutineMessage(
            item.target,
            item.message,
            item.nextRunExtraNote || null,
            item.recentGreetings || []
          );
        } else if (!item.useAI && !isOwnerNotification && item.nextRunExtraNote) {
          finalMessage = `${item.message} Por cierto: ${item.nextRunExtraNote}`;
        } else if (isOwnerNotification && !/^[📅⚠️🔔⏰🤖]/.test(String(finalMessage).trim())) {
          finalMessage = `⏰ *Recordatorio LILA:* ${finalMessage}`;
        }

        try {
          await safeSendMessage(jid, { text: finalMessage }, { ensureFreshSession: !isOwnerNotification });
          if (isOwnerNotification && cloudState.telegramChatId) {
            await sendTelegramMessage(cloudState.telegramChatId, finalMessage);
          }
          item.lastSentDate = todayStr;
          if (item.nextRunExtraNote) {
            item.nextRunExtraNote = null;
          }
          if (item.recurring && !isOwnerNotification) {
            if (!Array.isArray(item.recentGreetings)) item.recentGreetings = [];
            item.recentGreetings.push(finalMessage);
            if (item.recentGreetings.length > 5) {
              item.recentGreetings.splice(0, item.recentGreetings.length - 5);
            }
          }
          if (!item.recurring) item.active = false;
          changed = true;
          console.log(`[LILA] ✅ Recordatorio/Rutina enviada a ${jid}: ${finalMessage}`);
        } catch (e) {
          console.error("Error ejecutando rutina:", e.message);
        }
      }
    }
    if (changed) saveSchedules();
  } finally {
    isEvaluatingSchedules = false;
  }
}

// Vigía proactivo de Gmail en la nube (Envía notificaciones al grupo LILA y a Telegram)
async function pollGmailProactively() {
  if (connectionStatus !== "connected" || !sock) return;
  if (!cloudState.lilaNotificationGroupJid) {
    await syncWhatsAppGroups();
  }
  const notifyJid = getOwnerNotificationJid();
  if (!notifyJid) return;

  const accounts = [];
  const pCreds = resolveGmailAccountCreds("Personal");
  const uCreds = resolveGmailAccountCreds("Uniguajira");
  if (pCreds) accounts.push(["Personal", pCreds]);
  if (uCreds) accounts.push(["Uniguajira", uCreds]);

  for (const [accName, creds] of accounts) {
    try {
      const res = await queryGmailAccountLive(accName, creds, "is:unread newer_than:1d", 3);
      if (res && res.emails.length > 0) {
        for (const email of res.emails) {
          if (!cloudState.notifiedEmailIds.includes(email.id)) {
            cloudState.notifiedEmailIds.push(email.id);
            if (cloudState.notifiedEmailIds.length > 100) cloudState.notifiedEmailIds.shift();
            cloudState.lastEmailContext = email;
            if (!Array.isArray(cloudState.recentFetchedEmails)) cloudState.recentFetchedEmails = [];
            cloudState.recentFetchedEmails = [
              email,
              ...cloudState.recentFetchedEmails.filter((x) => x.id !== email.id),
            ].slice(0, 20);
            saveCloudState();

            recentEmails.push({ from: email.from, subject: email.subject, snippet: email.snippet, account: accName, time: new Date().toISOString() });
            if (recentEmails.length > 20) recentEmails.shift();

            const summary = await askLilaCloudAI(
              `Correo nuevo en '${accName}' del Señor Carlos.\nDe: ${email.from}\nAsunto: ${email.subject}\nContenido: ${email.snippet}\nRedacta un aviso de máximo 2 líneas con ortografía impecable.`,
              "routine",
              false
            );
            const alertText = `📧 *Nuevo Correo (${accName})*\n*De:* ${email.from}\n*Asunto:* ${email.subject}\n\n🤖 *LILA:* ${summary}`;
            await safeSendMessage(notifyJid, { text: alertText });
            if (cloudState.telegramChatId) {
              await sendTelegramMessage(cloudState.telegramChatId, alertText);
            }
          }
        }
      }
    } catch (_) {}
  }
}

setInterval(evaluateSchedules, 30 * 1000);
setInterval(pollGmailProactively, 5 * 60 * 1000);

// Auto-keepalive
setInterval(() => {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || "https://lila-server-1.onrender.com";
  fetch(`${selfUrl}/ping`).catch(() => {});
}, 10 * 60 * 1000);

// --- RUTAS HTTP ---

app.get("/ping", async (req, res) => {
  evaluateSchedules().catch(() => {});
  res.json({
    ok: true,
    status: "online",
  });
});

app.get("/status", requireAuth, async (req, res) => {
  res.json({
    ok: true,
    service: "LILA Cloud",
    whatsapp: connectionStatus,
    connectedNumber,
    telegramLinked: Boolean(cloudState.telegramChatId),
    mongoConnected: isMongoConnected,
    gmailSynced: {
      Personal: Boolean(cloudState.gmailOAuth?.Personal),
      Uniguajira: Boolean(cloudState.gmailOAuth?.Uniguajira),
    },
    activeTasksCount: cloudState.agendaTasks.filter((t) => !t.completed).length,
    activeSchedulesCount: schedules.filter((s) => s.active).length,
  });
});

// Sincronización bidireccional LILA Desk ↔ LILA Server
app.get("/sync", requireAuth, (req, res) => {
  res.json({
    ok: true,
    schedules: schedules.filter((s) => s.active),
    agendaTasks: cloudState.agendaTasks.filter((t) => !t.completed),
    learnedContacts: cloudState.learnedContacts,
    currentLocation: cloudState.currentLocation,
    recentEmails: recentEmails.slice(-10),
  });
});

app.post("/sync", requireAuth, (req, res) => {
  try {
    const { contacts, gmailOAuth, location, agendaTasks } = req.body || {};
    if (contacts && typeof contacts === "object") {
      for (const [k, v] of Object.entries(contacts)) {
        const cleanK = String(k).toLowerCase().trim();
        if (cleanK && cleanK !== "hermana" && v) {
          let digits = String(v).replace(/\D/g, "");
          if (digits.length === 10 && digits.startsWith("3")) digits = "57" + digits;
          if (digits.length >= 10) cloudState.learnedContacts[cleanK] = `${digits}@s.whatsapp.net`;
        }
      }
    }
    if (gmailOAuth && typeof gmailOAuth === "object") {
      if (gmailOAuth.Personal) cloudState.gmailOAuth.Personal = gmailOAuth.Personal;
      if (gmailOAuth.Uniguajira) cloudState.gmailOAuth.Uniguajira = gmailOAuth.Uniguajira;
    }
    if (location && typeof location === "object") {
      cloudState.currentLocation = { ...cloudState.currentLocation, ...location, updatedAt: new Date().toISOString() };
    }
    if (Array.isArray(agendaTasks)) {
      for (const t of agendaTasks) {
        if (t?.title && t?.dueDate && !cloudState.agendaTasks.some((x) => x.title === t.title && x.dueDate === t.dueDate)) {
          createAgendaEventWithReminders(t);
        }
      }
    }
    saveCloudState();
    res.json({
      ok: true,
      schedules: schedules.filter((s) => s.active),
      agendaTasks: cloudState.agendaTasks.filter((t) => !t.completed),
      learnedContacts: cloudState.learnedContacts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/agenda", requireAuth, (req, res) => {
  const { title, dueDate, dueTime = "07:00", notes = "" } = req.body || {};
  if (!title || !dueDate) return res.status(400).json({ success: false, error: "Faltan title o dueDate." });
  const result = createAgendaEventWithReminders({ title, dueDate, dueTime, notes });
  res.json({ success: true, ...result });
});

app.post("/send", requireAuth, async (req, res) => {
  try {
    const target = req.body.contact || req.body.number;
    const message = req.body.message;
    if (!target || !message) return res.status(400).json({ success: false, error: "Faltan parámetros." });
    const resolved = await resolveContactTargetAsync(target);
    if (!resolved.ok) return res.status(400).json({ success: false, ambiguous: Boolean(resolved.ambiguous), error: resolved.error });
    await safeSendMessage(resolved.jid, { text: String(message) });
    return res.json({ success: true, to: resolved.jid, contactName: resolved.canonicalName });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/schedule", requireAuth, async (req, res) => {
  const { target, message, time, specificDate = null, recurring = false, useAI = false } = req.body;
  if (!target || !message || !time) return res.status(400).json({ success: false, error: "Faltan parámetros." });
  const resolved = await resolveContactTargetAsync(target);
  if (!resolved.ok && resolved.ambiguous) return res.status(400).json({ success: false, ambiguous: true, error: resolved.error });

  const { dateStr: todayStr, timeStr: currentHHMM } = getColombiaNowParts();
  const cleanTime = String(time || "07:00").trim().padStart(5, "0");
  const isRecurring = Boolean(recurring);
  let finalDate = specificDate || null;
  let initialLastSentDate = null;

  if (!finalDate && cleanTime <= currentHHMM) {
    if (isRecurring) {
      initialLastSentDate = todayStr;
    } else {
      finalDate = addDaysToDateStr(todayStr, 1);
    }
  }

  const newItem = {
    id: Date.now().toString(36),
    target: resolved.ok ? resolved.jid : target,
    contactName: resolved.canonicalName || target,
    message,
    time: cleanTime,
    specificDate: finalDate,
    recurring: isRecurring,
    useAI: Boolean(useAI),
    pauseUntil: null,
    active: true,
    lastSentDate: initialLastSentDate,
  };
  schedules.push(newItem);
  saveSchedules();
  res.json({ success: true, schedule: newItem });
});

app.get("/schedules", requireAuth, (req, res) => {
  res.json({
    schedules: schedules.filter((s) => s.active),
    agendaTasks: cloudState.agendaTasks.filter((t) => !t.completed),
  });
});

app.post("/schedule/cancel", requireAuth, (req, res) => {
  const target = String(req.body.target || "").toLowerCase().trim();
  const pauseUntil = req.body.pauseUntil ? String(req.body.pauseUntil).trim() : null;
  let removed = 0;
  for (const s of schedules) {
    if (!s.active) continue;
    if (!target || String(s.target).includes(target) || String(s.contactName).toLowerCase().includes(target)) {
      if (pauseUntil) s.pauseUntil = pauseUntil;
      else s.active = false;
      removed++;
    }
  }
  saveSchedules();
  res.json({ success: true, removed, pausedUntil: pauseUntil });
});

app.post("/gmail-alert", requireAuth, async (req, res) => {
  try {
    const { from, subject, snippet, account = "Gmail" } = req.body;
    recentEmails.push({ from, subject, snippet, account, time: new Date().toISOString() });
    if (recentEmails.length > 20) recentEmails.shift();

    if (!cloudState.lilaNotificationGroupJid) {
      await syncWhatsAppGroups();
    }
    const notifyJid = getOwnerNotificationJid();
    if (!notifyJid || connectionStatus !== "connected" || !sock) return res.status(503).json({ success: false });

    const summary = await askLilaCloudAI(
      `Llegó un correo nuevo a '${account}'.\nDe: ${from}\nAsunto: ${subject}\nContenido: ${snippet}\nHaz un aviso de máximo 2 líneas con ortografía impecable.`,
      "routine",
      false
    );
    await safeSendMessage(notifyJid, { text: `📧 *Nuevo Correo (${account})*\n*De:* ${from}\n*Asunto:* ${subject}\n\n🤖 *LILA:* ${summary}` });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/qr", requireAuth, (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`<html><body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;">
      <h1 style="color:#4ade80;">✅ LILA Cloud Conectado 24/7</h1>
      <p>Número vinculado: <b>+${connectedNumber}</b></p>
      <p style="color:#aaa;font-size:14px;">Para evitar escanear el QR en futuras actualizaciones, puedes copiar tu sesión segura en <a style="color:#38bdf8;" href="/export-session?key=${LILA_SECRET_KEY}">/export-session</a> y pegarla en la variable <code>SESSION_DATA</code> de Render.</p>
    </body></html>`);
  }
  if (latestQrDataUrl) {
    return res.send(`<html><head><meta http-equiv="refresh" content="15"></head>
      <body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:40px;">
        <h2 style="color:#ec4899;">📱 Vincula tu WhatsApp con LILA</h2>
        <img src="${latestQrDataUrl}" style="border:8px solid white;border-radius:12px;width:280px;height:280px;"/>
      </body></html>`);
  }
  res.send(`<html><head><meta http-equiv="refresh" content="4"></head><body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;"><h2>⏳ Generando código QR...</h2></body></html>`);
});

// Endpoint seguro para exportar la sesión y guardarla en Render Environment (SESSION_DATA)
app.get("/export-session", requireAuth, (req, res) => {
  const credsPath = path.join(AUTH_FOLDER, "creds.json");
  if (fs.existsSync(credsPath)) {
    const raw = fs.readFileSync(credsPath, "utf-8");
    const b64 = Buffer.from(raw, "utf-8").toString("base64");
    return res.json({ ok: true, session_data: b64 });
  }
  return res.status(404).json({ ok: false, error: "Aún no se ha vinculado WhatsApp o no existe creds.json." });
});

// Endpoint para reiniciar la sesión de WhatsApp limpiamente si hay conflicto de llaves
app.get("/reset-session", requireAuth, async (req, res) => {
  try {
    if (sock) {
      try { sock.logout(); } catch (_) {}
      try { sock.end(); } catch (_) {}
      sock = null;
    }
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
    await clearAuthFromMongo();
    sentMessagesCache.clear();
    connectionStatus = "initializing";
    setTimeout(startWhatsApp, 2000);
    res.json({ ok: true, message: "Sesión reiniciada limpiamente. Abre /qr para escanear el nuevo código." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- BOT DE TELEGRAM 24/7 (SIN CIFRADO SIGNAL NI QR) ---
let telegramOffset = 0;
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("[LILA Telegram] Error enviando mensaje:", err.message);
  }
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=20`
    );
    if (res.ok) {
      const data = await res.json();
      for (const update of data.result || []) {
        telegramOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;
        if (cloudState.telegramChatId !== chatId) {
          cloudState.telegramChatId = chatId;
          saveCloudState();
        }
        const rawText = msg.text.replace(/^\/start\s*/i, "").replace(/^lila[,:\s]*/i, "").trim() || "Hola Lila";
        const sendInterm = async (partial) => {
          if (partial && partial.trim()) await sendTelegramMessage(chatId, `🤖 LILA: ${partial.trim()}`);
        };
        const reply = await askLilaCloudAI(rawText, `tg_${chatId}`, true, sendInterm);
        if (reply && reply.trim()) {
          await sendTelegramMessage(chatId, `🤖 LILA: ${reply.trim()}`);
        }
      }
    }
  } catch (_) {}
  setTimeout(pollTelegramUpdates, 2000);
}

function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) return;
  console.log("[LILA] ✈️ Bot de Telegram 24/7 activo.");
  pollTelegramUpdates();
}

app.listen(PORT, async () => {
  console.log(`[LILA] 🚀 Servidor activo en puerto ${PORT}`);
  if (MongoClient) {
    try {
      await initMongo();
      await loadStateFromMongo();
      await restoreAuthFromMongo();
      await runSelfDiagnosticAndRepair(true);
    } catch (e) {
      console.error("[LILA] Error en inicialización de MongoDB:", e.message);
    }
  }
  startWhatsApp().catch((err) => console.error("Error iniciando WhatsApp:", err));
  startTelegramBot();
});
