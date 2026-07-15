import unittest
import datetime
from scheduler import (
    Observatory,
    ShaneTelescope,
    Target,
    Scheduler,
    split_exposure_kast,
    get_target_exposure_details
)

class TestKastExposures(unittest.TestCase):

    def setUp(self):
        self.observatory = Observatory("Lick Observatory", 37.3414, -121.6429, 1283)
        self.telescope = ShaneTelescope()
        self.date_local = datetime.date(2026, 6, 18)
        self.scheduler = Scheduler(self.observatory, self.telescope, self.date_local)
        self.moon = {'phase': 0.5, 'ra': 18.0, 'dec': -20.0}

    def test_split_exposure_kast_bounds(self):
        # 1. Red exposure <= 600s, Blue exposure < 1900s
        for total_time in [300.0, 600.0, 1200.0, 1800.0, 2400.0, 3600.0, 5000.0]:
            red_exp, red_num, blue_exp, blue_num = split_exposure_kast(total_time)
            self.assertTrue(red_exp <= 600.0, f"Red exposure {red_exp} exceeds 600s for total {total_time}")
            self.assertTrue(blue_exp < 1900.0, f"Blue exposure {blue_exp} exceeds 1900s for total {total_time}")
            self.assertTrue(red_num >= 1)
            self.assertTrue(blue_num >= 1)

    def test_get_target_exposure_details_standards(self):
        # Standard star BD+284211: Blue 180s, Red 100s
        t = Target("BD+284211", 12.0, 28.0, 10.5, 1.0)
        red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(
            t, self.moon, 0.05, self.observatory.latitude
        )
        self.assertEqual(blue_exp, 180.0)
        self.assertEqual(blue_num, 1)
        self.assertEqual(red_exp, 100.0)
        self.assertEqual(red_num, 1)
        # Slew (7m) + max(180s, 100s) = 7 + 3 = 10 min duration
        self.assertEqual(dur_mins, 10)

        # Standard star HD19445: Blue 40s, Red 10s
        t_hd = Target("HD19445", 19.0, 20.0, 8.0, 1.0)
        red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(
            t_hd, self.moon, 0.05, self.observatory.latitude
        )
        self.assertEqual(blue_exp, 40.0)
        self.assertEqual(red_exp, 10.0)
        # Slew (7m) + ceil(40/60) = 7 + 1 = 8 min duration
        self.assertEqual(dur_mins, 8)

    def test_get_target_exposure_details_science_lookup(self):
        # Science target, <= 15.0 mag
        t1 = Target("Sci15.0", 12.0, 28.0, 14.5, 1.0)
        red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(
            t1, self.moon, 0.05, self.observatory.latitude
        )
        self.assertEqual(blue_exp, 637.0)
        self.assertEqual(blue_num, 1)
        self.assertEqual(red_exp, 300.0)
        self.assertEqual(red_num, 2)
        # T_R = 2 * (300 + 20) + (2 - 1) * 22 = 640 + 22 = 662s.
        # T_B = 1 * (637 + 5) + 0 = 642s.
        # T_seq = max(662, 642) = 662s -> ceil(662/60) = 12 mins.
        # dur_mins = 7 + 12 = 19 mins.
        self.assertEqual(dur_mins, 19)

        # Science target, 17.0 mag
        t2 = Target("Sci17.0", 12.0, 28.0, 17.0, 1.0)
        red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(
            t2, self.moon, 0.05, self.observatory.latitude
        )
        self.assertEqual(blue_exp, 1237.0)
        self.assertEqual(blue_num, 1)
        self.assertEqual(red_exp, 600.0)
        self.assertEqual(red_num, 2)

    def test_get_target_exposure_details_overrides(self):
        # Custom exposure overrides
        t = Target(
            "CustomTarget", 12.0, 28.0, 16.0, 1.0,
            red_exptime=450.0, red_num=2,
            blue_exptime=920.0, blue_num=1
        )
        red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(
            t, self.moon, 0.05, self.observatory.latitude
        )
        self.assertEqual(red_exp, 450.0)
        self.assertEqual(red_num, 2)
        self.assertEqual(blue_exp, 920.0)
        self.assertEqual(blue_num, 1)

        # T_R = 2 * (450 + 20) + 1 * 22 = 940 + 22 = 962s.
        # T_B = 1 * (920 + 5) + 0 = 925s.
        # T_seq = max(962, 925) = 962s -> ceil(962/60) = 17 mins.
        # dur_mins = 7 + 17 = 24 mins.
        self.assertEqual(dur_mins, 24)

if __name__ == '__main__':
    unittest.main()
