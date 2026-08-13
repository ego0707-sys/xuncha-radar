"use client";

import { useEffect, useMemo, useState } from "react";
import type { Clue, CoverageItem, InvestigationResult } from "./investigation-types";
import { runKimiDirect, testKimiKey } from "./kimi-direct";

type View = "radar" | "history" | "rules" | "memory";
type ResearchMode = "daily" | "topic";
type RunState = "idle" | "running" | "complete" | "error";
type ResultTab = "priority" | "watch" | "trace";
type FeedbackLabel = "valuable" | "continue" | "false_positive" | "used";
type HistoryItem = {
  id: string;
  mode: ResearchMode;
  prompt: string;
  createdAt: string;
  result: InvestigationResult;
};

const API_KEY_STORAGE = "xuncha-radar:kimi-api-key";
const HISTORY_STORAGE = "xuncha-radar:history:v2";
const FEEDBACK_STORAGE = "xuncha-radar:feedback:v2";

const platforms = ["全网", "抖音", "小红书", "B站", "微博", "贴吧", "百家号", "知乎", "境外公开平台"];
const timeOptions = ["近24小时", "近48小时", "近72小时", "近7天", "近30天", "近90天"];
const pipeline = ["权威规则", "弱信号发现", "实体溯源", "境内落地", "证据核验"];

const modeCopy: Record<ResearchMode, { title: string; description: string; prompt: string; time: string }> = {
  daily: {
    title: "日常自主巡查",
    description: "不要求你先知道搜索词。Agent 从治理重点、境内外弱信号和近期事件中主动提出风险命题。",
    prompt: "发现近期新出现、尚未被热榜充分覆盖的内容生态风险机制，并尽量定位境内原始帖子、视频或笔记。",
    time: "近72小时",
  },
  topic: {
    title: "专题线索追踪",
    description: "围绕已知事件、账号、组织、话术或风险机制，持续扩展源头、传播链和境内落地。",
    prompt: "请描述要追踪的事件、账号、组织、话术或风险机制，以及你已经掌握的线索。",
    time: "近7天",
  },
};

const templates: Array<{ name: string; mode: ResearchMode; prompt: string; time: string }> = [
  { name: "自主发现", mode: "daily", prompt: modeCopy.daily.prompt, time: "近72小时" },
  { name: "境外→境内", mode: "daily", prompt: "从境外公开平台近期出现的新组织、新话术和极端行动线索出发，追踪其是否已进入境内内容平台。", time: "近7天" },
  { name: "监管反向巡查", mode: "daily", prompt: "依据近期清朗行动、平台治理公告和互联网信息规则，反向发现仍在增长的新型违规内容机制。", time: "近30天" },
  { name: "突发舆情", mode: "topic", prompt: "围绕近期舆情事件，定位可能滋生负面叙事的原始内容载体、传播节点和可核验样本。", time: "近72小时" },
];

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function shortTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  } catch {
    return value;
  }
}

function gradeOf(clue: Clue) {
  const grade = clue.riskSignal.trim().charAt(0).toUpperCase();
  return grade === "A" || grade === "B" || grade === "C" ? grade : clue.verdict === "重点核验" ? "A" : "B";
}

function statusText(status: CoverageItem["status"]) {
  return { complete: "已覆盖", partial: "部分覆盖", failed: "采集失败", not_covered: "本轮未覆盖" }[status];
}

function feedbackText(label: FeedbackLabel) {
  return { valuable: "有效线索", continue: "继续追踪", false_positive: "误报", used: "已用于材料" }[label];
}

export default function Home() {
  const [view, setView] = useState<View>("radar");
  const [mode, setMode] = useState<ResearchMode>("daily");
  const [prompt, setPrompt] = useState(modeCopy.daily.prompt);
  const [timeRange, setTimeRange] = useState(modeCopy.daily.time);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["全网", "境外公开平台"]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [result, setResult] = useState<InvestigationResult | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("priority");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("正在建立本轮研究路径…");
  const [phase, setPhase] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [keyState, setKeyState] = useState<"needs_key" | "checking" | "ready" | "failed">("checking");
  const [keyPanel, setKeyPanel] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [feedback, setFeedback] = useState<Record<string, FeedbackLabel>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedKey = window.sessionStorage.getItem(API_KEY_STORAGE) || "";
      setHistory(readStorage<HistoryItem[]>(HISTORY_STORAGE, []));
      setFeedback(readStorage<Record<string, FeedbackLabel>>(FEEDBACK_STORAGE, {}));
      setApiKeyDraft(storedKey);
      if (!storedKey) {
        setKeyState("needs_key");
        return;
      }
      setApiKey(storedKey);
      testKimiKey(storedKey)
        .then(() => setKeyState("ready"))
        .catch((reason) => {
          setKeyState("failed");
          setKeyMessage(reason instanceof Error ? reason.message : "Kimi K3 连接失败");
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (runState !== "running") return;
    const timer = window.setInterval(() => setPhase((current) => Math.min(current + 1, pipeline.length - 1)), 12_000);
    return () => window.clearInterval(timer);
  }, [runState]);

  const priorityClues = useMemo(() => result?.clues.filter((clue) => gradeOf(clue) !== "C") ?? [], [result]);
  const watchClues = useMemo(() => result?.clues.filter((clue) => gradeOf(clue) === "C") ?? [], [result]);
  const feedbackCounts = useMemo(() => Object.values(feedback).reduce<Record<FeedbackLabel, number>>((counts, label) => {
    counts[label] += 1;
    return counts;
  }, { valuable: 0, continue: 0, false_positive: 0, used: 0 }), [feedback]);

  function switchMode(nextMode: ResearchMode) {
    setMode(nextMode);
    setPrompt(nextMode === "daily" ? modeCopy.daily.prompt : "");
    setTimeRange(modeCopy[nextMode].time);
    setResult(null);
    setError("");
  }

  function applyTemplate(template: typeof templates[number]) {
    setMode(template.mode);
    setPrompt(template.prompt);
    setTimeRange(template.time);
    setView("radar");
  }

  function togglePlatform(item: string) {
    setSelectedPlatforms((current) => {
      if (item === "全网") return current.includes("全网") ? [] : [...platforms];
      const next = current.filter((name) => name !== "全网");
      return next.includes(item) ? next.filter((name) => name !== item) : [...next, item];
    });
  }

  async function saveApiKey() {
    const nextKey = apiKeyDraft.trim();
    if (!nextKey) {
      setKeyMessage("请输入 Kimi API Key。");
      return;
    }
    setSavingKey(true);
    setKeyState("checking");
    setKeyMessage("正在验证 Kimi K3 权限…");
    try {
      await testKimiKey(nextKey);
      window.sessionStorage.setItem(API_KEY_STORAGE, nextKey);
      setApiKey(nextKey);
      setKeyState("ready");
      setKeyMessage("验证成功。密钥只保存在当前浏览器会话，不写入 GitHub。");
      setKeyPanel(false);
    } catch (reason) {
      setKeyState("failed");
      setKeyMessage(reason instanceof Error ? reason.message : "Kimi K3 连接失败");
    } finally {
      setSavingKey(false);
    }
  }

  function clearApiKey() {
    window.sessionStorage.removeItem(API_KEY_STORAGE);
    setApiKey("");
    setApiKeyDraft("");
    setKeyState("needs_key");
    setKeyMessage("已从当前浏览器会话清除。");
  }

  function saveRun(nextResult: InvestigationResult) {
    const item: HistoryItem = { id: nextResult.runId, mode, prompt: prompt.trim(), createdAt: nextResult.generatedAt, result: nextResult };
    setHistory((current) => {
      const next = [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 30);
      window.localStorage.setItem(HISTORY_STORAGE, JSON.stringify(next));
      return next;
    });
  }

  async function runResearch() {
    setError("");
    if (prompt.trim().length < 4) {
      setError(mode === "daily" ? "请保留或修改本轮自主发现目标。" : "请填写要追踪的专题线索。");
      return;
    }
    if (!selectedPlatforms.length) {
      setError("请至少选择一个平台范围。");
      return;
    }
    if (!apiKey || keyState !== "ready") {
      setKeyPanel(true);
      setError("请先设置并验证这台电脑使用的 Kimi API Key。");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 360_000);
    setPhase(0);
    setRunState("running");
    setResult(null);
    setProgress(mode === "daily" ? "Agent 正在从治理重点和近期弱信号中主动生成候选命题…" : "Agent 正在拆解专题并扩展实体、话术与传播链…");
    try {
      const completed = await runKimiDirect({
        apiKey,
        provider: "kimi",
        researchMode: mode,
        prompt: prompt.trim(),
        timeRange,
        platforms: selectedPlatforms,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(completed);
      saveRun(completed);
      setRunState("complete");
      setResultTab("priority");
    } catch (reason) {
      setRunState("error");
      if (reason instanceof DOMException && reason.name === "AbortError") setError("本轮超过6分钟仍未完成，已停止。请缩小范围后重试。");
      else setError(reason instanceof Error ? reason.message : "巡查请求失败，请稍后重试。");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function setClueFeedback(clueId: string, label: FeedbackLabel) {
    setFeedback((current) => {
      const next = { ...current, [clueId]: label };
      window.localStorage.setItem(FEEDBACK_STORAGE, JSON.stringify(next));
      return next;
    });
  }

  function restoreHistory(item: HistoryItem) {
    setMode(item.mode);
    setPrompt(item.prompt);
    setResult(item.result);
    setRunState("complete");
    setResultTab("priority");
    setView("radar");
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

  function renderClue(clue: Clue) {
    const grade = gradeOf(clue);
    return (
      <article className={`clue-card grade-${grade}`} key={clue.id}>
        <div className="grade-mark"><strong>{grade}</strong><span>{grade === "A" ? "可直接核验" : grade === "B" ? "有价值线索" : "观察池"}</span></div>
        <div className="clue-body">
          <div className="clue-meta"><span>{clue.source}</span><span>{clue.publishedAt || "时间待核"}</span><span>证据 {clue.evidenceLevel}</span></div>
          <h3>{clue.title}</h3>
          <p>{clue.summary}</p>
          <dl>
            <div><dt>风险信号</dt><dd>{clue.riskSignal}</dd></div>
            <div><dt>判断依据</dt><dd>{clue.whyItMatters}</dd></div>
          </dl>
          <div className="clue-footer">
            {clue.url ? <a href={clue.url} target="_blank" rel="noreferrer">打开原始页面 ↗</a> : <span className="disabled-link">缺少可访问原页</span>}
            <div className="feedback-row">
              {(["valuable", "continue", "false_positive", "used"] as FeedbackLabel[]).map((label) => (
                <button className={feedback[clue.id] === label ? "active" : ""} key={label} type="button" onClick={() => setClueFeedback(clue.id, label)}>{feedbackText(label)}</button>
              ))}
            </div>
          </div>
        </div>
      </article>
    );
  }

  const serviceLabel = keyState === "ready" ? "Kimi K3 已连接" : keyState === "checking" ? "正在验证服务" : keyState === "failed" ? "服务验证失败" : "待设置 Kimi Key";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-seal">巡</div><div><strong>巡查雷达</strong><span>OSINT RISK AGENT</span></div></div>
        <nav>
          <button className={view === "radar" ? "active" : ""} type="button" onClick={() => setView("radar")}><i>⌁</i><span>今日雷达<small>发现与执行</small></span></button>
          <button className={view === "history" ? "active" : ""} type="button" onClick={() => setView("history")}><i>◷</i><span>历史任务<small>复盘与复用</small></span></button>
          <button className={view === "rules" ? "active" : ""} type="button" onClick={() => setView("rules")}><i>⌘</i><span>判断规则<small>门禁与分层</small></span></button>
          <button className={view === "memory" ? "active" : ""} type="button" onClick={() => setView("memory")}><i>◎</i><span>团队记忆<small>反馈与经验</small></span></button>
        </nav>
        <div className="side-note"><b>第一版边界</b><p>Agent 负责发现风险与定位公开原页；评论区扩样和最终定性由人工完成。</p></div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div><span className="crumb">巡查雷达 /</span><strong>{({ radar: "发起巡查", history: "历史任务", rules: "判断规则", memory: "团队记忆" } as Record<View, string>)[view]}</strong></div>
          <div className="service-actions"><span className={`service-pill ${keyState}`}><i />{serviceLabel}</span><button type="button" onClick={() => setKeyPanel((current) => !current)}>{keyState === "ready" ? "管理密钥" : "设置密钥"}</button></div>
        </header>

        {keyPanel && (
          <section className="key-panel">
            <div><b>Kimi K3 服务密钥</b><p>通过 HTTPS 发送到当前网站后端；只在浏览器会话中保存，不写入 GitHub 和任务记录。</p></div>
            <input type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder="粘贴 Moonshot 开放平台 API Key" autoComplete="off" />
            <button type="button" disabled={savingKey} onClick={saveApiKey}>{savingKey ? "验证中…" : "验证并使用"}</button>
            {apiKey && <button className="quiet" type="button" onClick={clearApiKey}>清除</button>}
            {keyMessage && <p className={`key-message ${keyState}`}>{keyMessage}</p>}
          </section>
        )}

        {view === "radar" && (
          <main className="radar-page">
            <section className="hero">
              <span className="eyebrow">RISK DISCOVERY WORKSPACE</span>
              <h1>先发现风险，再寻找样本</h1>
              <p>从权威规则和境内外弱信号出发，沿实体与传播机制追踪到真实内容载体。</p>
              <div className="mode-tabs">
                {(["daily", "topic"] as ResearchMode[]).map((item) => (
                  <button className={mode === item ? "active" : ""} key={item} type="button" onClick={() => switchMode(item)}>
                    <span>{item === "daily" ? "01" : "02"}</span><div><strong>{modeCopy[item].title}</strong><small>{modeCopy[item].description}</small></div>
                  </button>
                ))}
              </div>
            </section>

            <section className="investigation-card">
              <div className="section-title"><div><span>NEW INVESTIGATION</span><h2>{modeCopy[mode].title}</h2></div><p>{mode === "daily" ? "由 Agent 主动提出候选命题，不依赖你先给搜索词。" : "输入你已经掌握的最小线索，Agent 负责扩展和交叉验证。"}</p></div>
              <div className="template-row">
                <span>快捷任务</span>{templates.map((template) => <button key={template.name} type="button" onClick={() => applyTemplate(template)}>{template.name}</button>)}
              </div>
              <label className="prompt-field">
                <span>{mode === "daily" ? "本轮发现目标" : "专题种子线索"}</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={modeCopy[mode].prompt} maxLength={5000} />
                <small>{prompt.length} / 5000</small>
              </label>
              <div className="parameter-grid">
                <label><span>时间范围</span><select value={timeRange} onChange={(event) => setTimeRange(event.target.value)}>{timeOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
                <div className="platform-field"><span>平台范围</span><div>{platforms.map((item) => <button className={selectedPlatforms.includes(item) ? "selected" : ""} key={item} type="button" onClick={() => togglePlatform(item)}><i />{item}</button>)}</div></div>
                <button className="run-button" type="button" disabled={runState === "running"} onClick={runResearch}><span>{runState === "running" ? "巡查进行中" : "启动巡查"}</span><small>{modeCopy[mode].title} · 最多10个主题</small><b>↗</b></button>
              </div>
              {error && <div className="error-banner"><b>!</b>{error}</div>}
            </section>

            <section className="research-layout">
              <aside className="trace-panel">
                <div className="panel-title"><div><span>RESEARCH TRACE</span><h2>研究路径</h2></div><small>{runState === "running" ? `${phase + 1}/5` : result ? "5/5" : "等待任务"}</small></div>
                <ol>{pipeline.map((item, index) => <li className={runState === "running" ? index < phase ? "complete" : index === phase ? "active" : "" : result ? "complete" : ""} key={item}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{item}</b><small>{index === 0 ? "治理依据与边界" : index === 1 ? "新实体、新话术、新机制" : index === 2 ? "账号、组织与源头" : index === 3 ? "帖子、视频与笔记原页" : "可访问性与内容匹配"}</small></div></li>)}</ol>
                <div className="truth-note"><b>不把数量当成发现</b><p>A/B 进入结果区；证据不足但值得观察的 C 级进入观察池；失败与覆盖缺口单独呈现。</p></div>
              </aside>

              <section className="results-panel">
                {runState === "running" && <div className="running-state"><div className="radar-animation"><i /><i /><span /></div><span className="eyebrow">AGENT RESEARCHING</span><h2>{pipeline[phase]}</h2><p>{progress}</p><small>真实联网研究通常需要数分钟，请保持页面打开。</small></div>}
                {runState !== "running" && !result && <div className="empty-state"><div className="empty-symbol">⌁</div><span className="eyebrow">WAITING FOR INVESTIGATION</span><h2>这里不会用热榜或卡片数量冒充发现</h2><p>启动后，Agent 会先形成风险命题，再寻找能支持或否定命题的公开原始页面。</p><div><span>A · 可直接核验</span><span>B · 有价值线索</span><span>C · 观察池</span></div></div>}
                {result && runState !== "running" && (
                  <>
                    <div className="result-head"><div><span className="eyebrow">RUN {result.runId}</span><h2>{result.task.mode} · 研究结果</h2><p>{result.assessment.summary}</p></div><button type="button" onClick={exportResult}>导出 JSON</button></div>
                    <div className="metrics"><div><span>A/B 结果</span><strong>{priorityClues.length}</strong><small>进入人工核验</small></div><div><span>C 级观察</span><strong>{watchClues.length}</strong><small>暂不进入材料</small></div><div><span>检索动作</span><strong>{result.task.queries.length}</strong><small>研究轨迹可回看</small></div><div><span>判断置信度</span><strong>{result.assessment.confidence}</strong><small>不等于最终定性</small></div></div>
                    <div className="result-tabs"><button className={resultTab === "priority" ? "active" : ""} type="button" onClick={() => setResultTab("priority")}>优先结果 <b>{priorityClues.length}</b></button><button className={resultTab === "watch" ? "active" : ""} type="button" onClick={() => setResultTab("watch")}>C级观察池 <b>{watchClues.length}</b></button><button className={resultTab === "trace" ? "active" : ""} type="button" onClick={() => setResultTab("trace")}>过程与缺口</button></div>
                    {resultTab === "priority" && <div className="clue-list">{priorityClues.length ? priorityClues.map(renderClue) : <div className="no-result"><b>本轮没有形成满足 A/B 门禁的线索</b><p>这不是系统故障。查看“过程与缺口”，确认是没有新风险，还是证据覆盖不足。</p></div>}</div>}
                    {resultTab === "watch" && <div className="clue-list">{watchClues.length ? watchClues.map(renderClue) : <div className="no-result"><b>本轮没有 C 级观察项</b></div>}</div>}
                    {resultTab === "trace" && <div className="trace-detail">
                      <section><h3>覆盖范围</h3>{result.coverage.map((item) => <div className="coverage-row" key={item.source}><i className={item.status} /><div><b>{item.source}</b><p>{item.note}</p></div><span>{statusText(item.status)} · {item.count}</span></div>)}</section>
                      <section><h3>证据缺口</h3><ul>{result.assessment.evidenceGaps.map((item) => <li key={item}>{item}</li>)}</ul></section>
                      <section><h3>实际检索式</h3>{result.task.queries.map((item, index) => <div className="query-row" key={`${item.query}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><code>{item.query}</code><p>{item.purpose}</p></div>)}</section>
                      <section><h3>Agent 日志</h3>{result.logs.map((log, index) => <div className="log-row" key={`${log.at}-${index}`}><time>{log.at}</time><b>{log.stage}</b><span>{log.message}</span></div>)}</section>
                    </div>}
                  </>
                )}
              </section>
            </section>
          </main>
        )}

        {view === "history" && <main className="sub-page"><div className="page-heading"><span className="eyebrow">INVESTIGATION ARCHIVE</span><h1>历史任务</h1><p>回看本机浏览器保存的最近30次巡查结果，可直接恢复任务继续研究。</p></div><div className="history-list">{history.length ? history.map((item) => <article key={item.id}><div><span>{item.mode === "daily" ? "日常自主巡查" : "专题线索追踪"}</span><time>{shortTime(item.createdAt)}</time></div><h2>{item.prompt}</h2><p>{item.result.assessment.summary}</p><footer><span>A/B {item.result.clues.filter((clue) => gradeOf(clue) !== "C").length}</span><span>C {item.result.clues.filter((clue) => gradeOf(clue) === "C").length}</span><button type="button" onClick={() => restoreHistory(item)}>打开结果</button></footer></article>) : <div className="blank-card">完成一次真实巡查后，任务会出现在这里。</div>}</div></main>}

        {view === "rules" && <main className="sub-page"><div className="page-heading"><span className="eyebrow">ASSESSMENT GATES</span><h1>判断规则</h1><p>规则决定一条内容能否进入结果区，不靠关键词命中直接定性。</p></div><div className="rule-grid"><article><span>A</span><h2>可直接核验</h2><ul><li>原始页面真实可访问</li><li>标题、链接与页面内容一致</li><li>发布时间落在任务窗口</li><li>具体内容触发明确治理规则</li><li>排除报道、批评、辟谣和事实核查</li></ul></article><article><span>B</span><h2>有价值线索</h2><ul><li>风险机制或传播链较明确</li><li>已有真实来源，但仍缺一项关键证据</li><li>值得人工打开原页继续核验</li><li>不得直接写成已确认事实</li></ul></article><article><span>C</span><h2>弱信号观察池</h2><ul><li>新实体、新话术或异常聚集刚出现</li><li>证据不足以进入正式材料</li><li>保留后续追踪价值</li><li>不在首页制造“发现很多”的假象</li></ul></article></div><div className="rule-note"><b>角色边界</b><p>D 发现 · L 定位 · V 核验 · B 规则依据 · N 否定性检查。只有完成必要角色链条，才允许提升结果等级。</p></div></main>}

        {view === "memory" && <main className="sub-page"><div className="page-heading"><span className="eyebrow">TEAM MEMORY</span><h1>团队记忆</h1><p>第一版先在当前浏览器记录人工反馈；服务端同时使用去重记忆，减少同一轮反复命中。</p></div><div className="memory-metrics"><div><strong>{feedbackCounts.valuable}</strong><span>有效线索</span></div><div><strong>{feedbackCounts.continue}</strong><span>继续追踪</span></div><div><strong>{feedbackCounts.false_positive}</strong><span>误报样本</span></div><div><strong>{feedbackCounts.used}</strong><span>已用于材料</span></div></div><div className="memory-list"><article><b>学习有效入口</b><p>把人工确认的实体、话术、来源与判断依据沉淀为后续任务的优先方向。</p></article><article><b>抑制重复与误报</b><p>已排除的线索保留否定反馈，防止仅因关键词相似再次进入优先结果。</p></article><article><b>保持可审计</b><p>结果、来源、规则依据、覆盖缺口和人工反馈分开记录，便于复盘。</p></article></div></main>}
      </div>
    </div>
  );
}
