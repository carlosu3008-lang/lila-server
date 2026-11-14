const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
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
const OWNER_PHONE = (process.env.OWNER_PHONE || "573018276980").replace(/\D/g, "");

const silentLogger = pino({ level: "silent" });

// --- CONEXIÓN PERMANENTE CON MONGODB ATLAS ---
let MongoClient = null;
try {
  MongoClient = require("mongodb").MongoClient;
} catch (_) {
  MongoClient = null;
}

const MONGODB_URI = (
  process.env.MONGODB_URI ||
  "mongodb+srv://carlosuriana2007_db_user:IrEv3ZutCpBNVTR7@cluster0.zna8fzy.mongodb.net/lila?retryWrites=true&w=majority"
).trim();

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
    paula: "573046497549@s.whatsapp.net",
    pechy: "573046497549@s.whatsapp.net",
    "mamá": "573046497549@s.whatsapp.net",
    mama: "573046497549@s.whatsapp.net",
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
  lastEmailContext: null,
  recentFetchedEmails: [],
  lilaNotificationGroupJid: null,
};

try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    cloudState = {
      ...cloudState,
      ...loaded,
      learnedContacts: { ...cloudState.learnedContacts, ...(loaded.learnedContacts || {}) },
      currentLocation: { ...cloudState.currentLocation, ...(loaded.currentLocation || {}) },
      gmailOAuth: { ...cloudState.gmailOAuth, ...(loaded.gmailOAuth || {}) },
    };
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
      cloudState = {
        ...cloudState,
        learnedContacts: { ...cloudState.learnedContacts, ...(doc.learnedContacts || {}) },
        currentLocation: { ...cloudState.currentLocation, ...(doc.currentLocation || {}) },
        gmailOAuth: { ...cloudState.gmailOAuth, ...(doc.gmailOAuth || {}) },
        agendaTasks: Array.isArray(doc.agendaTasks) ? doc.agendaTasks : cloudState.agendaTasks,
        notifiedEmailIds: Array.isArray(doc.notifiedEmailIds) ? doc.notifiedEmailIds : cloudState.notifiedEmailIds,
        lastEmailContext: doc.lastEmailContext || cloudState.lastEmailContext,
        recentFetchedEmails: Array.isArray(doc.recentFetchedEmails) ? doc.recentFetchedEmails : cloudState.recentFetchedEmails,
        lilaNotificationGroupJid: doc.lilaNotificationGroupJid || cloudState.lilaNotificationGroupJid,
      };
      console.log(`[LILA] 🍃 Estado cargado desde MongoDB: ${cloudState.agendaTasks.length} tareas en agenda.`);
    }

    const schedCol = mongoDb.collection("schedules");
    const schedDocs = await schedCol.find({ active: true }).toArray();
    if (schedDocs && schedDocs.length > 0) {
      const existingIds = new Set(schedules.map((s) => s.id));
      for (const s of schedDocs) {
        if (!existingIds.has(s.id)) schedules.push(s);
      }
      console.log(`[LILA] 🍃 ${schedDocs.length} rutinas activas cargadas desde MongoDB.`);
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

// --- PERSISTENCIA TOTAL DE LA SESIÓN DE WHATSAPP EN MONGODB ---
let syncAuthTimeout = null;
function scheduleSyncAuthToMongo(delayMs = 1500) {
  if (syncAuthTimeout) clearTimeout(syncAuthTimeout);
  syncAuthTimeout = setTimeout(() => {
    syncAllAuthToMongo().catch(() => {});
  }, delayMs);
}

async function clearAuthFromMongo() {
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
        }
      }
      console.log(`[LILA] 🍃 ${files.length} archivos de sesión de WhatsApp restaurados desde MongoDB.`);
    }
  } catch (err) {
    console.error("Error restaurando sesión de WhatsApp desde MongoDB:", err.message);
  }
}

async function syncAllAuthToMongo() {
  if (!isMongoConnected || !mongoDb || !fs.existsSync(AUTH_FOLDER)) return;
  try {
    const files = fs.readdirSync(AUTH_FOLDER);
    if (!files.includes("creds.json")) return;
    const col = mongoDb.collection("whatsapp_auth");
    const currentFileNames = [];
    for (const file of files) {
      const fullPath = path.join(AUTH_FOLDER, file);
      if (fs.statSync(fullPath).isFile()) {
        currentFileNames.push(file);
        const content = fs.readFileSync(fullPath, "utf-8");
        await col.updateOne(
          { fileName: file },
          { $set: { fileName: file, content, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
      }
    }
    if (currentFileNames.length > 0) {
      await col.deleteMany({ fileName: { $nin: currentFileNames } });
    }
    console.log(`[LILA] 🍃 Sesión de WhatsApp respaldada en MongoDB (${currentFileNames.length} archivos).`);
  } catch (err) {
    console.error("Error respaldando sesión en MongoDB:", err.message);
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

function rememberMessage(msgObj) {
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
}

// Normaliza el JID respetando grupos (@g.us) y canales
function normalizeTargetJid(jid) {
  if (!jid) return null;
  const raw = String(jid).trim();
  if (raw.endsWith("@g.us")) return raw;
  const ownerNum = OWNER_PHONE || connectedNumber;
  if (ownerNum && (raw.includes(ownerNum) || raw.endsWith("@lid"))) {
    return `${ownerNum}@s.whatsapp.net`;
  }
  return raw;
}

async function safeSendMessage(jid, content, options = {}) {
  if (!sock) throw new Error("Socket de WhatsApp no inicializado");
  const target = normalizeTargetJid(jid);
  const sent = await sock.sendMessage(target, content, options);
  if (sent) rememberMessage(sent);
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
  const ownerNum = OWNER_PHONE || connectedNumber || "573018276980";
  return `${ownerNum}@s.whatsapp.net`;
}

function resolveContactTarget(target) {
  if (!target) return { ok: false, error: "No se indicó destinatario." };
  const raw = String(target).trim();
  const lower = raw
    .toLowerCase()
    .replace(/^(el\s+grupo\s+de\s+whatsapp|grupo\s+de\s+whatsapp|el\s+grupo|grupo|mi)\s+/i, "")
    .trim();
  const normTarget = normalizeSearchKey(lower);

  if (lower === "lila_group" || lower === "notificaciones_lila") {
    const notifJid = getOwnerNotificationJid();
    return { ok: true, jid: notifJid, canonicalName: "Grupo LILA", relationship: "owner_group" };
  }

  if (lower === "hermana" || lower === "hermanas" || raw.toLowerCase() === "mi hermana") {
    return {
      ok: false,
      ambiguous: true,
      error: "Señor Carlos, usted tiene dos hermanas: Nelly y Perla. ¿A cuál de las dos desea escribirle?",
    };
  }

  if (["mamá", "mama", "mami", "madre", "paula", "pechy"].includes(lower) || ["mama", "mami", "madre", "paula", "pechy"].includes(normTarget)) {
    const momJid =
      cloudState.learnedContacts["paula"] ||
      cloudState.learnedContacts["pechy"] ||
      cloudState.learnedContacts["mamá"] ||
      "573046497549@s.whatsapp.net";
    return { ok: true, jid: momJid, canonicalName: "Paula (Pechy)", relationship: "mother" };
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
    description: "Programa un mensaje de WhatsApp a un contacto o grupo a una hora determinada.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: { type: "STRING", description: "Contacto (Paula, Pechy, Nelly, Perla), nombre de grupo o número." },
        message: { type: "STRING", description: "Texto o instrucción de saludo a enviar." },
        time: { type: "STRING", description: "Hora en formato 24h HH:MM (ej. '07:00')." },
        specificDate: { type: "STRING", description: "Fecha opcional YYYY-MM-DD." },
        recurring: { type: "BOOLEAN", description: "true solo si dijo 'todos los días'; false si es una sola vez." },
        useAI: { type: "BOOLEAN", description: "false si el mensaje fue dictado literal; true si pidió redactar un saludo." },
      },
      required: ["target", "message", "time"],
    },
  },
  {
    name: "pause_or_cancel_routine",
    description: "Pausa una rutina hasta cierta fecha (pauseUntil: 'YYYY-MM-DD') o cancela rutinas.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: { type: "STRING", description: "Contacto o ID a pausar o cancelar." },
        pauseUntil: { type: "STRING", description: "Fecha 'YYYY-MM-DD' hasta la cual pausar." },
      },
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
];

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
      let matchedEmail = findMatchingEmailContext(rawTo);
      let finalTo = rawTo;

      // Extraer correo si viene como "Nombre <correo@dominio>" o buscar en el último correo leído si solo dieron el nombre ("Carlos")
      const bracketMatch = rawTo.match(/<([^>]+@[^>]+)>/) || rawTo.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (bracketMatch) {
        finalTo = bracketMatch[1].trim();
      } else if (!rawTo.includes("@") && matchedEmail) {
        const ctxMatch =
          (matchedEmail.emailAddress && matchedEmail.emailAddress.includes("@") ? matchedEmail.emailAddress : null) ||
          matchedEmail.from?.match(/<([^>]+@[^>]+)>/)?.[1] ||
          matchedEmail.from?.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[1];
        if (ctxMatch) finalTo = ctxMatch.trim();
      }

      if (!finalTo || !finalTo.includes("@")) {
        return `No se encontró una dirección de correo válida para '${rawTo || "el destinatario"}'. Por favor indique el correo electrónico.`;
      }

      const isReply = Boolean(args?.isReply) || (!rawTo.includes("@") && Boolean(matchedEmail));
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

      const accountToUse = args?.account || matchedEmail?.account || "Personal";
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
          }) | Mensaje/Instrucción: "${s.message}"${s.pauseUntil ? ` [Pausada hasta ${s.pauseUntil}]` : ""}`
      );
      return `Rutinas activas programadas (${activeList.length}):\n` + lines.join("\n");
    }
    case "schedule_whatsapp_message": {
      const resolved = await resolveContactTargetAsync(args.target);
      if (!resolved.ok && resolved.ambiguous) return resolved.error;
      const targetStr = resolved.ok
        ? resolved.jid.endsWith("@g.us")
          ? resolved.jid
          : resolved.jid.split("@")[0]
        : args.target;

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
      }

      const newItem = {
        id: Date.now().toString(36),
        target: targetStr,
        contactName: resolved.canonicalName || args.target,
        message: args.message,
        time: cleanTime,
        specificDate,
        recurring: isRecurring,
        useAI: Boolean(args.useAI),
        pauseUntil: null,
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
      return `Rutina programada exitosamente para '${newItem.contactName}' ${startInfo} (${
        newItem.recurring ? "todos los días" : "una sola vez"
      }).`;
    }
    case "pause_or_cancel_routine": {
      const filter = String(args?.target || "").toLowerCase().trim();
      const pauseUntil = args?.pauseUntil ? String(args.pauseUntil).trim() : null;
      let count = 0;
      for (const s of schedules) {
        if (!s.active) continue;
        const matches = !filter || String(s.target).includes(filter) || String(s.contactName).toLowerCase().includes(filter);
        if (matches) {
          if (pauseUntil) s.pauseUntil = pauseUntil;
          else s.active = false;
          count++;
        }
      }
      saveSchedules();
      return pauseUntil
        ? `Se pausaron ${count} rutina(s) hasta el ${pauseUntil}.`
        : `Se cancelaron ${count} rutina(s).`;
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

// --- CEREBRO CONVERSACIONAL DE LILA EN LA NUBE ---
async function askLilaCloudAI(userPrompt, jid = "default", allowTools = true, onProgress = null) {
  const { dateStr, timeStr, readable } = getColombiaNowParts();
  const locStr = cloudState.currentLocation?.placeName
    ? `Ubicación conocida del Señor Carlos: ${cloudState.currentLocation.placeName}.`
    : "Ciudades habituales del Señor Carlos: Riohacha y Hatonuevo (La Guajira, Colombia).";

  const lastMailInfo = cloudState.lastEmailContext
    ? `\n9. CONTEXTO DEL ÚLTIMO CORREO LEÍDO (para responder con send_or_reply_gmail): De: ${cloudState.lastEmailContext.from} | Correo exacto: ${cloudState.lastEmailContext.emailAddress || cloudState.lastEmailContext.from} | Asunto: "${cloudState.lastEmailContext.subject}" | Bandeja: ${cloudState.lastEmailContext.account}.`
    : "";

  const systemPrompt =
    "Eres LILA, el asistente personal de inteligencia artificial creado y desarrollado exclusivamente por el Señor Carlos (estudiante de Ingeniería de Sistemas).\n" +
    "=== REGLAS DE IDENTIDAD Y ACCIÓN INQUEBRANTABLES ===\n" +
    "1. Tu único nombre es LILA. NUNCA digas 'LILA 2.0', NUNCA menciones a 'J.A.R.V.I.S.' y NUNCA digas que fuiste creada por Google. Tu creador es el Señor Carlos.\n" +
    "2. Dirígete siempre al usuario como 'Señor' o 'Señor Carlos', manteniendo siempre ortografía impecable en español (tildes y signos ¿? ¡! completos).\n" +
    "3. CONSCIENCIA HÍBRIDA (NUBE Y ESCRITORIO): Sabes que existes en dos nodos coordinados: LILA Cloud (este nodo en la nube 24/7 en WhatsApp) y LILA Desk (el nodo en el portátil del Señor Carlos). Ambos comparten la misma agenda y contactos en tiempo real.\n" +
    "4. TAREAS Y RECORDATORIOS INMEDIATOS: Si el Señor Carlos dice que tiene algo para cierto día (ej. 'para el viernes tengo exposición y laboratorio'), agenda DE INMEDIATO con `add_agenda_event` calculando la fecha exacta. Si pregunta qué tiene pendiente ('¿qué tengo pendiente?'), invoca `get_pending_tasks`. Si pregunta qué rutinas tiene programadas, invoca `get_scheduled_routines`.\n" +
    "5. CORREOS GMAIL: Puedes leer correos (`check_gmail`), y enviar o responder correos (`send_or_reply_gmail`) tanto en la cuenta Personal como en la de Uniguajira. NUNCA digas que enviaste o respondiste un correo sin haber invocado `send_or_reply_gmail`.\n" +
    "6. ÓRDENES MÚLTIPLES Y GRUPOS DE WHATSAPP: Si el Señor Carlos pide dos o más cosas en un mismo mensaje, invoca TODAS las herramientas necesarias. Si te pide escribir o presentarte en un grupo de WhatsApp (ej. 'Cuarto gamer'), invoca DE INMEDIATO `send_whatsapp_message` con el nombre del grupo en `target`.\n" +
    "7. FAMILIA: Mamá es Paula (él le dice 'Pechy', saludo natural sin cursilerías). Tiene dos hermanas: Nelly y Perla (si dice 'mi hermana' sin decir cuál, pregúntale a cuál de las dos).\n" +
    `8. FECHA Y HORA ACTUAL: Hoy es ${readable} (${dateStr}), hora actual en Colombia: ${timeStr}. ${locStr}${lastMailInfo}`;

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

// --- GENERADOR CON ESTILO PERSONAL PARA RUTINAS HACIA CONTACTOS ---
async function generateSafeRoutineMessage(target, instruction) {
  const targetLower = String(target || "").toLowerCase();
  const isMom = targetLower.includes("3046497549") || ["mamá", "mama", "paula", "pechy", "madre"].some((k) => targetLower.includes(k));
  const FALLBACK_GREETING = isMom ? "Hola Pechy, buenos días, ¿cómo amaneciste?" : "Hola, buenos días, ¿cómo amaneciste?";

  const styleRules = isMom
    ? "Mensaje de Carlos para su mamá Paula ('Pechy'). Carlos habla normal, sobrio y respetuoso. Jamás uses 'mi amor', 'cariño' o frases cursis."
    : "Mensaje en primera persona como Carlos. Tono natural, directo y sobrio. Prohibido 'mi amor'.";

  const sys = `${styleRules}\nOrtografía impecable con tildes y signos completos. Devuelve solo el texto del mensaje sin comillas.`;
  const prompt = `Instrucción: ${instruction}`;

  const gemRes = await callGeminiWithFallback(sys, [{ role: "user", parts: [{ text: prompt }] }], false);
  if (gemRes.ok && gemRes.text) {
    const candidate = gemRes.text.replace(/^["']|["']$/g, "").trim();
    if (candidate && !/error|señor carlos|nodo/i.test(candidate)) return candidate;
  }
  return FALLBACK_GREETING;
}

// --- INICIALIZACIÓN DE WHATSAPP (Baileys) - NUNCA BORRA SESIONES SIGNAL ---
async function startWhatsApp() {
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
        setTimeout(startWhatsApp, 3500);
      } else {
        if (fs.existsSync(AUTH_FOLDER)) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        await clearAuthFromMongo();
        setTimeout(startWhatsApp, 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      if (msg?.message) rememberMessage(msg);
    }
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid || "";
      if (remoteJid === "status@broadcast") continue;

      const isOwnerOrSelf =
        msg.key.fromMe ||
        (OWNER_PHONE && remoteJid.includes(OWNER_PHONE)) ||
        (connectedNumber && remoteJid.includes(connectedNumber)) ||
        remoteJid.endsWith("@lid");

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";
      if (!text) continue;

      const pushName = msg.pushName || remoteJid.split("@")[0];
      const { timeStr: nowCol } = getColombiaNowParts();

      if (!msg.key.fromMe && pushName && remoteJid.endsWith("@s.whatsapp.net")) {
        const cleanPush = pushName.toLowerCase().trim();
        if (cleanPush && cleanPush !== "hermana") {
          cloudState.learnedContacts[cleanPush] = remoteJid;
          saveCloudState();
        }
      }

      if (!msg.key.fromMe) {
        inboxMessages.push({ from: pushName, jid: remoteJid, body: text, time: nowCol, timestamp: Date.now() });
        if (inboxMessages.length > 50) inboxMessages.shift();
      }

      const cleanText = text.trim();
      if (cleanText.startsWith("🤖 *LILA:*")) continue;

      const isCommandForLila = /^lila[,:\s]+/i.test(cleanText);
      if (isCommandForLila && isOwnerOrSelf) {
        if (remoteJid.endsWith("@g.us") && !cloudState.lilaNotificationGroupJid) {
          syncWhatsAppGroups().catch(() => {});
        }
        const query = cleanText.replace(/^lila[,:\s]+/i, "").trim();
        if (query) {
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
        }
      }
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
async function evaluateSchedules() {
  if (connectionStatus !== "connected" || !sock) return;
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

    // Solo dispara si estamos dentro de la ventana de 30 minutos de la hora programada (nunca horas después en la noche)
    if (isTimeWithinMinutesWindow(item.time, currentHHMM, 30) && item.lastSentDate !== todayStr) {
      const isOwnerNotification =
        Boolean(item.parentEventId) ||
        item.target === "lila_group" ||
        (OWNER_PHONE && String(item.target).includes(OWNER_PHONE));
      const jid = isOwnerNotification ? getOwnerNotificationJid() : toWhatsAppJid(item.target);
      if (!jid) continue;

      let finalMessage = item.message;
      if (item.useAI) {
        finalMessage = await generateSafeRoutineMessage(item.target, item.message);
      }

      try {
        await safeSendMessage(jid, { text: finalMessage });
        item.lastSentDate = todayStr;
        if (!item.recurring) item.active = false;
        changed = true;
        console.log(`[LILA] ✅ Recordatorio/Rutina enviada a ${jid}: ${finalMessage}`);
      } catch (e) {
        console.error("Error ejecutando rutina:", e.message);
      }
    }
  }
  if (changed) saveSchedules();
}

// Vigía proactivo de Gmail en la nube (Envía notificaciones al grupo LILA)
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
            await safeSendMessage(notifyJid, {
              text: `📧 *Nuevo Correo (${accName})*\n*De:* ${email.from}\n*Asunto:* ${email.subject}\n\n🤖 *LILA:* ${summary}`,
            });
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
  await evaluateSchedules();
  res.json({
    ok: true,
    service: "LILA Cloud",
    whatsapp: connectionStatus,
    connectedNumber,
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
    target: resolved.ok ? (resolved.jid.endsWith("@g.us") ? resolved.jid : resolved.jid.split("@")[0]) : target,
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

app.listen(PORT, async () => {
  console.log(`[LILA] 🚀 Servidor activo en puerto ${PORT}`);
  if (MongoClient) {
    try {
      await initMongo();
      await loadStateFromMongo();
      await restoreAuthFromMongo();
    } catch (e) {
      console.error("[LILA] Error en inicialización de MongoDB:", e.message);
    }
  }
  startWhatsApp().catch((err) => console.error("Error iniciando WhatsApp:", err));
});
