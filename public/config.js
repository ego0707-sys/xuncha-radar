// 部署 Cloudflare Worker 后，将 apiBaseUrl 改为其公开地址。
// API Key 必须保存在 Worker Secret 中，不能写入此文件。
window.XUNCHA_RADAR_CONFIG = {
  apiBaseUrl: "https://xuncha-radar.ergoo0707.workers.dev",
};
