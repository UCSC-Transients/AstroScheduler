"""Data-driven site/telescope limits (#88) and structured exposure plans (#89)."""

import datetime
import re
import unittest

from astroscheduler.api import SiteSpec, SolveRequest, TargetSpec, solve
from astroscheduler.core import (
    Keck1Telescope,
    ShaneTelescope,
    Target,
    Telescope,
    exposure_plan,
    exposure_source,
    get_target_exposure_details,
    load_sites,
)

NIGHT = datetime.date(2026, 10, 15)
MOON = {"ra": 0.0, "dec": 0.0, "phase": 0.0}


def _target(**kw):
    base = dict(name="SN 2026aaa", ra="01:00:00", dec="+20:00:00", magnitude=17.0, priority=1,
                external_id="fu-101")
    base.update(kw)
    return TargetSpec(**base)


def _science(result):
    return [b for b in result.blocks if b.kind == "science"]


class TestTelescopeData(unittest.TestCase):

    def test_presets_come_from_data_file(self):
        sites = load_sites()
        self.assertEqual(set(sites), {"lick", "keck1", "keck2"})
        shane = ShaneTelescope()
        self.assertEqual((shane.ha_limit_east, shane.ha_limit_west), (-5.6667, 3.75))
        self.assertEqual((shane.dec_min, shane.dec_max), (-35.0, 72.0))
        self.assertEqual((shane.airmass_limit, shane.high_airmass_limit), (1.7, 2.2))

    def test_presets_accept_overrides(self):
        self.assertEqual(ShaneTelescope(ha_limit_west=5.6667).ha_limit_west, 5.6667)

    def test_keck_slew_penalty_on_equator_crossing(self):
        keck = Keck1Telescope()
        north = Target("n", "01:00:00", "+10:00:00", 17, 1)
        south = Target("s", "01:00:00", "-10:00:00", 17, 1)
        self.assertEqual(keck.get_slew_time(north, south), 15)
        self.assertEqual(keck.get_slew_time(north, north), 7)
        self.assertEqual(ShaneTelescope().get_slew_time(north, south), 7)

    def test_caller_telescope_limits_change_the_schedule(self):
        default = solve(SolveRequest(date=NIGHT, targets=[_target()], auto_standards=False))
        self.assertEqual(len(_science(default)), 1)

        # A dec ceiling below the target's dec makes it unobservable.
        site = SiteSpec(id="lick", telescope={"dec_max": 10.0})
        limited = solve(SolveRequest(date=NIGHT, site=site, targets=[_target()], auto_standards=False))
        self.assertEqual(_science(limited), [])
        self.assertIn("SN 2026aaa", limited.unobservable)

    def test_airmass_limit_is_overridable_per_solve(self):
        strict = solve(SolveRequest(date=NIGHT, targets=[_target()], auto_standards=False,
                                    realtime_constraints={"airmass_limit": 1.0001}))
        self.assertEqual(_science(strict), [])

    def test_custom_site(self):
        site = SiteSpec(id="testsite", name="Test 2m", latitude=37.0, longitude=-121.0,
                        elevation=1000.0, timezone="America/Los_Angeles",
                        telescope={"name": "Test 2m", "dec_min": -30.0, "dec_max": 70.0,
                                   "ha_limit_east": -4.0, "ha_limit_west": 4.0})
        observatory, telescope = site.resolve()
        self.assertEqual(observatory.name, "Test 2m")
        self.assertIsInstance(telescope, Telescope)
        self.assertEqual(telescope.ha_limit_east, -4.0)
        result = solve(SolveRequest(date=NIGHT, site=site, targets=[_target()], auto_standards=False))
        self.assertEqual(len(_science(result)), 1)

    def test_custom_site_needs_coordinates(self):
        with self.assertRaises(ValueError):
            SiteSpec(id="nowhere", telescope={"name": "X"}).resolve()


class TestExposurePlan(unittest.TestCase):

    def test_sources(self):
        self.assertEqual(exposure_source(Target("x", 1, 1, 17, 1)), "lookup")
        self.assertEqual(exposure_source(Target("x", 1, 1, 17, 1, manual_duration=30)), "manual_duration")
        self.assertEqual(exposure_source(Target("x", 1, 1, 17, 1, red_exptime=300, red_num=2,
                                                blue_exptime=600, blue_num=1)), "override")
        self.assertEqual(exposure_source(Target("Feige 34", 1, 1, 11, 0)), "standard")

    def test_overhead_minutes_changes_duration(self):
        base = Target("x", "01:00:00", "+20:00:00", 17.0, 1)
        slow = Target("x", "01:00:00", "+20:00:00", 17.0, 1, overhead_minutes=15)
        d_base = get_target_exposure_details(base, MOON, 0.0, 37.3)[4]
        d_slow = get_target_exposure_details(slow, MOON, 0.0, 37.3)[4]
        self.assertEqual(d_slow - d_base, 8)
        self.assertEqual(exposure_plan(slow, MOON, 0.0, 37.3)["overhead"]["slew_acq_min"], 15)

    def test_blocks_carry_plan_matching_comment(self):
        result = solve(SolveRequest(date=NIGHT, targets=[_target()]))
        self.assertTrue(result.blocks)
        for block in result.blocks:
            self.assertIn(block.exposure_source, ("lookup", "standard", "override", "manual_duration"))
            m = re.search(r"Blue: (\d+)x(\d+)s, Red: (\d+)x(\d+)s", block.comment)
            self.assertIsNotNone(m, block.comment)
            blue_n, blue_s, red_n, red_s = map(int, m.groups())
            self.assertEqual(block.exposures["blue"]["num"], blue_n)
            self.assertEqual(round(block.exposures["blue"]["exptime"]), blue_s)
            self.assertEqual(block.exposures["red"]["num"], red_n)
            self.assertEqual(round(block.exposures["red"]["exptime"]), red_s)
            self.assertEqual(block.instrument, "kast")

    def test_overhead_minutes_through_api(self):
        normal = _science(solve(SolveRequest(date=NIGHT, targets=[_target()], auto_standards=False)))[0]
        slow = _science(solve(SolveRequest(date=NIGHT, targets=[_target(overhead_minutes=17)],
                                           auto_standards=False)))[0]
        self.assertEqual(slow.duration_minutes - normal.duration_minutes, 10)
        self.assertEqual(slow.overhead["slew_acq_min"], 17)
        self.assertTrue(slow.comment.startswith("Slew: 17m."))


if __name__ == "__main__":
    unittest.main()
