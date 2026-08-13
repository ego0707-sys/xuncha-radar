from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .agent import AgentError, KimiFormulaAgent
from .models import ResearchTask
from .trace import TraceRecorder


BASELINE_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "搜索互联网以回答用户问题",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}


@dataclass(frozen=True)
class BaselineOutcome:
    content: str
    model_api_calls: int
    search_attempts: int
    search_successes: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass
class DirectKimiBaseline:
    """对照组：同一 Kimi K3、同一联网搜索和预算，但没有雷达规则、记忆与证据门禁。"""

    client: KimiFormulaAgent

    def run(self, task: ResearchTask, trace: TraceRecorder) -> BaselineOutcome:
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": "你是 Kimi。请使用联网搜索完成用户任务，给出近期、具体、可核验的链接和简明判断。不得编造来源。",
            },
            {
                "role": "user",
                "content": (
                    f"当前时间：{task.now}\n时间范围：近 {task.window_hours} 小时\n"
                    f"任务：{task.prompt}"
                ),
            },
        ]
        attempts = 0
        successes = 0
        model_calls = 0
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        seen: set[str] = set()

        for round_index in range(task.max_rounds):
            response = self.client._request(
                "POST",
                "/chat/completions",
                {
                    "model": self.client.model,
                    "messages": messages,
                    "tools": [BASELINE_SEARCH_TOOL],
                    "reasoning_effort": self.client.reasoning_effort,
                    "max_completion_tokens": 8192,
                },
            )
            model_calls += 1
            usage = response.get("usage") or {}
            prompt_tokens += int(usage.get("prompt_tokens") or 0)
            completion_tokens += int(usage.get("completion_tokens") or 0)
            total_tokens += int(usage.get("total_tokens") or 0)
            choice = response["choices"][0]
            message = choice["message"]
            if choice.get("finish_reason") == "length":
                raise AgentError("Kimi 对照组输出被截断")
            messages.append(message)
            calls = message.get("tool_calls") or []
            trace.record(
                "baseline_model_observation",
                round=round_index + 1,
                tool_call_count=len(calls),
            )
            if not calls:
                content = message.get("content") or ""
                if not content.strip():
                    raise AgentError("Kimi 对照组没有返回内容")
                return BaselineOutcome(
                    content=content,
                    model_api_calls=model_calls,
                    search_attempts=attempts,
                    search_successes=successes,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                )

            for call in calls:
                name = (call.get("function") or {}).get("name")
                raw_arguments = (call.get("function") or {}).get("arguments") or "{}"
                try:
                    arguments = json.loads(raw_arguments)
                    query = str(arguments.get("query") or "").strip()
                    normalized = "".join(query.casefold().split())
                    attempts += 1
                    if name != "web_search" or not query:
                        result: str | dict = {"error": "无效搜索工具调用"}
                    elif attempts > task.max_searches:
                        result = {"error": "搜索预算已耗尽，请直接总结"}
                    elif normalized in seen:
                        result = {"error": "重复搜索，请直接总结或更换查询"}
                    else:
                        seen.add(normalized)
                        result = self.client._call_search_formula(query)
                        successes += 1
                        trace.record("baseline_search_succeeded", query=query)
                except Exception as exc:
                    result = {"error": f"{type(exc).__name__}: {exc}"}
                    trace.record("baseline_search_failed", error=str(result["error"]))
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id"),
                        "content": result if isinstance(result, str) else json.dumps(result, ensure_ascii=False),
                    }
                )
        raise AgentError(f"Kimi 对照组超过最大轮数 {task.max_rounds}")

