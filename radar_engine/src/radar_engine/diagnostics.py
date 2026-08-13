from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class DiagnosticFinding:
    code: str
    severity: str
    message: str
    run_id: str | None = None
    platform: str | None = None


def inspect_legacy_export(data: dict[str, Any]) -> list[DiagnosticFinding]:
    """把旧版失败模式转成稳定回归信号，不复制原始敏感内容。"""

    findings: list[DiagnosticFinding] = []
    seed = data.get("seed") or {}
    if isinstance(seed, dict):
        seed_title = str(seed.get("title") or "")
        comparable_title = seed_title.removeprefix("巡查").strip()
        for item in seed.get("searchCoverage") or []:
            if not isinstance(item, dict):
                continue
            query = str(item.get("query") or "")
            platform = str(item.get("platform") or "") or None
            collected = int(item.get("collectedCount") or 0)
            if comparable_title and len(comparable_title) >= 12 and comparable_title[:12] in query:
                findings.append(
                    DiagnosticFinding(
                        code="BROAD_PROMPT_AS_QUERY",
                        severity="high",
                        message="搜索式直接继承了整段任务标题，应先提取实体、行为和时间锚点",
                        platform=platform,
                    )
                )
            if collected == 0 and item.get("endReached") is True:
                findings.append(
                    DiagnosticFinding(
                        code="ZERO_PARSE_FAKE_SUCCESS",
                        severity="critical",
                        message="搜索路径以‘到达底部’结束，但结构化结果为 0 且没有技术失败",
                        platform=platform,
                    )
                )

    runs = data.get("recentRuns") or []
    for run in runs:
        if not isinstance(run, dict):
            continue
        run_id = run.get("id")
        coverage = run.get("coverage") or {}
        by_platform = coverage.get("byPlatform") or {}
        for platform, stats in by_platform.items():
            if not isinstance(stats, dict):
                continue
            attempts = int(stats.get("attempts") or 0)
            successful = int(stats.get("successfulQueries") or 0)
            parsed = int(stats.get("structuredCardsCollected") or 0)
            analyzed = int(stats.get("analyzedCards") or 0)
            technical = int(stats.get("technicalFailures") or 0)
            if attempts and successful and parsed == 0 and technical == 0:
                findings.append(
                    DiagnosticFinding(
                        code="ZERO_PARSE_FAKE_SUCCESS",
                        severity="critical",
                        message="查询被记录为成功，但解析结果为 0 且没有技术失败",
                        run_id=run_id,
                        platform=platform,
                    )
                )
            if attempts >= 2 and analyzed == attempts * 120:
                findings.append(
                    DiagnosticFinding(
                        code="FIXED_CAP_ANOMALY",
                        severity="high",
                        message="每次检索恰好返回固定 120 条，必须检查截断或重复采集",
                        run_id=run_id,
                        platform=platform,
                    )
                )

        failed_batches = int(run.get("failedModelBatches") or coverage.get("failedModelBatches") or 0)
        outcome = run.get("outcome") or {}
        if failed_batches > 0 and outcome.get("code") not in {"incomplete", "failed"}:
            findings.append(
                DiagnosticFinding(
                    code="MODEL_FAILURE_FALSE_COMPLETION",
                    severity="critical",
                    message="存在模型批次失败，但运行没有标记为未完成/失败",
                    run_id=run_id,
                )
            )
        analyzed_cards = int(coverage.get("analyzedCards") or 0)
        new_matches = int(run.get("newMatches") or 0)
        if analyzed_cards >= 250 and new_matches == 0:
            findings.append(
                DiagnosticFinding(
                    code="VOLUME_VANITY",
                    severity="high",
                    message="处理了大量卡片却没有有效新线索，不能用处理量冒充质量",
                    run_id=run_id,
                )
            )

        for query in run.get("investigationQueries") or []:
            if isinstance(query, str) and len(query) >= 80:
                findings.append(
                    DiagnosticFinding(
                        code="BROAD_PROMPT_AS_QUERY",
                        severity="high",
                        message="搜索式疑似直接拼接整段任务，应先提取实体、行为和时间锚点",
                        run_id=run_id,
                    )
                )
                break
    deduplicated: list[DiagnosticFinding] = []
    seen: set[tuple[str, str | None, str | None]] = set()
    for finding in findings:
        key = (finding.code, finding.run_id, finding.platform)
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(finding)
    return deduplicated


def summarize_legacy_export(data: dict[str, Any]) -> dict[str, Any]:
    findings = inspect_legacy_export(data)
    return {
        "app_version": data.get("appVersion"),
        "exported_at": data.get("exportedAt"),
        "candidate_count": len(data.get("candidates") or []),
        "run_count": len(data.get("recentRuns") or []),
        "findings": [finding.__dict__ for finding in findings],
    }
