from __future__ import annotations

import unittest

from radar_engine.grading import assess_material_gate, grade_theme
from radar_engine.models import (
    AccessState,
    EvidenceCandidate,
    EvidenceVerification,
    Grade,
    ThemeProposal,
)


def direct_evidence() -> EvidenceCandidate:
    return EvidenceCandidate.from_dict(
        {
            "url": "https://example.com/post",
            "title": "原始帖子",
            "platform": "测试平台",
            "published_at": "2026-08-13T01:00:00Z",
            "excerpt": "页面直接发布了待评估内容",
            "author": "account-a",
            "role": "D",
            "dimensions": {
                "directness": 3,
                "evidence_quality": 3,
                "regulatory_match": 3,
                "novelty": 2,
                "domestic_connection": 3,
            },
            "regulatory_basis": ["平台规则第 1 条"],
            "anchors": ["account-a"],
        }
    )


def verified(url: str = "https://example.com/post") -> EvidenceVerification:
    return EvidenceVerification(
        url=url,
        access=AccessState.VERIFIED,
        http_status=200,
        title_match=True,
        date_match=True,
        content_match=True,
    )


class GradingTests(unittest.TestCase):
    def test_direct_sample_passes_all_material_gates(self) -> None:
        gate = assess_material_gate(direct_evidence(), verified())
        self.assertTrue(gate.passed)
        self.assertEqual(gate.reasons, ())

    def test_report_or_exposure_is_lead_not_direct_sample(self) -> None:
        raw = {
            **direct_evidence().__dict__,
            "role": "L",
            "dimensions": {
                "directness": 1,
                "evidence_quality": 3,
                "regulatory_match": 2,
                "novelty": 2,
                "domestic_connection": 2,
            },
        }
        raw["regulatory_basis"] = list(raw["regulatory_basis"])
        raw["anchors"] = list(raw["anchors"])
        evidence = EvidenceCandidate.from_dict(raw)
        proposal = ThemeProposal.from_dict(
            {
                "title": "曝光材料揭示新引流方式",
                "summary": "曝光材料可用于追踪，但不是直接样本。",
                "urgency": "today",
                "proposition": {
                    "subject": "未知账号",
                    "action": "引流",
                    "content": "待追踪内容",
                    "target": "普通用户",
                    "propagation_mechanism": "跨平台招募",
                    "possible_impact": "诱导参与",
                },
                "evidence": [
                    {
                        "url": evidence.url,
                        "title": evidence.title,
                        "platform": evidence.platform,
                        "published_at": evidence.published_at,
                        "excerpt": evidence.excerpt,
                        "author": evidence.author,
                        "role": evidence.role.value,
                        "dimensions": evidence.dimensions.__dict__,
                        "regulatory_basis": list(evidence.regulatory_basis),
                        "anchors": list(evidence.anchors),
                    }
                ],
                "uncertainty": ["尚未找到原始招募帖"],
            }
        )
        result = grade_theme(proposal, (verified(evidence.url),))
        self.assertEqual(result.grade, Grade.B2)

    def test_missing_date_downgrades_direct_candidate_to_b3(self) -> None:
        evidence = direct_evidence()
        raw = {
            "url": evidence.url,
            "title": evidence.title,
            "platform": evidence.platform,
            "published_at": None,
            "excerpt": evidence.excerpt,
            "author": evidence.author,
            "role": "D",
            "dimensions": evidence.dimensions.__dict__,
            "regulatory_basis": list(evidence.regulatory_basis),
            "anchors": list(evidence.anchors),
        }
        proposal = ThemeProposal.from_dict(
            {
                "title": "日期不明候选",
                "summary": "有候选链接但日期不明。",
                "urgency": "observe",
                "proposition": {
                    "subject": "测试账号",
                    "action": "发布",
                    "content": "测试内容",
                    "target": "用户",
                    "propagation_mechanism": "帖子传播",
                    "possible_impact": "不确定",
                },
                "evidence": [raw],
                "uncertainty": [],
            }
        )
        result = grade_theme(proposal, (verified(evidence.url),))
        self.assertEqual(result.grade, Grade.B3)
        self.assertIn("缺少可核验发布时间", result.grade_reasons)


if __name__ == "__main__":
    unittest.main()

