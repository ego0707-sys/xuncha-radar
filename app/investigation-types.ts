export type Provider = "kimi" | "deepseek" | "doubao";

export type QueryPlan = {
  query: string;
  purpose: string;
};

export type TaskSpec = {
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

export type CoverageItem = {
  source: string;
  status: "complete" | "partial" | "failed" | "not_covered";
  count: number;
  note: string;
};

export type Clue = {
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

export type InvestigationResult = {
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
