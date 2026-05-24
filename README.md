# Event Cinema 票务监测系统

基于 PRD 实现的轻量化 Node.js 应用，提供以下能力：

- Web UI 添加、查看、删除监测影片
- 持久化保存监测列表与 Telegram 配置
- 按悉尼时间定时检测 `IMAX Sydney` 和 `George Street`
- 手动触发检测任务
- 发现可售场次后通过 Telegram Bot 发送通知

## 本地运行

环境要求：

- Node.js 20 或以上

```bash
npm start
```

默认端口为 `3000`，可通过环境变量 `PORT` 覆盖。

```bash
PORT=3010 npm start
```

Windows PowerShell：

```powershell
$env:PORT="3010"
npm start
```

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
docker run -d --name movie-ticket-detector -p 3000:3000 -v movie-ticket-data:/app/data movie-ticket-detector
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
docker run -d --name movie-ticket-detector -p 3000:3000 -v movie-ticket-data:/app/data -e TELEGRAM_BOT_TOKEN=你的BotToken -e TELEGRAM_CHAT_ID=你的ChatID movie-ticket-detector
```

## Docker 验证

本项目已在当前机器完成以下验证：

```bash
docker build -t movie-ticket-detector .
docker run -d --name movie-ticket-detector-test -p 3010:3000 movie-ticket-detector
```

验证结果：

- `http://127.0.0.1:3010/` 返回 `HTTP 200`
- 容器 healthcheck 状态为 `healthy`
- 测试容器已停止并删除

## 首次使用

1. 打开 `http://localhost:3000`
2. 在页面里填写 Telegram Bot Token 和 Chat ID
3. 添加需要监测的影片全名
4. 点击“立即检测”验证抓取与通知

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
