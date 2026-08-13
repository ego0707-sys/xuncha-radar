from __future__ import annotations

import json
import mimetypes
import os
import tempfile
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from radar_engine.agent import KimiFormulaAgent
from radar_engine.engine import RadarEngine
from radar_engine.models import ResearchTask, RunState, to_jsonable
from radar_engine.verifier import HttpEvidenceVerifier


ROOT = Path(__file__).resolve().parent
STATIC_ROOT = (ROOT / "dist" / "client").resolve()
MODEL = "kimi-k3"
MOONSHOT_BASE = "https://api.moonshot.cn/v1"
MAX_BODY_BYTES = 64 * 1024
RESEARCH_SLOTS = threading.BoundedSemaphore(value=2)

TIME_WINDOWS = {"近24小时": 24, "近48小时": 48, "近7天": 168, "近30天": 720, "不限时间": 2160}
LANE_NAMES = {
    "authority": "权威规则",
    "weak_signal": "弱信号发现",
    "source_tracing": "实体溯源",
    "domestic_landing": "境内落地",
    "verification": "证据核验",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_trace(path: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if line.strip():
                events.append(json.loads(line))
    except (OSError, json.JSONDecodeError):
        pass
    return events


def trace_queries(events: list[dict[str, Any]]) -> list[dict[str, str]]:
    queries: list[dict[str, str]] = []
    seen: set[str] = set()
    for event in events:
        if event.get("event") != "search_requested":
            continue
        payload = event.get("payload") or {}
        query = str(payload.get("query") or "").strip()
        if not query or query in seen:
            continue
        seen.add(query)
        lane = str(payload.get("lane") or "")
        objective = str(payload.get("objective") or "").strip()
        queries.append({"query": query, "purpose": f"{LANE_NAMES.get(lane, lane or '研究路径')}：{objective}"})
    return queries[:12]


def trace_logs(events: list[dict[str, Any]]) -> list[dict[str, str]]:
    logs: list[dict[str, str]] = []
    for event in events:
        name = str(event.get("event") or "")
        payload = event.get("payload") or {}
        at = str(event.get("at") or utc_now())[11:19]
        if name == "research_started":
            logs.append({"at": at, "stage": "任务编译", "message": "研究 Agent 已建立五条必要路径", "status": "complete"})
        elif name == "search_requested":
            lane = LANE_NAMES.get(str(payload.get("lane") or ""), "联网检索")
            logs.append({"at": at, "stage": lane, "message": str(payload.get("query") or ""), "status": "running"})
        elif name == "search_succeeded":
            lane = LANE_NAMES.get(str(payload.get("lane") or ""), "联网检索")
            logs.append({"at": at, "stage": lane, "message": f"检索成功 · {payload.get('provider') or 'search'}", "status": "complete"})
        elif name == "search_failed":
            logs.append({"at": at, "stage": "检索失败", "message": str(payload.get("error") or "检索失败"), "status": "failed"})
        elif name == "evidence_verification_finished":
            access = str(payload.get("access") or "unknown")
            logs.append({"at": at, "stage": "证据核验", "message": f"{access} · {payload.get('url') or ''}", "status": "complete" if access == "verified" else "partial"})
        elif name == "theme_graded":
            logs.append({"at": at, "stage": "材料分级", "message": f"{payload.get('grade') or ''} · {payload.get('title') or ''}", "status": "complete"})
        elif name == "run_finished":
            logs.append({"at": at, "stage": "任务结束", "message": f"{payload.get('state') or ''} · 输出 {payload.get('result_count') or 0} 个主题", "status": "complete"})
        elif name == "research_failed":
            logs.append({"at": at, "stage": "任务失败", "message": str(payload.get("error") or "任务失败"), "status": "failed"})
    return logs[-40:]


def verdict_for_grade(grade: str) -> str:
    if grade.startswith("A"):
        return "重点核验"
    if grade.startswith("B") or grade == "C":
        return "弱信号"
    return "排除"


def evidence_level(grade: str, access: str) -> str:
    if grade.startswith("A") and access == "verified":
        return "高"
    if access in {"verified", "partial"}:
        return "中"
    if access in {"inaccessible", "invalid", "failed"}:
        return "低"
    return "待核"


def build_client_result(result: Any, events: list[dict[str, Any]], *, prompt: str, time_range: str, platforms: list[str]) -> dict[str, Any]:
    raw = to_jsonable(result)
    clues: list[dict[str, Any]] = []
    for theme in raw.get("themes") or []:
        grade = str(theme.get("grade") or "C")
        verifications = theme.get("verifications") or []
        for index, evidence in enumerate(theme.get("evidence") or []):
            verification = verifications[index] if index < len(verifications) else {}
            access = str(verification.get("access") or "failed")
            reasons = "；".join(theme.get("grade_reasons") or [])
            basis = "；".join(evidence.get("regulatory_basis") or [])
            clues.append(
                {
                    "id": f"CLUE-{len(clues) + 1:03d}",
                    "title": evidence.get("title") or theme.get("title") or "待核线索",
                    "url": evidence.get("url") or "",
                    "source": evidence.get("platform") or "公开网页",
                    "publishedAt": evidence.get("published_at") or "待核",
                    "summary": evidence.get("excerpt") or theme.get("summary") or "需要打开原页继续核验",
                    "riskSignal": f"{grade} · {theme.get('title') or '风险主题'}",
                    "whyItMatters": "；".join(str(item) for item in [reasons, basis, verification.get("reason")] if item) or "与本轮风险命题存在关联，需人工复核原页",
                    "evidenceLevel": evidence_level(grade, access),
                    "verdict": verdict_for_grade(grade),
                }
            )

    health = raw.get("tool_health") or {}
    coverage = raw.get("coverage") or {}
    state = str(raw.get("state") or "failed")
    state_reasons = [str(item) for item in raw.get("state_reasons") or []]
    gaps = [str(item) for item in coverage.get("gaps") or []]
    tool_failures = [str(item) for item in health.get("tool_failures") or []]
    incomplete = state in {RunState.INCOMPLETE.value, RunState.FAILED.value}
    queries = trace_queries(events)

    if state == RunState.COMPLETED_WITH_LEADS.value:
        confidence = "高" if any(str(item.get("riskSignal") or "").startswith("A") for item in clues) else "中"
    elif clues:
        confidence = "中"
    else:
        confidence = "低"

    uncertainty: list[str] = []
    for theme in raw.get("themes") or []:
        uncertainty.extend(str(item) for item in theme.get("uncertainty") or [])
    evidence_gaps = list(dict.fromkeys([*state_reasons, *gaps, *tool_failures, *uncertainty]))[:10]
    if not evidence_gaps:
        evidence_gaps = ["平台内部完整索引和评论区尚未接入，需人工打开原始页面复核"]
    logs = trace_logs(events) or [{"at": utc_now()[11:19], "stage": "任务状态", "message": "本轮没有生成可展示的研究轨迹", "status": "failed"}]

    return {
        "runId": raw.get("run_id") or f"XR-{datetime.now().strftime('%y%m%d%H%M%S')}",
        "mode": "live",
        "provider": "Kimi",
        "model": MODEL,
        "generatedAt": raw.get("finished_at") or utc_now(),
        "task": {
            "objective": prompt,
            "mode": "服务端多轮风险研究 Agent",
            "timeRange": time_range,
            "platforms": platforms,
            "riskHypotheses": [str(item.get("title")) for item in raw.get("themes") or [] if item.get("title")][:8] or ["本轮尚未形成可验证的风险主题"],
            "inclusionCriteria": ["真实可访问链接", "页面内容与风险命题直接相关", "发布时间与本轮窗口一致"],
            "exclusions": ["新闻报道和批判揭露", "辟谣或事实核查", "纯关键词重合和无法核验页面"],
            "evidenceRequirements": ["原始链接", "标题与正文一致", "发布时间", "具体规则依据"],
            "queries": queries,
        },
        "coverage": [
            {"source": "Kimi 联网搜索", "status": "partial" if incomplete or int(health.get("opaque_searches") or 0) else "complete", "count": int(health.get("search_successes") or 0), "note": f"实际请求 {int(health.get('search_attempts') or 0)} 次，成功 {int(health.get('search_successes') or 0)} 次"},
            {"source": "平台原生页面", "status": "partial" if clues else ("failed" if incomplete else "complete"), "count": len(clues), "note": "每条输出均经过服务端公开 URL 与页面内容核验；平台登录内页面仍可能无法自动访问"},
            {"source": "评论区", "status": "not_covered", "count": 0, "note": "第一版按需求不批量翻评论区"},
        ],
        "clues": clues[:15],
        "assessment": {
            "summary": f"本轮状态：{state}。" + ("形成可进一步核验的线索。" if clues else "没有形成满足输出门禁的线索。") + " ".join(state_reasons[:3]),
            "confidence": confidence,
            "evidenceGaps": evidence_gaps,
            "nextActions": list(dict.fromkeys(["打开重点线索原页核对画面、正文和发布时间", *uncertainty]))[:8],
        },
        "logs": logs,
    }


def validate_key(api_key: str) -> dict[str, str]:
    request = Request(f"{MOONSHOT_BASE}/models", headers={"Authorization": f"Bearer {api_key}", "User-Agent": "XunchaRadarRender/0.1"})
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 401:
            raise PermissionError("Kimi API Key 无效，请重新填写。") from exc
        raise RuntimeError(f"Kimi API 返回 HTTP {exc.code}") from exc
    models = {str(item.get("id") or "").casefold() for item in payload.get("data") or []}
    if MODEL.casefold() not in models:
        raise PermissionError("该 API Key 当前没有 kimi-k3 模型权限。")
    return {"model": MODEL}


class RadarHandler(BaseHTTPRequestHandler):
    server_version = "XunchaRadar/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "public, max-age=300")
        super().end_headers()

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("请求正文为空或过大")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求必须是 JSON 对象")
        return payload

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_json({"status": "ok", "service": "xuncha-radar", "model": MODEL})
            return
        path = self.path.split("?", 1)[0]
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        candidate = (STATIC_ROOT / relative).resolve()
        if STATIC_ROOT not in candidate.parents and candidate != STATIC_ROOT:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            candidate = STATIC_ROOT / "index.html"
        if not candidate.is_file():
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "前端构建产物不存在")
            return
        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self.read_json()
            api_key = str(payload.get("apiKey") or "").strip()
            if not api_key or len(api_key) > 512:
                raise PermissionError("请提供有效的 Kimi API Key。")
            if self.path == "/api/kimi/test":
                self.send_json(validate_key(api_key))
                return
            if self.path != "/api/research":
                self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
                return
            if not RESEARCH_SLOTS.acquire(blocking=False):
                self.send_json({"error": "当前已有调查任务运行，请稍后再试。"}, HTTPStatus.TOO_MANY_REQUESTS)
                return
            try:
                self.run_research(payload, api_key)
            finally:
                RESEARCH_SLOTS.release()
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.UNAUTHORIZED)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self.send_json({"error": f"研究服务执行失败：{type(exc).__name__}: {exc}"}, HTTPStatus.BAD_GATEWAY)

    def run_research(self, payload: dict[str, Any], api_key: str) -> None:
        prompt = str(payload.get("prompt") or "").strip()
        time_range = str(payload.get("timeRange") or "近48小时")
        raw_platforms = payload.get("platforms") or []
        platforms = [str(item).strip() for item in raw_platforms if str(item).strip()][:12]
        if len(prompt) < 4 or len(prompt) > 5_000:
            raise ValueError("巡查任务需为 4–5000 个字符。")
        if not platforms:
            raise ValueError("请至少选择一个平台范围。")
        expanded_prompt = f"{prompt}\n时间范围：{time_range}；平台范围：{'、'.join(platforms)}。重点发现新的风险机制并尽量定位帖子、视频或笔记原页；排除新闻报道、批判揭露、辟谣和纯关键词重合。"
        task = ResearchTask(prompt=expanded_prompt, mode="topic", window_hours=TIME_WINDOWS.get(time_range, 48), max_searches=10, max_rounds=8, max_results=10)
        engine = RadarEngine(
            agent=KimiFormulaAgent(api_key=api_key, model=MODEL, timeout_seconds=120),
            verifier=HttpEvidenceVerifier(timeout_seconds=10),
            memory=None,
        )
        trace_file = tempfile.NamedTemporaryFile(prefix="radar-trace-", suffix=".jsonl", delete=False)
        trace_file.close()
        try:
            result = engine.run(task, trace_path=trace_file.name)
            events = read_trace(trace_file.name)
        finally:
            try:
                os.unlink(trace_file.name)
            except OSError:
                pass
        client = build_client_result(result, events, prompt=prompt, time_range=time_range, platforms=platforms)
        if result.state is RunState.FAILED:
            self.send_json({"error": "；".join(result.state_reasons) or "研究 Agent 执行失败", "result": client}, HTTPStatus.BAD_GATEWAY)
        else:
            self.send_json(client)


def main() -> None:
    port = int(os.environ.get("PORT", "10000"))
    if not STATIC_ROOT.is_dir():
        raise SystemExit(f"前端构建目录不存在：{STATIC_ROOT}")
    server = ThreadingHTTPServer(("0.0.0.0", port), RadarHandler)
    print(f"巡查雷达已启动：http://0.0.0.0:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
