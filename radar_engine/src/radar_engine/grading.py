from __future__ import annotations

from collections import defaultdict

from .models import (
    AccessState,
    EvidenceCandidate,
    EvidenceVerification,
    Grade,
    MaterialGate,
    PageRole,
    ThemeProposal,
    ThemeResult,
)


def assess_material_gate(
    evidence: EvidenceCandidate,
    verification: EvidenceVerification,
) -> MaterialGate:
    """A 级材料的硬门禁。任何一项失败都只能降级，模型无权绕过。"""

    reasons: list[str] = []
    if evidence.role is not PageRole.DIRECT:
        reasons.append("页面角色不是直接风险载体 D")
    if evidence.dimensions.directness < 2:
        reasons.append("直接性低于 R2")
    if evidence.dimensions.evidence_quality < 2:
        reasons.append("证据质量低于 E2")
    if evidence.dimensions.regulatory_match != 3:
        reasons.append("监管规则匹配未达到 M3")
    if evidence.dimensions.novelty < 2:
        reasons.append("新颖性低于 N2")
    if evidence.dimensions.domestic_connection < 2:
        reasons.append("境内落地关联低于 C2")
    if not evidence.published_at:
        reasons.append("缺少可核验发布时间")
    if not evidence.excerpt:
        reasons.append("缺少页面可见内容摘录")
    if not evidence.regulatory_basis:
        reasons.append("缺少当前有效的具体规则依据")
    if verification.access is not AccessState.VERIFIED:
        reasons.append("原始链接未成功访问核验")
    if not verification.title_match:
        reasons.append("链接与标题不一致")
    if not verification.date_match:
        reasons.append("链接与日期不一致")
    if not verification.content_match:
        reasons.append("链接与所述内容不一致")
    return MaterialGate(passed=not reasons, reasons=tuple(reasons))


def grade_theme(
    proposal: ThemeProposal,
    verifications: tuple[EvidenceVerification, ...],
) -> ThemeResult:
    by_url = {item.url: item for item in verifications}
    gates: list[tuple[EvidenceCandidate, MaterialGate]] = []
    for evidence in proposal.evidence:
        verification = by_url.get(
            evidence.url,
            EvidenceVerification(
                url=evidence.url,
                access=AccessState.FAILED,
                reason="未执行核验",
            ),
        )
        gates.append((evidence, assess_material_gate(evidence, verification)))

    accepted_direct = [evidence for evidence, gate in gates if gate.passed]
    if accepted_direct:
        identities = {(item.platform, item.author or item.url) for item in accepted_direct}
        if len(accepted_direct) >= 2 and len(identities) >= 2:
            grade = Grade.A2
            grade_reasons = ("至少两个不同平台/账号的直接风险样本通过材料门禁",)
        else:
            grade = Grade.A1
            grade_reasons = ("一个直接风险样本通过材料门禁",)
    elif any(item.role is PageRole.DIRECT for item in proposal.evidence):
        grade = Grade.B3
        failures = []
        for item, gate in gates:
            if item.role is PageRole.DIRECT:
                failures.extend(gate.reasons)
        grade_reasons = tuple(dict.fromkeys(failures)) or ("直接样本候选尚未完成证据核验",)
    elif any(
        item.role in {PageRole.LEAD, PageRole.VERIFICATION}
        and item.dimensions.evidence_quality >= 2
        and item.dimensions.novelty >= 1
        for item in proposal.evidence
    ):
        grade = Grade.B2
        grade_reasons = ("存在高价值曝光/权威/投诉线索，但尚非直接风险样本",)
    elif any(
        item.role in {PageRole.LEAD, PageRole.BACKGROUND, PageRole.VERIFICATION}
        and item.dimensions.evidence_quality >= 1
        and item.dimensions.novelty >= 2
        and item.dimensions.domestic_connection < 2
        and bool(item.anchors)
        for item in proposal.evidence
    ):
        grade = Grade.B1
        grade_reasons = ("形成新风险主题，但尚未找到境内直接样本",)
    elif any(item.role is not PageRole.NOISE and item.anchors for item in proposal.evidence):
        grade = Grade.C
        grade_reasons = ("存在真实弱信号和可继续追踪的锚点",)
    else:
        grade = Grade.EXCLUDED
        grade_reasons = ("没有达到可行动线索的最低证据门槛",)

    return ThemeResult(
        title=proposal.title,
        summary=proposal.summary,
        proposition=proposal.proposition,
        grade=grade,
        urgency=proposal.urgency,
        evidence=proposal.evidence,
        verifications=verifications,
        grade_reasons=grade_reasons,
        uncertainty=proposal.uncertainty,
    )


GRADE_ORDER = {
    Grade.A2: 0,
    Grade.A1: 1,
    Grade.B2: 2,
    Grade.B3: 3,
    Grade.B1: 4,
    Grade.C: 5,
    Grade.EXCLUDED: 6,
}

URGENCY_ORDER = {"immediate": 0, "today": 1, "observe": 2}


def rank_and_limit(themes: list[ThemeResult], limit: int) -> tuple[ThemeResult, ...]:
    """同主题按标题聚合，只展示最多十个；绝不为凑数制造卡片。"""

    grouped: dict[str, list[ThemeResult]] = defaultdict(list)
    for theme in themes:
        grouped[theme.title.strip().casefold()].append(theme)

    merged: list[ThemeResult] = []
    for group in grouped.values():
        best = min(group, key=lambda item: GRADE_ORDER[item.grade])
        if len(group) == 1:
            merged.append(best)
            continue
        evidence_by_url = {item.url: item for theme in group for item in theme.evidence}
        verification_by_url = {
            item.url: item for theme in group for item in theme.verifications
        }
        merged.append(
            ThemeResult(
                title=best.title,
                summary=best.summary,
                proposition=best.proposition,
                grade=best.grade,
                urgency=best.urgency,
                evidence=tuple(evidence_by_url.values()),
                verifications=tuple(verification_by_url.values()),
                grade_reasons=best.grade_reasons,
                uncertainty=tuple(
                    dict.fromkeys(note for theme in group for note in theme.uncertainty)
                ),
            )
        )

    merged.sort(
        key=lambda item: (GRADE_ORDER[item.grade], URGENCY_ORDER[item.urgency.value])
    )
    return tuple(merged[:limit])
