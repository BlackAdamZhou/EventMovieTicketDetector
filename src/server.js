const http = require("http");
const fs = require("fs");
const path = require("path");
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

const TARGET_CINEMAS = [
  {
    key: "imax-sydney",
    name: "IMAX Sydney",
    url: "https://www.eventcinemas.com.au/Cinema/IMAX-Sydney/NowShowing"
  },
  {
    key: "george-street",
    name: "George Street",
    url: "https://www.eventcinemas.com.au/Cinema/George-Street/Sessions"
  }
];

const SCHEDULE_RULES = [
  { weekday: "Tuesday", hour: 6, minute: 0 },
  { weekday: "Tuesday", hour: 23, minute: 0 },
  { weekday: "Wednesday", hour: 7, minute: 0 },
  { weekday: "Wednesday", hour: 23, minute: 0 }
];

let scheduleState = {
  timer: null,
  lastRunKey: ""
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      movies: [],
      settings: {
        telegramBotToken: TELEGRAM_DEFAULT_TOKEN,
        telegramChatId: TELEGRAM_DEFAULT_CHAT_ID
      },
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
  const monitored = store.movies.map((movie) => ({
    ...movie,
    normalizedName: normalizeTitle(movie.name)
  }));

  if (monitored.length === 0) {
    const result = {
      source,
      checkedAt: new Date().toISOString(),
      matches: [],
      message: "监测列表为空，已跳过检测。"
    };
    addLog(`[${source}] ${result.message}`, "warn");
    return result;
  }

  const allMatches = [];
  const errors = [];

  for (const cinema of TARGET_CINEMAS) {
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
      <p class="lead">按悉尼时区定时监测 <strong>IMAX Sydney</strong> 与 <strong>George Street</strong> 的影片开票情况。一旦你关注的影片出现可购场次，系统会通过 Telegram 立即通知。</p>
      ${flash}
      <div class="summary">
        <div class="stat">
          <span>监测影片数</span>
          <strong>${data.store.movies.length}</strong>
        </div>
        <div class="stat">
          <span>目标影院</span>
          <strong>${TARGET_CINEMAS.length}</strong>
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
        <p class="hint">请输入影片全名。系统使用大小写不敏感的完整匹配进行监测。</p>
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
        <h2>调度与通知</h2>
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
          <strong>固定调度</strong><br/>
          星期二 06:00 / 23:00<br/>
          星期三 07:00 / 23:00<br/>
          <span class="hint">以上均按 ${escapeHtml(TIME_ZONE)} 执行。</span>
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
      resolve(Object.fromEntries(params.entries()));
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
addLog("服务启动完成");
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
