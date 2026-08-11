# 巡查雷达 v0.1

面向内容生态治理的开源情报调查工作台。第一版只验证一条核心链路：

> 任意自然语言巡查需求 → 动态任务说明 → 调查查询 → 公开网页检索 → 语境排除 → 可核验线索

## 第一版包含

- Kimi、DeepSeek、豆包三种模型入口，模型可以替换；
- 通用调查任务编译器，不按宗教、谣言、未成年人等主题硬编码；
- 公开网页检索与真实链接输出；
- 对“完整覆盖、部分覆盖、采集失败、本轮未覆盖”进行区分；
- 任务说明、查询策略、证据卡、AI研判和执行日志；
- 演示模式：安全网关未连接时可直接体验界面，但所有演示内容均明确标注；
- GitHub Pages 前端与 Cloudflare Worker 安全网关分离。

第一版不包含平台内部完整搜索、评论区采集、长期证据库、账号关系图谱和持续监测。这些能力将在验证核心链路有效后逐步接入。

## 项目结构

```text
app/                    调查工作台前端
public/config.js        前端运行配置，仅填写网关地址
cloudflare-worker/      API安全网关、模型适配和公开网页检索
.github/workflows/      GitHub Pages自动发布
```

## 本地预览前端

```bash
npm install
npm run dev
```

未填写 `public/config.js` 的 `apiBaseUrl` 时，网页自动进入演示模式，不会伪造实时调查结果。

## 部署安全网关

进入 `cloudflare-worker`：

```bash
npm install
npx wrangler login
```

将你需要启用的模型密钥保存为 Worker Secret：

```bash
npx wrangler secret put KIMI_API_KEY
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DOUBAO_API_KEY
```

密钥输入过程由 Cloudflare 接收，不要把密钥写进代码、`wrangler.toml`、GitHub Secrets 输出或 `public/config.js`。

豆包还需要在 `wrangler.toml` 中填写你在火山方舟创建的推理接入点 ID：

```toml
DOUBAO_MODEL = "你的推理接入点ID"
```

部署：

```bash
npm run deploy
```

部署成功后，将 Worker 地址写入 `public/config.js`：

```js
window.XUNCHA_RADAR_CONFIG = {
  apiBaseUrl: "https://你的-worker.workers.dev",
};
```

API Key始终只保存在 Cloudflare Worker Secret 中，不会发送给访问网页的用户。

## 发布 GitHub Pages

仓库的 `Settings → Pages → Build and deployment` 选择 `GitHub Actions`。推送到 `main` 后，工作流会构建并发布前端。

## 当前检索边界

第一版使用公开网页索引发现线索，可以覆盖搜索引擎已收录的平台页面，但不能承诺完整检索抖音、小红书、B站、贴吧等平台内部内容。页面返回“0条”时，会同时展示采集状态；只要采集失败，就不会写成“未发现”。

## 使用提醒

本项目不在第一版加入访客频率、每日预算或全站额度限制。公开访问产生的所有模型调用费用由密钥所属账户承担。后续可以在不改动前端的情况下，在 Worker 中增加预算和滥用保护。
