"use client";

import { useMemo, useState } from "react";

type Provider = "kimi" | "deepseek" | "doubao";
type RunState = "idle" | "running" | "complete" | "error";

type QueryPlan = {
  query: string;
  purpose: string;
};

type TaskSpec = {
  objective: string;
  mode: string;
  timeRange: string;
  platforms: string[];
  riskHypotheses: string[];
  inclusionCriteria: string[];
  exclusions: string[];
  evidenceRequirements: string[];
  queries: QueryPlan[];
};

type CoverageItem = {
  source: string;
  status: "complete" | "partial" | "failed" | "not_covered";
  count: number;
  note: string;
};

type Clue = {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  summary: string;
  riskSignal: string;
  whyItMatters: string;
  evidenceLevel: "高" | "中" | "低" | "待核";
  verdict: "重点核验" | "弱信号" | "排除" | "待核";
};

type InvestigationResult = {
  runId: string;
  mode: "live" | "demo";
  provider: string;
  model: string;
  generatedAt: string;
  task: TaskSpec;
  coverage: CoverageItem[];
  clues: Clue[];
  assessment: {
    summary: string;
    confidence: "高" | "中" | "低";
    evidenceGaps: string[];
    nextActions: string[];
  };
  logs: Array<{ at: string; stage: string; message: string; status: string }>;
};

declare global {
  interface Window {
    XUNCHA_RADAR_CONFIG?: { apiBaseUrl?: string };
  }
}

const providers: Array<{ id: Provider; name: string; detail: string; mark: string }> = [
  { id: "kimi", name: "Kimi", detail: "长上下文", mark: "K" },
  { id: "deepseek", name: "DeepSeek", detail: "深度研判", mark: "D" },
  { id: "doubao", name: "豆包", detail: "中文理解", mark: "豆" },
];

const platformOptions = ["全网", "抖音", "小红书", "B站", "微博", "贴吧", "百家号"];
const timeOptions = ["近24小时", "近48小时", "近7天", "近30天", "不限时间"];

const demoResult: InvestigationResult = {
  runId: "DEMO-260811-001",
  mode: "demo",
  provider: "演示引擎",
  model: "任务编译器 v0.1",
  generatedAt: "2026-08-11T06:10:00.000Z",
  task: {
    objective: "发现近48小时内可能形成集中讨论、事实争议或群体情绪对立的原生风险线索",
    mode: "开放式风险发现",
    timeRange: "近48小时",
    platforms: ["全网公开网页", "抖音", "小红书", "B站"],
    riskHypotheses: ["突发事件细节被夸大或虚构", "评论区出现集中质疑与情绪对立", "同一叙事被多账号重复搬运"],
    inclusionCriteria: ["存在可核验原链接", "内容发布时间符合范围", "具备明确风险信号而非一般负面评价"],
    exclusions: ["权威媒体的批判或辟谣内容", "与任务主题仅有关键词重合", "无法确认发布时间的历史内容"],
    evidenceRequirements: ["原始链接", "标题与发布主体", "发布时间", "风险话术或关键画面", "交叉来源"],
    queries: [
      { query: "近48小时 通报 质疑 现场视频", purpose: "发现突发事件与事实争议" },
      { query: "site:douyin.com 近期 回应 网友质疑", purpose: "定位短视频平台原生讨论" },
      { query: "site:xiaohongshu.com 曝光 最新 争议", purpose: "寻找社区型弱信号" },
      { query: "site:bilibili.com/video 近期 造假 实锤", purpose: "核验视频化二次传播" },
    ],
  },
  coverage: [
    { source: "公开网页索引", status: "complete", count: 18, note: "演示：已完成4组查询并去重" },
    { source: "平台原生页面", status: "partial", count: 6, note: "演示：仅覆盖公开收录页面，未覆盖登录后内容" },
    { source: "评论区", status: "not_covered", count: 0, note: "演示：第一版尚未接入平台评论采集" },
  ],
  clues: [
    {
      id: "CLUE-001",
      title: "演示样本：某事件视频以“内部消息”补充未经证实细节",
      url: "",
      source: "短视频平台",
      publishedAt: "近2小时",
      summary: "标题和口播均使用确定性语气，但页面没有给出消息来源，评论区出现对真实性的集中追问。",
      riskSignal: "无来源爆料 · 确定性表述 · 评论质疑",
      whyItMatters: "满足“突发事件细节可能被虚构”的初筛假设，需要回到原视频核对画面、账号历史和权威通报。",
      evidenceLevel: "待核",
      verdict: "重点核验",
    },
    {
      id: "CLUE-002",
      title: "演示样本：多个账号复用同一截图并使用相近标题",
      url: "",
      source: "公开网页索引",
      publishedAt: "近9小时",
      summary: "3个页面出现相同裁剪截图与高度相似话术，尚不能确认是否属于同一传播主体。",
      riskSignal: "同图复用 · 话术趋同 · 跨账号传播",
      whyItMatters: "可能构成传播矩阵弱信号，但需要账号、联系方式或发布时间序列继续补证。",
      evidenceLevel: "低",
      verdict: "弱信号",
    },
    {
      id: "CLUE-003",
      title: "演示排除：媒体对网传说法进行事实核查",
      url: "",
      source: "新闻网站",
      publishedAt: "近1天",
      summary: "正文明确引用权威回应并否定网传说法，属于批判与辟谣语境。",
      riskSignal: "命中关键词但语境相反",
      whyItMatters: "不作为原生风险样本，保留为反向证据。",
      evidenceLevel: "高",
      verdict: "排除",
    },
  ],
  assessment: {
    summary: "本次演示发现1条重点核验线索和1条传播矩阵弱信号。当前证据只能支持继续调查，不能直接认定违规。",
    confidence: "低",
    evidenceGaps: ["缺少平台原始页面截图", "未核验具体发布时间", "评论区尚未覆盖", "账号关联证据不足"],
    nextActions: ["打开原始页面核对标题、画面与发布时间", "检索截图中的稀有文字锚点", "反查首发账号及相同素材", "与权威通报进行时间线比对"],
  },
  logs: [
    { at: "14:08:11", stage: "任务编译", message: "识别为开放式风险发现任务", status: "complete" },
    { at: "14:08:12", stage: "查询规划", message: "生成4组具有不同调查目的的查询", status: "complete" },
    { at: "14:08:15", stage: "公开检索", message: "演示数据：18条结果进入去重与语境排除", status: "complete" },
    { at: "14:08:18", stage: "证据研判", message: "保留2条线索，排除1条反向语境内容", status: "complete" },
  ],
};

function statusText(status: CoverageItem["status"]) {
  return {
    complete: "已覆盖",
    partial: "部分覆盖",
    failed: "采集失败",
    not_covered: "本轮未覆盖",
  }[status];
}

function shortTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function Home() {
  const [provider, setProvider] = useState<Provider>("kimi");
  const [platforms, setPlatforms] = useState<string[]>(["全网", "抖音", "小红书", "B站"]);
  const [timeRange, setTimeRange] = useState("近48小时");
  const [prompt, setPrompt] = useState("巡查各大平台，找出近48小时内可能引发热敏舆情的事件。重点寻找平台原生风险样本，排除新闻报道和辟谣内容，每条线索必须有真实链接。");
  const [runState, setRunState] = useState<RunState>("idle");
  const [result, setResult] = useState<InvestigationResult | null>(null);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"clues" | "queries" | "logs">("clues");

  const apiBaseUrl = typeof window !== "undefined" ? window.XUNCHA_RADAR_CONFIG?.apiBaseUrl?.replace(/\/$/, "") : "";
  const isDemoOnly = !apiBaseUrl;
  const selectedProvider = providers.find((item) => item.id === provider)!;
  const riskCount = useMemo(() => result?.clues.filter((item) => item.verdict === "重点核验").length ?? 0, [result]);

  function togglePlatform(item: string) {
    setPlatforms((current) => {
      if (item === "全网") return current.includes("全网") ? [] : ["全网", ...platformOptions.slice(1)];
      const withoutAll = current.filter((name) => name !== "全网");
      return withoutAll.includes(item) ? withoutAll.filter((name) => name !== item) : [...withoutAll, item];
    });
  }

  async function runInvestigation() {
    setError("");
    if (!prompt.trim()) {
      setError("请输入本轮需要调查的内容。");
      return;
    }
    if (platforms.length === 0) {
      setError("请至少选择一个平台范围。");
      return;
    }

    if (isDemoOnly) {
      setRunState("running");
      await new Promise((resolve) => setTimeout(resolve, 700));
      setResult({
        ...demoResult,
        task: { ...demoResult.task, objective: prompt.trim(), timeRange, platforms },
        provider: selectedProvider.name,
      });
      setRunState("complete");
      setActiveTab("clues");
      return;
    }

    try {
      setRunState("running");
      setResult(null);
      const response = await fetch(`${apiBaseUrl}/api/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, prompt: prompt.trim(), timeRange, platforms }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `调查请求失败（${response.status}）`);
      setResult(payload);
      setRunState("complete");
      setActiveTab("clues");
    } catch (runError) {
      setRunState("error");
      setError(runError instanceof Error ? runError.message : "调查请求失败，请稍后重试。");
    }
  }

  function exportResult() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `巡查雷达_${result.runId}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="radar-logo" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-name">巡查雷达 <span>XUNCHA RADAR</span></div>
            <div className="brand-subtitle">OPEN-SOURCE INTELLIGENCE WORKSPACE</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="system-state"><i /> 系统就绪</div>
          <div className="version-tag">V0.1 · VALIDATION BUILD</div>
        </div>
      </header>

      <section className="command-deck">
        <div className="command-head">
          <div>
            <span className="eyebrow">NEW INVESTIGATION</span>
            <h1>发起一次内容风险调查</h1>
          </div>
          <div className={`runtime-badge ${isDemoOnly ? "demo" : "live"}`}>
            <i /> {isDemoOnly ? "演示模式 · 待连接安全网关" : "实时模式 · 安全网关已连接"}
          </div>
        </div>

        <label className="prompt-box">
          <span className="prompt-index">01</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="用自然语言描述你要查什么、时间范围、平台和证据要求……"
            aria-label="调查任务"
          />
          <span className="prompt-count">{prompt.length} 字</span>
        </label>

        <div className="controls-row">
          <div className="control-group provider-control">
            <label>调查模型</label>
            <div className="segmented model-segmented">
              {providers.map((item) => (
                <button
                  key={item.id}
                  className={provider === item.id ? "active" : ""}
                  onClick={() => setProvider(item.id)}
                  type="button"
                >
                  <span className="model-mark">{item.mark}</span>
                  <span><b>{item.name}</b><small>{item.detail}</small></span>
                </button>
              ))}
            </div>
          </div>

          <div className="control-group time-control">
            <label htmlFor="time-range">时间范围</label>
            <select id="time-range" value={timeRange} onChange={(event) => setTimeRange(event.target.value)}>
              {timeOptions.map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>

          <button className="run-button" type="button" onClick={runInvestigation} disabled={runState === "running"}>
            <span className="run-icon">⌁</span>
            <span>{runState === "running" ? "调查进行中" : isDemoOnly ? "运行演示调查" : "开始调查"}<small>{selectedProvider.name} · {timeRange}</small></span>
            <b>↗</b>
          </button>
        </div>

        <div className="platform-row">
          <span>平台范围</span>
          <div className="platform-chips">
            {platformOptions.map((item) => (
              <button key={item} type="button" className={platforms.includes(item) ? "selected" : ""} onClick={() => togglePlatform(item)}>
                <i /> {item}
              </button>
            ))}
          </div>
          <span className="coverage-note">第一版基于公开网页索引，平台内部完整覆盖将在后续接入</span>
        </div>
        {error && <div className="error-banner"><b>!</b>{error}</div>}
      </section>

      <section className="workspace-grid">
        <aside className="left-rail">
          <div className="panel-heading"><span>调查进程</span><small>PIPELINE</small></div>
          <ol className="pipeline">
            {["理解需求并编译任务", "生成调查查询", "检索公开网页", "去重与语境排除", "证据研判与输出"].map((label, index) => {
              const complete = runState === "complete";
              const active = runState === "running" && index === 0;
              return (
                <li key={label} className={complete ? "complete" : active ? "active" : ""}>
                  <span>{complete ? "✓" : String(index + 1).padStart(2, "0")}</span>
                  <div><b>{label}</b><small>{complete ? "已完成" : active ? "处理中" : "等待"}</small></div>
                </li>
              );
            })}
          </ol>

          <div className="rail-divider" />
          <div className="panel-heading"><span>覆盖状态</span><small>COVERAGE</small></div>
          <div className="coverage-list">
            {(result?.coverage ?? [
              { source: "公开网页索引", status: "not_covered", count: 0, note: "等待开始" },
              { source: "平台原生页面", status: "not_covered", count: 0, note: "等待开始" },
              { source: "评论区", status: "not_covered", count: 0, note: "第一版未接入" },
            ]).map((item) => (
              <div className="coverage-card" key={item.source}>
                <div><span className={`status-dot ${item.status}`} /> <b>{item.source}</b><strong>{item.count}</strong></div>
                <p>{statusText(item.status)} · {item.note}</p>
              </div>
            ))}
          </div>
        </aside>

        <section className="evidence-workspace">
          {!result && runState !== "running" && (
            <div className="empty-state">
              <div className="empty-radar"><i /><i /><span /></div>
              <span className="eyebrow">READY FOR TASKING</span>
              <h2>输入任何内容治理巡查需求</h2>
              <p>系统会先形成一份适配本次需求的任务说明，再生成搜索策略。只有获得真实来源链接后，线索才会进入结果区。</p>
              <div className="empty-principles">
                <span><b>01</b> 不机械拼接整句需求</span>
                <span><b>02</b> 不把采集失败写成未发现</span>
                <span><b>03</b> 不把批判报道当风险样本</span>
              </div>
            </div>
          )}

          {runState === "running" && (
            <div className="running-state">
              <div className="scanner"><span /></div>
              <span className="eyebrow">INVESTIGATION IN PROGRESS</span>
              <h2>正在编译任务并检索公开来源</h2>
              <p>等待模型返回任务结构、查询计划和可核验线索。第一版完成后一次性呈现结果。</p>
              <div className="running-bars"><i /><i /><i /><i /></div>
            </div>
          )}

          {result && runState === "complete" && (
            <>
              <div className="result-header">
                <div>
                  <span className="eyebrow">INVESTIGATION {result.runId}</span>
                  <h2>{result.task.objective}</h2>
                  <div className="result-meta">
                    <span>{result.provider} / {result.model}</span>
                    <span>{shortTime(result.generatedAt)}</span>
                    {result.mode === "demo" && <b>演示数据 · 不代表实时巡查结果</b>}
                  </div>
                </div>
                <button className="export-button" type="button" onClick={exportResult}>↓ 导出 JSON</button>
              </div>

              <div className="metrics-strip">
                <div><small>收录线索</small><strong>{result.clues.length}</strong><span>TOTAL CLUES</span></div>
                <div><small>重点核验</small><strong className="amber">{riskCount}</strong><span>PRIORITY</span></div>
                <div><small>查询策略</small><strong>{result.task.queries.length}</strong><span>SEARCH LANES</span></div>
                <div><small>研判置信度</small><strong className={result.assessment.confidence === "低" ? "muted" : "cyan"}>{result.assessment.confidence}</strong><span>CONFIDENCE</span></div>
              </div>

              <div className="task-brief">
                <div className="brief-label"><span>AI任务说明</span><small>COMPILED TASK</small></div>
                <div className="brief-grid">
                  <div><small>任务模式</small><b>{result.task.mode}</b></div>
                  <div><small>时间范围</small><b>{result.task.timeRange}</b></div>
                  <div><small>纳入标准</small><p>{result.task.inclusionCriteria.join("；")}</p></div>
                  <div><small>排除语境</small><p>{result.task.exclusions.join("；")}</p></div>
                </div>
              </div>

              <div className="tabs" role="tablist">
                <button className={activeTab === "clues" ? "active" : ""} onClick={() => setActiveTab("clues")}>线索证据 <b>{result.clues.length}</b></button>
                <button className={activeTab === "queries" ? "active" : ""} onClick={() => setActiveTab("queries")}>检索策略 <b>{result.task.queries.length}</b></button>
                <button className={activeTab === "logs" ? "active" : ""} onClick={() => setActiveTab("logs")}>执行日志 <b>{result.logs.length}</b></button>
              </div>

              {activeTab === "clues" && (
                <div className="clue-list">
                  {result.clues.length === 0 ? (
                    <div className="no-clues"><b>本轮没有形成可输出线索</b><p>请查看覆盖状态：可能是真无有效结果，也可能是公开索引覆盖不足或采集失败。</p></div>
                  ) : result.clues.map((clue) => (
                    <article className={`clue-card verdict-${clue.verdict}`} key={clue.id}>
                      <div className="clue-index">{clue.id.replace("CLUE-", "")}</div>
                      <div className="clue-main">
                        <div className="clue-topline">
                          <span className={`verdict-chip verdict-${clue.verdict}`}>{clue.verdict}</span>
                          <span>{clue.source}</span>
                          {clue.publishedAt && <span>{clue.publishedAt}</span>}
                          <span>证据 {clue.evidenceLevel}</span>
                        </div>
                        <h3>{clue.title}</h3>
                        <p>{clue.summary}</p>
                        <div className="signal-line"><small>风险信号</small><b>{clue.riskSignal}</b></div>
                        <div className="why-line"><small>研判依据</small><span>{clue.whyItMatters}</span></div>
                      </div>
                      <div className="clue-action">
                        {clue.url ? <a href={clue.url} target="_blank" rel="noreferrer">核验原页 ↗</a> : <span>演示链接未开放</span>}
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {activeTab === "queries" && (
                <div className="query-table">
                  <div className="query-row header"><span>序号</span><span>检索式</span><span>调查目的</span></div>
                  {result.task.queries.map((item, index) => (
                    <div className="query-row" key={`${item.query}-${index}`}>
                      <span>{String(index + 1).padStart(2, "0")}</span><code>{item.query}</code><p>{item.purpose}</p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "logs" && (
                <div className="log-terminal">
                  <div className="terminal-head"><span /><span /><span /><b>RUN LOG · {result.runId}</b></div>
                  {result.logs.map((log, index) => (
                    <div className="log-line" key={`${log.at}-${index}`}><time>{log.at}</time><b>[{log.stage}]</b><span>{log.message}</span><i className={log.status}>{log.status}</i></div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <aside className="analysis-rail">
          <div className="panel-heading"><span>AI研判</span><small>ASSESSMENT</small></div>
          {result ? (
            <>
              <div className="assessment-summary">
                <div className="confidence-ring"><span>{result.assessment.confidence}</span><small>置信度</small></div>
                <p>{result.assessment.summary}</p>
              </div>
              <div className="analysis-section">
                <h3>风险假设</h3>
                <ul>{result.task.riskHypotheses.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="analysis-section gaps">
                <h3>证据缺口</h3>
                <ul>{result.assessment.evidenceGaps.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="analysis-section next-actions">
                <h3>下一步动作</h3>
                <ol>{result.assessment.nextActions.map((item, index) => <li key={item}><span>{index + 1}</span>{item}</li>)}</ol>
              </div>
            </>
          ) : (
            <div className="analysis-placeholder">
              <div className="placeholder-grid" />
              <p>调查完成后，这里将显示风险假设、证据缺口与下一步调查动作。</p>
            </div>
          )}
        </aside>
      </section>

      <footer className="statusbar">
        <span><i className="green" /> 任务编译器 ONLINE</span>
        <span><i className={isDemoOnly ? "amber" : "green"} /> 安全网关 {isDemoOnly ? "NOT CONNECTED" : "CONNECTED"}</span>
        <span><i className="slate" /> 平台原生采集 ROADMAP</span>
        <b>所有“未发现”结论均需先排除采集失败</b>
      </footer>
    </main>
  );
}
