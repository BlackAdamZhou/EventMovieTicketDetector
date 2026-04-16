# Event Cinema 票务监测系统

基于 PRD 实现的轻量化 Node.js 应用，提供以下能力：

- Web UI 添加、查看、删除监测影片
- 持久化保存监测列表与 Telegram 配置
- 按悉尼时间定时检测 `IMAX Sydney` 和 `George Street`
- 手动触发检测任务
- 发现可售场次后通过 Telegram Bot 发送通知

## 运行

```bash
npm start
```

默认端口为 `3000`，可通过环境变量 `PORT` 覆盖。

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
- 通过解析 Event Cinemas 页面内嵌的 `data-movies` 数据完成检测
