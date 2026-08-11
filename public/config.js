// 浏览器只访问巡查雷达的中转入口；Kimi API Key 仍保存在 Cloudflare Secret 中。
// 这样可避免部分网络直接拦截 workers.dev，且不会把密钥写入网页。
window.XUNCHA_RADAR_CONFIG = {
  apiBaseUrl: "https://xuncha-radar.handdoranibcu.chatgpt.site/api/gateway",
};
