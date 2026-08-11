import type { Clue, InvestigationResult, Provider, QueryPlan, TaskSpec } from "./investigation-types";

type UnknownRecord = Record<string, unknown>;

type KimiMessage = {
  role: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
  name?: string;
};

type KimiToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type KimiChoice = {
  finishReason: string;
  message: KimiMessage;
};

const DEFAULT_API_BASE = "https://api.moonshot.cn/v1";
const MODEL = "kimi-k3";
const WEB_SEARCH_TOOL = [{ type: "builtin_function", function: { name: "$web_search" } }];

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? value as UnknownRecord : {};
}

function stringList(value: unknown, fallback: string[] = []) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8) : fallback;
}

function stripJsonFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function parseModelJson(value: string) {
  const clean = stripJsonFence(value);
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1)) as unknown;
    throw new Error("Kimi K3 没有返回可解析的调查结果");
  }
}

function httpUrl(value: unknown) {
  const text = String(value || "").trim();
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function host(value: string) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "公开网页"; }
}

function fallbackQueries(prompt: string, platforms: string[]) {
  const siteMap: Record<string, string> = {
    抖音: "site:douyin.com",
    小红书: "site:xiaohongshu.com",
    B站: "site:bilibili.com/video",
    微博: "site:weibo.com",
    贴吧: "site:tieba.baidu.com",
    百家号: "site:baijiahao.baidu.com",
  };
  return [
    { query: prompt, purpose: "直接检索调查目标" },
    ...platforms.filter((item) => siteMap[item]).slice(0, 4).map((item) => ({
      query: `${siteMap[item]} ${prompt}`,
      purpose: `定位${item}公开原生页面`,
    })),
  ].slice(0, 5);
}

function normalizeQueries(value: unknown, fallback: QueryPlan[]) {
  if (!Array.isArray(value)) return fallback;
  const queries = value.map((entry) => {
    const item = record(entry);
    return { query: String(item.query || "").trim(), purpose: String(item.purpose || "").trim() };
  }).filter((item) => item.query).slice(0, 6);
  return queries.length ? queries : fallback;
}

function normalizeTask(value: unknown, prompt: string, timeRange: string, platforms: string[]): TaskSpec {
  const item = record(value);
  const queries = fallbackQueries(prompt, platforms);
  return {
    objective: String(item.objective || prompt),
    mode: String(item.mode || "开放式风险发现"),
    timeRange,
    platforms,
    riskHypotheses: stringList(item.riskHypotheses, ["相关风险叙事可能已出现在公开网页", "同类话术可能跨平台传播"]),
    inclusionCriteria: stringList(item.inclusionCriteria, ["具有真实可核验链接", "与调查目标直接相关", "存在明确风险信号"]),
    exclusions: stringList(item.exclusions, ["新闻报道和批判揭露", "辟谣内容", "纯关键词重合"]),
    evidenceRequirements: stringList(item.evidenceRequirements, ["原始链接", "标题与主体", "发布时间", "关键风险话术"]),
    queries: normalizeQueries(item.queries, queries),
  };
}

function normalizeClues(value: unknown): Clue[] {
  if (!Array.isArray(value)) return [];
  const evidenceValues = new Set(["高", "中", "低", "待核"]);
  const verdictValues = new Set(["重点核验", "弱信号", "排除", "待核"]);
  const clues: Clue[] = [];
  for (const [index, entry] of value.entries()) {
    const item = record(entry);
    const url = httpUrl(item.url);
    if (!url) continue;
    const evidence = String(item.evidenceLevel || "待核");
    const verdict = String(item.verdict || "待核");
    clues.push({
      id: `CLUE-${String(index + 1).padStart(3, "0")}`,
      title: String(item.title || "待核线索"),
      url,
      source: String(item.source || host(url)),
      publishedAt: String(item.publishedAt || "待核"),
      summary: String(item.summary || "需要打开原页继续核验"),
      riskSignal: String(item.riskSignal || "待核验"),
      whyItMatters: String(item.whyItMatters || "与本轮调查目标存在关联，需要人工复核"),
      evidenceLevel: (evidenceValues.has(evidence) ? evidence : "待核") as Clue["evidenceLevel"],
      verdict: (verdictValues.has(verdict) ? verdict : "待核") as Clue["verdict"],
    });
  }
  return clues.slice(0, 15);
}

function normalizeResult(
  value: unknown,
  prompt: string,
  timeRange: string,
  platforms: string[],
  searchCalls: number,
  startedAt: number,
): InvestigationResult {
  const root = record(value);
  const assessment = record(root.assessment);
  const clues = normalizeClues(root.clues);
  const confidence = String(assessment.confidence || "低");
  return {
    runId: `XR-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}`,
    mode: "live",
    provider: "Kimi",
    model: MODEL,
    generatedAt: new Date().toISOString(),
    task: normalizeTask(root.task, prompt, timeRange, platforms),
    coverage: [
      {
        source: "Kimi 联网搜索",
        status: searchCalls ? "complete" : "partial",
        count: clues.length,
        note: searchCalls ? `Kimi K3 执行 ${searchCalls} 次联网搜索并输出 ${clues.length} 条可核验线索` : "Kimi K3 未触发联网搜索，结果只能作为待核信息",
      },
      {
        source: "平台原生页面",
        status: "partial",
        count: clues.filter((item) => /douyin|xiaohongshu|bilibili|weibo|baidu/.test(item.url)).length,
        note: "仅覆盖 Kimi 联网搜索可访问的公开页面，不代表平台内部完整覆盖",
      },
      { source: "评论区", status: "not_covered", count: 0, note: "第一版尚未接入登录后的完整评论采集" },
    ],
    clues,
    assessment: {
      summary: String(assessment.summary || (clues.length ? "本轮已形成可核验线索，仍需打开原始页面复核。" : "本轮没有形成满足证据要求的可输出线索。")),
      confidence: (["高", "中", "低"].includes(confidence) ? confidence : "低") as "高" | "中" | "低",
      evidenceGaps: stringList(assessment.evidenceGaps, ["平台内部搜索与评论区尚未完整覆盖"]),
      nextActions: stringList(assessment.nextActions, ["打开原始页面核对标题、画面与发布时间"]),
    },
    logs: [
      { at: new Date(startedAt).toISOString().slice(11, 19), stage: "模型连接", message: "浏览器已直连 Kimi 官方 API，并锁定 kimi-k3", status: "complete" },
      { at: new Date().toISOString().slice(11, 19), stage: "联网检索", message: `Kimi K3 调用内置联网搜索 ${searchCalls} 次`, status: searchCalls ? "complete" : "partial" },
      { at: new Date().toISOString().slice(11, 19), stage: "证据研判", message: `完成语境排除与链接校验，保留 ${clues.length} 条线索；耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`, status: "complete" },
    ],
  };
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (response.status === 401) return "Kimi API Key 无效，请重新填写。";
  if (response.status === 429) return payload?.error?.message || "Kimi API 当前限流或余额不足，请稍后重试。";
  return payload?.error?.message || `Kimi API 返回 ${response.status}`;
}

async function streamChat(
  apiKey: string,
  apiBase: string,
  messages: KimiMessage[],
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<KimiChoice> {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "high",
      max_completion_tokens: 32768,
      stream: true,
      messages,
      tools: WEB_SEARCH_TOOL,
    }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await responseError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason = "";
  const message: KimiMessage = { role: "assistant", content: "", reasoning_content: "", tool_calls: [] };
  const toolCalls = new Map<number, KimiToolCall>();
  let lastProgressAt = 0;

  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const payload = JSON.parse(data) as { choices?: Array<{ delta?: UnknownRecord; finish_reason?: string | null }> };
    const choice = payload.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = record(choice.delta);
    if (typeof delta.content === "string") message.content = `${message.content || ""}${delta.content}`;
    if (typeof delta.reasoning_content === "string") {
      message.reasoning_content = `${message.reasoning_content || ""}${delta.reasoning_content}`;
      if (onProgress && Date.now() - lastProgressAt > 5000) {
        lastProgressAt = Date.now();
        onProgress("Kimi K3 正在推理并核验联网结果…");
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const chunk = record(raw);
        const index = Number(chunk.index || 0);
        const fn = record(chunk.function);
        const current = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (typeof chunk.id === "string") current.id += chunk.id;
        if (typeof chunk.type === "string") current.type = chunk.type;
        if (typeof fn.name === "string") current.function.name += fn.name;
        if (typeof fn.arguments === "string") current.function.arguments += fn.arguments;
        toolCalls.set(index, current);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  }
  if (buffer) consumeLine(buffer);
  message.tool_calls = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b).map(([, item]) => item);
  if (!message.tool_calls.length) delete message.tool_calls;
  if (!message.reasoning_content) delete message.reasoning_content;
  return { finishReason: finishReason || (message.tool_calls?.length ? "tool_calls" : "stop"), message };
}

export async function testKimiKey(apiKey: string, apiBase = DEFAULT_API_BASE) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${apiBase.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const models = (payload.data || []).map((item) => item.id || "");
    if (!models.some((item) => item.toLowerCase() === MODEL)) {
      throw new Error("该 API Key 的模型列表中没有 kimi-k3，系统不会降级调用 K2。 ");
    }
    return { model: MODEL };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("连接 Kimi 官方 API 超时，请检查公司网络。 ");
    if (error instanceof TypeError) throw new Error("浏览器无法直连 api.moonshot.cn，请检查公司网络拦截策略。 ");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function runKimiDirect(options: {
  apiKey: string;
  apiBase?: string;
  provider: Provider;
  prompt: string;
  timeRange: string;
  platforms: string[];
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { apiKey, prompt, timeRange, platforms, signal, onProgress } = options;
  if (options.provider !== "kimi") throw new Error("当前直连版只启用了 Kimi K3；DeepSeek 与豆包将在后续接入。 ");
  const apiBase = options.apiBase || DEFAULT_API_BASE;
  const startedAt = Date.now();
  const system = `你是面向中国大陆内容平台生态治理的谨慎型开源情报调查 Agent。你必须主动使用 $web_search 多轮检索，并只依据实际检索到的公开页面输出结论。不得编造链接、标题、发布时间或风险事实；不得把新闻报道、批判揭露、辟谣内容、普通讨论和纯关键词重合当作原生风险样本。无法核实时标“待核”，证据不足时 clues 返回空数组。最终只输出一个 JSON 对象，不要 Markdown。`;
  const user = `执行一次内容风险调查。\n用户需求：${prompt}\n时间范围：${timeRange}\n平台范围：${platforms.join("、")}\n当前日期：${new Date().toISOString().slice(0, 10)}\n\n请先拆解2至6组短而具体的检索式，再用联网搜索逐组核查。重点保留平台原生页面和真实可打开链接，排除批判、报道、辟谣和无关语境。最终JSON必须严格包含：\n{\n  "task": {"objective":"", "mode":"", "riskHypotheses":[], "inclusionCriteria":[], "exclusions":[], "evidenceRequirements":[], "queries":[{"query":"", "purpose":""}]},\n  "clues": [{"title":"", "url":"https://...", "source":"", "publishedAt":"待核或明确时间", "summary":"", "riskSignal":"", "whyItMatters":"", "evidenceLevel":"高|中|低|待核", "verdict":"重点核验|弱信号|排除|待核"}],\n  "assessment": {"summary":"", "confidence":"高|中|低", "evidenceGaps":[], "nextActions":[]}\n}\n每条 clues.url 必须来自本轮真实搜索结果，不能凭记忆补写。`;

  const messages: KimiMessage[] = [{ role: "system", content: system }, { role: "user", content: user }];
  let searchCalls = 0;
  for (let round = 0; round < 10; round += 1) {
    onProgress?.(round ? `Kimi K3 正在继续第 ${round + 1} 轮检索与研判…` : "Kimi K3 正在拆解任务并开始联网检索…");
    const choice = await streamChat(apiKey, apiBase, messages, signal, onProgress);
    const toolCalls = choice.message.tool_calls || [];
    if (choice.finishReason === "tool_calls" && toolCalls.length) {
      messages.push(choice.message);
      for (const toolCall of toolCalls) {
        if (toolCall.function.name !== "$web_search") throw new Error(`Kimi 请求了未启用工具：${toolCall.function.name}`);
        searchCalls += 1;
        let args: unknown = toolCall.function.arguments;
        try { args = JSON.parse(toolCall.function.arguments); } catch { /* 保留原始参数交回 Kimi */ }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(args),
        });
      }
      continue;
    }
    const content = choice.message.content || "";
    if (!content) throw new Error("Kimi K3 调查结束，但没有返回可用内容。 ");
    return normalizeResult(parseModelJson(content), prompt, timeRange, platforms, searchCalls, startedAt);
  }
  throw new Error("Kimi K3 联网检索轮次过多，已自动停止；请缩小调查范围后重试。 ");
}
