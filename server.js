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
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 3001;
const LILA_SECRET_KEY = (process.env.LILA_SECRET_KEY || "lila_secret_2026").trim();
let GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
let GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const OWNER_PHONE = (process.env.OWNER_PHONE || "573018276980").replace(/\D/g, "");

const silentLogger = pino({ level: "silent" });

// Estado de WhatsApp en memoria
let sock = null;
let latestQrDataUrl = null;
let connectionStatus = "initializing"; // initializing | qr_ready | connected | disconnected
let connectedNumber = null;

// --- PERSISTENCIA UNIFICADA EN DISCO (cloud_state.json + schedules.json) ---
const STATE_FILE = path.join(__dirname, "cloud_state.json");
const SCHEDULES_FILE = path.join(__dirname, "schedules.json");

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

function saveCloudState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(cloudState, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando cloud_state.json:", e.message);
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

function saveSchedules() {
  try {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando schedules:", e.message);
  }
}

// --- CACHÉ DE REINTENTOS SIGNAL (Evita "Esperando mensaje" en celular y PC) ---
function createSimpleCache(maxEntries = 2000) {
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

const msgRetryCounterCache = createSimpleCache(2000);
const sentMessagesCache = new Map();

function rememberSentMessage(msgObj) {
  if (msgObj?.key?.id && msgObj?.message) {
    sentMessagesCache.set(msgObj.key.id, msgObj.message);
    if (sentMessagesCache.size > 600) {
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
  return { dateStr, timeStr, readable };
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

// --- RESOLUCIÓN INTELIGENTE DE CONTACTOS Y DESAMBIGUACIÓN FAMILIAR (Nelly vs Perla, Paula/Pechy) ---
function resolveContactTarget(target) {
  if (!target) return { ok: false, error: "No se indicó destinatario." };
  const raw = String(target).trim();
  const lower = raw.toLowerCase().replace(/^mi\s+/, "").trim();

  if (lower === "hermana" || lower === "hermanas" || raw.toLowerCase() === "mi hermana") {
    return {
      ok: false,
      ambiguous: true,
      error: "Señor Carlos, usted tiene dos hermanas: Nelly y Perla. ¿A cuál de las dos desea escribirle?",
    };
  }

  if (["mamá", "mama", "mami", "madre", "paula", "pechy"].includes(lower)) {
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

  const matches = [];
  for (const [name, jid] of Object.entries(cloudState.learnedContacts)) {
    if (name.includes(lower) || lower.includes(name)) {
      matches.push({ name, jid });
    }
  }
  const uniqueJids = [...new Set(matches.map((m) => m.jid))];
  if (uniqueJids.length === 1) {
    return { ok: true, jid: uniqueJids[0], canonicalName: matches[0].name, relationship: "general" };
  }
  if (uniqueJids.length > 1) {
    const namesList = matches.map((m) => `${m.name} (+${m.jid.split("@")[0]})`).join(", ");
    return {
      ok: false,
      ambiguous: true,
      error: `Señor Carlos, encontré varios contactos que coinciden con '${raw}': ${namesList}. ¿A cuál de ellos se refiere?`,
    };
  }

  let digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("3")) {
    digits = "57" + digits;
  }
  if (digits.length >= 10) {
    return { ok: true, jid: `${digits}@s.whatsapp.net`, canonicalName: `+${digits}`, relationship: "general" };
  }

  return {
    ok: false,
    error: `Señor Carlos, aún no tengo registrado el número de '${raw}' en mi memoria. ¿Me indica su número una sola vez para guardarlo permanentemente?`,
  };
}

function toWhatsAppJid(target) {
  const res = resolveContactTarget(target);
  return res.ok ? res.jid : null;
}

// --- DETECTOR DE ZONA POR COORDENADAS GPS O WI-FI (Uniguajira, Riohacha, Hatonuevo) ---
function classifyLocation(lat, lon, wifiSsid = "") {
  const ssidLower = String(wifiSsid || "").toLowerCase();
  if (ssidLower.includes("uniguajira")) return "Universidad de La Guajira (Riohacha)";
  if (ssidLower.includes("hatonuevo")) return "Hatonuevo, La Guajira";

  if (typeof lat === "number" && typeof lon === "number" && !isNaN(lat) && !isNaN(lon)) {
    const dist = (lat1, lon1, lat2, lon2) =>
      Math.hypot((lat1 - lat2) * 111, (lon1 - lon2) * 109);

    if (dist(lat, lon, 11.5142, -72.8692) <= 1.5) {
      return "Universidad de La Guajira (Riohacha)";
    }
    if (dist(lat, lon, 11.5444, -72.9072) <= 8.0) {
      return "Riohacha, La Guajira";
    }
    if (dist(lat, lon, 11.0672, -72.7647) <= 8.0) {
      return "Hatonuevo, La Guajira";
    }
  }
  return null;
}

// --- CLIMA EN TIEMPO REAL CON DOBLE RESPALDO (Open-Meteo + wttr.in) ---
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

  // Respaldo automático con wttr.in si Open-Meteo falla
  const wttrUrl = `https://wttr.in/${encodeURIComponent(name)}?format=j1`;
  const wRes = await fetch(wttrUrl, { headers });
  if (!wRes.ok) throw new Error(`HTTP ${wRes.status}`);
  const wData = await wRes.json();
  const c = wData?.current_condition?.[0] || {};
  const tempC = c.temp_C || "";
  const feelsC = c.FeelsLikeC || tempC;
  const hum = c.humidity || "";
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
      const locNote = cloudState.currentLocation?.placeName
        ? `Ubicación registrada recientemente: ${cloudState.currentLocation.placeName}.\n`
        : "";
      return `${locNote}- ${riohacha}\n- ${hatonuevo}`;
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
    return `En Riohacha y Hatonuevo la temperatura actual ronda los 31 °C con cielo parcialmente nublado (detalle técnico: ${e.message}).`;
  }
}

// --- CONEXIÓN EN VIVO A GMAIL (Personal + Institucional Uniguajira) ---
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

async function queryGmailAccountLive(accountName, oauthCreds, query = "is:unread newer_than:2d", maxResults = 5) {
  const accessToken = await getAccessTokenFromOAuth(oauthCreds);
  if (!accessToken) return null;

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`Gmail API (${accountName}) HTTP ${listRes.status}`);
  }
  const listData = await listRes.json();
  const messages = listData.messages || [];
  if (messages.length === 0) {
    return { account: accountName, emails: [] };
  }

  const detailed = [];
  for (const m of messages.slice(0, maxResults)) {
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
    const msgRes = await fetch(msgUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (msgRes.ok) {
      const msgData = await msgRes.json();
      const headers = msgData.payload?.headers || [];
      const from = headers.find((h) => h.name.toLowerCase() === "from")?.value || "Desconocido";
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value || "Sin asunto";
      detailed.push({
        id: m.id,
        account: accountName,
        from,
        subject,
        snippet: msgData.snippet || "",
      });
    }
  }
  return { account: accountName, emails: detailed };
}

async function checkGmailLive(query = "is:unread newer_than:2d", targetAccount = "All") {
  const accounts = [];
  const pCreds =
    cloudState.gmailOAuth?.Personal ||
    (process.env.GMAIL_REFRESH_TOKEN_PERSONAL
      ? {
          client_id: process.env.GMAIL_CLIENT_ID,
          client_secret: process.env.GMAIL_CLIENT_SECRET,
          refresh_token: process.env.GMAIL_REFRESH_TOKEN_PERSONAL,
        }
      : null);
  const uCreds =
    cloudState.gmailOAuth?.Uniguajira ||
    (process.env.GMAIL_REFRESH_TOKEN_UNI
      ? {
          client_id: process.env.GMAIL_CLIENT_ID,
          client_secret: process.env.GMAIL_CLIENT_SECRET,
          refresh_token: process.env.GMAIL_REFRESH_TOKEN_UNI,
        }
      : null);

  if ((targetAccount === "All" || targetAccount.toLowerCase().includes("personal")) && pCreds) {
    accounts.push(["Personal", pCreds]);
  }
  if ((targetAccount === "All" || targetAccount.toLowerCase().includes("uni")) && uCreds) {
    accounts.push(["Uniguajira", uCreds]);
  }

  const lines = [];
  for (const [accName, creds] of accounts) {
    try {
      const res = await queryGmailAccountLive(accName, creds, query, 5);
      if (res) {
        if (res.emails.length === 0) {
          lines.push(`Bandeja ${accName}: No hay correos nuevos que coincidan con '${query}'.`);
        } else {
          lines.push(`Bandeja ${accName} (${res.emails.length} encontrados):`);
          for (const e of res.emails) {
            lines.push(`- De: ${e.from} | Asunto: ${e.subject} | Resumen: ${e.snippet}`);
          }
        }
      }
    } catch (err) {
      lines.push(`Bandeja ${accName}: Error al consultar en vivo (${err.message}).`);
    }
  }

  if (lines.length > 0) {
    return lines.join("\n");
  }

  if (recentEmails.length > 0) {
    return (
      "Últimos correos recibidos en la bandeja sincronizada:\n" +
      recentEmails
        .slice(-6)
        .map((e, i) => `${i + 1}. [${e.account}] De: ${e.from} | Asunto: ${e.subject} | Resumen: ${e.snippet}`)
        .join("\n")
    );
  }

  return "Aún no se han sincronizado las credenciales de Gmail desde LILA Desk tras el último reinicio del servidor. Abra LILA Desk un instante en su portátil para sincronizar ambas cuentas (Personal y Uniguajira).";
}

// --- MOTOR DE AGENDA ACADÉMICA Y RECORDATORIOS ESCALONADOS (3 días antes, 1 día antes y el mismo día) ---
function createAgendaEventWithReminders({ title, dueDate, dueTime = "07:00", notes = "" }) {
  const { dateStr: todayStr } = getColombiaNowParts();
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

  const ownerTarget = OWNER_PHONE || connectedNumber || "573018276980";
  const createdReminders = [];

  // 1. Recordatorio 3 días antes (08:00 a.m.)
  const date3DaysBefore = addDaysToDateStr(task.dueDate, -3);
  if (date3DaysBefore >= todayStr) {
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
  if (date1DayBefore >= todayStr) {
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

  // 3. Recordatorio el mismo día (07:00 a.m. o la hora indicada)
  if (task.dueDate >= todayStr) {
    const morningTime = task.dueTime && task.dueTime !== "08:00" ? task.dueTime : "07:00";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- DECLARACIONES DE HERRAMIENTAS NATIVAS (GEMINI FUNCTION CALLING EN LA NUBE) ---
const CLOUD_TOOLS_DECLARATIONS = [
  {
    name: "get_weather",
    description:
      "Consulta el clima real en vivo de cualquier ciudad del mundo, o de las ciudades del Señor Carlos (Riohacha, Hatonuevo, Universidad de La Guajira).",
    parameters: {
      type: "OBJECT",
      properties: {
        city: {
          type: "STRING",
          description: "Nombre de la ciudad (ej. 'Riohacha', 'Hatonuevo', 'Medellín') o vacío para reporte automático de Riohacha y Hatonuevo.",
        },
      },
    },
  },
  {
    name: "check_gmail",
    description:
      "Lee o busca correos reales en vivo en las cuentas de Gmail del Señor Carlos (Personal e Institucional de Uniguajira).",
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "Filtro de búsqueda de Gmail (ej. 'is:unread newer_than:2d', 'from:profesor', 'newer_than:3d').",
        },
        account: {
          type: "STRING",
          description: "'All' (ambas cuentas), 'Personal' o 'Uniguajira'.",
        },
      },
    },
  },
  {
    name: "add_agenda_event",
    description:
      "EJECUTAR DE INMEDIATO sin pedir confirmación cuando el Señor Carlos diga que tiene una exposición, examen, parcial, taller, tarea o evento para algún día (ej. 'para el viernes tengo una exposición'). Registra el evento y programa automáticamente 3 recordatorios por WhatsApp (3 días antes, 1 día antes y el mismo día).",
    parameters: {
      type: "OBJECT",
      properties: {
        title: {
          type: "STRING",
          description: "Título claro del compromiso, exposición, examen o tarea (ej. 'Exposición', 'Parcial de Termodinámica').",
        },
        dueDate: {
          type: "STRING",
          description: "Fecha exacta del compromiso en formato 'YYYY-MM-DD' calculada a partir de la fecha actual.",
        },
        dueTime: {
          type: "STRING",
          description: "Hora del recordatorio del mismo día en formato 24h 'HH:MM' (por defecto '07:00').",
        },
        notes: {
          type: "STRING",
          description: "Detalles adicionales opcionales.",
        },
      },
      required: ["title", "dueDate"],
    },
  },
  {
    name: "list_agenda_and_routines",
    description: "Lista todas las tareas de la agenda, recordatorios escalonados y rutinas de WhatsApp activas o pausadas.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "schedule_whatsapp_message",
    description:
      "Programa el envío de un mensaje de WhatsApp a un contacto o número a una hora determinada (una sola vez o todos los días).",
    parameters: {
      type: "OBJECT",
      properties: {
        target: {
          type: "STRING",
          description: "Nombre del contacto (ej. 'Paula', 'Pechy', 'Mamá', 'Nelly', 'Perla') o número telefónico.",
        },
        message: {
          type: "STRING",
          description: "Texto exacto a enviar (si useAI=false) o instrucción del saludo (si useAI=true).",
        },
        time: {
          type: "STRING",
          description: "Hora en formato 24h 'HH:MM' (ej. '07:00', '13:30').",
        },
        specificDate: {
          type: "STRING",
          description: "Opcional: Fecha 'YYYY-MM-DD' si es para un día futuro específico.",
        },
        recurring: {
          type: "BOOLEAN",
          description: "true SOLO si el Señor Carlos pidió explícitamente 'todos los días' o 'a diario'; false si es solo una vez.",
        },
        useAI: {
          type: "BOOLEAN",
          description: "false si el Señor Carlos dictó el mensaje literal (ej. 'diciendo que...'); true si pidió redactar un saludo variable (ej. 'deséale buenos días').",
        },
      },
      required: ["target", "message", "time"],
    },
  },
  {
    name: "pause_or_cancel_routine",
    description:
      "Pausa temporalmente una rutina hasta una fecha ('pauseUntil': 'YYYY-MM-DD', ej. 'no le escribas a mi mamá hasta la otra semana') o cancela/elimina una rutina o tarea.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: {
          type: "STRING",
          description: "Contacto, título de la tarea o ID de la rutina (ej. 'Paula', 'Mamá', o vacío para todas).",
        },
        pauseUntil: {
          type: "STRING",
          description: "Fecha 'YYYY-MM-DD' hasta la cual pausar la rutina (si solo desea pausarla temporalmente). Dejar vacío si desea eliminarla definitivamente.",
        },
      },
    },
  },
  {
    name: "send_whatsapp_message",
    description: "Envía un mensaje de WhatsApp inmediatamente a otro contacto o número.",
    parameters: {
      type: "OBJECT",
      properties: {
        target: {
          type: "STRING",
          description: "Nombre del contacto (ej. 'Paula', 'Pechy', 'Nelly', 'Perla', 'hermana') o número.",
        },
        message: {
          type: "STRING",
          description: "Mensaje a enviar con ortografía impecable.",
        },
      },
      required: ["target", "message"],
    },
  },
  {
    name: "save_contact_alias",
    description: "Guarda o vincula el número de teléfono de un contacto o familiar (ej. Nelly, Perla, Paula, amigos).",
    parameters: {
      type: "OBJECT",
      properties: {
        name: {
          type: "STRING",
          description: "Nombre del contacto (ej. 'Perla', 'Nelly', 'Paula').",
        },
        number: {
          type: "STRING",
          description: "Número de teléfono.",
        },
      },
      required: ["name", "number"],
    },
  },
  {
    name: "set_current_location",
    description: "Actualiza la ubicación actual del Señor Carlos cuando él menciona dónde está (ej. Riohacha, Hatonuevo, Universidad).",
    parameters: {
      type: "OBJECT",
      properties: {
        placeName: {
          type: "STRING",
          description: "Nombre del lugar donde se encuentra el Señor Carlos.",
        },
      },
      required: ["placeName"],
    },
  },
];

async function executeCloudToolCall(name, args) {
  switch (name) {
    case "get_weather": {
      return await getWeatherLive(args?.city || "");
    }
    case "check_gmail": {
      return await checkGmailLive(args?.query || "is:unread newer_than:2d", args?.account || "All");
    }
    case "add_agenda_event": {
      const { task, createdReminders } = createAgendaEventWithReminders({
        title: args.title,
        dueDate: args.dueDate,
        dueTime: args.dueTime || "07:00",
        notes: args.notes || "",
      });
      return `Evento '${task.title}' registrado exitosamente en la agenda para el ${task.dueDate}. Recordatorios automáticos programados en WhatsApp: ${createdReminders.join(", ")}.`;
    }
    case "list_agenda_and_routines": {
      const activeTasks = cloudState.agendaTasks.filter((t) => !t.completed);
      const activeScheds = schedules.filter((s) => s.active);
      let out = "";
      if (activeTasks.length > 0) {
        out +=
          "📚 Tareas y Eventos en Agenda:\n" +
          activeTasks.map((t) => `- [${t.dueDate}] ${t.title}${t.notes ? " (" + t.notes + ")" : ""}`).join("\n") +
          "\n\n";
      } else {
        out += "📚 Tareas y Eventos en Agenda: Ninguno pendiente.\n\n";
      }
      if (activeScheds.length > 0) {
        out +=
          "⏰ Rutinas y Recordatorios Programados:\n" +
          activeScheds
            .map(
              (s) =>
                `- ID ${s.id} -> Para ${s.target} a las ${s.time} (${
                  s.recurring ? "Diario" : s.specificDate ? `Fecha: ${s.specificDate}` : "Una vez"
                }${s.pauseUntil ? `, PAUSADO hasta ${s.pauseUntil}` : ""}): ${s.message}`
            )
            .join("\n");
      } else {
        out += "⏰ Rutinas y Recordatorios Programados: Ninguno activo.";
      }
      return out.trim();
    }
    case "schedule_whatsapp_message": {
      const resolved = resolveContactTarget(args.target);
      if (!resolved.ok && resolved.ambiguous) {
        return resolved.error;
      }
      const targetStr = resolved.ok ? resolved.jid.split("@")[0] : args.target;
      const newItem = {
        id: Date.now().toString(36),
        target: targetStr,
        contactName: resolved.canonicalName || args.target,
        message: args.message,
        time: args.time,
        specificDate: args.specificDate || null,
        recurring: Boolean(args.recurring),
        useAI: Boolean(args.useAI),
        pauseUntil: null,
        active: true,
        lastSentDate: null,
      };
      schedules.push(newItem);
      saveSchedules();
      return `Rutina programada exitosamente (ID ${newItem.id}) para '${newItem.contactName}' a las ${newItem.time} (${
        newItem.recurring ? "todos los días" : newItem.specificDate ? `el día ${newItem.specificDate}` : "una sola vez"
      }, modo: ${newItem.useAI ? "redacción con estilo de Carlos" : "mensaje literal"}).`;
    }
    case "pause_or_cancel_routine": {
      const filter = String(args?.target || "").toLowerCase().trim();
      const isMomFilter = ["mamá", "mama", "paula", "pechy", "madre"].includes(filter);
      const pauseUntil = args?.pauseUntil ? String(args.pauseUntil).trim() : null;
      let count = 0;

      for (const s of schedules) {
        if (!s.active) continue;
        const sTarget = String(s.target || "").toLowerCase();
        const sName = String(s.contactName || "").toLowerCase();
        const sMsg = String(s.message || "").toLowerCase();
        const matches =
          !filter ||
          sTarget.includes(filter) ||
          sName.includes(filter) ||
          sMsg.includes(filter) ||
          (isMomFilter && (sTarget.includes("3046497549") || sName.includes("paula") || sName.includes("pechy")));

        if (matches) {
          if (pauseUntil) {
            s.pauseUntil = pauseUntil;
          } else {
            s.active = false;
          }
          count++;
        }
      }
      saveSchedules();
      if (pauseUntil) {
        return `Se pausaron ${count} rutina(s) hasta el ${pauseUntil}. No se enviarán mensajes hasta esa fecha.`;
      }
      return `Se cancelaron/desactivaron ${count} rutina(s) o recordatorio(s).`;
    }
    case "send_whatsapp_message": {
      const resolved = resolveContactTarget(args.target);
      if (!resolved.ok) {
        return resolved.error;
      }
      await safeSendMessage(resolved.jid, { text: String(args.message) });
      return `Mensaje enviado exitosamente a ${resolved.canonicalName} (${resolved.jid.split("@")[0]}): "${args.message}"`;
    }
    case "save_contact_alias": {
      let digits = String(args.number || "").replace(/\D/g, "");
      if (digits.length === 10 && digits.startsWith("3")) digits = "57" + digits;
      if (digits.length < 10) return "Número de teléfono inválido.";
      const jid = `${digits}@s.whatsapp.net`;
      const cleanName = String(args.name || "").toLowerCase().trim();
      cloudState.learnedContacts[cleanName] = jid;
      saveCloudState();
      return `Contacto '${args.name}' guardado permanentemente con el número +${digits}.`;
    }
    case "set_current_location": {
      cloudState.currentLocation = {
        ...cloudState.currentLocation,
        placeName: args.placeName,
        updatedAt: new Date().toISOString(),
      };
      saveCloudState();
      return `Ubicación actual actualizada a: ${args.placeName}.`;
    }
    default:
      return `Herramienta ${name} no reconocida.`;
  }
}

// --- LLAMADA RESILIENTE A GEMINI CON SOPORTE DE FUNCTION CALLING Y CASCADA DE MODELOS ---
async function callGeminiWithFallback(systemPrompt, geminiContents, enableTools = false) {
  if (!GEMINI_API_KEY) return { ok: false, error: "Sin GEMINI_API_KEY" };

  const modelsToTry = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
  let lastError = "";

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [...geminiContents],
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
        console.warn(lastError);
        if (res.status === 503 || res.status === 429) await sleep(1200);
        continue;
      }

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const fnCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

      if (fnCalls.length > 0) {
        const toolResponseParts = [];
        for (const fc of fnCalls) {
          const toolResult = await executeCloudToolCall(fc.name, fc.args || {});
          toolResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: { result: toolResult },
            },
          });
        }

        const followUpContents = [
          ...geminiContents,
          { role: "model", parts },
          { role: "user", parts: toolResponseParts },
        ];

        const res2 = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: followUpContents,
            tools: [{ functionDeclarations: CLOUD_TOOLS_DECLARATIONS }],
          }),
        });

        if (res2.ok) {
          const data2 = await res2.json();
          const finalText = (data2?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || "")
            .join("\n")
            .trim();
          if (finalText) return { ok: true, text: finalText };
        }
        const directSummary = toolResponseParts.map((tr) => tr.functionResponse.response.result).join("\n");
        return { ok: true, text: directSummary };
      }

      const text = parts.map((p) => p.text || "").join("\n").trim();
      if (text) {
        return { ok: true, text };
      }
    } catch (e) {
      lastError = `Gemini (${modelName}) Error: ${e.message}`;
      console.error(lastError);
    }
  }
  return { ok: false, error: lastError };
}

// --- CEREBRO PRINCIPAL DE LILA EN LA NUBE (Para conversar con el Señor Carlos) ---
async function askLilaCloudAI(userPrompt, jid = "default", allowTools = true) {
  const { dateStr, timeStr, readable } = getColombiaNowParts();
  const locStr = cloudState.currentLocation?.placeName
    ? `Ubicación actual conocida del Señor Carlos: ${cloudState.currentLocation.placeName}.`
    : "Ciudades habituales del Señor Carlos: Riohacha y Hatonuevo (La Guajira, Colombia).";

  const systemPrompt =
    "Eres LILA, el asistente personal de inteligencia artificial creado y desarrollado exclusivamente por el Señor Carlos (estudiante de Ingeniería de Sistemas).\n" +
    "=== REGLAS INQUEBRANTABLES DE IDENTIDAD, ORTOGRAFÍA Y ACCIÓN ===\n" +
    "1. Tu único nombre es LILA. NUNCA digas 'LILA 2.0', NUNCA menciones a 'J.A.R.V.I.S.' y NUNCA digas que fuiste creada por Google ni por otra empresa. Tu único creador es el Señor Carlos.\n" +
    "2. Dirígete siempre al usuario como 'Señor' o 'Señor Carlos'.\n" +
    "3. ORTOGRAFÍA IMPECABLE: Escribe siempre con ortografía perfecta en español (todas las tildes correctas, signos de apertura y cierre ¿? y ¡!, y puntuación impecable).\n" +
    "4. PROHIBIDO PEDIR CONFIRMACIÓN PARA AGENDAR: Cuando el Señor Carlos mencione que tiene una exposición, parcial, examen, entrega o compromiso para cierto día (ej. 'para el viernes tengo una exposición' o 'la otra semana tengo X cosa'), NUNCA preguntes '¿desea que lo registre?'. Invoca DE INMEDIATO la herramienta `add_agenda_event` calculando la fecha exacta y confírmale que ya quedó agendado con sus 3 recordatorios automáticos (3 días antes, 1 día antes y el mismo día).\n" +
    "5. FAMILIA Y CONTACTOS DEL SEÑOR CARLOS:\n" +
    "   - Su mamá se llama Paula y él también le dice 'Pechy'. Él le habla con tono natural, sobrio y respetuoso (ej. 'Hola Pechy, buenos días, ¿cómo amaneciste?'). Jamás uses términos como 'mi amor' o 'cariño'.\n" +
    "   - Tiene dos hermanas: Nelly y Perla. Si pide escribirle a 'mi hermana' sin especificar cuál, pregúntale siempre si se refiere a Nelly o a Perla.\n" +
    `6. CONTEXTO TEMPORAL Y GEOGRÁFICO ACTUAL: Hoy es ${readable} (${dateStr}), hora actual en Colombia: ${timeStr}. ${locStr}`;

  const history = chatHistoryByJid.get(jid) || [];
  const geminiContents = [
    ...history.map((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.text }],
    })),
    { role: "user", parts: [{ text: userPrompt }] },
  ];

  const gemRes = await callGeminiWithFallback(systemPrompt, geminiContents, allowTools);
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
        if (text && text.trim()) {
          const cleanReply = text.trim();
          if (jid !== "routine") {
            history.push({ role: "user", text: userPrompt });
            history.push({ role: "assistant", text: cleanReply });
            if (history.length > 14) history.splice(0, history.length - 14);
            chatHistoryByJid.set(jid, history);
          }
          return cleanReply;
        }
      }
    } catch (e) {
      console.error("Error Groq Cloud:", e.message);
    }
  }

  return `Señor Carlos, el nodo en la nube está activo, pero los proveedores de IA devolvieron error temporal (${gemRes.error || "sin conexión"}).`;
}

// --- GENERADOR BLINDADO CON EL ESTILO PERSONAL DE CARLOS (Para rutinas hacia contactos) ---
async function generateSafeRoutineMessage(target, instruction) {
  const targetLower = String(target || "").toLowerCase();
  const isMom =
    targetLower.includes("3046497549") ||
    ["mamá", "mama", "paula", "pechy", "madre"].some((k) => targetLower.includes(k));

  const FALLBACK_GREETING = isMom
    ? "Hola Pechy, buenos días, ¿cómo amaneciste?"
    : "Hola, buenos días, ¿cómo amaneciste?";

  const styleRules = isMom
    ? "Estás redactando un mensaje de WhatsApp de parte de Carlos para su mamá (que se llama Paula y él le dice 'Pechy' o 'Paula'). " +
      "Carlos NO es empalagoso ni excesivamente cariñoso; habla normal, natural y sobrio. " +
      "Ejemplos exactos de cómo saluda Carlos a su mamá: 'Hola Pechy, buenos días, ¿cómo amaneciste?' o 'Hola Paula, buenos días, ¿cómo estás?'. " +
      "PROHIBIDO ESTRICTAMENTE usar frases como 'mi amor', 'cariño', 'corazón', 'mami linda', 'un abrazo muy grande' o signos de exclamación exagerados."
    : "Estás redactando un mensaje de WhatsApp en primera persona como si fueras Carlos. " +
      "Usa un tono natural, directo, sobrio y sin ser cursi. PROHIBIDO usar 'mi amor' o 'cariño'.";

  const sys =
    `${styleRules}\n` +
    "REGLA DE ORTOGRAFÍA: Usa siempre una ortografía impecable en español (todas las tildes como en 'días', 'cómo', 'estás', y signos ¿? completos).\n" +
    "Devuelve ÚNICAMENTE el texto del mensaje final sin comillas ni explicaciones.";

  const prompt = `Instrucción del mensaje: ${instruction}`;

  const gemRes = await callGeminiWithFallback(sys, [{ role: "user", parts: [{ text: prompt }] }], false);
  if (gemRes.ok && gemRes.text) {
    const candidate = gemRes.text.replace(/^["']|["']$/g, "").trim();
    const looksInvalid =
      /señor carlos|nodo en la nube|http\s*\d{3}|error|api_key|proveedores de ia|mi amor|cariño|corazón/i.test(
        candidate
      );
    if (candidate && !looksInvalid) {
      return candidate;
    }
  }

  return FALLBACK_GREETING;
}

// --- INICIALIZACIÓN DE WHATSAPP (Baileys) + SOLUCIÓN A "ESPERANDO MENSAJE" EN ANDROID ---
function ingestContactsList(contactsArray) {
  if (!Array.isArray(contactsArray)) return;
  let updated = false;
  for (const c of contactsArray) {
    const jid = c?.id;
    if (!jid || (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@c.us"))) continue;
    const normalizedJid = jid.replace("@c.us", "@s.whatsapp.net");
    const names = [c.name, c.notify, c.verifiedName, c.shortName].filter(Boolean);
    for (const rawName of names) {
      const clean = String(rawName).toLowerCase().trim();
      if (clean && clean.length >= 2 && clean !== "hermana") {
        cloudState.learnedContacts[clean] = normalizedJid;
        updated = true;
      }
    }
  }
  if (updated) saveCloudState();
}

// Limpia sesiones Signal desincronizadas de despliegues anteriores conservando creds.json (nunca pide QR pero renueva llaves con el celular)
let cleanedStaleSessionsOnBoot = false;
function cleanStaleSignalSessionsOnce(authFolder) {
  if (cleanedStaleSessionsOnBoot) return;
  cleanedStaleSessionsOnBoot = true;
  try {
    if (!fs.existsSync(authFolder)) return;
    const files = fs.readdirSync(authFolder);
    for (const file of files) {
      if (file.startsWith("session-") || file.startsWith("sender-key-")) {
        try {
          fs.unlinkSync(path.join(authFolder, file));
        } catch (_) {}
      }
    }
    console.log("[LILA] 🔄 Llaves de sesión Signal renovadas para evitar 'Esperando mensaje' en el teléfono.");
  } catch (e) {
    console.error("Error limpiando sesiones Signal:", e.message);
  }
}

async function startWhatsApp() {
  const authFolder = path.join(__dirname, "auth_info_baileys");
  cleanStaleSignalSessionsOnce(authFolder);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
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
    markOnlineOnConnect: false,
    msgRetryCounterCache,
    patchMessageBeforeSending: (message) => {
      const requiresPatch = Boolean(
        message.buttonsMessage || message.templateMessage || message.listMessage
      );
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        };
      }
      return message;
    },
    getMessage: async (key) => {
      if (key?.id && sentMessagesCache.has(key.id)) {
        return sentMessagesCache.get(key.id);
      }
      return undefined;
    },
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("contacts.upsert", (contacts) => ingestContactsList(contacts));
  sock.ev.on("contacts.update", (contacts) => ingestContactsList(contacts));
  sock.ev.on("chats.upsert", (chats) => ingestContactsList(chats));

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionStatus = "qr_ready";
      latestQrDataUrl = await QRCode.toDataURL(qr);
      console.log("[LILA] Nuevo código QR generado. Ábrelo en /qr para vincular.");
    }
    if (connection === "open") {
      connectionStatus = "connected";
      latestQrDataUrl = null;
      connectedNumber = sock.user?.id?.split(":")[0] || "Conectado";
      console.log(`[LILA] ✅ WhatsApp conectado exitosamente (${connectedNumber})`);
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      console.log(`[LILA] Conexión cerrada (código ${statusCode}). Reconectando: ${shouldReconnect}`);
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
    for (const msg of messages) {
      if (msg?.key?.fromMe && msg?.message) {
        rememberSentMessage(msg);
      }
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

      const locMsg = msg.message.locationMessage || msg.message.liveLocationMessage;
      if (locMsg && isOwnerOrSelf) {
        const lat = locMsg.degreesLatitude;
        const lon = locMsg.degreesLongitude;
        const detected = classifyLocation(lat, lon) || locMsg.name || `Coordenadas (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
        cloudState.currentLocation = {
          placeName: detected,
          lat,
          lon,
          wifiSsid: null,
          updatedAt: new Date().toISOString(),
        };
        saveCloudState();
        await safeSendMessage(remoteJid, {
          text: `🤖 *LILA:* Ubicación actualizada, Señor Carlos. Veo que se encuentra en *${detected}*.`,
        });
        continue;
      }

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
        inboxMessages.push({
          from: pushName,
          jid: remoteJid,
          body: text,
          time: nowCol,
          timestamp: Date.now(),
        });
        if (inboxMessages.length > 50) inboxMessages.shift();
      }

      const cleanText = text.trim();
      if (cleanText.startsWith("🤖 *LILA:*")) continue;

      const isCommandForLila = /^lila[,:\s]+/i.test(cleanText);
      if (isCommandForLila && isOwnerOrSelf) {
        const query = cleanText.replace(/^lila[,:\s]+/i, "").trim();
        if (query) {
          const reply = await askLilaCloudAI(query, "owner_self", true);
          await safeSendMessage(remoteJid, { text: `🤖 *LILA:* ${reply}` });
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
    return res.status(401).json({ error: "No autorizado. Token LILA_SECRET_KEY inválido." });
  }
  next();
}

// --- EVALUADOR DE RUTINAS, PAUSAS Y RECORDATORIOS ESCALONADOS + VIGÍA DE GMAIL ---
async function evaluateSchedules() {
  if (connectionStatus !== "connected" || !sock) return;
  const { dateStr: todayStr, timeStr: currentHHMM } = getColombiaNowParts();

  let changed = false;
  for (const item of schedules) {
    if (!item.active) continue;

    if (item.pauseUntil && todayStr < item.pauseUntil) {
      continue;
    }
    if (item.pauseUntil && todayStr >= item.pauseUntil) {
      item.pauseUntil = null;
      changed = true;
    }

    if (item.specificDate && item.specificDate !== todayStr) {
      continue;
    }

    if (item.time <= currentHHMM && item.lastSentDate !== todayStr) {
      const jid = toWhatsAppJid(item.target);
      if (!jid) continue;

      let finalMessage = item.message;
      if (item.useAI) {
        finalMessage = await generateSafeRoutineMessage(item.target, item.message);
      }

      try {
        await safeSendMessage(jid, { text: finalMessage });
        item.lastSentDate = todayStr;
        if (!item.recurring) {
          item.active = false;
        }
        changed = true;
        console.log(`[LILA] ✅ Rutina/Recordatorio enviado hacia ${jid}: ${finalMessage}`);
      } catch (e) {
        console.error("Error ejecutando rutina:", e.message);
      }
    }
  }
  if (changed) saveSchedules();
}

async function pollGmailProactively() {
  if (connectionStatus !== "connected" || !sock) return;
  const ownerJid = toWhatsAppJid(OWNER_PHONE || connectedNumber);
  if (!ownerJid) return;

  const accounts = [];
  if (cloudState.gmailOAuth?.Personal) accounts.push(["Personal", cloudState.gmailOAuth.Personal]);
  if (cloudState.gmailOAuth?.Uniguajira) accounts.push(["Uniguajira", cloudState.gmailOAuth.Uniguajira]);

  for (const [accName, creds] of accounts) {
    try {
      const res = await queryGmailAccountLive(accName, creds, "is:unread newer_than:1d", 3);
      if (res && res.emails.length > 0) {
        for (const email of res.emails) {
          if (!cloudState.notifiedEmailIds.includes(email.id)) {
            cloudState.notifiedEmailIds.push(email.id);
            if (cloudState.notifiedEmailIds.length > 100) cloudState.notifiedEmailIds.shift();
            saveCloudState();

            recentEmails.push({
              from: email.from,
              subject: email.subject,
              snippet: email.snippet,
              account: accName,
              time: new Date().toISOString(),
            });
            if (recentEmails.length > 20) recentEmails.shift();

            const summary = await askLilaCloudAI(
              `Acaba de llegar un correo nuevo a la cuenta '${accName}' del Señor Carlos.\nDe: ${email.from}\nAsunto: ${email.subject}\nContenido: ${email.snippet}\nRedacta un aviso breve y directo de máximo 2 líneas con ortografía impecable.`,
              "routine",
              false
            );
            await safeSendMessage(ownerJid, {
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

setInterval(() => {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || "https://lila-server-1.onrender.com";
  fetch(`${selfUrl}/ping`).catch(() => {});
}, 10 * 60 * 1000);

// --- RUTAS HTTP DEL SERVIDOR ---

app.get("/ping", async (req, res) => {
  await evaluateSchedules();
  res.json({
    ok: true,
    service: "LILA Cloud",
    whatsapp: connectionStatus,
    connectedNumber,
    location: cloudState.currentLocation?.placeName || "Riohacha / Hatonuevo",
    gmailSynced: {
      Personal: Boolean(cloudState.gmailOAuth?.Personal),
      Uniguajira: Boolean(cloudState.gmailOAuth?.Uniguajira),
    },
    inboxCount: inboxMessages.length,
    activeSchedules: schedules.filter((s) => s.active).length,
    agendaTasksCount: cloudState.agendaTasks.filter((t) => !t.completed).length,
  });
});

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
    const { contacts, gmailOAuth, location, emails, agendaTasks } = req.body || {};
    if (contacts && typeof contacts === "object") {
      for (const [k, v] of Object.entries(contacts)) {
        const cleanK = String(k).toLowerCase().trim();
        if (cleanK && cleanK !== "hermana" && v) {
          let digits = String(v).replace(/\D/g, "");
          if (digits.length === 10 && digits.startsWith("3")) digits = "57" + digits;
          if (digits.length >= 10) {
            cloudState.learnedContacts[cleanK] = `${digits}@s.whatsapp.net`;
          }
        }
      }
    }
    if (gmailOAuth && typeof gmailOAuth === "object") {
      if (gmailOAuth.Personal) cloudState.gmailOAuth.Personal = gmailOAuth.Personal;
      if (gmailOAuth.Uniguajira) cloudState.gmailOAuth.Uniguajira = gmailOAuth.Uniguajira;
    }
    if (location && typeof location === "object") {
      const detected =
        location.placeName ||
        classifyLocation(Number(location.lat), Number(location.lon), location.wifiSsid);
      if (detected) {
        cloudState.currentLocation = {
          placeName: detected,
          lat: location.lat ?? cloudState.currentLocation.lat,
          lon: location.lon ?? cloudState.currentLocation.lon,
          wifiSsid: location.wifiSsid || cloudState.currentLocation.wifiSsid,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    if (Array.isArray(emails)) {
      for (const em of emails) {
        if (em?.subject && !recentEmails.some((r) => r.subject === em.subject && r.from === em.from)) {
          recentEmails.push({
            from: em.from,
            subject: em.subject,
            snippet: em.snippet || "",
            account: em.account || "Gmail",
            time: new Date().toISOString(),
          });
        }
      }
      if (recentEmails.length > 20) recentEmails.splice(0, recentEmails.length - 20);
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
      currentLocation: cloudState.currentLocation,
      gmailSynced: {
        Personal: Boolean(cloudState.gmailOAuth?.Personal),
        Uniguajira: Boolean(cloudState.gmailOAuth?.Uniguajira),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/location", requireAuth, (req, res) => {
  const { lat, lon, wifiSsid, placeName } = req.body || {};
  const detected =
    placeName ||
    classifyLocation(Number(lat), Number(lon), wifiSsid) ||
    (lat && lon ? `Coordenadas (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})` : "Riohacha, La Guajira");
  cloudState.currentLocation = {
    placeName: detected,
    lat: lat ? Number(lat) : null,
    lon: lon ? Number(lon) : null,
    wifiSsid: wifiSsid || null,
    updatedAt: new Date().toISOString(),
  };
  saveCloudState();
  res.json({ ok: true, currentLocation: cloudState.currentLocation });
});

app.get("/qr", requireAuth, (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`
      <html><body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;">
        <h1 style="color:#4ade80;">✅ LILA Cloud WhatsApp Conectado 24/7</h1>
        <p>Número vinculado: <b>+${connectedNumber}</b></p>
        <p>Ya puedes cerrar esta ventana. Tu portátil gastará 0 MB de RAM y nunca se abrirán ventanas al enviar mensajes.</p>
      </body></html>
    `);
  }
  if (latestQrDataUrl) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="15"></head>
      <body style="background:#0f0f17;color:#fff;font-family:sans-serif;text-align:center;padding-top:40px;">
        <h2 style="color:#ec4899;">📱 Vincula tu WhatsApp con LILA</h2>
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
        error: `WhatsApp en la nube aún no está vinculado (estado: ${connectionStatus}).`,
      });
    }
    const target = req.body.contact || req.body.number;
    const message = req.body.message;
    if (!target || !message) {
      return res.status(400).json({ success: false, error: "Faltan parámetros 'contact'/'number' o 'message'." });
    }
    const resolved = resolveContactTarget(target);
    if (!resolved.ok) {
      return res.status(400).json({
        success: false,
        ambiguous: Boolean(resolved.ambiguous),
        error: resolved.error,
      });
    }
    await safeSendMessage(resolved.jid, { text: String(message) });
    return res.json({ success: true, to: resolved.jid, contactName: resolved.canonicalName });
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
  const { target, message, time, specificDate = null, recurring = false, useAI = false } = req.body;
  if (!target || !message || !time) {
    return res.status(400).json({ success: false, error: "Se requieren 'target', 'message' y 'time' (HH:MM)." });
  }
  const resolved = resolveContactTarget(target);
  if (!resolved.ok && resolved.ambiguous) {
    return res.status(400).json({ success: false, ambiguous: true, error: resolved.error });
  }
  const newItem = {
    id: Date.now().toString(36),
    target: resolved.ok ? resolved.jid.split("@")[0] : target,
    contactName: resolved.canonicalName || target,
    message,
    time,
    specificDate: specificDate || null,
    recurring: Boolean(recurring),
    useAI: Boolean(useAI),
    pauseUntil: null,
    active: true,
    lastSentDate: null,
  };
  schedules.push(newItem);
  saveSchedules();
  res.json({ success: true, schedule: newItem });
});

app.post("/agenda", requireAuth, (req, res) => {
  const { title, dueDate, dueTime = "07:00", notes = "" } = req.body || {};
  if (!title || !dueDate) {
    return res.status(400).json({ success: false, error: "Se requieren 'title' y 'dueDate' (YYYY-MM-DD)." });
  }
  const result = createAgendaEventWithReminders({ title, dueDate, dueTime, notes });
  res.json({ success: true, ...result });
});

app.get("/schedules", requireAuth, (req, res) => {
  res.json({
    schedules: schedules.filter((s) => s.active),
    agendaTasks: cloudState.agendaTasks.filter((t) => !t.completed),
  });
});

app.post("/schedule/cancel", requireAuth, (req, res) => {
  const target = String(req.body.target || "").toLowerCase().trim();
  const contact = String(req.body.contact || "").toLowerCase().trim();
  const pauseUntil = req.body.pauseUntil ? String(req.body.pauseUntil).trim() : null;
  const filter = target || contact;
  const isMomFilter = ["mamá", "mama", "paula", "pechy", "madre"].includes(filter);
  let removed = 0;

  for (const s of schedules) {
    if (!s.active) continue;
    const sTarget = String(s.target || "").toLowerCase();
    const sName = String(s.contactName || "").toLowerCase();
    const sMsg = String(s.message || "").toLowerCase();
    const matches =
      !filter ||
      sTarget.includes(filter) ||
      sName.includes(filter) ||
      sMsg.includes(filter) ||
      (isMomFilter && (sTarget.includes("3046497549") || sName.includes("paula") || sName.includes("pechy")));

    if (matches) {
      if (pauseUntil) {
        s.pauseUntil = pauseUntil;
      } else {
        s.active = false;
      }
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

    const ownerJid = toWhatsAppJid(OWNER_PHONE || connectedNumber);
    if (!ownerJid || connectionStatus !== "connected" || !sock) {
      return res.status(503).json({ success: false, error: "WhatsApp no conectado para enviar alerta." });
    }
    const summary = await askLilaCloudAI(
      `Llegó un correo nuevo a la cuenta '${account}' del Señor Carlos.\nDe: ${from}\nAsunto: ${subject}\nContenido: ${snippet}\nHaz un aviso de máximo 2 líneas con ortografía impecable para enviárselo por WhatsApp.`,
      "routine",
      false
    );
    await safeSendMessage(ownerJid, {
      text: `📧 *Nuevo Correo (${account})*\n*De:* ${from}\n*Asunto:* ${subject}\n\n🤖 *LILA:* ${summary}`,
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[LILA] 🚀 Servidor activo en el puerto ${PORT}`);
  startWhatsApp().catch((err) => console.error("Error iniciando WhatsApp:", err));
});
