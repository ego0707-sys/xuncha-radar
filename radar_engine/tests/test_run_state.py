from __future__ import annotations

import unittest

from radar_engine.models import CoverageReport, RunState, ToolHealth
from radar_engine.run_state import evaluate_run_state


class RunStateTests(unittest.TestCase):
    def test_opaque_only_search_cannot_claim_complete_coverage(self) -> None:
        state, reasons = evaluate_run_state(
            CoverageReport(covered_lanes=("authority",), gaps=(), stop_reason="done"),
            ToolHealth(
                search_attempts=2,
                search_successes=2,
                opaque_searches=2,
                submitted=True,
            ),
            (),
        )
        self.assertEqual(state, RunState.INCOMPLETE)
        self.assertTrue(any("不可独立审计" in reason for reason in reasons))

    def test_transparent_success_with_zero_results_can_honestly_finish_empty(self) -> None:
        state, reasons = evaluate_run_state(
            CoverageReport(covered_lanes=("authority",), gaps=(), stop_reason="no current lead"),
            ToolHealth(
                search_attempts=2,
                search_successes=2,
                transparent_searches=2,
                zero_result_searches=2,
                submitted=True,
            ),
            (),
        )
        self.assertEqual(state, RunState.COMPLETED_NO_LEAD)
        self.assertTrue(any("当前没有" in reason for reason in reasons))


if __name__ == "__main__":
    unittest.main()

