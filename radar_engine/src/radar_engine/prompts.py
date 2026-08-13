from __future__ import annotations

import json

from .models import ResearchTask


SYSTEM_PROMPT = """你是“巡查雷达”的研究决策层，不是关键词搜索器，也不是自动定性执法工具。

目标：比常规热榜巡查更早发现近期出现的内容生态风险机制，并尽量定位到真实、可复核的原始帖子、视频或笔记。用户会自行扩展评论和样本，你不需要批量翻评论区。

必须遵守：
1. 先提出可证伪的风险假设，再选择检索路径；根据新实体、账号、暗语、组织名、事件名不断调整路径。
2. 信息链优先级：监管/平台规则 → 境内外弱信号 → 溯源与实体扩展 → 境内内容落地 → 事实与链接核验。热榜只能用于升温验证，不能冒充未知风险发现。
3. 每次 radar_search 必须标注 lane 和 objective。重复同一查询、没有信息增益时立即换路径。
4. 页面角色严格区分：D=直接风险载体；L=线索载体；V=核验材料；B=背景；N=噪声。报道、曝光、辟谣和治理公告通常是 L/V，不是 D。
5. 只描述页面可观察到的内容与传播机制。没有权威依据时，不得断言“邪教、诈骗、违法”等法律/组织属性；不得根据受保护身份、群体身份或政治立场本身推断风险。对 LGBT 等议题，只能评估具体行动、组织动员、伤害或违规传播行为，身份本身不是风险。
6. 直接样本必须给出 URL、标题、平台、日期、可见原文摘录和具体有效规则依据。缺任何一项都不能假装已经坐实。
7. 结果最多提交 10 个真正有价值的主题，不得凑数。资料不足、页面不可达、时间不明或工具失败必须明确写入 coverage.gaps / uncertainty。
8. 结束前必须调用 submit_research_result；普通文本回答不算完成。
"""


SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "radar_search",
        "description": "按研究路径执行一次联网搜索。只有查询能带来新的实体、机制、规则或落地样本时才调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "lane": {
                    "type": "string",
                    "enum": [
                        "authority",
                        "weak_signal",
                        "source_tracing",
                        "domestic_landing",
                        "verification",
                    ],
                    "description": "本次检索属于哪条证据链",
                },
                "query": {"type": "string", "description": "精确、自然的搜索式"},
                "objective": {
                    "type": "string",
                    "description": "本轮要验证什么假设或补足什么证据",
                },
            },
            "required": ["lane", "query", "objective"],
            "additionalProperties": False,
        },
    },
}


SUBMISSION_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_research_result",
        "description": "提交结构化研究结果。只有完成必要检索、交叉核验或明确说明覆盖缺口后才能调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "task_summary": {"type": "string"},
                "coverage": {
                    "type": "object",
                    "properties": {
                        "covered_lanes": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "gaps": {"type": "array", "items": {"type": "string"}},
                        "stop_reason": {"type": "string"},
                    },
                    "required": ["covered_lanes", "gaps", "stop_reason"],
                    "additionalProperties": False,
                },
                "themes": {
                    "type": "array",
                    "maxItems": 10,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "summary": {"type": "string"},
                            "urgency": {
                                "type": "string",
                                "enum": ["immediate", "today", "observe"],
                            },
                            "proposition": {
                                "type": "object",
                                "properties": {
                                    "subject": {"type": "string"},
                                    "action": {"type": "string"},
                                    "content": {"type": "string"},
                                    "target": {"type": "string"},
                                    "propagation_mechanism": {"type": "string"},
                                    "possible_impact": {"type": "string"},
                                },
                                "required": [
                                    "subject",
                                    "action",
                                    "content",
                                    "target",
                                    "propagation_mechanism",
                                    "possible_impact",
                                ],
                                "additionalProperties": False,
                            },
                            "evidence": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "url": {"type": "string"},
                                        "title": {"type": "string"},
                                        "platform": {"type": "string"},
                                        "published_at": {"type": ["string", "null"]},
                                        "excerpt": {"type": ["string", "null"]},
                                        "author": {"type": ["string", "null"]},
                                        "role": {
                                            "type": "string",
                                            "enum": ["D", "L", "V", "B", "N"],
                                        },
                                        "dimensions": {
                                            "type": "object",
                                            "properties": {
                                                "directness": {"type": "integer", "minimum": 0, "maximum": 3},
                                                "evidence_quality": {"type": "integer", "minimum": 0, "maximum": 3},
                                                "regulatory_match": {"type": "integer", "minimum": 0, "maximum": 3},
                                                "novelty": {"type": "integer", "minimum": 0, "maximum": 3},
                                                "domestic_connection": {"type": "integer", "minimum": 0, "maximum": 3},
                                            },
                                            "required": [
                                                "directness",
                                                "evidence_quality",
                                                "regulatory_match",
                                                "novelty",
                                                "domestic_connection",
                                            ],
                                            "additionalProperties": False,
                                        },
                                        "regulatory_basis": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                        "anchors": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                    },
                                    "required": [
                                        "url",
                                        "title",
                                        "platform",
                                        "published_at",
                                        "excerpt",
                                        "author",
                                        "role",
                                        "dimensions",
                                        "regulatory_basis",
                                        "anchors",
                                    ],
                                    "additionalProperties": False,
                                },
                            },
                            "uncertainty": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                        },
                        "required": [
                            "title",
                            "summary",
                            "urgency",
                            "proposition",
                            "evidence",
                            "uncertainty",
                        ],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["task_summary", "coverage", "themes"],
            "additionalProperties": False,
        },
    },
}


def build_task_message(task: ResearchTask, memory_context: list[dict]) -> str:
    payload = {
        "task": task.prompt,
        "mode": task.mode,
        "current_time": task.now,
        "window_hours": task.window_hours,
        "required_lanes": list(task.required_lanes),
        "budgets": {
            "max_searches": task.max_searches,
            "max_tool_rounds": task.max_rounds,
            "max_result_themes": task.max_results,
        },
        "team_memory": memory_context,
    }
    return (
        "请执行以下巡查研究任务。团队历史记忆仅用于去重和延续线索，不能代替本次证据。\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )

