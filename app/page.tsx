"use client";

import { useEffect, useMemo, useState } from "react";
import type { CoverageItem, InvestigationResult, Provider } from "./investigation-types";
import { runKimiDirect, testKimiKey } from "./kimi-direct";

type RunState = "idle" | "running" | "complete" | "error";

declare global {
  interface Window {
    XUNCHA_RADAR_CONFIG?: { directKimiApiBase?: string };
  }
}

const providers: Array<{ id: Provider; name: string; detail: string; mark: string }> = [
  { id: "kimi", name: "Kimi", detail: "K3", mark: "K" },
  { id: "deepseek", name: "DeepSeek", detail: "深度研判", mark: "D" },
  { id: "doubao", name: "豆包", detail: "中文理解", mark: "豆" },
];

const platformOptions = ["全网", "抖音", "小红书", "B站", "微博", "贴吧", "百家号"];
const timeOptions = ["近24小时", "近48小时", "近7天", "近30天", "不限时间"];
const API_KEY_STORAGE = "xuncha-radar:kimi-api-key";
const DEFAULT_KIMI_API_BASE = "https://api.moonshot.cn/v1";

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
  const [serviceState, setServiceState] = useState<"needs_key" | "checking" | "ready" | "unreachable">("checking");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyPanelOpen, setApiKeyPanelOpen] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState("");
  const apiBase = DEFAULT_KIMI_API_BASE;
  const [progressMessage, setProgressMessage] = useState("正在连接 Kimi K3 并准备联网检索…");
  const [savingKey, setSavingKey] = useState(false);

  const selectedProvider = providers.find((item) => item.id === provider)!;
  const riskCount = useMemo(() => result?.clues.filter((item) => item.verdict === "重点核验").length ?? 0, [result]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const configuredBase = window.XUNCHA_RADAR_CONFIG?.directKimiApiBase?.replace(/\/$/, "") || DEFAULT_KIMI_API_BASE;
      const storedKey = window.localStorage.getItem(API_KEY_STORAGE) || "";
      setApiKeyDraft(storedKey);
      if (!storedKey) {
        setServiceState("needs_key");
        setApiKeyPanelOpen(true);
        return;
      }
      setApiKey(storedKey);
      setServiceState("checking");
      testKimiKey(storedKey, configuredBase)
        .then(() => setServiceState("ready"))
        .catch((keyError) => {
          setServiceState("unreachable");
          setApiKeyMessage(keyError instanceof Error ? keyError.message : "Kimi K3 连接失败");
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function saveApiKey() {
    const nextKey = apiKeyDraft.trim();
    if (!nextKey) {
      setApiKeyMessage("请输入 Kimi API Key。 ");
      return;
    }
    setSavingKey(true);
    setApiKeyMessage("正在验证 Kimi K3 权限…");
    setServiceState("checking");
    try {
      await testKimiKey(nextKey, apiBase);
      window.localStorage.setItem(API_KEY_STORAGE, nextKey);
      setApiKey(nextKey);
      setServiceState("ready");
      setApiKeyMessage("Kimi K3 已验证，密钥只保存在这台电脑。 ");
      setApiKeyPanelOpen(false);
    } catch (keyError) {
      setServiceState("unreachable");
      setApiKeyMessage(keyError instanceof Error ? keyError.message : "Kimi K3 连接失败");
    } finally {
      setSavingKey(false);
    }
  }

  function clearApiKey() {
    window.localStorage.removeItem(API_KEY_STORAGE);
    setApiKey("");
    setApiKeyDraft("");
    setServiceState("needs_key");
    setApiKeyMessage("已清除这台电脑保存的密钥。 ");
  }

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
    if (provider !== "kimi") {
      setError("当前直连版只启用了 Kimi K3；DeepSeek 与豆包将在后续接入。 ");
      return;
    }
    if (!apiKey || serviceState !== "ready") {
      setApiKeyPanelOpen(true);
      setError("请先设置并验证这台电脑使用的 Kimi API Key。 ");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 360000);
    try {
      setRunState("running");
      setResult(null);
      setProgressMessage("Kimi K3 正在拆解任务并开始联网检索…");
      const completed = await runKimiDirect({
        apiKey,
        apiBase,
        provider,
        prompt: prompt.trim(),
        timeRange,
        platforms,
        signal: controller.signal,
        onProgress: setProgressMessage,
      });
      setResult(completed);
      setRunState("complete");
      setActiveTab("clues");
    } catch (runError) {
      setRunState("error");
      if (runError instanceof DOMException && runError.name === "AbortError") {
        setError("调查超过6分钟仍未完成，已自动停止。请缩小时间或平台范围后重试。");
      } else if (runError instanceof TypeError) {
        setError("浏览器无法直连 Kimi 官方 API。请先点击“设置 Kimi Key”重新验证；若验证也失败，说明公司网络拦截了 api.moonshot.cn。 ");
      } else {
        setError(runError instanceof Error ? runError.message : "调查请求失败，请稍后重试。");
      }
    } finally {
      window.clearTimeout(timeout);
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
          <div className="runtime-actions">
            <div className={`runtime-badge ${serviceState === "ready" ? "live" : "demo"}`}>
              <i /> {serviceState === "ready"
                ? "实时模式 · Kimi K3 官方直连已验证"
                : serviceState === "needs_key"
                  ? "实时模式 · 待设置本机 Kimi Key"
                  : serviceState === "unreachable"
                    ? "实时模式 · Kimi 直连验证失败"
                    : "实时模式 · 正在验证 Kimi K3"}
            </div>
            <button className="key-settings-button" type="button" onClick={() => setApiKeyPanelOpen((current) => !current)}>
              {serviceState === "ready" ? "管理 Kimi Key" : "设置 Kimi Key"}
            </button>
          </div>
        </div>

        {apiKeyPanelOpen && (
          <section className="api-key-panel" aria-label="Kimi API Key 设置">
            <div className="api-key-copy">
              <b>Kimi K3 本机直连</b>
              <p>密钥只保存在这台电脑的浏览器中，不会写入 GitHub，也不再经过 workers.dev 或 chatgpt.site。</p>
            </div>
            <label>
              <span>Kimi API Key</span>
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder="粘贴 Moonshot 开放平台 API Key"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="api-key-actions">
              <button type="button" onClick={saveApiKey} disabled={savingKey}>{savingKey ? "正在验证" : "验证并保存"}</button>
              {apiKey && <button className="quiet" type="button" onClick={clearApiKey}>清除本机密钥</button>}
            </div>
            {apiKeyMessage && <p className={`api-key-message ${serviceState === "ready" ? "success" : ""}`}>{apiKeyMessage}</p>}
          </section>
        )}

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
                  disabled={item.id !== "kimi"}
                  title={item.id === "kimi" ? "Kimi K3 官方直连" : "待后续接入"}
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
            <span>{runState === "running" ? "调查进行中" : "开始调查"}<small>{selectedProvider.name} K3 · {timeRange}</small></span>
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
          <span className="coverage-note">第一版基于 Kimi 联网搜索，平台内部完整覆盖将在后续接入</span>
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
              { source: "Kimi 联网搜索", status: "not_covered", count: 0, note: "等待开始" },
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
              <h2>正在由 Kimi K3 执行联网调查</h2>
              <p>{progressMessage}</p>
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
        <span><i className={serviceState === "ready" ? "green" : "amber"} /> KIMI K3 DIRECT {serviceState === "ready" ? "READY" : "SETUP"}</span>
        <span><i className="slate" /> 平台原生采集 ROADMAP</span>
        <b>所有“未发现”结论均需先排除采集失败</b>
      </footer>
    </main>
  );
}
