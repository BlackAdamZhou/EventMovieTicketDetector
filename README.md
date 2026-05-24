# Event Cinema 票务监测系统

基于 PRD 实现的轻量化 Node.js 应用，提供以下能力：

- Web UI 添加、查看、删除监测影片
- 持久化保存监测列表与 Telegram 配置
- 按悉尼时间定时检测 `IMAX Sydney` 和 `George Street`
- 手动触发检测任务
- 发现可售场次后通过 Telegram Bot 发送通知
- 基于 Admin Token 的访问控制
- 基于客户端 IP 的请求限流

## 本地运行

环境要求：

- Node.js 20 或以上

```bash
ADMIN_TOKEN=请替换为强随机令牌 npm start
```

默认端口为 `3000`，可通过环境变量 `PORT` 覆盖。

```bash
PORT=3010 npm start
```

Windows PowerShell：

```powershell
$env:PORT="3010"
$env:ADMIN_TOKEN="请替换为强随机令牌"
npm start
```

如果没有显式设置 `ADMIN_TOKEN`，系统会在首次启动时生成一个随机 Admin Token，并只在启动日志中打印一次；持久化数据中只保存该 token 的哈希。

## Docker 运行

环境要求：

- Docker Desktop
- Docker Linux engine 正常运行

构建镜像：

```bash
docker build -t movie-ticket-detector .
```

启动容器：

```bash
docker run -d --name movie-ticket-detector -p 3000:3000 -v movie-ticket-data:/app/data -e ADMIN_TOKEN=请替换为强随机令牌 movie-ticket-detector
```

打开：

```text
http://localhost:3000
```

停止并删除容器：

```bash
docker stop movie-ticket-detector
docker rm movie-ticket-detector
```

如需用环境变量预置 Telegram 配置：

```bash
docker run -d --name movie-ticket-detector -p 3000:3000 -v movie-ticket-data:/app/data -e ADMIN_TOKEN=请替换为强随机令牌 -e TELEGRAM_BOT_TOKEN=你的BotToken -e TELEGRAM_CHAT_ID=你的ChatID movie-ticket-detector
```

浏览器访问时会先进入 `/login`，输入 Admin Token 后才能进入管理页面。自动化请求可使用：

```bash
curl -H "Authorization: Bearer 请替换为强随机令牌" http://localhost:3000/
```

登录成功后，浏览器保存的是 HttpOnly 会话 cookie，不会把 Admin Token 明文写入 cookie。

## 安全配置

可用环境变量：

- `ADMIN_TOKEN`：管理员访问令牌。生产环境建议显式设置强随机值。
- `RATE_LIMIT_WINDOW_MS`：限流窗口，默认 `60000`。
- `RATE_LIMIT_MAX`：每个客户端 IP 在窗口内的最大请求数，默认 `120`。
- `LOGIN_RATE_LIMIT_MAX`：每个客户端 IP 在窗口内的登录尝试次数，默认 `10`。
- `TRUST_PROXY`：如果部署在可信反向代理后，并需要使用 `X-Forwarded-For` 识别客户端 IP，可设置为 `true`。

公开端点：

- `/health`：健康检查端点，不要求 Admin Token。

受保护端点：

- `/`
- `/movies`
- `/movies/:id/delete`
- `/settings`
- `/check`
- `/logout`

## Docker 验证

本项目已在当前机器完成以下验证：

```bash
docker build -t movie-ticket-detector .
docker run -d --name movie-ticket-detector-test -p 3010:3000 -e ADMIN_TOKEN=请替换为强随机令牌 movie-ticket-detector
```

验证结果：

- `http://127.0.0.1:3010/health` 返回 `HTTP 200`
- 未携带 Admin Token 访问 `/` 会跳转到 `/login`
- 携带 `Authorization: Bearer <ADMIN_TOKEN>` 访问 `/` 返回 `HTTP 200`
- 容器 healthcheck 状态为 `healthy`
- 测试容器已停止并删除

## 首次使用

1. 打开 `http://localhost:3000`
2. 输入 Admin Token 登录
3. 在页面里填写 Telegram Bot Token 和 Chat ID
4. 添加需要监测的影片全名
5. 点击“立即检测”验证抓取与通知

## 调度规则

系统会按悉尼时区执行以下检查：

- 星期二 06:00
- 星期二 23:00
- 星期三 07:00
- 星期三 23:00

## 实现说明

- 不依赖 Python，使用 Node.js 内置 `fetch`、`http`、`fs`
- 数据存储在 `data/store.json`
- Docker 容器内的数据存储在 `/app/data/store.json`
- 使用 Docker 运行时，建议挂载 volume 到 `/app/data`，避免容器删除后丢失监测列表和 Telegram 配置
- 通过 Event Cinemas 的 `/Cinemas/GetSessions` 接口获取场次数据
- 检测逻辑会遍历影院接口返回的全部可选日期，避免漏掉未来日期开售的影片
- Admin Token 使用环境变量或本地哈希持久化，页面、cookie 和数据文件不会保存明文自动生成 token
