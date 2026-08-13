from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from radar_engine.agent import FixtureAgent
from radar_engine.engine import RadarEngine
from radar_engine.memory import SQLiteMemoryStore
from radar_engine.models import (
    AccessState,
    EvidenceVerification,
    Grade,
    ResearchTask,
    RunState,
)
from radar_engine.verifier import FixtureVerifier


FIXTURE = Path(__file__).parent / "fixtures" / "direct_sample.json"
URL = "https://example.com/risk-post"


def good_verifier() -> FixtureVerifier:
    return FixtureVerifier(
        {
            URL: EvidenceVerification(
                url=URL,
                access=AccessState.VERIFIED,
                http_status=200,
                title_match=True,
                date_match=True,
                content_match=True,
            )
        }
    )


class EngineTests(unittest.TestCase):
    def test_end_to_end_fixture_produces_a1_and_complete_run(self) -> None:
        engine = RadarEngine(FixtureAgent.from_path(FIXTURE), good_verifier())
        with tempfile.TemporaryDirectory() as directory:
            result = engine.run(
                ResearchTask(prompt="fixture task"),
                trace_path=Path(directory) / "trace.jsonl",
            )
            self.assertEqual(result.state, RunState.COMPLETED_WITH_LEADS)
            self.assertEqual(result.themes[0].grade, Grade.A1)
            self.assertTrue(Path(result.trace_path or "").exists())

    def test_claimed_coverage_without_tool_trace_is_incomplete(self) -> None:
        with FIXTURE.open("r", encoding="utf-8") as handle:
            fixture = json.load(handle)
        fixture["tool_health"]["searched_lanes"] = ["authority"]
        engine = RadarEngine(FixtureAgent(fixture), good_verifier())
        result = engine.run(ResearchTask(prompt="fixture task"))
        self.assertEqual(result.state, RunState.INCOMPLETE)
        self.assertTrue(any("未实际执行必要路径" in reason for reason in result.state_reasons))

    def test_failed_page_verification_cannot_receive_a_grade(self) -> None:
        verifier = FixtureVerifier(
            {
                URL: EvidenceVerification(
                    url=URL,
                    access=AccessState.INACCESSIBLE,
                    reason="blocked",
                )
            }
        )
        engine = RadarEngine(FixtureAgent.from_path(FIXTURE), verifier)
        result = engine.run(ResearchTask(prompt="fixture task"))
        self.assertEqual(result.themes[0].grade, Grade.B3)
        self.assertEqual(result.state, RunState.SUPPLEMENTING)

    def test_team_memory_prevents_old_theme_from_scoring_as_new(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            memory = SQLiteMemoryStore(Path(directory) / "memory.sqlite3")
            try:
                engine = RadarEngine(FixtureAgent.from_path(FIXTURE), good_verifier(), memory)
                first = engine.run(ResearchTask(prompt="fixture task"))
                second = engine.run(ResearchTask(prompt="fixture task"))
            finally:
                memory.close()
        self.assertEqual(first.themes[0].grade, Grade.A1)
        self.assertEqual(second.themes[0].grade, Grade.B3)
        self.assertTrue(any("历史记忆" in note for note in second.themes[0].uncertainty))


if __name__ == "__main__":
    unittest.main()
