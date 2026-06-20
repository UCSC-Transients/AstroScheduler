"""
Unit tests for scheduler.py (unittest version)
"""

import unittest
import datetime
from scheduler import (
    Observatory,
    ShaneTelescope,
    Target,
    Scheduler,
    get_lst,
    get_alt_az,
    get_airmass,
    get_separation,
    parse_coordinate
)


class TestScheduler(unittest.TestCase):

    def test_coordinate_parsing(self):
        # RA parsing (is_ra=True)
        # Decimal hours directly (treated as degrees -> 18.5 / 15.0 = 1.2333 hours)
        self.assertAlmostEqual(parse_coordinate("18.5", is_ra=True), 1.2333333333333334)
        # Sexagesimal hours: 18:30:00 -> 18.5
        self.assertAlmostEqual(parse_coordinate("18:30:00", is_ra=True), 18.5)
        self.assertAlmostEqual(parse_coordinate("18 30 00", is_ra=True), 18.5)
        self.assertAlmostEqual(parse_coordinate("18h30m00s", is_ra=True), 18.5)
        # Decimal degrees: 277.5 deg -> 18.5 hours
        self.assertAlmostEqual(parse_coordinate("277.5", is_ra=True), 18.5)
        
        # Dec parsing (is_ra=False)
        self.assertAlmostEqual(parse_coordinate("38.5", is_ra=False), 38.5)
        self.assertAlmostEqual(parse_coordinate("+38:30:00", is_ra=False), 38.5)
        self.assertAlmostEqual(parse_coordinate("-38:30:00", is_ra=False), -38.5)
        self.assertAlmostEqual(parse_coordinate("38°30'", is_ra=False), 38.5)

    def test_float_priority_scheduling(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)
        
        lst_mid = get_lst(scheduler.chunk_times[scheduler.num_chunks // 2], observatory.longitude)
        
        # Two conflicting targets at same position
        # Dec = -16.0 limits their observability window to a very short transit duration (airmass < 1.7)
        # Mag = 18.2 results in an exposure time requiring 35 mins (7 chunks) each, forcing them to conflict.
        t1 = Target("Target1.2", lst_mid * 15.0, -16.0, 18.2, 1.2)
        t2 = Target("Target1.8", lst_mid * 15.0, -16.0, 18.2, 1.8)
        
        targets = [t1, t2]
        res = scheduler.solve(targets)
        
        # Target 1.2 should be scheduled because it has a higher priority (1.2 < 1.8)
        # Target 1.8 should be in conflict
        science_blocks = [b for b in res['blocks'] if b['priority'] > 0]
        self.assertEqual(len(science_blocks), 1)
        self.assertEqual(science_blocks[0]['target_name'], "Target1.2")
        self.assertIn("Target1.8", res['conflicts'])

    def test_time_conversions(self):
        # Test LST calculation
        dt = datetime.datetime(2026, 6, 18, 22, 0, 0, tzinfo=datetime.timezone.utc)
        # Lick longitude is -121.6429 deg
        lst = get_lst(dt, -121.6429)
        self.assertTrue(0.0 <= lst < 24.0)

    def test_pointing_and_airmass(self):
        # Target overhead
        # Lick latitude is 37.3414 N
        # A target at RA = LST and Dec = latitude should have altitude ~90 deg and airmass ~1.0
        dt = datetime.datetime(2026, 6, 18, 22, 0, 0, tzinfo=datetime.timezone.utc)
        lst = get_lst(dt, -121.6429)
        alt, az = get_alt_az(dt, 37.3414, -121.6429, lst, 37.3414)
        self.assertTrue(80.0 <= alt <= 90.0)
        
        airmass = get_airmass(alt)
        self.assertTrue(1.0 <= airmass < 1.2)
        
        # Check declination and hour angle limits of Lick Shane
        telescope = ShaneTelescope()
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        
        # Declination too far south (-40 deg) should not be visible
        self.assertFalse(telescope.is_visible(lst, -40.0, dt, observatory))
        
        # Declination too far north (+75 deg) should not be visible
        self.assertFalse(telescope.is_visible(lst, 75.0, dt, observatory))
        
        # Valid declination (+30 deg) at LST (HA = 0) should be visible
        self.assertTrue(telescope.is_visible(lst, 30.0, dt, observatory))
        
        # Hour angle too far East: RA is LST + 6 hours (HA = -6 hours)
        self.assertFalse(telescope.is_visible(lst + 6.0, 30.0, dt, observatory))
        
        # Hour angle too far West: RA is LST - 4 hours (HA = +4 hours)
        self.assertFalse(telescope.is_visible(lst - 4.0, 30.0, dt, observatory))

    def test_exposure_time_calculation(self):
        # Base target
        target = Target("Vega", 18.6 * 15.0, 38.7, 15.0, 1) # Mag 15
        # Dark sky, no moon (phase = 0)
        exp = target.calculate_exposure_time(0.0, 90.0)
        self.assertTrue(99.0 <= exp <= 101.0) # 100 seconds
        
        # Bright moon close by (phase = 1.0, sep = 0 deg)
        exp_moon = target.calculate_exposure_time(1.0, 0.0)
        self.assertTrue(exp_moon > 500.0) # Significantly increased
        
        # S/N mode test
        target_class = Target("Vega", 18.6 * 15.0, 38.7, 16.0, 1, sn_mode="classification")
        exp_class = target_class.calculate_exposure_time(0.0, 90.0)
        self.assertTrue(124.0 <= exp_class <= 127.0) # ~125.6 seconds (half of normal)
        
        target_high = Target("Vega", 18.6 * 15.0, 38.7, 16.0, 1, sn_mode="high_sn")
        exp_high = target_high.calculate_exposure_time(0.0, 90.0)
        self.assertTrue(500.0 <= exp_high <= 505.0) # ~502.4 seconds (double of normal)

    def test_scheduler_solver(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        
        scheduler = Scheduler(observatory, telescope, date_local)
        
        # Create targets
        # Target 1: Always visible during the night
        lst_mid = get_lst(scheduler.chunk_times[scheduler.num_chunks // 2], observatory.longitude)
        t1 = Target("Target1", lst_mid * 15.0, 37.3, 15.0, 1) # Normal
        
        # Target 2: Same position, competing for the same slot
        t2 = Target("Target2", lst_mid * 15.0, 37.3, 15.0, 1)
        
        targets = [t1, t2]
        res = scheduler.solve(targets)
        
        # Both targets should be scheduled since they can fit sequentially
        science_blocks = [b for b in res['blocks'] if b['priority'] > 0]
        self.assertEqual(len(science_blocks), 2)
        self.assertEqual(len(res['conflicts']), 0)
        self.assertEqual(len(res['unobservable']), 0)
        
        # Check that they don't overlap in time
        b1 = science_blocks[0]
        b2 = science_blocks[1]
        
        t1_start = datetime.datetime.fromisoformat(b1['start_time'])
        t1_end = datetime.datetime.fromisoformat(b1['end_time'])
        t2_start = datetime.datetime.fromisoformat(b2['start_time'])
        t2_end = datetime.datetime.fromisoformat(b2['end_time'])
        
        self.assertTrue(t1_end <= t2_start or t2_end <= t1_start)

    def test_impossible_target(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)
        
        # Target 1: Observable
        lst_mid = get_lst(scheduler.chunk_times[scheduler.num_chunks // 2], observatory.longitude)
        t1 = Target("Target1", lst_mid * 15.0, 37.3, 15.0, 1)
        
        # Target 2: Deep Southern Hemisphere (-80 declination) -> Unobservable
        t2 = Target("ImpossibleTarget", lst_mid * 15.0, -80.0, 15.0, 1)
        
        targets = [t1, t2]
        res = scheduler.solve(targets)
        
        # Target 1 should be scheduled, Target 2 should be in unobservable
        science_blocks = [b for b in res['blocks'] if b['priority'] > 0]
        self.assertEqual(len(science_blocks), 1)
        self.assertEqual(science_blocks[0]['target_name'], "Target1")
        self.assertIn("ImpossibleTarget", res['unobservable'])
        self.assertEqual(len(res['conflicts']), 0)


if __name__ == '__main__':
    unittest.main()
