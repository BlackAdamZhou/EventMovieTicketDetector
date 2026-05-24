# Event Cinema 票务监测系统 / Event Cinema Ticket Monitor

基于 PRD 实现的轻量化 Node.js 应用，用于监测 Event Cinemas 指定影院的电影开票状态，并通过 Telegram 发送通知。

A lightweight Node.js application for monitoring ticket availability at selected Event Cinemas locations and sending Telegram notifications.

## 功能 / Features

- Web UI 添加、查看、删除监测影片 / Web UI to add, view, and remove monitored movies
- 持久化保存监测列表与 Telegram 配置 / Persistent storage for movie list and Telegram settings
- 按悉尼时间定时检测 `IMAX Sydney` 和 `George Street` / Scheduled checks for `IMAX Sydney` and `George Street` in Sydney time
- 手动触发检测任务 / Manual check trigger
- 发现可售场次后通过 Telegram Bot 通知 / Telegram Bot notification when available sessions are found
- 基于 Admin Token 的访问控制 / Admin Token based access control
- 基于客户端 IP 的请求限流 / Client IP based rate limiting

## 本地运行 / Local Run

环境要求 / Requirements:

- Node.js 20 或以上 / Node.js 20 or later

Linux/macOS:

```bash
ADMIN_TOKEN=replace-with-a-strong-random-token npm start
```

默认端口为 `3000`，可通过环境变量 `PORT` 覆盖。

The default port is `3000`. Override it with `PORT`.

```bash
PORT=3010 ADMIN_TOKEN=replace-with-a-strong-random-token npm start
```

Windows PowerShell:

```powershell
$env:PORT="3010"
$env:ADMIN_TOKEN="replace-with-a-strong-random-token"
npm start
```

如果没有显式设置 `ADMIN_TOKEN`，系统会在首次启动时生成一个随机 Admin Token，并只在启动日志中打印一次；持久化数据中只保存该 token 的哈希。

If `ADMIN_TOKEN` is not explicitly set, the app generates a random Admin Token on first startup and prints it once in the startup logs. Only the token hash is persisted.

## Docker 运行 / Docker Run

环境要求 / Requirements:

- Docker Desktop
- Docker Linux engine 正常运行 / Docker Linux engine running

构建镜像 / Build the image:

```bash
docker build -t movie-ticket-detector .
```

启动容器 / Start the container:

```bash
docker run -d --name movie-ticket-detector -p 3000:3000 -v movie-ticket-data:/app/data -e ADMIN_TOKEN=replace-with-a-strong-random-token movie-ticket-detector
```

打开 / Open:

```text
http://localhost:3000
```

停止并删除容器 / Stop and remove the container:

```bash
docker stop movie-ticket-detector
docker rm movie-ticket-detector
```

如需用环境变量预置 Telegram 配置 / Preload Telegram settings with environment variables:

```bash
docker run -d --name movie-ticket-detector -p 3000:3000 -v movie-ticket-data:/app/data -e ADMIN_TOKEN=replace-with-a-strong-random-token -e TELEGRAM_BOT_TOKEN=your-bot-token -e TELEGRAM_CHAT_ID=your-chat-id movie-ticket-detector
```

浏览器访问时会先进入 `/login`，输入 Admin Token 后才能进入管理页面。

Browser access is redirected to `/login`; enter the Admin Token to access the admin UI.

自动化请求可使用 / Automated requests can use:

```bash
curl -H "Authorization: Bearer replace-with-a-strong-random-token" http://localhost:3000/
```

登录成功后，浏览器保存的是 HttpOnly 会话 cookie，不会把 Admin Token 明文写入 cookie。

After login, the browser stores an HttpOnly session cookie. The Admin Token is not stored in plaintext in cookies.

## 安全配置 / Security Configuration

可用环境变量 / Available environment variables:

- `ADMIN_TOKEN`: 管理员访问令牌。生产环境建议显式设置强随机值。 / Admin access token. Set a strong random value in production.
- `RATE_LIMIT_WINDOW_MS`: 限流窗口，默认 `60000`。 / Rate limit window in milliseconds. Default: `60000`.
- `RATE_LIMIT_MAX`: 每个客户端 IP 在窗口内的最大请求数，默认 `120`。 / Maximum requests per client IP per window. Default: `120`.
- `LOGIN_RATE_LIMIT_MAX`: 每个客户端 IP 在窗口内的登录尝试次数，默认 `10`。 / Maximum login attempts per client IP per window. Default: `10`.
- `TRUST_PROXY`: 如果部署在可信反向代理后，并需要使用 `X-Forwarded-For` 识别客户端 IP，可设置为 `true`。 / Set to `true` behind a trusted reverse proxy to use `X-Forwarded-For` for client IP detection.

公开端点 / Public endpoint:

- `/health`: 健康检查端点，不要求 Admin Token。 / Health check endpoint, no Admin Token required.

受保护端点 / Protected endpoints:

- `/`
- `/movies`
- `/movies/:id/delete`
- `/settings`
- `/check`
- `/logout`

## Docker 验证 / Docker Verification

本项目已在当前机器完成以下验证 / The following verification was completed on this machine:

```bash
docker build -t movie-ticket-detector .
docker run -d --name movie-ticket-detector-test -p 3010:3000 -e ADMIN_TOKEN=replace-with-a-strong-random-token movie-ticket-detector
```

验证结果 / Results:

- `http://127.0.0.1:3010/health` 返回 `HTTP 200` / returns `HTTP 200`
- 未携带 Admin Token 访问 `/` 会跳转到 `/login` / accessing `/` without Admin Token redirects to `/login`
- 携带 `Authorization: Bearer <ADMIN_TOKEN>` 访问 `/` 返回 `HTTP 200` / accessing `/` with `Authorization: Bearer <ADMIN_TOKEN>` returns `HTTP 200`
- 容器 healthcheck 状态为 `healthy` / container healthcheck status is `healthy`
- 测试容器已停止并删除 / test container was stopped and removed

## 首次使用 / First Use

1. 打开 `http://localhost:3000` / Open `http://localhost:3000`
2. 输入 Admin Token 登录 / Log in with the Admin Token
3. 在页面里填写 Telegram Bot Token 和 Chat ID / Enter Telegram Bot Token and Chat ID in the UI
4. 添加需要监测的影片全名 / Add the full movie title to monitor
5. 点击“立即检测”验证抓取与通知 / Click "立即检测" to verify scraping and notification

## 调度规则 / Schedule

系统按悉尼时区执行以下检查 / Checks run in Sydney time:

- 星期二 06:00 / Tuesday 06:00
- 星期二 23:00 / Tuesday 23:00
- 星期三 07:00 / Wednesday 07:00
- 星期三 23:00 / Wednesday 23:00

## 实现说明 / Implementation Notes

- 不依赖 Python，使用 Node.js 内置 `fetch`、`http`、`fs` / No Python dependency; uses built-in Node.js `fetch`, `http`, and `fs`
- 数据存储在 `data/store.json` / Local data is stored in `data/store.json`
- Docker 容器内的数据存储在 `/app/data/store.json` / Docker data is stored in `/app/data/store.json`
- 使用 Docker 运行时，建议挂载 volume 到 `/app/data`，避免容器删除后丢失监测列表和 Telegram 配置 / When running with Docker, mount a volume to `/app/data` to preserve movie list and Telegram settings
- 通过 Event Cinemas 的 `/Cinemas/GetSessions` 接口获取场次数据 / Session data is fetched from Event Cinemas `/Cinemas/GetSessions`
- 检测逻辑会遍历影院接口返回的全部可选日期，避免漏掉未来日期开售的影片 / The checker scans all available dates returned by the cinema API to avoid missing future sessions
- Admin Token 使用环境变量或本地哈希持久化，页面、cookie 和数据文件不会保存明文自动生成 token / Admin Token is configured by environment variable or persisted as a local hash; generated tokens are not stored in plaintext in pages, cookies, or data files
