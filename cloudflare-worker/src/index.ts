interface Env {
  KIMI_API_KEY?: string;
  KIMI_API_BASE?: string;
  KIMI_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_BASE?: string;
  DEEPSEEK_MODEL?: string;
  DOUBAO_API_KEY?: string;
  DOUBAO_API_BASE?: string;
  DOUBAO_MODEL?: string;
}

type ProviderName = "kimi" | "deepseek" | "doubao";

type ProviderConfig = {
  id: ProviderName;
  label: string;
  apiKey: string;
  apiBase: string;
  model: string;
};

type SearchItem = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  query: string;
};

type UnknownRecord = Record<string, unknown>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...(init.headers || {}) },
  });
}

function providerConfig(provider: ProviderName, env: Env): ProviderConfig {
  const configs: Record<ProviderName, ProviderConfig> = {
    kimi: {
      id: "kimi",
      label: "Kimi",
      apiKey: env.KIMI_API_KEY || "",
      apiBase: env.KIMI_API_BASE || "https://api.moonshot.cn/v1",
      model: env.KIMI_MODEL || "kimi-k2.5",
    },
    deepseek: {
      id: "deepseek",
      label: "DeepSeek",
      apiKey: env.DEEPSEEK_API_KEY || "",
      apiBase: env.DEEPSEEK_API_BASE || "https://api.deepseek.com",
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
    },
    doubao: {
      id: "doubao",
      label: "豆包",
      apiKey: env.DOUBAO_API_KEY || "",
      apiBase: env.DOUBAO_API_BASE || "https://ark.cn-beijing.volces.com/api/v3",
      model: env.DOUBAO_MODEL || "",
    },
  };
  return configs[provider];
}

function stripJsonFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function parseModelJson(value: string) {
  const clean = stripJsonFence(value);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("模型没有返回可解析的 JSON");
  }
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? value as UnknownRecord : {};
}

async function callModel(config: ProviderConfig, system: string, user: string) {
  const endpoint = `${config.apiBase.replace(/\/$/, "")}/chat/completions`;
  const sampling = config.id === "kimi" ? {} : { temperature: 0.2 };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      ...sampling,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const payload = await response.json() as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `${config.label} API 返回 ${response.status}`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${config.label} API 未返回有效内容`);
  return { raw: content, parsed: parseModelJson(content) };
}

async function resolveAvailableModel(config: ProviderConfig) {
  if (config.id !== "kimi") return config;
  try {
    const response = await fetch(`${config.apiBase.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) return config;
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const ids = (payload.data || []).map((item) => item.id || "").filter(Boolean);
    if (ids.includes(config.model)) return config;

    const preferences = [
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2-0905-preview",
      "kimi-k2-turbo-preview",
      "kimi-k2",
      "moonshot-v1-auto",
      "moonshot-v1-128k",
      "moonshot-v1-32k",
      "moonshot-v1-8k",
    ];
    const model = preferences.find((item) => ids.includes(item))
      || ids.find((item) => /^(kimi|moonshot-v1)/.test(item));
    return model ? { ...config, model } : config;
  } catch {
    return config;
  }
}

function escapeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? escapeXml(match[1]) : "";
}

function hostname(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "公开网页"; }
}

async function searchPublicWeb(query: string, index: number): Promise<{ items: SearchItem[]; ok: boolean; note: string }> {
  const endpoint = `https://www.bing.com/search?format=rss&count=10&q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(endpoint, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; XunchaRadar/0.1; +https://github.com/)" },
    });
    if (!response.ok) return { items: [], ok: false, note: `公开搜索返回 ${response.status}` };
    const xml = await response.text();
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    const items = blocks.map((block, itemIndex) => {
      const url = tag(block, "link");
      return {
        id: `S${index + 1}-${itemIndex + 1}`,
        title: tag(block, "title"),
        url,
        snippet: tag(block, "description"),
        source: hostname(url),
        query,
      };
    }).filter((item) => item.title && item.url);
    return { items, ok: true, note: items.length ? `采集 ${items.length} 条` : "搜索成功但没有返回结果" };
  } catch (error) {
    return { items: [], ok: false, note: error instanceof Error ? error.message : "公开搜索请求失败" };
  }
}

function fallbackTask(prompt: string, timeRange: string, platforms: string[]) {
  const siteMap: Record<string, string> = {
    抖音: "site:douyin.com", 小红书: "site:xiaohongshu.com", B站: "site:bilibili.com/video", 微博: "site:weibo.com", 贴吧: "site:tieba.baidu.com", 百家号: "site:baijiahao.baidu.com",
  };
  const anchors = platforms.filter((item) => siteMap[item]).slice(0, 3);
  return {
    objective: prompt,
    mode: "定向线索检索",
    timeRange,
    platforms,
    riskHypotheses: ["任务描述中的风险表现可能已出现在公开网页", "同类内容可能以相近标题或话术跨平台传播"],
    inclusionCriteria: ["具有可核验原链接", "与用户目标直接相关", "存在明确风险信号"],
    exclusions: ["批判报道和辟谣内容", "纯关键词重合内容", "证据来源不明内容"],
    evidenceRequirements: ["真实链接", "标题", "来源", "发布时间（如可得）", "风险信号"],
    queries: [
      { query: `${prompt} ${timeRange}`, purpose: "直接检索用户目标" },
      ...anchors.map((item) => ({ query: `${siteMap[item]} ${prompt}`, purpose: `定位${item}公开收录页面` })),
    ].slice(0, 4),
  };
}

function normalizeTask(task: unknown, prompt: string, timeRange: string, platforms: string[]) {
  const fallback = fallbackTask(prompt, timeRange, platforms);
  const taskObject = asRecord(task);
  return {
    objective: String(taskObject.objective || fallback.objective),
    mode: String(taskObject.mode || fallback.mode),
    timeRange: String(taskObject.timeRange || timeRange),
    platforms: Array.isArray(taskObject.platforms) ? taskObject.platforms.map(String) : platforms,
    riskHypotheses: Array.isArray(taskObject.riskHypotheses) ? taskObject.riskHypotheses.map(String).slice(0, 5) : fallback.riskHypotheses,
    inclusionCriteria: Array.isArray(taskObject.inclusionCriteria) ? taskObject.inclusionCriteria.map(String).slice(0, 5) : fallback.inclusionCriteria,
    exclusions: Array.isArray(taskObject.exclusions) ? taskObject.exclusions.map(String).slice(0, 5) : fallback.exclusions,
    evidenceRequirements: Array.isArray(taskObject.evidenceRequirements) ? taskObject.evidenceRequirements.map(String).slice(0, 6) : fallback.evidenceRequirements,
    queries: Array.isArray(taskObject.queries)
      ? taskObject.queries
        .map((value) => {
          const item = asRecord(value);
          return { query: String(item.query || ""), purpose: String(item.purpose || "") };
        })
        .filter((item) => item.query)
        .slice(0, 5)
      : fallback.queries,
  };
}

function normalizeAnalysis(analysis: unknown, sources: SearchItem[]) {
  const analysisObject = asRecord(analysis);
  const assessment = asRecord(analysisObject.assessment);
  const sourceById = new Map(sources.map((item) => [item.id, item]));
  const clues = (Array.isArray(analysisObject.clues) ? analysisObject.clues : []).map((value, index: number) => {
    const item = asRecord(value);
    const source = sourceById.get(String(item.sourceId || ""));
    if (!source) return null;
    const evidenceValue = String(item.evidenceLevel || "");
    const verdictValue = String(item.verdict || "");
    const evidenceLevel = ["高", "中", "低", "待核"].includes(evidenceValue) ? evidenceValue : "待核";
    const verdict = ["重点核验", "弱信号", "排除", "待核"].includes(verdictValue) ? verdictValue : "待核";
    return {
      id: `CLUE-${String(index + 1).padStart(3, "0")}`,
      title: source.title,
      url: source.url,
      source: source.source,
      publishedAt: String(item.publishedAt || "待核"),
      summary: String(item.summary || source.snippet || "公开网页索引结果"),
      riskSignal: String(item.riskSignal || "待核验"),
      whyItMatters: String(item.whyItMatters || "需要打开原页继续核验"),
      evidenceLevel,
      verdict,
    };
  }).filter(Boolean).slice(0, 12);

  return {
    clues,
    assessment: {
      summary: String(assessment.summary || "公开网页检索已完成，但模型没有形成稳定结论。"),
      confidence: ["高", "中", "低"].includes(String(assessment.confidence || "")) ? String(assessment.confidence) : "低",
      evidenceGaps: Array.isArray(assessment.evidenceGaps) ? assessment.evidenceGaps.map(String).slice(0, 6) : ["需要打开原始页面复核"],
      nextActions: Array.isArray(assessment.nextActions) ? assessment.nextActions.map(String).slice(0, 6) : ["核验原始页面与发布时间"],
    },
  };
}

async function investigate(request: Request, env: Env) {
  let body: { provider?: ProviderName; prompt?: string; timeRange?: string; platforms?: string[] };
  try { body = await request.json(); } catch { return json({ error: "请求内容不是有效 JSON" }, { status: 400 }); }

  const provider = body.provider;
  const prompt = body.prompt?.trim();
  const timeRange = body.timeRange?.trim() || "不限时间";
  const platforms = Array.isArray(body.platforms) ? body.platforms.map(String) : ["全网"];
  if (!provider || !["kimi", "deepseek", "doubao"].includes(provider)) return json({ error: "请选择支持的调查模型" }, { status: 400 });
  if (!prompt) return json({ error: "请输入调查任务" }, { status: 400 });

  const configured = providerConfig(provider, env);
  if (!configured.apiKey) return json({ error: `${configured.label} 尚未配置 API Key` }, { status: 503 });
  if (!configured.model) return json({ error: `${configured.label} 尚未配置模型或推理接入点` }, { status: 503 });
  const config = await resolveAvailableModel(configured);

  const startedAt = Date.now();
  const logs: Array<{ at: string; stage: string; message: string; status: string }> = [];
  const log = (stage: string, message: string, status = "complete") => logs.push({ at: new Date().toISOString().slice(11, 19), stage, message, status });
  let task: ReturnType<typeof fallbackTask>;

  if (config.model !== configured.model) {
    log("模型适配", `当前账户未开放 ${configured.model}，已自动切换为 ${config.model}`);
  }

  try {
    const compile = await callModel(config,
      "你是内容生态治理调查任务编译器。必须理解用户真正要调查的对象、风险边界、排除条件和证据要求，不能把整句需求机械拼成关键词。仅输出一个JSON对象，不要Markdown。",
      `把下面需求编译为一次可执行的公开网络调查任务。\n用户需求：${prompt}\n时间范围：${timeRange}\n平台范围：${platforms.join("、")}\n\nJSON字段必须为：objective, mode, timeRange, platforms, riskHypotheses, inclusionCriteria, exclusions, evidenceRequirements, queries。queries为2到5项，每项包含query和purpose。查询词要短、具体、彼此有不同调查目的；需要平台定向时使用site:语法；不得预设风险已经成立。`
    );
    task = normalizeTask(compile.parsed, prompt, timeRange, platforms);
    log("任务编译", `模型识别为“${task.mode}”，生成 ${task.queries.length} 组调查查询`);
  } catch (error) {
    task = fallbackTask(prompt, timeRange, platforms);
    log("任务编译", `模型编译失败，已使用透明降级策略：${error instanceof Error ? error.message : "未知错误"}`, "partial");
  }

  const searchRuns = await Promise.all(task.queries.map((item, index) => searchPublicWeb(item.query, index)));
  const unique = new Map<string, SearchItem>();
  for (const run of searchRuns) for (const item of run.items) if (!unique.has(item.url)) unique.set(item.url, item);
  const sources = Array.from(unique.values()).slice(0, 30);
  const failedSearches = searchRuns.filter((item) => !item.ok).length;
  log("公开检索", `${task.queries.length} 组查询完成，${failedSearches} 组失败，去重后获得 ${sources.length} 条公开结果`, failedSearches ? "partial" : "complete");

  let normalized: ReturnType<typeof normalizeAnalysis>;
  if (!sources.length) {
    normalized = {
      clues: [],
      assessment: {
        summary: failedSearches === searchRuns.length ? "本轮公开网页采集失败，不能据此判断“未发现”。" : "公开网页索引没有返回可供研判的结果，但这不等于相关平台不存在内容。",
        confidence: "低",
        evidenceGaps: ["平台内部搜索未覆盖", "评论区未覆盖", failedSearches ? "部分或全部公开搜索请求失败" : "公开搜索索引可能不足"],
        nextActions: ["更换稀有话术或主体名称继续检索", "接入平台原生搜索工具后复核"],
      },
    };
    log("证据研判", "没有可供模型研判的公开来源，未生成风险样本", failedSearches ? "error" : "complete");
  } else {
    try {
      const compactSources = sources.map(({ id, title, url, snippet, source }) => ({ id, title, url, snippet, source }));
      const analyzed = await callModel(config,
        "你是谨慎的内容风险调查分析员。只能依据提供的公开搜索结果判断，绝不能补写不存在的事实。标题命中风险词不等于违规；必须排除新闻报道、批判揭露、辟谣、普通讨论和纯关键词重合。仅输出JSON，不要Markdown。",
        `调查任务：${JSON.stringify(task)}\n公开搜索结果：${JSON.stringify(compactSources)}\n\n请输出JSON：{\"clues\":[{\"sourceId\":\"S1-1\",\"publishedAt\":\"待核或可见时间\",\"summary\":\"仅基于来源的内容概括\",\"riskSignal\":\"明确风险信号\",\"whyItMatters\":\"为什么值得核验\",\"evidenceLevel\":\"高|中|低|待核\",\"verdict\":\"重点核验|弱信号|排除|待核\"}],\"assessment\":{\"summary\":\"本轮结论\",\"confidence\":\"高|中|低\",\"evidenceGaps\":[\"缺口\"],\"nextActions\":[\"下一步\"]}}。最多保留12条。引用必须使用给定sourceId；无法从标题摘要确认时标为待核。`
      );
      normalized = normalizeAnalysis(analyzed.parsed, sources);
      log("证据研判", `模型完成语境排除与线索分级，输出 ${normalized.clues.length} 条线索`);
    } catch (error) {
      normalized = {
        clues: sources.slice(0, 10).map((source, index) => ({
          id: `CLUE-${String(index + 1).padStart(3, "0")}`,
          title: source.title,
          url: source.url,
          source: source.source,
          publishedAt: "待核",
          summary: source.snippet || "公开网页索引结果，模型研判未完成。",
          riskSignal: "待核验",
          whyItMatters: "模型研判失败，仅保留原始搜索结果供人工复核。",
          evidenceLevel: "待核" as const,
          verdict: "待核" as const,
        })),
        assessment: {
          summary: "模型研判失败，系统仅保留原始搜索结果，不做风险认定。",
          confidence: "低" as const,
          evidenceGaps: ["模型语境分析未完成", "平台原始页面与发布时间需要人工核验"],
          nextActions: ["打开原始页面人工复核", "稍后使用同一模型重新研判"],
        },
      };
      log("证据研判", `模型研判失败，原始搜索结果已保留：${error instanceof Error ? error.message : "未知错误"}`, "partial");
    }
  }

  const coverage = [
    {
      source: "公开网页索引",
      status: failedSearches === searchRuns.length ? "failed" : failedSearches ? "partial" : "complete",
      count: sources.length,
      note: failedSearches ? `${failedSearches}/${searchRuns.length} 组查询失败` : `${task.queries.length} 组查询完成并去重`,
    },
    {
      source: "平台原生页面",
      status: "partial",
      count: sources.filter((item) => /douyin|xiaohongshu|bilibili|weibo|baidu/.test(item.url)).length,
      note: "仅统计公开网页索引收录结果，不代表平台内部完整覆盖",
    },
    { source: "评论区", status: "not_covered", count: 0, note: "第一版尚未接入平台评论采集" },
  ];

  return json({
    runId: `XR-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}`,
    mode: "live",
    provider: config.label,
    model: config.model,
    generatedAt: new Date().toISOString(),
    task,
    coverage,
    clues: normalized.clues,
    assessment: normalized.assessment,
    logs,
    meta: { durationMs: Date.now() - startedAt, searchBackend: "public-web-rss", sourceCount: sources.length },
  });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "xuncha-radar-gateway",
        version: "0.1.0",
        providers: {
          kimi: Boolean(env.KIMI_API_KEY),
          deepseek: Boolean(env.DEEPSEEK_API_KEY),
          doubao: Boolean(env.DOUBAO_API_KEY && env.DOUBAO_MODEL),
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/investigate") return investigate(request, env);
    return json({ error: "Not found" }, { status: 404 });
  },
};

export default worker;
