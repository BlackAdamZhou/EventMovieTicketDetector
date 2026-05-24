const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const TIME_ZONE = "Australia/Sydney";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TELEGRAM_DEFAULT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120);
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX || 10);
const AUTH_COOKIE_NAME = "movie_ticket_admin";
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";

const UPCOMING_DAYS = 31;

const CINEMA_CATALOG = [
  {
    key: "imax-sydney",
    name: "IMAX Sydney",
    url: "https://www.eventcinemas.com.au/Cinema/IMAX-Sydney/NowShowing",
    comingSoonUrl: "https://www.eventcinemas.com.au/Cinema/IMAX-Sydney/ComingSoon"
  },
  {
    key: "george-street",
    name: "George Street",
    url: "https://www.eventcinemas.com.au/Cinema/George-Street/Sessions",
    comingSoonUrl: "https://www.eventcinemas.com.au/Cinema/George-Street/ComingSoon"
  }
];
const DEFAULT_CINEMA_KEYS = CINEMA_CATALOG.map((cinema) => cinema.key);

const SCHEDULE_RULES = [
  { weekday: "Tuesday", hour: 6, minute: 0 },
  { weekday: "Thursday", hour: 6, minute: 0 }
];

let scheduleState = {
  timer: null,
  lastRunKey: ""
};

const rateLimitBuckets = new Map();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      movies: [],
      settings: {
        telegramBotToken: TELEGRAM_DEFAULT_TOKEN,
        telegramChatId: TELEGRAM_DEFAULT_CHAT_ID,
        selectedCinemaKeys: DEFAULT_CINEMA_KEYS
      },
      upcomingMovies: [],
      upcomingMoviesUpdatedAt: "",
      logs: [],
      sentNotifications: {}
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  parsed.movies = Array.isArray(parsed.movies) ? parsed.movies : [];
  parsed.settings = parsed.settings || {};
  parsed.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
  parsed.sentNotifications = parsed.sentNotifications || {};
  parsed.upcomingMovies = Array.isArray(parsed.upcomingMovies) ? parsed.upcomingMovies : [];
  parsed.upcomingMoviesUpdatedAt = parsed.upcomingMoviesUpdatedAt || "";
  parsed.settings.selectedCinemaKeys = getValidCinemaKeys(parsed.settings.selectedCinemaKeys);
  if (!parsed.settings.telegramBotToken && TELEGRAM_DEFAULT_TOKEN) {
    parsed.settings.telegramBotToken = TELEGRAM_DEFAULT_TOKEN;
  }
  if (!parsed.settings.telegramChatId && TELEGRAM_DEFAULT_CHAT_ID) {
    parsed.settings.telegramChatId = TELEGRAM_DEFAULT_CHAT_ID;
  }
  return parsed;
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function hashAdminToken(token, salt) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${token}`)
    .digest("hex");
}

function createAdminToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function ensureAdminCredentials() {
  if (ADMIN_TOKEN) {
    return;
  }

  const store = readStore();
  if (store.settings.adminTokenHash && store.settings.adminTokenSalt) {
    return;
  }

  const token = createAdminToken();
  const salt = crypto.randomBytes(16).toString("hex");
  store.settings.adminTokenHash = hashAdminToken(token, salt);
  store.settings.adminTokenSalt = salt;
  writeStore(store);

  console.warn("Generated ADMIN_TOKEN for this instance:");
  console.warn(token);
  console.warn("Set ADMIN_TOKEN explicitly in production to avoid losing access if data is reset.");
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyAdminToken(token) {
  const candidate = String(token || "").trim();
  if (!candidate) {
    return false;
  }

  if (ADMIN_TOKEN) {
    return timingSafeEqualString(candidate, ADMIN_TOKEN);
  }

  const store = readStore();
  const salt = store.settings.adminTokenSalt;
  const expectedHash = store.settings.adminTokenHash;
  if (!salt || !expectedHash) {
    return false;
  }
  return timingSafeEqualString(hashAdminToken(candidate, salt), expectedHash);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getPresentedAdminToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  if (req.headers["x-admin-token"]) {
    return String(req.headers["x-admin-token"]).trim();
  }

  return "";
}

function isAuthorized(req) {
  return verifyAdminToken(getPresentedAdminToken(req)) || verifyAdminSession(req);
}

function getSessionSecret() {
  if (ADMIN_TOKEN) {
    return `env:${ADMIN_TOKEN}`;
  }

  const store = readStore();
  return `store:${store.settings.adminTokenSalt || ""}:${store.settings.adminTokenHash || ""}`;
}

function createAdminSessionCookie() {
  const createdAt = String(Date.now());
  const signature = crypto
    .createHmac("sha256", getSessionSecret())
    .update(createdAt)
    .digest("base64url");
  return `${createdAt}.${signature}`;
}

function verifyAdminSession(req) {
  const cookies = parseCookies(req);
  const session = cookies[AUTH_COOKIE_NAME] || "";
  const [createdAt, signature] = session.split(".");
  const createdAtNumber = Number(createdAt);

  if (!createdAt || !signature || !Number.isFinite(createdAtNumber)) {
    return false;
  }

  const maxAgeMs = 12 * 60 * 60 * 1000;
  if (Date.now() - createdAtNumber > maxAgeMs) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", getSessionSecret())
    .update(createdAt)
    .digest("base64url");

  return timingSafeEqualString(signature, expected);
}

function getClientIp(req) {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(key, maxRequests) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    return { allowed: true, remaining: Math.max(0, maxRequests - 1), retryAfter: 0 };
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - bucket.count),
    retryAfter: 0
  };
}

function applyRateLimit(req, res, reqUrl) {
  const ip = getClientIp(req);
  const globalLimit = checkRateLimit(`global:${ip}`, RATE_LIMIT_MAX);
  if (!globalLimit.allowed) {
    sendRateLimitExceeded(res, globalLimit.retryAfter);
    return false;
  }

  if (req.method === "POST" && reqUrl.pathname === "/login") {
    const loginLimit = checkRateLimit(`login:${ip}`, LOGIN_RATE_LIMIT_MAX);
    if (!loginLimit.allowed) {
      sendRateLimitExceeded(res, loginLimit.retryAfter);
      return false;
    }
  }

  return true;
}

function sendRateLimitExceeded(res, retryAfter) {
  res.writeHead(429, {
    "content-type": "text/plain; charset=utf-8",
    "retry-after": String(retryAfter),
    "cache-control": "no-store"
  });
  res.end("Too Many Requests");
}

function pruneRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now >= bucket.resetAt) {
      rateLimitBuckets.delete(key);
    }
  }
}

function addLog(message, level = "info") {
  const store = readStore();
  store.logs.unshift({
    id: createId(),
    level,
    message,
    createdAt: new Date().toISOString()
  });
  store.logs = store.logs.slice(0, 80);
  writeStore(store);
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTitle(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getValidCinemaKeys(value) {
  const incoming = Array.isArray(value) ? value : [value].filter(Boolean);
  const allowed = new Set(CINEMA_CATALOG.map((cinema) => cinema.key));
  const selected = incoming
    .map((item) => String(item || "").trim())
    .filter((item) => allowed.has(item));
  return selected.length > 0 ? Array.from(new Set(selected)) : DEFAULT_CINEMA_KEYS;
}

function getSelectedCinemas(store) {
  const selectedKeys = getValidCinemaKeys(store.settings && store.settings.selectedCinemaKeys);
  const selectedSet = new Set(selectedKeys);
  return CINEMA_CATALOG.filter((cinema) => selectedSet.has(cinema.key));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2B;/g, "+");
}

function formatSydneyDate(date) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function getSydneyParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getNextScheduleDescription() {
  const now = new Date();
  for (let offset = 0; offset < 8 * 24 * 60; offset += 1) {
    const probe = new Date(now.getTime() + offset * 60000);
    const parts = getSydneyParts(probe);
    const match = SCHEDULE_RULES.find(
      (rule) =>
        rule.weekday === parts.weekday &&
        rule.hour === parts.hour &&
        rule.minute === parts.minute
    );
    if (match) {
      return `${parts.weekday} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} (${TIME_ZONE})`;
    }
  }
  return "未计算出下次时间";
}

async function fetchCinemaMovies(cinema) {
  const pageResponse = await fetch(cinema.url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!pageResponse.ok) {
    throw new Error(`${cinema.name} 页面请求失败: ${pageResponse.status}`);
  }

  const html = await pageResponse.text();
  const cinemaId = extractCinemaId(html);
  const apiUrl = `https://www.eventcinemas.com.au/Cinemas/GetSessions?cinemaIds=${cinemaId}`;
  const sessionsResponse = await fetch(apiUrl, {
    headers: {
      "user-agent": USER_AGENT,
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json,text/plain,*/*"
    }
  });

  if (!sessionsResponse.ok) {
    throw new Error(`${cinema.name} 场次接口请求失败: ${sessionsResponse.status}`);
  }

  const payload = await sessionsResponse.json();
  if (!payload || payload.Success !== true || !payload.Data || !Array.isArray(payload.Data.Movies)) {
    throw new Error(`${cinema.name} 场次接口返回异常`);
  }

  const dates = Array.isArray(payload.Data.Dates) ? payload.Data.Dates : [];
  const moviesByName = new Map();

  mergeMoviesByName(moviesByName, payload.Data.Movies);

  for (const date of dates) {
    if (!date || date === payload.Data.SelectedDate) {
      continue;
    }

    const datedResponse = await fetch(
      `https://www.eventcinemas.com.au/Cinemas/GetSessions?cinemaIds=${cinemaId}&date=${encodeURIComponent(date)}`,
      {
        headers: {
          "user-agent": USER_AGENT,
          "x-requested-with": "XMLHttpRequest",
          accept: "application/json,text/plain,*/*"
        }
      }
    );

    if (!datedResponse.ok) {
      throw new Error(`${cinema.name} ${date} 场次接口请求失败: ${datedResponse.status}`);
    }

    const datedPayload = await datedResponse.json();
    if (!datedPayload || datedPayload.Success !== true || !datedPayload.Data || !Array.isArray(datedPayload.Data.Movies)) {
      throw new Error(`${cinema.name} ${date} 场次接口返回异常`);
    }

    mergeMoviesByName(moviesByName, datedPayload.Data.Movies);
  }

  return {
    cinema: cinema.name,
    cinemaId,
    movies: Array.from(moviesByName.values())
  };
}

function mergeMoviesByName(moviesByName, movies) {
  for (const movie of movies) {
    const key = normalizeTitle(movie.Name);
    const existing = moviesByName.get(key);
    if (!existing) {
      moviesByName.set(key, movie);
      continue;
    }

    existing.CinemaModels = mergeCinemaModels(existing.CinemaModels, movie.CinemaModels);
  }
}

function mergeCinemaModels(existingModels, incomingModels) {
  const merged = Array.isArray(existingModels) ? [...existingModels] : [];
  const incoming = Array.isArray(incomingModels) ? incomingModels : [];

  for (const model of incoming) {
    if (!model) {
      continue;
    }

    const existing = merged.find((item) => item && item.Name === model.Name);
    if (!existing) {
      merged.push(model);
      continue;
    }

    const sessions = Array.isArray(existing.Sessions) ? [...existing.Sessions] : [];
    const knownSessionIds = new Set(sessions.map((session) => session && session.Id).filter(Boolean));

    for (const session of Array.isArray(model.Sessions) ? model.Sessions : []) {
      if (!session) {
        continue;
      }

      if (session.Id && knownSessionIds.has(session.Id)) {
        continue;
      }

      sessions.push(session);
      if (session.Id) {
        knownSessionIds.add(session.Id);
      }
    }

    existing.Sessions = sessions;
  }

  return merged;
}

function extractCinemaId(html) {
  const match = html.match(/id="Cinema_Id"[^>]*value="(\d+)"/i);
  if (!match) {
    throw new Error("未找到影院 ID");
  }
  return Number(match[1]);
}

function extractComingSoonMovies(html) {
  const patterns = [
    /data-option=["']comingsoon["'][\s\S]*?data-movies="([^"]*)"/i,
    /data-movies="([^"]*)"[\s\S]*?data-option=["']comingsoon["']/i,
    /data-movies="([^"]*)"/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) {
      continue;
    }

    const raw = decodeHtmlEntities(match[1]);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  return [];
}

function parseReleaseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinUpcomingWindow(value, now = new Date()) {
  const releaseDate = parseReleaseDate(value);
  if (!releaseDate) {
    return false;
  }

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + UPCOMING_DAYS);
  return releaseDate >= start && releaseDate <= end;
}

function formatDateOnly(value) {
  const date = parseReleaseDate(value);
  if (!date) {
    return "";
  }
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getMovieUrl(movie) {
  const url = movie.Url || movie.WebsiteUrl || movie.MovieUrl || "";
  if (!url) {
    return "";
  }
  return url.startsWith("http") ? url : `https://www.eventcinemas.com.au${url}`;
}

async function fetchCinemaComingSoonMovies(cinema) {
  const pageResponse = await fetch(cinema.comingSoonUrl || cinema.url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!pageResponse.ok) {
    throw new Error(`${cinema.name} 即将上映页面请求失败: ${pageResponse.status}`);
  }

  const html = await pageResponse.text();
  const movies = extractComingSoonMovies(html)
    .filter((movie) => movie && movie.Name && isWithinUpcomingWindow(movie.ReleasedAt))
    .map((movie) => ({
      name: movie.Name,
      releasedAt: movie.ReleasedAt || "",
      movieUrl: getMovieUrl(movie),
      cinemaKey: cinema.key,
      cinemaName: cinema.name
    }));

  return {
    cinema: cinema.name,
    movies
  };
}

function mergeUpcomingMovies(existing, incoming) {
  const merged = new Map();

  for (const movie of [...existing, ...incoming]) {
    const key = normalizeTitle(movie.name);
    if (!key) {
      continue;
    }

    const current = merged.get(key) || {
      id: createId(),
      name: movie.name,
      releasedAt: movie.releasedAt || "",
      movieUrl: movie.movieUrl || "",
      cinemas: [],
      lastSeenAt: new Date().toISOString()
    };

    if (!current.releasedAt && movie.releasedAt) {
      current.releasedAt = movie.releasedAt;
    }
    if (!current.movieUrl && movie.movieUrl) {
      current.movieUrl = movie.movieUrl;
    }
    if (movie.cinemaName && !current.cinemas.includes(movie.cinemaName)) {
      current.cinemas.push(movie.cinemaName);
    }
    current.lastSeenAt = new Date().toISOString();
    merged.set(key, current);
  }

  return Array.from(merged.values()).sort((left, right) => {
    const leftTime = parseReleaseDate(left.releasedAt)?.getTime() || Number.MAX_SAFE_INTEGER;
    const rightTime = parseReleaseDate(right.releasedAt)?.getTime() || Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime || left.name.localeCompare(right.name);
  });
}

async function refreshUpcomingMovies(store = readStore(), options = {}) {
  const shouldLog = options.log !== false;
  const selectedCinemas = getSelectedCinemas(store);
  const found = [];
  const errors = [];

  for (const cinema of selectedCinemas) {
    try {
      const payload = await fetchCinemaComingSoonMovies(cinema);
      found.push(...payload.movies);
    } catch (error) {
      errors.push(`${cinema.name}: ${error.message}`);
    }
  }

  store.upcomingMovies = mergeUpcomingMovies([], found);
  store.upcomingMoviesUpdatedAt = new Date().toISOString();
  writeStore(store);

  const message = `已刷新 ${UPCOMING_DAYS} 天内即将上映影片 ${store.upcomingMovies.length} 部`;
  if (shouldLog) {
    addLog(errors.length > 0 ? `${message}，异常 ${errors.length} 项` : message, errors.length > 0 ? "warn" : "info");
    errors.forEach((item) => addLog(item, "error"));
  }

  return {
    movies: store.upcomingMovies,
    errors,
    message
  };
}

function pickAvailableSessions(movie, cinemaName) {
  const cinemaModels = Array.isArray(movie.CinemaModels) ? movie.CinemaModels : [];
  const matchedCinema = cinemaModels.find((item) => item && item.Name === cinemaName) || cinemaModels[0];
  const sessions = matchedCinema && Array.isArray(matchedCinema.Sessions) ? matchedCinema.Sessions : [];

  return sessions.filter((session) => {
    if (!session) {
      return false;
    }
    if (typeof session.SeatsAvailable === "number") {
      return session.SeatsAvailable > 0;
    }
    return Boolean(session.BookingUrl || session.StartTime);
  });
}

function buildNotificationKey(cinemaName, movieName, session) {
  const sessionId = session && session.Id ? session.Id : `${session.StartTime || "unknown"}-${session.BookingUrl || "urlless"}`;
  return `${cinemaName}::${movieName}::${sessionId}`;
}

async function runCheck(source = "manual") {
  const store = readStore();
  const selectedCinemas = getSelectedCinemas(store);
  const preflightErrors = [];

  try {
    const upcomingResult = await refreshUpcomingMovies(store, { log: false });
    preflightErrors.push(...upcomingResult.errors);
  } catch (error) {
    preflightErrors.push(`刷新即将上映影片失败: ${error.message}`);
  }

  const monitored = store.movies.map((movie) => ({
    ...movie,
    normalizedName: normalizeTitle(movie.name)
  }));

  if (monitored.length === 0) {
    const result = {
      source,
      checkedAt: new Date().toISOString(),
      matches: [],
      errors: preflightErrors,
      message: "监测列表为空，已跳过开票检测。"
    };
    addLog(
      `[${source}] ${result.message}${preflightErrors.length > 0 ? `，异常 ${preflightErrors.length} 项` : ""}`,
      preflightErrors.length > 0 ? "error" : "warn"
    );
    preflightErrors.forEach((item) => addLog(item, "error"));
    return result;
  }

  const allMatches = [];
  const errors = [...preflightErrors];

  for (const cinema of selectedCinemas) {
    try {
      const payload = await fetchCinemaMovies(cinema);
      for (const remoteMovie of payload.movies) {
        const matchedMovie = monitored.find(
          (item) => item.normalizedName === normalizeTitle(remoteMovie.Name)
        );
        if (!matchedMovie) {
          continue;
        }

        const sessions = pickAvailableSessions(remoteMovie, cinema.name);
        if (sessions.length === 0) {
          continue;
        }

        allMatches.push({
          cinema: cinema.name,
          movieName: remoteMovie.Name,
          sessions
        });
      }
    } catch (error) {
      errors.push(`${cinema.name}: ${error.message}`);
    }
  }

  const notifications = [];
  for (const match of allMatches) {
    const firstSession = match.sessions[0];
    const notificationKey = buildNotificationKey(match.cinema, match.movieName, firstSession);
    if (store.sentNotifications[notificationKey]) {
      continue;
    }

    const sent = await sendTelegramNotification(store.settings, match).catch((error) => {
      errors.push(`${match.movieName} / ${match.cinema}: ${error.message}`);
      return false;
    });

    if (sent) {
      store.sentNotifications[notificationKey] = new Date().toISOString();
      notifications.push({
        cinema: match.cinema,
        movieName: match.movieName,
        sessionTime: firstSession.StartTime || ""
      });
    }
  }

  writeStore(store);

  const summary = [
    `[${source}] 检测完成`,
    `命中 ${allMatches.length} 部影片`,
    notifications.length > 0 ? `发送通知 ${notifications.length} 条` : "无新增通知"
  ];

  if (errors.length > 0) {
    summary.push(`异常 ${errors.length} 项`);
  }

  addLog(summary.join("，"), errors.length > 0 ? "warn" : "info");
  if (errors.length > 0) {
    errors.forEach((item) => addLog(item, "error"));
  }

  return {
    source,
    checkedAt: new Date().toISOString(),
    matches: allMatches,
    notifications,
    errors,
    message: summary.join("，")
  };
}

async function sendTelegramNotification(settings, match) {
  const token = String(settings.telegramBotToken || "").trim();
  const chatId = String(settings.telegramChatId || "").trim();
  if (!token || !chatId) {
    throw new Error("Telegram Bot Token 或 Chat ID 未配置");
  }

  const firstSession = match.sessions[0] || {};
  const lines = [
    `🎟️ 电影【${match.movieName}】已经在【${match.cinema}】开始售票啦，请尽快前往官网购买！`
  ];

  if (firstSession.StartTime) {
    lines.push(`首个发现场次：${firstSession.StartTime}`);
  }

  if (firstSession.BookingUrl) {
    lines.push(`购票链接：https://www.eventcinemas.com.au${firstSession.BookingUrl}`);
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n")
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram 推送失败: ${response.status} ${body}`);
  }

  return true;
}

function renderPage(data) {
  const selectedCinemas = getSelectedCinemas(data.store);
  const selectedCinemaKeys = new Set(selectedCinemas.map((cinema) => cinema.key));
  const movieItems = data.store.movies
    .map(
      (movie) => `
        <li class="movie-item">
          <div>
            <strong>${escapeHtml(movie.name)}</strong>
            <span class="meta">创建于 ${escapeHtml(formatSydneyDate(new Date(movie.createdAt)))}</span>
          </div>
          <form method="post" action="/movies/${encodeURIComponent(movie.id)}/delete">
            <button class="danger" type="submit">移除</button>
          </form>
        </li>
      `
    )
    .join("");

  const cinemaItems = CINEMA_CATALOG.map(
    (cinema) => `
      <label class="checkbox-row">
        <input type="checkbox" name="cinemaKeys" value="${escapeHtml(cinema.key)}" ${
          selectedCinemaKeys.has(cinema.key) ? "checked" : ""
        } />
        <span>
          <strong>${escapeHtml(cinema.name)}</strong>
          <small>${escapeHtml(cinema.url)}</small>
        </span>
      </label>
    `
  ).join("");

  const upcomingItems = data.store.upcomingMovies
    .map(
      (movie) => `
        <li class="movie-item">
          <div>
            <strong>${escapeHtml(movie.name)}</strong>
            <span class="meta">
              上映日期 ${escapeHtml(formatDateOnly(movie.releasedAt) || "未知")}
              ${movie.cinemas && movie.cinemas.length > 0 ? ` · ${escapeHtml(movie.cinemas.join(", "))}` : ""}
            </span>
            ${movie.movieUrl ? `<a class="link" href="${escapeHtml(movie.movieUrl)}" target="_blank" rel="noreferrer">查看影片页面</a>` : ""}
          </div>
          <form method="post" action="/movies">
            <input type="hidden" name="movieName" value="${escapeHtml(movie.name)}" />
            <button type="submit">添加监测</button>
          </form>
        </li>
      `
    )
    .join("");

  const logItems = data.store.logs
    .map(
      (log) => `
        <li class="log-item log-${escapeHtml(log.level)}">
          <span>${escapeHtml(formatSydneyDate(new Date(log.createdAt)))}</span>
          <span>${escapeHtml(log.message)}</span>
        </li>
      `
    )
    .join("");

  const flash = data.flash
    ? `<div class="flash ${escapeHtml(data.flash.type || "info")}">${escapeHtml(data.flash.message || "")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>电影票监测系统</title>
  <style>
    :root {
      --bg: #f4efe7;
      --panel: #fffaf4;
      --ink: #1f2933;
      --accent: #b83b24;
      --accent-dark: #8f2f1d;
      --line: #e5d6c7;
      --muted: #6b7280;
      --ok: #175f3a;
      --warn: #8c5a00;
      --error: #9b1c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(184, 59, 36, 0.16), transparent 28%),
        linear-gradient(180deg, #faf4ed 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    h1, h2, h3 { margin: 0; }
    h1 {
      font-size: 36px;
      letter-spacing: 0.02em;
      margin-bottom: 12px;
    }
    p.lead {
      margin: 0;
      color: var(--muted);
      max-width: 760px;
      line-height: 1.6;
    }
    .hero {
      background: rgba(255, 250, 244, 0.88);
      border: 1px solid rgba(229, 214, 199, 0.8);
      border-radius: 24px;
      padding: 28px;
      backdrop-filter: blur(8px);
      box-shadow: 0 20px 50px rgba(73, 43, 25, 0.08);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-top: 22px;
    }
    .card-grid {
      display: grid;
      grid-template-columns: 1.2fr 0.9fr;
      gap: 20px;
      margin-top: 22px;
    }
    .panel, .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 22px;
      box-shadow: 0 14px 40px rgba(73, 43, 25, 0.06);
    }
    .stat span {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }
    .stat strong {
      font-size: 28px;
      color: var(--accent);
    }
    form {
      margin: 0;
    }
    label {
      display: block;
      font-size: 14px;
      margin-bottom: 8px;
      color: var(--muted);
    }
    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: #fff;
      font: inherit;
      margin-bottom: 14px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 18px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      color: white;
      background: var(--accent);
    }
    button:hover {
      background: var(--accent-dark);
    }
    button.secondary {
      background: #243447;
    }
    button.danger {
      background: #7a1f1f;
    }
    input[type="checkbox"] {
      width: auto;
      margin: 0;
      accent-color: var(--accent);
    }
    input[type="hidden"] {
      display: none;
    }
    .inline-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .movie-list, .log-list {
      list-style: none;
      padding: 0;
      margin: 16px 0 0;
      display: grid;
      gap: 12px;
    }
    .movie-item, .log-item {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: white;
      padding: 14px 16px;
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
    }
    .movie-item .meta {
      display: block;
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .checkbox-row {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #fff;
      padding: 12px 14px;
      margin-bottom: 10px;
      color: var(--ink);
    }
    .checkbox-row small {
      display: block;
      color: var(--muted);
      margin-top: 4px;
      overflow-wrap: anywhere;
    }
    .link {
      display: inline-block;
      margin-top: 8px;
      color: var(--accent-dark);
      font-size: 13px;
      font-weight: 600;
    }
    .log-item {
      display: grid;
      gap: 6px;
      justify-content: stretch;
    }
    .log-info { border-left: 4px solid #2459a8; }
    .log-warn { border-left: 4px solid var(--warn); }
    .log-error { border-left: 4px solid var(--error); }
    .empty {
      color: var(--muted);
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 16px;
      margin-top: 16px;
      background: rgba(255, 255, 255, 0.5);
    }
    .flash {
      margin-top: 18px;
      border-radius: 14px;
      padding: 14px 16px;
      font-weight: 600;
    }
    .flash.info { background: #eef6ff; color: #16457a; }
    .flash.success { background: #edf8f0; color: var(--ok); }
    .flash.warn { background: #fff7e6; color: var(--warn); }
    .flash.error { background: #fdecec; color: var(--error); }
    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    @media (max-width: 860px) {
      .card-grid { grid-template-columns: 1fr; }
      h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>Event Cinema 票务监测系统</h1>
      <p class="lead">按悉尼时区定时监测你选择的 Event Cinemas 影院。系统会自动刷新 1 个月内即将上映的影片；一旦你关注的影片出现可购场次，会通过 Telegram 立即通知。</p>
      <form method="post" action="/logout" style="margin-top:16px">
        <button class="secondary" type="submit">退出登录</button>
      </form>
      ${flash}
      <div class="summary">
        <div class="stat">
          <span>监测影片数</span>
          <strong>${data.store.movies.length}</strong>
        </div>
        <div class="stat">
          <span>已选影院</span>
          <strong>${selectedCinemas.length}</strong>
        </div>
        <div class="stat">
          <span>当前悉尼时间</span>
          <strong style="font-size:18px">${escapeHtml(formatSydneyDate(new Date()))}</strong>
        </div>
        <div class="stat">
          <span>下次计划运行</span>
          <strong style="font-size:18px">${escapeHtml(getNextScheduleDescription())}</strong>
        </div>
      </div>
    </section>

    <section class="card-grid">
      <div class="panel">
        <h2>影片管理</h2>
        <p class="hint">请输入影片全名，或从下方“即将上映”列表一键加入。系统使用大小写不敏感的完整匹配进行监测。</p>
        <form method="post" action="/movies">
          <label for="movieName">影片名称</label>
          <input id="movieName" name="movieName" placeholder="例如：Mobile Suit Gundam: Hathaway" required />
          <button type="submit">添加监测影片</button>
        </form>
        ${
          movieItems
            ? `<ul class="movie-list">${movieItems}</ul>`
            : `<div class="empty">当前还没有监测影片。</div>`
        }
      </div>

      <div class="panel">
        <h2>影院选择</h2>
        <p class="hint">只会检测已勾选影院的开票状态，并按已选影院刷新即将上映影片。</p>
        <form method="post" action="/cinemas">
          ${cinemaItems}
          <button type="submit">保存影院选择</button>
        </form>
        <div class="empty" style="margin-top:16px">
          <strong>固定调度</strong><br/>
          星期二 06:00<br/>
          星期四 06:00<br/>
          <span class="hint">以上均按 ${escapeHtml(TIME_ZONE)} 执行。</span>
        </div>
      </div>
    </section>

    <section class="card-grid">
      <div class="panel">
        <h2>1 个月内即将上映</h2>
        <p class="hint">列表来自已选影院的 Coming Soon 页面。部分影院页面如果未公开结构化列表，会在日志中记录但不会影响其他影院。</p>
        <div class="inline-actions">
          <form method="post" action="/upcoming/refresh">
            <button class="secondary" type="submit">刷新即将上映影片</button>
          </form>
        </div>
        <p class="hint">最近刷新：${data.store.upcomingMoviesUpdatedAt ? escapeHtml(formatSydneyDate(new Date(data.store.upcomingMoviesUpdatedAt))) : "尚未刷新"}</p>
        ${
          upcomingItems
            ? `<ul class="movie-list">${upcomingItems}</ul>`
            : `<div class="empty">当前还没有 1 个月内即将上映影片。可点击刷新获取最新列表。</div>`
        }
      </div>

      <div class="panel">
        <h2>通知配置</h2>
        <p class="hint">Telegram Chat ID 需要你自己的接收会话 ID。Bot Token 与 Chat ID 保存到本地 data/store.json。</p>
        <form method="post" action="/settings">
          <label for="telegramBotToken">Telegram Bot Token</label>
          <input id="telegramBotToken" name="telegramBotToken" value="${escapeHtml(
            data.store.settings.telegramBotToken || ""
          )}" placeholder="8747..." />
          <label for="telegramChatId">Telegram Chat ID</label>
          <input id="telegramChatId" name="telegramChatId" value="${escapeHtml(
            data.store.settings.telegramChatId || ""
          )}" placeholder="例如：123456789" />
          <button type="submit">保存通知配置</button>
        </form>
        <div class="inline-actions">
          <form method="post" action="/check">
            <button class="secondary" type="submit">立即检测</button>
          </form>
        </div>
        <div class="empty" style="margin-top:16px">
          <strong>立即检测会同时执行</strong><br/>
          刷新 1 个月内即将上映影片<br/>
          检查监测影片是否已有可售场次
        </div>
      </div>
    </section>

    <section class="panel" style="margin-top:20px">
      <h2>运行日志</h2>
      ${
        logItems
          ? `<ul class="log-list">${logItems}</ul>`
          : `<div class="empty">暂无日志。</div>`
      }
    </section>
  </main>
</body>
</html>`;
}

function renderLoginPage(data = {}) {
  const flash = data.flash
    ? `<div class="flash ${escapeHtml(data.flash.type || "info")}">${escapeHtml(data.flash.message || "")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>登录 - 电影票监测系统</title>
  <style>
    :root {
      --bg: #eef2f6;
      --panel: #ffffff;
      --ink: #1f2933;
      --accent: #2459a8;
      --accent-dark: #183f78;
      --line: #d6dee8;
      --muted: #64748b;
      --error: #9b1c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
      padding: 24px;
    }
    main {
      width: min(420px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 18px 45px rgba(31, 41, 51, 0.08);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 24px;
    }
    p {
      margin: 0 0 22px;
      color: var(--muted);
      line-height: 1.6;
    }
    label {
      display: block;
      font-size: 14px;
      margin-bottom: 8px;
      color: var(--muted);
    }
    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--line);
      font: inherit;
      margin-bottom: 16px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 8px;
      padding: 12px 16px;
      color: #fff;
      background: var(--accent);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { background: var(--accent-dark); }
    .flash {
      margin-bottom: 16px;
      border-radius: 8px;
      padding: 12px 14px;
      background: #fdecec;
      color: var(--error);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main>
    <h1>Admin Token</h1>
    <p>访问电影票监测系统需要管理员令牌。</p>
    ${flash}
    <form method="post" action="/login">
      <label for="adminToken">Admin Token</label>
      <input id="adminToken" name="adminToken" type="password" autocomplete="current-password" required autofocus />
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const parsed = {};
      for (const [key, value] of params.entries()) {
        if (Array.isArray(parsed[key])) {
          parsed[key].push(value);
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          parsed[key] = [parsed[key], value];
          continue;
        }
        parsed[key] = value;
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: encodeURI(location) });
  res.end();
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function getFlashFromUrl(reqUrl) {
  const flash = reqUrl.searchParams.get("flash");
  const type = reqUrl.searchParams.get("type");
  if (!flash) {
    return null;
  }
  return { message: flash, type: type || "info" };
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (!applyRateLimit(req, res, reqUrl)) {
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/login") {
    if (isAuthorized(req)) {
      return redirect(res, "/");
    }
    return sendHtml(
      res,
      renderLoginPage({
        flash: getFlashFromUrl(reqUrl)
      })
    );
  }

  if (req.method === "POST" && reqUrl.pathname === "/login") {
    const body = await parseFormBody(req);
    if (!verifyAdminToken(body.adminToken)) {
      return redirect(res, "/login?type=error&flash=Admin Token 无效");
    }

    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `${AUTH_COOKIE_NAME}=${encodeURIComponent(createAdminSessionCookie())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    if (req.method === "GET" || req.method === "HEAD") {
      return redirect(res, "/login");
    }

    res.writeHead(401, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end("Unauthorized");
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/logout") {
    res.writeHead(302, {
      Location: "/login",
      "Set-Cookie": `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "cache-control": "no-store"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/") {
    const store = readStore();
    return sendHtml(
      res,
      renderPage({
        store,
        flash: getFlashFromUrl(reqUrl)
      })
    );
  }

  if (req.method === "POST" && reqUrl.pathname === "/movies") {
    const body = await parseFormBody(req);
    const name = String(body.movieName || "").trim();
    if (!name) {
      return redirect(res, "/?type=error&flash=影片名称不能为空");
    }

    const store = readStore();
    const exists = store.movies.some(
      (item) => normalizeTitle(item.name) === normalizeTitle(name)
    );
    if (exists) {
      return redirect(res, "/?type=warn&flash=该影片已在监测列表中");
    }

    store.movies.unshift({
      id: createId(),
      name,
      createdAt: new Date().toISOString()
    });
    writeStore(store);
    addLog(`已添加监测影片: ${name}`);
    return redirect(res, "/?type=success&flash=影片已加入监测列表");
  }

  if (req.method === "POST" && reqUrl.pathname.startsWith("/movies/") && reqUrl.pathname.endsWith("/delete")) {
    const id = decodeURIComponent(reqUrl.pathname.split("/")[2] || "");
    const store = readStore();
    const target = store.movies.find((movie) => movie.id === id);
    store.movies = store.movies.filter((movie) => movie.id !== id);
    writeStore(store);
    if (target) {
      addLog(`已移除监测影片: ${target.name}`);
    }
    return redirect(res, "/?type=success&flash=影片已移除");
  }

  if (req.method === "POST" && reqUrl.pathname === "/settings") {
    const body = await parseFormBody(req);
    const store = readStore();
    store.settings.telegramBotToken = String(body.telegramBotToken || "").trim();
    store.settings.telegramChatId = String(body.telegramChatId || "").trim();
    writeStore(store);
    addLog("Telegram 配置已更新");
    return redirect(res, "/?type=success&flash=通知配置已保存");
  }

  if (req.method === "POST" && reqUrl.pathname === "/cinemas") {
    const body = await parseFormBody(req);
    const submitted = Array.isArray(body.cinemaKeys)
      ? body.cinemaKeys
      : [body.cinemaKeys].filter(Boolean);
    const allowed = new Set(CINEMA_CATALOG.map((cinema) => cinema.key));
    const selectedCinemaKeys = Array.from(
      new Set(submitted.map((item) => String(item || "").trim()).filter((item) => allowed.has(item)))
    );

    if (selectedCinemaKeys.length === 0) {
      return redirect(res, "/?type=error&flash=请至少选择一个影院");
    }

    const store = readStore();
    store.settings.selectedCinemaKeys = selectedCinemaKeys;
    writeStore(store);
    addLog(`影院选择已更新: ${getSelectedCinemas(store).map((cinema) => cinema.name).join(", ")}`);
    return redirect(res, "/?type=success&flash=影院选择已保存");
  }

  if (req.method === "POST" && reqUrl.pathname === "/upcoming/refresh") {
    const store = readStore();
    const result = await refreshUpcomingMovies(store);
    const type = result.errors.length > 0 ? "warn" : "success";
    return redirect(res, `/?type=${type}&flash=${result.message}`);
  }

  if (req.method === "POST" && reqUrl.pathname === "/check") {
    const result = await runCheck("manual");
    return redirect(res, `/?type=success&flash=${result.message}`);
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

function shouldRunScheduledCheck(date = new Date()) {
  const parts = getSydneyParts(date);
  return SCHEDULE_RULES.some(
    (rule) =>
      rule.weekday === parts.weekday &&
      rule.hour === parts.hour &&
      rule.minute === parts.minute
  );
}

function getScheduleRunKey(date = new Date()) {
  const parts = getSydneyParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function startScheduler() {
  const tick = async () => {
    const now = new Date();
    if (!shouldRunScheduledCheck(now)) {
      return;
    }
    const runKey = getScheduleRunKey(now);
    if (scheduleState.lastRunKey === runKey) {
      return;
    }
    scheduleState.lastRunKey = runKey;
    try {
      await runCheck("scheduler");
    } catch (error) {
      addLog(`定时检测失败: ${error.message}`, "error");
    }
  };

  scheduleState.timer = setInterval(tick, 30_000);
  tick().catch((error) => addLog(`调度器初始化失败: ${error.message}`, "error"));
}

ensureStore();
ensureAdminCredentials();
addLog("服务启动完成");
setInterval(pruneRateLimitBuckets, RATE_LIMIT_WINDOW_MS).unref();
startScheduler();

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((error) => {
    addLog(`请求处理失败: ${error.message}`, "error");
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  });
});

server.listen(PORT, HOST, () => {
  addLog(`Web 服务已监听 http://localhost:${PORT}`);
});
