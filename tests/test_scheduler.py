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
        t1 = Target("Target1.2", lst_mid * 15.0, -16.0, 19.0, 1.2)
        t2 = Target("Target1.8", lst_mid * 15.0, -16.0, 19.0, 1.8)
        
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

    def test_standards_override(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # Target 1: Observable science target
        lst_mid = get_lst(scheduler.chunk_times[scheduler.num_chunks // 2], observatory.longitude)
        t1 = Target("Target1", lst_mid * 15.0, 37.3, 15.0, 1)
        targets = [t1]

        # Test 1: Auto standards enabled (default)
        res_auto = scheduler.solve(targets, auto_standards=True)
        # Some standard blocks should be scheduled
        standard_blocks_auto = [b for b in res_auto['blocks'] if b['priority'] == 0.0]
        self.assertTrue(len(standard_blocks_auto) > 0)

        # Test 2: Auto standards disabled, selected_standards empty
        res_none = scheduler.solve(targets, auto_standards=False, selected_standards=[])
        standard_blocks_none = [b for b in res_none['blocks'] if b['priority'] == 0.0]
        self.assertEqual(len(standard_blocks_none), 0)

        # Test 3: Auto standards disabled, selected_standards contains BD+284211
        res_one = scheduler.solve(targets, auto_standards=False, selected_standards=["BD+284211"])
        standard_blocks_one = [b for b in res_one['blocks'] if b['priority'] == 0.0]
        for b in standard_blocks_one:
            self.assertEqual(b['target_name'], "BD+284211")

    def test_manual_start_time_override(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # Create a target with manual start time pinned at the middle of the night
        mid_chunk = scheduler.num_chunks // 2
        start_time_str = scheduler.chunk_times[mid_chunk].isoformat()
        lst_mid = get_lst(scheduler.chunk_times[mid_chunk], observatory.longitude)

        # Even with high magnitude and Dec that would normally restrict it or require twilight bypass,
        # manually scheduling it should succeed because soft constraints are relaxed.
        t1 = Target(
            name="PinnedTarget",
            ra=lst_mid * 15.0,
            dec=37.3,
            magnitude=15.0,
            priority=1.0,
            manual_start_time=start_time_str
        )
        res = scheduler.solve([t1])
        print("DEBUG target.manual_start_time:", t1.manual_start_time)
        print("DEBUG chunk_times[mid]:", scheduler.chunk_times[mid_chunk].isoformat())
        print("DEBUG parsed idx:", scheduler.get_chunk_idx_from_time_str(t1.manual_start_time))
        print("DEBUG is_chunk_valid:", scheduler.is_chunk_valid(t1, mid_chunk, is_manual=True))
        print("DEBUG solve results:", res)
        scheduled = [b for b in res['blocks'] if b['target_name'] == "PinnedTarget"]
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(scheduled[0]['start_time'], start_time_str)

    def test_multiple_manual_standards(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        # Use September equinox for longer twilight/night and excellent visibility of these RAs
        date_local = datetime.date(2026, 9, 21)
        scheduler = Scheduler(observatory, telescope, date_local)

        # Select 5 standards manually that are well-spaced and visible outside the 30-minute buffer
        selected = ["BD+284211", "BD+174708", "HD19445", "G191B2B", "Feige 110"]
        res = scheduler.solve([], auto_standards=False, selected_standards=selected)
        standard_blocks = [b for b in res['blocks'] if b['priority'] == 0.0]
        
        # Verify that all 5 standards are scheduled
        scheduled_names = {b['target_name'] for b in standard_blocks}
        self.assertEqual(len(scheduled_names), 5)
        for name in selected:
            self.assertIn(name, scheduled_names)

    def test_manual_night_limits(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)
        
        # Set manual limits override (e.g. half night: night starts at 04:00 and ends at 08:00 UT)
        realtime_constraints = {
            'manual_limits_enabled': True,
            'manual_limit_start': '04:00',
            'manual_limit_end': '08:00',
            'manual_limit_tz': 'UTC'
        }
        res = scheduler.solve([], realtime_constraints=realtime_constraints)
        
        # Check that scheduler.start_night and scheduler.end_night are overridden correctly
        self.assertEqual(scheduler.start_night.hour, 4)
        self.assertEqual(scheduler.start_night.minute, 0)
        self.assertEqual(scheduler.end_night.hour, 8)
        self.assertEqual(scheduler.end_night.minute, 0)
        
        # Check that chunk times are strictly within the manual limit
        for t in scheduler.chunk_times:
            self.assertTrue(scheduler.start_night <= t < scheduler.end_night)

    def test_strict_time_tolerance(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # A locked time perfectly matching a chunk (e.g. index 10) should succeed
        matching_time = scheduler.chunk_times[10].isoformat()
        self.assertEqual(scheduler.get_chunk_idx_from_time_str(matching_time), 10)

        # A locked time offset by more than 1 minute (e.g. 5 minutes before sunset) should return None
        offset_time = (scheduler.start_night - datetime.timedelta(minutes=5)).isoformat()
        self.assertIsNone(scheduler.get_chunk_idx_from_time_str(offset_time))

    def test_standard_star_twilight_buffer(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # Run solve with auto_standards=True
        res = scheduler.solve([], auto_standards=True)
        for block in res['blocks']:
            if block['priority'] == 0.0:
                # Ensure it's not scheduled within 30 minutes of sunset or sunrise
                start_dt = datetime.datetime.fromisoformat(block['start_time']).replace(tzinfo=None)
                end_dt = datetime.datetime.fromisoformat(block['end_time']).replace(tzinfo=None)
                start_night = scheduler.start_night.replace(tzinfo=None)
                end_night = scheduler.end_night.replace(tzinfo=None)
                self.assertTrue(start_dt >= start_night + datetime.timedelta(minutes=30))
                self.assertTrue(end_dt <= end_night - datetime.timedelta(minutes=30))

    def test_locked_target_precedence_constraint(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # A is locked at chunk 500, B is unlocked but must schedule before A (schedule_before=["A"])
        locked_time = scheduler.chunk_times[500].isoformat()
        target_a = Target("A", 18.0, 30.0, 10.0, 1.0, comment="", manual_start_time=locked_time, manual_duration=30, allow_twilight=True)
        target_b = Target("B", 18.0, 30.0, 10.0, 1.0, comment="", manual_start_time=None, manual_duration=30, schedule_before=["A"], allow_twilight=True)
    
        res = scheduler.solve([target_a, target_b], auto_standards=False)
        print("TEST CONFLICTS:", res['conflicts'])
        print("TEST BLOCKS:", [b['target_name'] for b in res['blocks']])
        
        block_a = next(b for b in res['blocks'] if b['target_name'] == "A")
        block_b = next(b for b in res['blocks'] if b['target_name'] == "B")
        
        a_start = datetime.datetime.fromisoformat(block_a['start_time']).replace(tzinfo=None)
        b_end = datetime.datetime.fromisoformat(block_b['end_time']).replace(tzinfo=None)
        self.assertTrue(b_end <= a_start)

    def test_observed_target_filtering(self):
        from app import run_schedule_logic
        data = {
            'date': '2026-06-18',
            'observatory': {'name': 'Lick Observatory', 'lat': 37.3414, 'lon': -121.6429, 'elevation': 1283},
            'targets': [
                {'name': 'ObservedTarget', 'ra': 18.0, 'dec': 30.0, 'magnitude': 10.0, 'priority': 1.0, 'allow_twilight': True, 'status': 'Observed'},
                {'name': 'ActiveTarget', 'ra': 18.0, 'dec': 30.0, 'magnitude': 10.0, 'priority': 1.0, 'allow_twilight': True, 'status': 'Scheduled'}
            ],
            'auto_standards': False
        }
        res = run_schedule_logic(data)
        block_names = [b['target_name'] for b in res['blocks']]
        self.assertIn('ActiveTarget', block_names)
        self.assertNotIn('ObservedTarget', block_names)

    def test_standard_star_scheduling_with_manual_limits(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        realtime_constraints = {
            'manual_limits_enabled': True,
            'manual_limit_start': '04:00',
            'manual_limit_end': '08:00',
            'manual_limit_tz': 'UTC'
        }
        res = scheduler.solve([], auto_standards=True, realtime_constraints=realtime_constraints)
        
        # Verify that standards can be scheduled within overridden boundaries
        standard_blocks = [b for b in res['blocks'] if b['priority'] == 0.0]
        self.assertTrue(len(standard_blocks) > 0)
        
        start_night = scheduler.start_night.replace(tzinfo=None)
        end_night = scheduler.end_night.replace(tzinfo=None)
        
        for block in standard_blocks:
            start_dt = datetime.datetime.fromisoformat(block['start_time']).replace(tzinfo=None)
            end_dt = datetime.datetime.fromisoformat(block['end_time']).replace(tzinfo=None)
            self.assertTrue(start_dt >= start_night)
            self.assertTrue(end_dt <= end_night)

    def test_twilight_science_target_nautical_limit_and_darkest_part_override(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        t_eve_12 = scheduler.solar_times['twilight_evening_12'].replace(tzinfo=None)
        t_morn_12 = scheduler.solar_times['twilight_morning_12'].replace(tzinfo=None)
        t_eve_18 = scheduler.solar_times['twilight_evening_18'].replace(tzinfo=None)

        # LST at twilight_evening_12
        lst_eve_12 = get_lst(scheduler.solar_times['twilight_evening_12'], observatory.longitude)
        
        target = Target(
            name="TwilightScienceTarget",
            ra=lst_eve_12 * 15.0,
            dec=37.3,
            magnitude=15.0,
            priority=1.0,
            allow_twilight=True
        )

        res = scheduler.solve([target], auto_standards=False)
        blocks = [b for b in res['blocks'] if b['target_name'] == "TwilightScienceTarget"]
        self.assertEqual(len(blocks), 1)

        block = blocks[0]
        start_time = datetime.datetime.fromisoformat(block['start_time']).replace(tzinfo=None)
        end_time = datetime.datetime.fromisoformat(block['end_time']).replace(tzinfo=None)

        # Must not extend beyond 12-degree twilight
        self.assertTrue(start_time >= t_eve_12)
        self.assertTrue(end_time <= t_morn_12)

        # Darkest twilight preference: should be scheduled closer to 18-degree boundary
        dist_to_18 = abs((t_eve_18 - start_time).total_seconds())
        dist_to_12 = abs((start_time - t_eve_12).total_seconds())
        self.assertTrue(dist_to_18 < dist_to_12)

    def test_layered_priority_solver_shifting(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # Override night parameters to have exactly 8 hours (480 minutes)
        t_start = datetime.datetime(2026, 6, 19, 3, 30, 0, tzinfo=datetime.timezone.utc)
        t_end = datetime.datetime(2026, 6, 19, 11, 30, 0, tzinfo=datetime.timezone.utc)
        
        scheduler.solar_times = {
            'sunset': t_start,
            'sunrise': t_end,
            'twilight_evening_18': t_start + datetime.timedelta(minutes=30),
            'twilight_morning_18': t_end - datetime.timedelta(minutes=30),
            'twilight_evening_12': t_start + datetime.timedelta(minutes=15),
            'twilight_morning_12': t_end - datetime.timedelta(minutes=15),
        }
        
        scheduler.start_night = t_start
        scheduler.end_night = t_end
        scheduler.num_chunks = 480
        scheduler.chunk_times = [t_start + datetime.timedelta(minutes=i) for i in range(480)]

        # Target A (Priority 1), Target B (Priority 2). Transit at 07:30 UT.
        lst_mid = get_lst(t_start + datetime.timedelta(hours=4), observatory.longitude)
        target_a = Target(
            name="TargetA",
            ra=lst_mid * 15.0,
            dec=37.3,
            magnitude=15.0,
            priority=1.0,
            allow_twilight=False
        )
        target_b = Target(
            name="TargetB",
            ra=lst_mid * 15.0,
            dec=37.3,
            magnitude=15.0,
            priority=2.0,
            allow_twilight=False
        )

        # Force 240 minutes (14400s) exposure
        scheduler.telescope.classification_exposure = lambda mag: 14400
        scheduler.telescope.normal_exposure = lambda mag: 14400

        res = scheduler.solve([target_a, target_b], auto_standards=False)
        blocks = res['blocks']
        
        # Verify both A and B are scheduled (requires shifting A from its optimal center slot)
        scheduled_names = {b['target_name'] for b in blocks}
        self.assertIn("TargetA", scheduled_names)
        self.assertIn("TargetB", scheduled_names)

    def test_timeline_reordering_constraints(self):
        observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        telescope = ShaneTelescope()
        date_local = datetime.date(2026, 6, 18)
        scheduler = Scheduler(observatory, telescope, date_local)

        # Force 60 minutes exposure
        scheduler.telescope.classification_exposure = lambda mag: 3600
        scheduler.telescope.normal_exposure = lambda mag: 3600

        # Transit at 07:30 UT
        t_mid = datetime.datetime(2026, 6, 19, 7, 30, 0, tzinfo=datetime.timezone.utc)
        lst_mid = get_lst(t_mid, observatory.longitude)

        # Target A (P1) and Target B (P3)
        target_a = Target(
            name="TargetA",
            ra=lst_mid * 15.0,
            dec=37.3,
            magnitude=12.0,
            priority=1.0,
            allow_twilight=True
        )
        target_b = Target(
            name="TargetB",
            ra=lst_mid * 15.0,
            dec=37.3,
            magnitude=12.0,
            priority=3.0,
            allow_twilight=True,
            schedule_before=["TargetA"]
        )

        res = scheduler.solve([target_a, target_b], auto_standards=False)
        blocks = res['blocks']
        
        # Verify both are scheduled
        scheduled_names = {b['target_name'] for b in blocks}
        self.assertIn("TargetA", scheduled_names)
        self.assertIn("TargetB", scheduled_names)

        # Verify precedence constraint: B must be before A
        block_a = next(b for b in blocks if b['target_name'] == "TargetA")
        block_b = next(b for b in blocks if b['target_name'] == "TargetB")
        
        a_start = datetime.datetime.fromisoformat(block_a['start_time'])
        b_end = datetime.datetime.fromisoformat(block_b['end_time'])
        self.assertTrue(b_end <= a_start)


if __name__ == '__main__':
    unittest.main()
