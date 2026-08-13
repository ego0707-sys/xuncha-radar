from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .models import ResearchSubmission, ResearchTask, ToolHealth, ValidationError
from .prompts import SEARCH_TOOL, SUBMISSION_TOOL, SYSTEM_PROMPT, build_task_message
from .search import SearchProvider
from .trace import TraceRecorder


class AgentError(RuntimeError):
    pass


class ConfigurationError(AgentError):
    pass


@dataclass(frozen=True)
class AgentOutcome:
    submission: ResearchSubmission
    health: ToolHealth


class ResearchAgent(Protocol):
    def research(
        self,
        task: ResearchTask,
        memory_context: list[dict[str, Any]],
        trace: TraceRecorder,
    ) -> AgentOutcome: ...


@dataclass
class KimiFormulaAgent:
    """Kimi K3 推理层 + Formula 联网检索；网页证据仍由引擎二次核验。"""

    api_key: str | None = None
    base_url: str = "https://api.moonshot.cn/v1"
    model: str = "kimi-k3"
    reasoning_effort: str = "high"
    timeout_seconds: float = 120.0
    formula_uri: str = "moonshot/web-search:latest"
    search_provider: SearchProvider | None = None

    def __post_init__(self) -> None:
        if self.api_key is None:
            self.api_key = os.environ.get("MOONSHOT_API_KEY")
        self.base_url = self.base_url.rstrip("/")

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.api_key:
            raise ConfigurationError(
                "未配置 MOONSHOT_API_KEY；引擎拒绝伪造联网结果"
            )
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "XunchaRadarEngine/0.1",
            },
        )
        for attempt in range(3):
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    return json.loads(response.read().decode("utf-8"))
            except HTTPError as exc:
                retry_after = exc.headers.get("Retry-After")
                if exc.code == 429 and attempt < 2:
                    delay = min(float(retry_after or 2**attempt), 8.0)
                    time.sleep(delay)
                    continue
                try:
                    detail = json.loads(exc.read().decode("utf-8", errors="replace"))
                    message = detail.get("error", {}).get("message") or str(detail)
                except Exception:
                    message = f"HTTP {exc.code}"
                raise AgentError(f"Kimi API 请求失败: {message}") from exc
            except Exception as exc:
                raise AgentError(f"Kimi API 连接失败: {type(exc).__name__}: {exc}") from exc
        raise AgentError("Kimi API 重试耗尽")

    def _call_search_formula(self, query: str) -> str:
        fiber = self._request(
            "POST",
            f"/formulas/{self.formula_uri}/fibers",
            {"name": "web_search", "arguments": json.dumps({"query": query}, ensure_ascii=False)},
        )
        context = fiber.get("context") or {}
        result = context.get("output") or context.get("encrypted_output")
        if fiber.get("status") != "succeeded" or not result:
            error = fiber.get("error") or context.get("error") or "官方检索工具未返回结果"
            raise AgentError(str(error))
        if isinstance(result, str):
            return result
        return json.dumps(result, ensure_ascii=False)

    def research(
        self,
        task: ResearchTask,
        memory_context: list[dict[str, Any]],
        trace: TraceRecorder,
    ) -> AgentOutcome:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_task_message(task, memory_context)},
        ]
        tools = [SEARCH_TOOL, SUBMISSION_TOOL]
        seen_queries: set[tuple[str, str]] = set()
        lanes: list[str] = []
        failures: list[str] = []
        attempts = 0
        successes = 0
        duplicates = 0
        exhausted = False
        no_tool_responses = 0
        model_api_calls = 0
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        transparent_searches = 0
        opaque_searches = 0
        zero_result_searches = 0

        trace.record(
            "research_started",
            task=task.prompt,
            required_lanes=list(task.required_lanes),
            memory_items=len(memory_context),
            model=self.model,
        )

        for round_index in range(task.max_rounds):
            trace.record("model_call", round=round_index + 1, message_count=len(messages))
            response = self._request(
                "POST",
                "/chat/completions",
                {
                    "model": self.model,
                    "messages": messages,
                    "tools": tools,
                    "reasoning_effort": self.reasoning_effort,
                    "max_completion_tokens": 8192,
                },
            )
            model_api_calls += 1
            usage = response.get("usage") or {}
            prompt_tokens += int(usage.get("prompt_tokens") or 0)
            completion_tokens += int(usage.get("completion_tokens") or 0)
            total_tokens += int(usage.get("total_tokens") or 0)
            try:
                choice = response["choices"][0]
                message = choice["message"]
            except (KeyError, IndexError, TypeError) as exc:
                raise AgentError("Kimi API 返回结构不完整") from exc
            finish_reason = choice.get("finish_reason")
            if finish_reason == "length":
                raise AgentError("模型输出被截断，研究结果不可采信")

            messages.append(message)
            tool_calls = message.get("tool_calls") or []
            trace.record(
                "model_observation",
                round=round_index + 1,
                finish_reason=finish_reason,
                tool_call_count=len(tool_calls),
            )
            if not tool_calls:
                no_tool_responses += 1
                if no_tool_responses >= 2:
                    raise AgentError("模型连续两轮未调用检索或提交工具")
                messages.append(
                    {
                        "role": "user",
                        "content": "你尚未完成任务。请继续检索，或调用 submit_research_result 并如实说明覆盖缺口。",
                    }
                )
                continue

            accepted_submission: ResearchSubmission | None = None
            for call in tool_calls:
                call_id = call.get("id")
                function = call.get("function") or {}
                name = function.get("name")
                raw_arguments = function.get("arguments") or "{}"
                try:
                    arguments = json.loads(raw_arguments)
                    if not isinstance(arguments, dict):
                        raise ValueError("工具参数必须是对象")
                except Exception as exc:
                    result = {"ok": False, "error": f"工具参数不是合法 JSON: {exc}"}
                else:
                    if name == "radar_search":
                        attempts += 1
                        lane = str(arguments.get("lane", "")).strip()
                        query = str(arguments.get("query", "")).strip()
                        objective = str(arguments.get("objective", "")).strip()
                        query_key = (lane, "".join(query.casefold().split()))
                        trace.record(
                            "search_requested",
                            lane=lane,
                            query=query,
                            objective=objective,
                        )
                        if attempts > task.max_searches:
                            exhausted = True
                            result = {"ok": False, "error": "检索预算已耗尽，请提交当前结论和缺口"}
                        elif not lane or not query or not objective:
                            result = {"ok": False, "error": "lane/query/objective 均为必填"}
                        elif query_key in seen_queries:
                            duplicates += 1
                            result = {"ok": False, "error": "重复检索已阻止；请更换实体、机制或证据路径"}
                            trace.record("search_blocked_duplicate", lane=lane, query=query)
                        else:
                            seen_queries.add(query_key)
                            lanes.append(lane)
                            try:
                                if self.search_provider is None:
                                    output = self._call_search_formula(query)
                                    opaque_searches += 1
                                    result_count = None
                                    provider_name = "kimi-formula"
                                else:
                                    search_response = self.search_provider.search(query)
                                    output = search_response.for_model()
                                    transparent_searches += 1
                                    result_count = len(search_response.items)
                                    provider_name = search_response.provider
                                    if result_count == 0:
                                        zero_result_searches += 1
                                successes += 1
                                result = output
                                trace.record(
                                    "search_succeeded",
                                    lane=lane,
                                    query=query,
                                    provider=provider_name,
                                    result_count=result_count,
                                    transparent=self.search_provider is not None,
                                )
                            except Exception as exc:
                                failure = f"{lane} 检索失败: {type(exc).__name__}: {exc}"
                                failures.append(failure)
                                result = {"ok": False, "error": failure}
                                trace.record("search_failed", lane=lane, query=query, error=failure)
                    elif name == "submit_research_result":
                        try:
                            accepted_submission = ResearchSubmission.from_dict(arguments)
                            result = {"ok": True, "accepted": True}
                            trace.record(
                                "submission_accepted",
                                theme_count=len(accepted_submission.themes),
                                stop_reason=accepted_submission.coverage.stop_reason,
                            )
                        except ValidationError as exc:
                            result = {"ok": False, "error": str(exc)}
                            trace.record("submission_rejected", error=str(exc))
                    else:
                        result = {"ok": False, "error": f"未知工具: {name}"}

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": result if isinstance(result, str) else json.dumps(result, ensure_ascii=False),
                    }
                )

            if accepted_submission is not None:
                return AgentOutcome(
                    submission=accepted_submission,
                    health=ToolHealth(
                        model_api_calls=model_api_calls,
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        total_tokens=total_tokens,
                        search_attempts=attempts,
                        search_successes=successes,
                        transparent_searches=transparent_searches,
                        opaque_searches=opaque_searches,
                        zero_result_searches=zero_result_searches,
                        searched_lanes=tuple(dict.fromkeys(lanes)),
                        tool_failures=tuple(failures),
                        duplicate_calls_blocked=duplicates,
                        submitted=True,
                        exhausted_budget=exhausted,
                    ),
                )

        raise AgentError(f"工具调用超过最大轮数 {task.max_rounds}")


@dataclass
class FixtureAgent:
    fixture: dict[str, Any]

    @classmethod
    def from_path(cls, path: str | Path) -> "FixtureAgent":
        with Path(path).open("r", encoding="utf-8") as handle:
            return cls(json.load(handle))

    def research(
        self,
        task: ResearchTask,
        memory_context: list[dict[str, Any]],
        trace: TraceRecorder,
    ) -> AgentOutcome:
        trace.record("fixture_research_started", task=task.prompt)
        submission = ResearchSubmission.from_dict(self.fixture["submission"])
        health_data = self.fixture.get("tool_health", {})
        health = ToolHealth(
            model_api_calls=int(health_data.get("model_api_calls", 1)),
            prompt_tokens=int(health_data.get("prompt_tokens", 0)),
            completion_tokens=int(health_data.get("completion_tokens", 0)),
            total_tokens=int(health_data.get("total_tokens", 0)),
            search_attempts=int(health_data.get("search_attempts", 1)),
            search_successes=int(health_data.get("search_successes", 1)),
            transparent_searches=int(health_data.get("transparent_searches", health_data.get("search_successes", 1))),
            opaque_searches=int(health_data.get("opaque_searches", 0)),
            zero_result_searches=int(health_data.get("zero_result_searches", 0)),
            searched_lanes=tuple(health_data.get("searched_lanes", task.required_lanes)),
            tool_failures=tuple(health_data.get("tool_failures", [])),
            duplicate_calls_blocked=int(health_data.get("duplicate_calls_blocked", 0)),
            submitted=True,
            exhausted_budget=bool(health_data.get("exhausted_budget", False)),
        )
        trace.record("fixture_submission_loaded", theme_count=len(submission.themes))
        return AgentOutcome(submission=submission, health=health)
