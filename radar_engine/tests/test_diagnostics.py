from __future__ import annotations

import unittest

from radar_engine.diagnostics import inspect_legacy_export


class DiagnosticRegressionTests(unittest.TestCase):
    def test_detects_zero_parse_fixed_cap_volume_and_false_completion(self) -> None:
        data = {
            "recentRuns": [
                {
                    "id": "legacy-1",
                    "failedModelBatches": 2,
                    "newMatches": 0,
                    "outcome": {"code": "completed"},
                    "coverage": {
                        "analyzedCards": 300,
                        "byPlatform": {
                            "抖音": {
                                "attempts": 2,
                                "successfulQueries": 2,
                                "structuredCardsCollected": 0,
                                "analyzedCards": 0,
                                "technicalFailures": 0,
                            },
                            "B站": {
                                "attempts": 2,
                                "successfulQueries": 2,
                                "structuredCardsCollected": 240,
                                "analyzedCards": 240,
                                "technicalFailures": 0,
                            },
                        },
                    },
                }
            ]
        }
        codes = {finding.code for finding in inspect_legacy_export(data)}
        self.assertTrue(
            {
                "ZERO_PARSE_FAKE_SUCCESS",
                "FIXED_CAP_ANOMALY",
                "VOLUME_VANITY",
                "MODEL_FAILURE_FALSE_COMPLETION",
            }.issubset(codes)
        )

    def test_long_task_prompt_used_as_query_is_detected(self) -> None:
        data = {
            "recentRuns": [
                {
                    "id": "legacy-2",
                    "investigationQueries": ["整段任务" * 30],
                    "coverage": {},
                }
            ]
        }
        codes = {finding.code for finding in inspect_legacy_export(data)}
        self.assertIn("BROAD_PROMPT_AS_QUERY", codes)

    def test_seed_search_inheriting_task_title_is_detected(self) -> None:
        data = {
            "seed": {
                "title": "巡查检索各大平台,找近48小时内有可能会引发热敏舆情的事件",
                "searchCoverage": [
                    {
                        "platform": "抖音",
                        "query": "检索各大平台,找近48小时内有可能会引发热敏舆情 群体情绪对立",
                        "collectedCount": 0,
                        "endReached": True,
                    }
                ],
            }
        }
        codes = {finding.code for finding in inspect_legacy_export(data)}
        self.assertIn("BROAD_PROMPT_AS_QUERY", codes)
        self.assertIn("ZERO_PARSE_FAKE_SUCCESS", codes)


if __name__ == "__main__":
    unittest.main()
