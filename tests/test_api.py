"""Tests for the typed library API (astroscheduler.api)."""

import datetime
import unittest

from astroscheduler import __version__
from astroscheduler.api import (
    SCHEMA_VERSION,
    Block,
    SiteSpec,
    SolveRequest,
    SolveResult,
    TargetSpec,
    solve,
    solve_dict,
)

NIGHT = datetime.date(2026, 10, 15)


def _targets():
    # Synthetic targets: two well placed for an October night at Lick, one never visible.
    return [
        TargetSpec(name="SN 2026aaa", ra="01:00:00", dec="+20:00:00", magnitude=17.0,
                   priority=1, external_id="fu-101"),
        TargetSpec(name="SN 2026bbb", ra="03:00:00", dec="+30:00:00", magnitude=16.5,
                   priority=2, external_id="fu-102"),
        TargetSpec(name="SN 2026ccc", ra="12:00:00", dec="-80:00:00", magnitude=17.0,
                   priority=1, external_id="fu-103"),
    ]


class TestSolveApi(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.request = SolveRequest(date=NIGHT, site=SiteSpec(id="lick"), targets=_targets())
        cls.result = solve(cls.request)

    def test_result_is_typed_and_versioned(self):
        self.assertIsInstance(self.result, SolveResult)
        self.assertTrue(all(isinstance(b, Block) for b in self.result.blocks))
        self.assertEqual(self.result.solver_version, __version__)
        self.assertEqual(self.result.schema_version, SCHEMA_VERSION)

    def test_external_id_echoed_on_science_blocks(self):
        science = {b.target_name: b for b in self.result.blocks if b.kind == "science"}
        self.assertEqual(science["SN 2026aaa"].external_id, "fu-101")
        self.assertEqual(science["SN 2026bbb"].external_id, "fu-102")

    def test_standards_are_marked(self):
        standards = [b for b in self.result.blocks if b.kind == "standard"]
        self.assertTrue(standards, "auto standards should add at least one standard block")
        self.assertTrue(all(b.external_id is None for b in standards))

    def test_unobservable_maps_back_to_external_id(self):
        self.assertIn("SN 2026ccc", self.result.unobservable)
        self.assertEqual(self.result.external_ids["SN 2026ccc"], "fu-103")

    def test_result_round_trips_through_dict(self):
        again = SolveResult.from_dict(self.result.to_dict())
        self.assertEqual(again.to_dict(), self.result.to_dict())

    def test_block_keeps_unknown_fields(self):
        b = Block.from_dict({"target_name": "x", "start_time": "s", "end_time": "e",
                             "duration_minutes": 5, "airmass_start": 1.0, "airmass_end": 1.1,
                             "airmass_median": 1.05, "future_field": 42})
        self.assertEqual(b.extra, {"future_field": 42})
        self.assertEqual(b.to_dict()["future_field"], 42)


class TestSolveDict(unittest.TestCase):

    def test_json_payload_matches_typed_call(self):
        payload = {
            "date": NIGHT.isoformat(),
            "observatory": {"id": "lick"},
            "targets": [t.to_dict() for t in _targets()],
        }
        self.assertEqual(SolveRequest.from_dict(payload).targets, _targets())
        out = solve_dict(payload)
        for key in ("blocks", "conflicts", "unobservable", "empty_blocks", "moon_info",
                    "moon_plot", "airmass_plots", "solar_times", "external_ids",
                    "solver_version", "schema_version"):
            self.assertIn(key, out)
        ids = {b["target_name"]: b["external_id"] for b in out["blocks"]}
        self.assertEqual(ids["SN 2026aaa"], "fu-101")

    def test_legacy_observatory_keys(self):
        site = SiteSpec.from_dict({"id": "keck1", "lat": 19.8, "lon": -155.5})
        self.assertEqual((site.latitude, site.longitude), (19.8, -155.5))
        observatory, telescope = site.resolve()
        self.assertEqual(observatory.timezone, "Pacific/Honolulu")
        self.assertEqual(telescope.name, "Keck I")

    def test_missing_date_is_an_error(self):
        with self.assertRaises(ValueError):
            solve_dict({"targets": []})

    def test_done_and_faint_targets_are_dropped(self):
        targets = _targets()[:2]
        targets[0].status = "Observed"
        request = SolveRequest(date=NIGHT, targets=targets, auto_standards=False,
                               realtime_constraints={"mag_limit": 16.0})
        result = solve(request)
        self.assertFalse([b for b in result.blocks if b.kind == "science"])


class TestPreviousSchedule(unittest.TestCase):

    def test_previous_schedule_matches_on_external_id(self):
        targets = _targets()[:2]
        first = solve(SolveRequest(date=NIGHT, targets=targets, auto_standards=False))
        start = {b.external_id: b.start_time for b in first.blocks}

        # The same follow-up comes back under a new name; its slot should be kept.
        renamed = _targets()[:2]
        renamed[0].name = "AT 2026aaa"
        previous = [{"target_name": "old name", "external_id": "fu-101", "start_time": start["fu-101"]}]
        second = solve(SolveRequest(date=NIGHT, targets=renamed, auto_standards=False,
                                    previous_schedule=previous))
        moved = {b.external_id: b for b in second.blocks}
        self.assertEqual(moved["fu-101"].target_name, "AT 2026aaa")
        self.assertEqual(moved["fu-101"].start_time, start["fu-101"])


if __name__ == "__main__":
    unittest.main()
