# 巡查雷达 v0.1

面向内容生态治理的开源情报调查工作台。第一版只验证一条核心链路：

> 任意自然语言巡查需求 → 动态任务说明 → 调查查询 → 公开网页检索 → 语境排除 → 可核验线索

## 第一版包含

- Kimi、DeepSeek、豆包三种模型入口，模型可以替换；
- 通用调查任务编译器，不按宗教、谣言、未成年人等主题硬编码；
- Kimi K3 官方 API 直连及内置联网搜索；
- 对“完整覆盖、部分覆盖、采集失败、本轮未覆盖”进行区分；
- 任务说明、查询策略、证据卡、AI研判和执行日志；
- GitHub Pages 网址保持不变，不依赖 `workers.dev` 或 `chatgpt.site`；
- API Key 由每台团队电脑首次使用时填写，只保存在该浏览器本机。

第一版不包含平台内部完整搜索、评论区采集、长期证据库、账号关系图谱和持续监测。这些能力将在验证核心链路有效后逐步接入。

## 项目结构

```text
app/                    调查工作台前端
public/config.js        Kimi 官方 API 地址配置（不含密钥）
cloudflare-worker/      旧版可选安全网关，不再是 GitHub Pages 的必需链路
.github/workflows/      GitHub Pages自动发布
```

## 本地预览前端

```bash
npm install
npm run dev
```

首次打开页面时，点击“设置 Kimi Key”，粘贴 Moonshot 开放平台 API Key。页面会先调用 `/models` 验证该 Key 确实可以使用 `kimi-k3`，验证通过后才允许开始调查；系统不会降级到 K2。

密钥保存在浏览器 `localStorage`，不会写入 GitHub 源码、GitHub Pages 构建产物或网页导出的诊断文件。需要在多台团队电脑使用时，每台电脑各设置一次。

## 直连配置

`public/config.js` 只保存非敏感的 Kimi API 基础地址：

```js
window.XUNCHA_RADAR_CONFIG = {
  directKimiApiBase: "https://api.moonshot.cn/v1",
};
```

调查固定使用 `kimi-k3`，并通过 Kimi 官方 `$web_search` 工具完成公开网络检索。由于 GitHub Pages 是静态托管，GitHub Secret 无法在浏览器运行时充当后端密钥；不要把真实 API Key 写进 `config.js` 或公开仓库。

## 可选 Cloudflare 网关（非当前默认）

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

该目录保留给网络允许访问 `workers.dev` 的环境。当前 GitHub Pages 正式版不再引用它。

## 发布 GitHub Pages

仓库的 `Settings → Pages → Build and deployment` 选择 `GitHub Actions`。推送到 `main` 后，工作流会构建并发布前端。

## 当前检索边界

第一版使用 Kimi K3 内置联网搜索发现线索，可以覆盖搜索服务能够访问的公开页面，但不能承诺完整检索抖音、小红书、B站、贴吧等平台内部内容。页面返回“0条”时，会同时展示采集状态；没有真实可核验链接的内容不会进入线索区。

## 使用提醒

本项目不在第一版加入访客频率、每日预算或全站额度限制。每台电脑发起的模型调用费用由其本机保存的密钥所属账户承担。团队成员不要在公共电脑上保存密钥；如需撤销，可在页面中点击“清除本机密钥”。
