from __future__ import annotations

from .models import CoverageReport, Grade, RunState, ThemeResult, ToolHealth


def evaluate_run_state(
    coverage: CoverageReport | None,
    health: ToolHealth,
    themes: tuple[ThemeResult, ...],
    *,
    agent_error: str | None = None,
) -> tuple[RunState, tuple[str, ...]]:
    """运行状态和结果等级完全分离，失败不得包装成“无风险”。"""

    if agent_error:
        return RunState.FAILED, (agent_error,)
    if not health.submitted or coverage is None:
        return RunState.FAILED, ("研究 Agent 未提交结构化结果",)

    incomplete_reasons: list[str] = []
    if health.tool_failures:
        incomplete_reasons.extend(health.tool_failures)
    if health.search_attempts == 0:
        incomplete_reasons.append("未实际执行联网检索")
    elif health.search_successes == 0:
        incomplete_reasons.append("联网检索没有一次成功执行")
    if health.exhausted_budget:
        incomplete_reasons.append("研究预算耗尽")
    if health.opaque_searches > 0 and health.transparent_searches == 0:
        incomplete_reasons.append("本次仅使用模型可见的密文检索结果，原始结果集不可独立审计")
    if health.duplicate_calls_blocked >= 3:
        incomplete_reasons.append("重复检索过多，路径没有产生信息增益")
    if coverage.gaps:
        incomplete_reasons.extend(f"覆盖缺口：{gap}" for gap in coverage.gaps)
    if incomplete_reasons:
        return RunState.INCOMPLETE, tuple(dict.fromkeys(incomplete_reasons))

    actionable = [item for item in themes if item.grade in {Grade.A1, Grade.A2, Grade.B1, Grade.B2, Grade.B3}]
    if actionable:
        if any(item.grade in {Grade.B1, Grade.B3} for item in actionable) and not any(
            item.grade in {Grade.A1, Grade.A2, Grade.B2} for item in actionable
        ):
            return RunState.SUPPLEMENTING, ("已形成线索，但仍缺直接样本或关键证据",)
        return RunState.COMPLETED_WITH_LEADS, ("形成至少一个可行动的 A/B 级线索",)
    return RunState.COMPLETED_NO_LEAD, ("检索覆盖完整，但当前没有达到 A/B 级的线索",)
