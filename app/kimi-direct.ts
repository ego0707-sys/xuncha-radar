import type { InvestigationResult, Provider } from "./investigation-types";

type ApiError = { error?: string };

async function parseError(response: Response) {
  const payload = await response.json().catch(() => null) as ApiError | null;
  if (response.status === 401) return payload?.error || "Kimi API Key 无效，请重新填写。";
  if (response.status === 429) return payload?.error || "当前已有调查任务运行，请稍后重试。";
  return payload?.error || `研究服务返回 ${response.status}`;
}

async function postJson<T>(path: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, apiKey }),
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(await parseError(response));
  return await response.json() as T;
}

export async function testKimiKey(apiKey: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    return await postJson<{ model: string }>("/api/kimi/test", apiKey, {}, controller.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("服务端验证 Kimi K3 超时，请稍后重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function runKimiDirect(options: {
  apiKey: string;
  apiBase?: string;
  provider: Provider;
  researchMode: "daily" | "topic";
  prompt: string;
  timeRange: string;
  platforms: string[];
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  if (options.provider !== "kimi") throw new Error("第一版只启用了 Kimi K3 研究 Agent。");
  options.onProgress?.("服务端 Agent 正在拆解任务，并沿五条研究路径进行联网检索与证据核验…");
  return await postJson<InvestigationResult>(
    "/api/research",
    options.apiKey,
    { researchMode: options.researchMode, prompt: options.prompt, timeRange: options.timeRange, platforms: options.platforms },
    options.signal,
  );
}
