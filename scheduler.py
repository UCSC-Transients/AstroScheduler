"""
Astronomical Observation Scheduler Core Module
Implements astronomical calculations, telescope constraints, exposure models,
and the scheduling algorithm.
"""

import math
import datetime
from typing import List, Dict, Tuple, Optional, Any, Set

try:
    import astropy
    from astropy.utils.iers import conf as iers_conf
    iers_conf.auto_download = False
    iers_conf.auto_max_age = None
    iers_conf.iers_degraded_accuracy = 'ignore'
    
    import astropy.units as u
    from astropy.time import Time
    from astropy.coordinates import EarthLocation, SkyCoord, get_moon, AltAz
    from astroplan import Observer, FixedTarget
    HAS_ASTRO_LIBS = True
except ImportError:
    HAS_ASTRO_LIBS = False


# Kast Spectrograph Constants
BLUE_ERASE = 5.0
RED_ERASE = 20.0
BLUE_READOUT = 30.0
RED_READOUT = 22.0
SLEW_ACQ_OVERHEAD_MIN = 7.0

# Kast Science lookup table (Magnitude -> Total Exposure time (mins), Blue (s), Blue N, Red (s), Red N)
# Magnitudes are rounded to the nearest 0.5.
# Under 13.0, maps to 13.0. Over 20.0, maps to 20.0.
# Map keys to nearest 0.5 magnitude
KAST_SCIENCE_LOOKUP = {
    13.0: {"blue_exp": 637.0, "blue_num": 1, "red_exp": 300.0, "red_num": 2},
    13.5: {"blue_exp": 637.0, "blue_num": 1, "red_exp": 300.0, "red_num": 2},
    14.0: {"blue_exp": 637.0, "blue_num": 1, "red_exp": 300.0, "red_num": 2},
    14.5: {"blue_exp": 637.0, "blue_num": 1, "red_exp": 300.0, "red_num": 2},
    15.0: {"blue_exp": 637.0, "blue_num": 1, "red_exp": 300.0, "red_num": 2},
    15.5: {"blue_exp": 937.0, "blue_num": 1, "red_exp": 450.0, "red_num": 2},
    16.0: {"blue_exp": 937.0, "blue_num": 1, "red_exp": 450.0, "red_num": 2},
    16.5: {"blue_exp": 937.0, "blue_num": 1, "red_exp": 450.0, "red_num": 2},
    17.0: {"blue_exp": 1237.0, "blue_num": 1, "red_exp": 600.0, "red_num": 2},
    17.5: {"blue_exp": 1570.0, "blue_num": 1, "red_exp": 500.0, "red_num": 3},
    18.0: {"blue_exp": 1845.0, "blue_num": 1, "red_exp": 600.0, "red_num": 3},
    18.5: {"blue_exp": 1230.0, "blue_num": 2, "red_exp": 600.0, "red_num": 4},
    19.0: {"blue_exp": 1560.0, "blue_num": 2, "red_exp": 600.0, "red_num": 5},
    19.5: {"blue_exp": 1845.0, "blue_num": 2, "red_exp": 600.0, "red_num": 6},
    20.0: {"blue_exp": 2145.0, "blue_num": 2, "red_exp": 600.0, "red_num": 7},
}

KAST_STANDARD_LOOKUP = {
    "Feige 34": {"blue_exp": 180.0, "blue_num": 1, "red_exp": 100.0, "red_num": 1},
    "BD+284211": {"blue_exp": 180.0, "blue_num": 1, "red_exp": 100.0, "red_num": 1},
    "Feige 110": {"blue_exp": 240.0, "blue_num": 1, "red_exp": 150.0, "red_num": 1},
    "G191B2B": {"blue_exp": 240.0, "blue_num": 1, "red_exp": 150.0, "red_num": 1},
    "G191-B2B": {"blue_exp": 240.0, "blue_num": 1, "red_exp": 150.0, "red_num": 1},
    "HZ 44": {"blue_exp": 240.0, "blue_num": 1, "red_exp": 150.0, "red_num": 1},
    "HZ44": {"blue_exp": 240.0, "blue_num": 1, "red_exp": 150.0, "red_num": 1},
    "BD+332642": {"blue_exp": 180.0, "blue_num": 1, "red_exp": 100.0, "red_num": 1},
    "HD19445": {"blue_exp": 40.0, "blue_num": 1, "red_exp": 10.0, "red_num": 1},
    "HD84937": {"blue_exp": 60.0, "blue_num": 1, "red_exp": 20.0, "red_num": 1},
    "BD+262606": {"blue_exp": 135.0, "blue_num": 1, "red_exp": 40.0, "red_num": 1},
    "BD+174708": {"blue_exp": 135.0, "blue_num": 1, "red_exp": 35.0, "red_num": 1},
}

def split_exposure_kast(total_exposure_seconds: float) -> Tuple[float, int, float, int]:
    t_seq = total_exposure_seconds
    
    # Blue: max 1899s. Blue erase: 5s, Blue readout: 30s.
    num_blue = int(math.ceil((t_seq + 30.0) / 1934.0))
    if num_blue < 1:
        num_blue = 1
    exptime_blue = (t_seq + 30.0) / num_blue - 35.0
    if exptime_blue < 0:
        exptime_blue = 0.0
        
    # Red: max 600s. Red erase: 20s, Red readout: 22s.
    num_red = int(math.ceil((t_seq + 22.0) / 642.0))
    if num_red < 1:
        num_red = 1
    exptime_red = (t_seq + 22.0) / num_red - 42.0
    if exptime_red < 0:
        exptime_red = 0.0
        
    return exptime_red, num_red, exptime_blue, num_blue



import re

def get_median(lst):
    if not lst:
        return 0.0
    s_lst = sorted(lst)
    n = len(s_lst)
    if n % 2 == 1:
        return s_lst[n // 2]
    else:
        return (s_lst[n // 2 - 1] + s_lst[n // 2]) / 2.0

def parse_coordinate(val: Any, is_ra: bool = False) -> float:
    """
    Parses a coordinate string or numeric input.
    If it is a float/int:
      - If is_ra: treated as degrees, divide by 15.0 to get hours.
      - If Dec: kept as degrees.
    If it is a string:
      - Check for sexagesimal indicators (colons, spaces, letters).
      - If none found, convert to float and apply the same decimal rules.
    """
    if isinstance(val, (int, float)):
        val_float = float(val)
        if is_ra:
            return val_float / 15.0 if val_float > 24.0 else val_float
        return val_float

    # Convert to string and clean
    s = str(val).strip()
    if not s:
        raise ValueError("Empty coordinate value")
        
    # Check if there are letters or separators
    # Split by common sexagesimal separators: colon, space, h, m, s, d, m, s, ', "
    cleaned = re.sub(r"[hmsd°'\"hmsHMSD\u2032\u2033]", " ", s)
    cleaned = cleaned.replace(":", " ")
    parts = [p for p in cleaned.split() if p]
    
    if len(parts) > 1:
        # It's sexagesimal
        # Handle sign
        sign = 1.0
        first_part = parts[0]
        if first_part.startswith("-"):
            sign = -1.0
            first_part = first_part.lstrip("-")
        elif first_part.startswith("+"):
            first_part = first_part.lstrip("+")
            
        try:
            d = float(first_part)
            m = float(parts[1]) if len(parts) > 1 else 0.0
            sec = float(parts[2]) if len(parts) > 2 else 0.0
            
            decimal_val = sign * (d + m / 60.0 + sec / 3600.0)
            # If sexagesimal, RA is already in hours, Dec is in degrees.
            return decimal_val
        except ValueError:
            pass
            
    # Try parsing as float directly
    try:
        val_float = float(s)
        if is_ra:
            return val_float / 15.0 if val_float > 24.0 else val_float
        return val_float
    except ValueError:
        raise ValueError(f"Could not parse coordinate: {val}")


# ==============================================================================
# PURE PYTHON FALLBACK ASTRONOMICAL CALCULATIONS
# ==============================================================================

def datetime_to_d(dt_utc: datetime.datetime) -> float:
    """Calculate days since J2000.0 (2000-01-01 12:00:00 UTC)."""
    j2000 = datetime.datetime(2000, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
    delta = dt_utc - j2000
    return delta.total_seconds() / 86400.0


def get_lst(dt_utc: datetime.datetime, lon_deg: float) -> float:
    """Calculate Local Sidereal Time in hours."""
    d = datetime_to_d(dt_utc)
    # GMST in hours
    gmst = (18.697374558 + 24.06570982441908 * d) % 24.0
    lst = (gmst + lon_deg / 15.0) % 24.0
    return lst


def get_hour_angle(lst_hours: float, ra_hours: float) -> float:
    """Calculate hour angle in hours, normalized to [-12, 12]."""
    ha = lst_hours - ra_hours
    return (ha + 12.0) % 24.0 - 12.0


def get_alt_az(dt_utc: datetime.datetime, lat_deg: float, lon_deg: float, ra_hours: float, dec_deg: float) -> Tuple[float, float]:
    """Calculate altitude and azimuth in degrees."""
    lst = get_lst(dt_utc, lon_deg)
    ha = get_hour_angle(lst, ra_hours)
    
    ha_rad = math.radians(ha * 15.0)
    dec_rad = math.radians(dec_deg)
    lat_rad = math.radians(lat_deg)
    
    sin_alt = math.sin(lat_rad) * math.sin(dec_rad) + math.cos(lat_rad) * math.cos(dec_rad) * math.cos(ha_rad)
    sin_alt = max(-1.0, min(1.0, sin_alt))
    alt = math.asin(sin_alt)
    
    cos_alt = math.cos(alt)
    if cos_alt < 1e-9:
        az = 0.0
    else:
        cos_az = (math.sin(dec_rad) - math.sin(lat_rad) * sin_alt) / (math.cos(lat_rad) * cos_alt)
        cos_az = max(-1.0, min(1.0, cos_az))
        az = math.acos(cos_az)
        if math.sin(ha_rad) > 0:  # West of meridian
            az = 2 * math.pi - az
            
    return math.degrees(alt), math.degrees(az)


def get_airmass(alt_deg: float) -> float:
    """Calculate airmass for a given altitude in degrees."""
    if alt_deg <= 0:
        return 999.0
    zenith_angle = 90.0 - alt_deg
    cos_z = math.cos(math.radians(zenith_angle))
    if cos_z < 1e-4:
        return 999.0
    return 1.0 / cos_z


def get_sun_position(d: float) -> Tuple[float, float]:
    """Calculate Sun's Right Ascension (hours) and Declination (degrees)."""
    # Mean anomaly
    g = math.radians((357.529 + 0.98560028 * d) % 360.0)
    # Ecliptic longitude
    q = math.radians((280.459 + 0.98564736 * d) % 360.0)
    l = q + math.radians(1.915) * math.sin(g) + math.radians(0.020) * math.sin(2 * g)
    # Obliquity of ecliptic
    obliq = math.radians(23.439 - 0.0000004 * d)
    # RA and Dec
    sin_dec = math.sin(obliq) * math.sin(l)
    dec = math.asin(sin_dec)
    cos_l = math.cos(l)
    ra = math.atan2(math.cos(obliq) * math.sin(l), cos_l)
    ra_hours = (math.degrees(ra) % 360.0) / 15.0
    return ra_hours, math.degrees(dec)


def get_moon_position(d: float) -> Tuple[float, float, float]:
    """Calculate Moon's RA (hours), Dec (degrees), and Illumination Fraction."""
    # Mean longitude
    l = math.radians((218.316 + 13.176396 * d) % 360.0)
    # Mean anomaly
    m = math.radians((134.963 + 13.064993 * d) % 360.0)
    # Mean elongation
    d_elon = math.radians((297.850 + 12.190749 * d) % 360.0)
    # Argument of latitude
    f = math.radians((93.272 + 13.229350 * d) % 360.0)
    
    # Geocentric longitude
    lambda_m = l + math.radians(6.289) * math.sin(m)
    obliq = math.radians(23.439)
    
    # Declination and RA
    sin_dec = math.sin(lambda_m) * math.sin(obliq)
    dec = math.asin(sin_dec)
    ra = math.atan2(math.cos(obliq) * math.sin(lambda_m), math.cos(lambda_m))
    ra_hours = (math.degrees(ra) % 360.0) / 15.0
    
    # Illumination fraction (phase)
    phase = 0.5 * (1.0 - math.cos(d_elon))
    return ra_hours, math.degrees(dec), phase


def get_separation(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Calculate angular separation in degrees between two coordinates."""
    ra1_rad = math.radians(ra1 * 15.0)
    dec1_rad = math.radians(dec1)
    ra2_rad = math.radians(ra2 * 15.0)
    dec2_rad = math.radians(dec2)
    
    cos_theta = math.sin(dec1_rad) * math.sin(dec2_rad) + math.cos(dec1_rad) * math.cos(dec2_rad) * math.cos(ra1_rad - ra2_rad)
    cos_theta = max(-1.0, min(1.0, cos_theta))
    return math.degrees(math.acos(cos_theta))


def get_solar_times_fallback(date_utc: datetime.datetime, lat_deg: float, lon_deg: float, elevation_m: float) -> Dict[str, datetime.datetime]:
    """Calculate sunset, sunrise, and twilights using analytical formulas (fallback)."""
    # Centered at noon UTC on the date
    noon = datetime.datetime(date_utc.year, date_utc.month, date_utc.day, 12, 0, 0, tzinfo=datetime.timezone.utc)
    d = datetime_to_d(noon)
    sun_ra, sun_dec = get_sun_position(d)
    
    # LST of noon
    lst_noon = get_lst(noon, lon_deg)
    ha_noon = get_hour_angle(lst_noon, sun_ra)
    transit = noon - datetime.timedelta(hours=ha_noon)
    
    lat_rad = math.radians(lat_deg)
    dec_rad = math.radians(sun_dec)
    
    def time_for_altitude(h0_deg: float) -> Tuple[Optional[datetime.datetime], Optional[datetime.datetime]]:
        h0_rad = math.radians(h0_deg)
        numerator = math.sin(h0_rad) - math.sin(lat_rad) * math.sin(dec_rad)
        denominator = math.cos(lat_rad) * math.cos(dec_rad)
        if denominator == 0:
            return None, None
        cos_h0 = numerator / denominator
        if cos_h0 > 1.0 or cos_h0 < -1.0:
            return None, None
        h0 = math.acos(cos_h0)
        h0_hours = math.degrees(h0) / 15.0
        set_time = transit + datetime.timedelta(hours=h0_hours)
        rise_time = transit - datetime.timedelta(hours=h0_hours)
        return rise_time, set_time
        
    # Sunset / Sunrise with atmospheric refraction and elevation correction
    h0_sunset = -0.833 - 1.15 * math.sqrt(elevation_m) / 60.0
    sunrise, sunset = time_for_altitude(h0_sunset)
    
    # Twilight times
    twilight_rise_18, twilight_set_18 = time_for_altitude(-18.0)
    twilight_rise_12, twilight_set_12 = time_for_altitude(-12.0)
    
    # Roll over morning times to the next day if they fall before evening times
    if sunset and sunrise and sunrise < sunset:
        sunrise += datetime.timedelta(days=1)
    if twilight_set_18 and twilight_rise_18 and twilight_rise_18 < twilight_set_18:
        twilight_rise_18 += datetime.timedelta(days=1)
    if twilight_set_12 and twilight_rise_12 and twilight_rise_12 < twilight_set_12:
        twilight_rise_12 += datetime.timedelta(days=1)
    
    # Ensure they are valid datetimes, otherwise set fallback defaults
    return {
        'sunset': sunset or (transit + datetime.timedelta(hours=6)),
        'sunrise': sunrise or (transit + datetime.timedelta(hours=18)),
        'twilight_evening_18': twilight_set_18 or sunset or (transit + datetime.timedelta(hours=7.5)),
        'twilight_morning_18': twilight_rise_18 or sunrise or (transit + datetime.timedelta(hours=16.5)),
        'twilight_evening_12': twilight_set_12 or sunset or (transit + datetime.timedelta(hours=7.0)),
        'twilight_morning_12': twilight_rise_12 or sunrise or (transit + datetime.timedelta(hours=17.0)),
    }


# ==============================================================================
# MAIN CLASSES
# ==============================================================================

class Observatory:
    """Represents an astronomical observatory location."""
    
    def __init__(self, name: str, latitude: float, longitude: float, elevation: float):
        self.name = name
        self.latitude = latitude      # degrees N
        self.longitude = longitude    # degrees E (negative for W)
        self.elevation = elevation    # meters
        
    def get_night_parameters(self, date_local: datetime.date) -> Dict[str, Any]:
        """
        Calculate night twilights and moon conditions centered around the night of date_local.
        Night starts on evening of date_local.
        """
        # Convert local date noon to UTC datetime as the reference midpoint
        # Assuming US/Pacific (UTC-7 or UTC-8) for default Lick
        local_noon = datetime.datetime(date_local.year, date_local.month, date_local.day, 12, 0, 0)
        # Approximate offset conversion to UTC
        # If West longitude, offset is positive west, so UTC is local_noon + offset
        offset_hours = -self.longitude / 15.0
        utc_noon = local_noon + datetime.timedelta(hours=offset_hours)
        utc_noon = utc_noon.replace(tzinfo=datetime.timezone.utc)
        
        solar_times = {}
        moon_ra = 0.0
        moon_dec = 0.0
        moon_phase = 0.0
        
        if HAS_ASTRO_LIBS:
            try:
                loc = EarthLocation(lat=self.latitude*u.deg, lon=self.longitude*u.deg, height=self.elevation*u.m)
                observer = Observer(location=loc, name=self.name)
                t_ref = Time(utc_noon)
                
                # Get next sunset and sunrise relative to noon reference
                sunset = observer.sun_set_time(t_ref, which='next')
                sunrise = observer.sun_rise_time(t_ref, which='next')
                
                twilight_eve_18 = observer.twilight_evening_astronomical(t_ref, which='next')
                twilight_morn_18 = observer.twilight_morning_astronomical(t_ref, which='next')
                twilight_eve_12 = observer.twilight_evening_nautical(t_ref, which='next')
                twilight_morn_12 = observer.twilight_morning_nautical(t_ref, which='next')
                
                solar_times = {
                    'sunset': sunset.datetime.replace(tzinfo=datetime.timezone.utc),
                    'sunrise': sunrise.datetime.replace(tzinfo=datetime.timezone.utc),
                    'twilight_evening_18': twilight_eve_18.datetime.replace(tzinfo=datetime.timezone.utc),
                    'twilight_morning_18': twilight_morn_18.datetime.replace(tzinfo=datetime.timezone.utc),
                    'twilight_evening_12': twilight_eve_12.datetime.replace(tzinfo=datetime.timezone.utc),
                    'twilight_morning_12': twilight_morn_12.datetime.replace(tzinfo=datetime.timezone.utc),
                }
                
                # Moon position and phase at midnight UTC of the night
                midnight_utc = solar_times['sunset'] + (solar_times['sunrise'] - solar_times['sunset']) / 2
                t_mid = Time(midnight_utc)
                moon_coord = get_moon(t_mid, location=loc)
                moon_ra = moon_coord.ra.hour
                moon_dec = moon_coord.dec.degree
                
                # Calculate moon phase fraction illuminated (0 to 1)
                # Astropy get_moon does not give phase directly, compute elongation from Sun
                sun_coord = get_sun(t_mid)
                elong = moon_coord.separation(sun_coord).rad
                moon_phase = 0.5 * (1.0 - math.cos(elong))
                
            except Exception:
                # Fall back if astropy fails
                solar_times = get_solar_times_fallback(utc_noon, self.latitude, self.longitude, self.elevation)
                d_mid = datetime_to_d(solar_times['sunset'] + (solar_times['sunrise'] - solar_times['sunset']) / 2)
                moon_ra, moon_dec, moon_phase = get_moon_position(d_mid)
        else:
            solar_times = get_solar_times_fallback(utc_noon, self.latitude, self.longitude, self.elevation)
            d_mid = datetime_to_d(solar_times['sunset'] + (solar_times['sunrise'] - solar_times['sunset']) / 2)
            moon_ra, moon_dec, moon_phase = get_moon_position(d_mid)
            
        return {
            'solar_times': solar_times,
            'moon': {
                'ra': moon_ra,
                'dec': moon_dec,
                'phase': moon_phase
            }
        }


class Telescope:
    """Represents pointing constraints and wrap rules of a telescope."""
    
    def __init__(self, name: str, dec_min: float, dec_max: float):
        self.name = name
        self.dec_min = dec_min
        self.dec_max = dec_max
        
    def is_visible(self, ra: float, dec: float, dt_utc: datetime.datetime, observatory: Observatory) -> bool:
        """Check basic visibility limits."""
        if not (self.dec_min <= dec <= self.dec_max):
            return False
        return True


class ShaneTelescope(Telescope):
    """Lick Shane 3m telescope equatorial pointing limits."""
    
    def __init__(self):
        super().__init__(name="Lick Shane 3m", dec_min=-35.0, dec_max=72.0)
        # Hour angle limits: East 05:40 (-5.667 hours), West 03:45 (+3.75 hours)
        self.ha_limit_east = -5.6667
        self.ha_limit_west = 3.75
        
    def is_visible(self, ra: float, dec: float, dt_utc: datetime.datetime, observatory: Observatory) -> bool:
        if not super().is_visible(ra, dec, dt_utc, observatory):
            return False
            
        # Check hour angle limit
        lst = get_lst(dt_utc, observatory.longitude)
        ha = get_hour_angle(lst, ra)
        if not (self.ha_limit_east <= ha <= self.ha_limit_west):
            return False
        return True


class Target:
    """Represents a scheduling target and its user parameters."""
    
    def __init__(self, name: str, ra: Any, dec: Any, magnitude: float, priority: float,
                 allow_twilight: bool = False, high_airmass: bool = False,
                 sn_mode: str = "normal", comment: str = "",
                 manual_start_time: Optional[str] = None,
                 manual_duration: Optional[float] = None,
                 schedule_before: Optional[List[str]] = None,
                 status: Optional[str] = None,
                 red_exptime: Optional[float] = None,
                 red_num: Optional[int] = None,
                 blue_exptime: Optional[float] = None,
                 blue_num: Optional[int] = None):
        self.name = name
        self.ra = parse_coordinate(ra, is_ra=True)  # Right Ascension in decimal hours (0 to 24)
        self.dec = parse_coordinate(dec, is_ra=False)  # Declination in decimal degrees (-90 to 90)
        self.magnitude = float(magnitude)
        self.priority = float(priority)  # 1 (highest), 2, 3... supports float
        self.allow_twilight = allow_twilight
        self.high_airmass = high_airmass
        self.sn_mode = sn_mode      # "classification", "normal", "high_sn"
        self.comment = comment
        self.manual_start_time = manual_start_time
        self.manual_duration = manual_duration
        self.schedule_before = schedule_before or []
        self.status = status
        self.red_exptime = red_exptime
        self.red_num = red_num
        self.blue_exptime = blue_exptime
        self.blue_num = blue_num
        
    def calculate_exposure_time(self, moon_phase: float, moon_separation: float, extinction: float = 0.0, latitude: float = 37.3414) -> float:
        """
        Calculate target exposure time in seconds, accounting for moon illumination
        fraction, angular separation, and atmospheric extinction.
        """
        # calculate meridian airmass
        z_deg = abs(latitude - self.dec)
        if z_deg >= 90.0:
            meridian_airmass = 999.0
        else:
            meridian_airmass = 1.0 / math.cos(math.radians(z_deg))

        # Base exposure time at magnitude 15 under dark skies
        base_exp = 100.0 * (2.512 ** (self.magnitude - 15.0))
        
        # Apply extinction scaling: base_exp * 2.512**(E * X_meridian)
        base_exp = base_exp * (2.512 ** (extinction * meridian_airmass))
        
        # S/N mode multiplier
        sn_multipliers = {
            "classification": 0.5,
            "normal": 1.0,
            "high_sn": 2.0
        }
        sn_mult = sn_multipliers.get(self.sn_mode, 1.0)
        
        # Moon sky brightness correction multiplier
        # Increases exposure if the moon is bright and nearby
        # f_moon is 0 to 1, separation in degrees.
        moon_factor = 1.0 + 5.0 * moon_phase * math.exp(-moon_separation / 30.0)
        
        total_exposure = base_exp * sn_mult * moon_factor
        # Minimum exposure time of 60 seconds, max 7200 seconds (2 hours)
        return max(60.0, min(7200.0, total_exposure))


# ==============================================================================
# SCHEDULING ALGORITHM
# ==============================================================================

class ObservationBlock:
    """Represents a scheduled observation block."""
    
    def __init__(self, target: Target, start_time: datetime.datetime, duration_minutes: int,
                 airmass_start: float, airmass_end: float, airmass_median: float,
                 priority: Optional[float] = None, comment: Optional[str] = None):
        self.target = target
        self.start_time = start_time
        self.duration_minutes = duration_minutes
        self.airmass_start = airmass_start
        self.airmass_end = airmass_end
        self.airmass_median = airmass_median
        self.priority = priority
        self.comment = comment
        
    @property
    def end_time(self) -> datetime.datetime:
        return self.start_time + datetime.timedelta(minutes=self.duration_minutes)

    def to_dict(self) -> Dict[str, Any]:
        prio = self.priority if self.priority is not None else self.target.priority
        comm = self.comment if self.comment is not None else getattr(self.target, 'comment', '')
        return {
            'target_name': self.target.name,
            'start_time': self.start_time.isoformat(),
            'end_time': self.end_time.isoformat(),
            'duration_minutes': self.duration_minutes,
            'airmass_start': round(self.airmass_start, 3),
            'airmass_end': round(self.airmass_end, 3),
            'airmass_median': round(self.airmass_median, 3),
            'priority': prio,
            'comment': comm
        }


def parse_hour_minute(time_str: str, is_start: bool = False, is_local_tz: bool = False) -> Optional[Tuple[int, int]]:
    if not time_str:
        return None
    clean = time_str.strip().lower()
    
    is_pm = "pm" in clean
    is_am = "am" in clean
    
    numeric_str = "".join([c for c in clean if c.isdigit() or c == ":"]).strip()
    if not numeric_str:
        return None
        
    try:
        if ":" in numeric_str:
            parts = numeric_str.split(":")
            hh = int(parts[0])
            mm = int(parts[1])
        else:
            hh = int(numeric_str)
            mm = 0
    except ValueError:
        return None
        
    if is_pm:
        if hh < 12:
            hh += 12
    elif is_am:
        if hh == 12:
            hh = 0
    else:
        if is_start and is_local_tz and 0 < hh < 12:
            hh += 12
            
    return hh, mm


def get_target_exposure_details(target: Target, moon: Dict[str, Any], extinction: float, latitude: float) -> Tuple[float, int, float, int, int]:
    """
    Returns (red_exp, red_num, blue_exp, blue_num, duration_minutes) for a target.
    Accounts for manual overrides, standard star rules, lookup tables, and overheads.
    """
    # 1. Check standard star lookup:
    if target.name in KAST_STANDARD_LOOKUP:
        std = KAST_STANDARD_LOOKUP[target.name]
        # Standard stars are observed once
        t_seq = max(std["blue_exp"], std["red_exp"])
        # Total duration is 7 mins slew + ceil(t_seq / 60.0)
        dur_mins = 7 + int(math.ceil(t_seq / 60.0))
        return std["red_exp"], std["red_num"], std["blue_exp"], std["blue_num"], dur_mins

    # 2. Check if exposure overrides are set:
    if target.red_exptime is not None and target.red_num is not None and target.blue_exptime is not None and target.blue_num is not None:
        t_red = target.red_num * (target.red_exptime + RED_ERASE) + (target.red_num - 1) * RED_READOUT
        t_blue = target.blue_num * (target.blue_exptime + BLUE_ERASE) + (target.blue_num - 1) * BLUE_READOUT
        t_seq = max(t_red, t_blue)
        dur_mins = 7 + int(math.ceil(t_seq / 60.0))
        return target.red_exptime, target.red_num, target.blue_exptime, target.blue_num, dur_mins

    # 3. If manual duration is set:
    if target.manual_duration is not None:
        t_seq = max(0.0, target.manual_duration * 60.0 - 420.0)
        red_exp, red_num, blue_exp, blue_num = split_exposure_kast(t_seq)
        dur_mins = int(math.ceil(target.manual_duration))
        return red_exp, red_num, blue_exp, blue_num, dur_mins

    # 4. Use lookup table based on magnitude rounded to nearest 0.5:
    mag_val = target.magnitude
    mag_rounded = round(mag_val * 2.0) / 2.0
    if mag_rounded < 13.0:
        mag_rounded = 13.0
    elif mag_rounded > 20.0:
        mag_rounded = 20.0

    entry = KAST_SCIENCE_LOOKUP.get(mag_rounded)
    if entry:
        red_exp = entry["red_exp"]
        red_num = entry["red_num"]
        blue_exp = entry["blue_exp"]
        blue_num = entry["blue_num"]
        t_red = red_num * (red_exp + RED_ERASE) + (red_num - 1) * RED_READOUT
        t_blue = blue_num * (blue_exp + BLUE_ERASE) + (blue_num - 1) * BLUE_READOUT
        t_seq = max(t_red, t_blue)
        dur_mins = 7 + int(math.ceil(t_seq / 60.0))
        return red_exp, red_num, blue_exp, blue_num, dur_mins

    # Fallback:
    red_exp, red_num, blue_exp, blue_num = 300.0, 1, 300.0, 1
    t_red = red_num * (red_exp + RED_ERASE) + (red_num - 1) * RED_READOUT
    t_blue = blue_num * (blue_exp + BLUE_ERASE) + (blue_num - 1) * BLUE_READOUT
    t_seq = max(t_red, t_blue)
    dur_mins = 7 + int(math.ceil(t_seq / 60.0))
    return red_exp, red_num, blue_exp, blue_num, dur_mins


class Scheduler:
    """Discretizes the night and optimizes the schedule."""
    
    def __init__(self, observatory: Observatory, telescope: Telescope, date_local: datetime.date):
        self.observatory = observatory
        self.telescope = telescope
        self.date_local = date_local
        
        # Get sunset/sunrise/moon
        night_params = observatory.get_night_parameters(date_local)
        self.solar_times = night_params['solar_times']
        self.moon = night_params['moon']
        
        # Discretize night into 1-minute chunks from sunset to sunrise.
        # Floor start to whole minute so block.start_time values are clean HH:MM:00 UTC.
        raw_sunset = self.solar_times['sunset']
        self.start_night = raw_sunset.replace(second=0, microsecond=0)
        self.end_night = self.solar_times['sunrise'].replace(second=0, microsecond=0)
        total_seconds = (self.end_night - self.start_night).total_seconds()
        self.num_chunks = int(total_seconds // 60)
        
        self.chunk_times = [
            self.start_night + datetime.timedelta(minutes=i)
            for i in range(self.num_chunks)
        ]
        
        self._loc = None
        self._obs = None
        self._time_cache = {}
        if HAS_ASTRO_LIBS:
            try:
                self._loc = EarthLocation(lat=self.observatory.latitude*u.deg, lon=self.observatory.longitude*u.deg, height=self.observatory.elevation*u.m)
                self._obs = Observer(location=self._loc)
            except Exception:
                pass
        
    def get_airmass_for_target(self, target: Target, dt_utc: datetime.datetime) -> float:
        """Compute target airmass at dt_utc."""
        if not hasattr(target, '_airmass_cache'):
            target._airmass_cache = {}
        if dt_utc in target._airmass_cache:
            return target._airmass_cache[dt_utc]

        val = 999.0
        astropy_ok = False
        if HAS_ASTRO_LIBS and self._obs is not None:
            try:
                if dt_utc not in self._time_cache:
                    self._time_cache[dt_utc] = Time(dt_utc)
                t = self._time_cache[dt_utc]
                if not hasattr(target, '_fixed_target'):
                    target._fixed_target = FixedTarget(coord=SkyCoord(ra=target.ra*u.hourangle, dec=target.dec*u.deg), name=target.name)
                altaz = self._obs.altaz(t, target._fixed_target)
                alt = altaz.alt.degree
                if alt <= 0:
                    val = 999.0
                else:
                    val = altaz.secz.value
                astropy_ok = True
            except Exception:
                pass
                
        if not astropy_ok:
            alt, _ = get_alt_az(dt_utc, self.observatory.latitude, self.observatory.longitude, target.ra, target.dec)
            val = get_airmass(alt)

        target._airmass_cache[dt_utc] = val
        return val

    def precompute_target_airmass(self, target: Target):
        """Precompute airmass for all chunk_times in one vectorized astropy call."""
        if not hasattr(target, '_airmass_cache'):
            target._airmass_cache = {}
        
        # Only compute the times that are not already cached
        uncached_indices = [i for i, t in enumerate(self.chunk_times) if t not in target._airmass_cache]
        if not uncached_indices:
            return
            
        times_to_compute = [self.chunk_times[i] for i in uncached_indices]
        
        astropy_ok = False
        if HAS_ASTRO_LIBS and self._obs is not None:
            try:
                times = Time(times_to_compute)
                if not hasattr(target, '_fixed_target'):
                    target._fixed_target = FixedTarget(coord=SkyCoord(ra=target.ra*u.hourangle, dec=target.dec*u.deg), name=target.name)
                
                altazs = self._obs.altaz(times, target._fixed_target)
                for idx, c_idx in enumerate(uncached_indices):
                    alt = altazs[idx].alt.degree
                    val = altazs[idx].secz.value if alt > 0 else 999.0
                    target._airmass_cache[self.chunk_times[c_idx]] = val
                astropy_ok = True
            except Exception:
                pass
                
        if not astropy_ok:
            for c_idx in uncached_indices:
                dt_utc = self.chunk_times[c_idx]
                alt, _ = get_alt_az(dt_utc, self.observatory.latitude, self.observatory.longitude, target.ra, target.dec)
                target._airmass_cache[dt_utc] = get_airmass(alt)

    def is_chunk_valid(self, target: Target, chunk_idx: int, is_manual: bool = False, ignore_scheduling_limits: bool = False) -> bool:
        """Check if a target can be observed in a given chunk."""
        t = self.chunk_times[chunk_idx]

        # 1. Twilight check
        if not is_manual:
            if ignore_scheduling_limits:
                # Just check if it's within the night (sunset to sunrise)
                if not (self.solar_times['sunset'] <= t <= self.solar_times['sunrise']):
                    return False
            else:
                # Standard: 18-degree twilight limit
                t_eve_18 = self.solar_times['twilight_evening_18']
                t_morn_18 = self.solar_times['twilight_morning_18']

                if not target.allow_twilight:
                    # Must be strictly within 18-deg twilight
                    if not (t_eve_18 <= t <= t_morn_18):
                        return False
                else:
                    is_standard = (target.priority == 0.0)
                    if is_standard:
                        # Allowed as early as 30 minutes after sunset, up to 30 minutes before sunrise
                        has_manual = bool(self.realtime_constraints and self.realtime_constraints.get('manual_limits_enabled'))
                        limit_start = self.solar_times['sunset']
                        if not has_manual:
                            limit_start += datetime.timedelta(minutes=30)
                        limit_end = self.solar_times['sunrise']
                        if not has_manual:
                            limit_end -= datetime.timedelta(minutes=30)
                    else:
                        # Non-standard twilight targets must not extend beyond 12-degree twilight
                        limit_start = self.solar_times['twilight_evening_12']
                        limit_end = self.solar_times['twilight_morning_12']
                    
                    if not (limit_start <= t <= limit_end):
                        return False

        # 2. Telescope pointing limits (Dec, Hour Angle)
        if not is_manual:
            if not self.telescope.is_visible(target.ra, target.dec, t, self.observatory):
                return False

        # 3. Airmass limit
        airmass = self.get_airmass_for_target(target, t)
        if is_manual:
            if airmass <= 0:
                return False
        else:
            if ignore_scheduling_limits:
                # Use absolute physical limit (alt >= 20 deg => airmass <= 2.92)
                if airmass <= 0 or airmass > 2.92:
                    return False
            else:
                airmass_limit = 2.2 if target.high_airmass else 1.7
                if airmass <= 0 or airmass > airmass_limit:
                    return False

        # 4. Real-time Pointing Limits (HA, Altitude, Dec, Az)
        if not is_manual:
            rt = getattr(self, 'realtime_constraints', {})
            
            # Dec limit
            dec_min = rt.get('dec_min')
            dec_max = rt.get('dec_max')
            try:
                dec_min_val = float(dec_min) if dec_min is not None and dec_min != "" else -35.0
                dec_max_val = float(dec_max) if dec_max is not None and dec_max != "" else 72.0
                if not (dec_min_val <= target.dec <= dec_max_val):
                    return False
            except (ValueError, TypeError):
                pass

            # Alt limit
            if not ignore_scheduling_limits:
                alt_limit = rt.get('alt_limit')
                alt_max = rt.get('alt_max')
                try:
                    alt_limit_val = float(alt_limit) if alt_limit is not None and alt_limit != "" else 20.0
                    alt_max_val = float(alt_max) if alt_max is not None and alt_max != "" else 90.0
                    alt = math.degrees(math.asin(1.0 / airmass)) if airmass > 0 else 0.0
                    if alt < alt_limit_val or alt > alt_max_val:
                        return False
                except (ValueError, TypeError):
                    pass

            # Az limit
            if not ignore_scheduling_limits:
                az_min = rt.get('az_min')
                az_max = rt.get('az_max')
                try:
                    az_min_val = float(az_min) if az_min is not None and az_min != "" else 0.0
                    az_max_val = float(az_max) if az_max is not None and az_max != "" else 360.0
                    _, az = get_alt_az(t, self.observatory.latitude, self.observatory.longitude, target.ra, target.dec)
                    if az_min_val <= az_max_val:
                        if not (az_min_val <= az <= az_max_val):
                            return False
                    else:
                        if az < az_min_val and az > az_max_val:
                            return False
                except (ValueError, TypeError):
                    pass

            # HA limit
            if not ignore_scheduling_limits:
                ha_limit_east = rt.get('ha_limit_east')
                ha_limit_west = rt.get('ha_limit_west')
                try:
                    limit_east = float(ha_limit_east) if ha_limit_east is not None and ha_limit_east != "" else self.telescope.ha_limit_east
                    limit_west = float(ha_limit_west) if ha_limit_west is not None and ha_limit_west != "" else self.telescope.ha_limit_west
                    lst = get_lst(t, self.observatory.longitude)
                    ha = get_hour_angle(lst, target.ra)
                    if not (limit_east <= ha <= limit_west):
                        return False
                except (ValueError, TypeError):
                    pass

            # 5. Real-time start time limit (recalculate starting now)
            start_from = rt.get('start_from')
            if start_from:
                try:
                    start_dt = datetime.datetime.fromisoformat(start_from.replace("Z", "+00:00"))
                    # Ensure t and start_dt are compared in timezone-aware way
                    if t.tzinfo is not None and start_dt.tzinfo is None:
                        start_dt = start_dt.replace(tzinfo=datetime.timezone.utc)
                    elif t.tzinfo is None and start_dt.tzinfo is not None:
                        t = t.replace(tzinfo=datetime.timezone.utc)
                    if t < start_dt:
                        return False
                except Exception:
                    pass

        return True

    def get_chunk_idx_from_time_str(self, time_str: Optional[str]) -> Optional[int]:
        if not time_str:
            return None
        try:
            # Parse ISO string
            dt = datetime.datetime.fromisoformat(time_str.replace("Z", "+00:00"))
        except ValueError:
            try:
                # Parse HH:MM
                parts = time_str.split(":")
                hh = int(parts[0])
                mm = int(parts[1])
                # Find closest chunk by hour/minute matching (no tolerance)
                best_idx = None
                min_diff = float('inf')
                for idx, c_time in enumerate(self.chunk_times):
                    diff_min = abs((c_time.hour - hh) * 60 + (c_time.minute - mm))
                    if diff_min > 720:
                        diff_min = 1440 - diff_min
                    if diff_min < min_diff:
                        min_diff = diff_min
                        best_idx = idx
                return best_idx
            except Exception:
                return None

        best_idx = None
        min_diff = float('inf')
        dt_naive = dt.replace(tzinfo=None)
        for idx, c_time in enumerate(self.chunk_times):
            c_time_naive = c_time.replace(tzinfo=None)
            diff = abs((c_time_naive - dt_naive).total_seconds())
            if diff < min_diff:
                min_diff = diff
                best_idx = idx
        # 60s tolerance. chunk_times are now floored to whole minutes so any stored
        # ISO block.start_time will match a chunk exactly (diff == 0).
        if min_diff <= 60:
            return best_idx
        return None

    def solve(self, targets: List[Target], disabled_standards: Optional[Set[str]] = None, selected_standards: Optional[List[str]] = None, auto_standards: bool = True, realtime_constraints: Optional[Dict[str, Any]] = None, standards_overrides: Optional[Dict[str, Any]] = None, previous_schedule: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """
        Main entry point for scheduling. Schedules standard stars first, then science targets.
        """
        self.auto_standards = auto_standards
        self.realtime_constraints = realtime_constraints or {}
        
        rt = self.realtime_constraints
        print(f"SCHEDULER SOLVE realtime_constraints={rt}", flush=True)
        if rt.get('manual_limits_enabled'):
            try:
                start_str = rt.get('manual_limit_start', '')
                end_str = rt.get('manual_limit_end', '')
                tz_mode = rt.get('manual_limit_tz', 'UTC')
                
                sunset_utc = self.solar_times['sunset']
                sunrise_utc = self.solar_times['sunrise']
                
                if tz_mode == 'UTC':
                    sunset_hh = sunset_utc.hour
                    sunset_mm = sunset_utc.minute
                    sunrise_hh = sunrise_utc.hour
                    sunrise_mm = sunrise_utc.minute
                else:
                    import pytz
                    pacific = pytz.timezone('America/Los_Angeles')
                    sunset_local = sunset_utc.replace(tzinfo=pytz.UTC).astimezone(pacific) if sunset_utc.tzinfo is None else sunset_utc.astimezone(pacific)
                    sunrise_local = sunrise_utc.replace(tzinfo=pytz.UTC).astimezone(pacific) if sunrise_utc.tzinfo is None else sunrise_utc.astimezone(pacific)
                    sunset_hh = sunset_local.hour
                    sunset_mm = sunset_local.minute
                    sunrise_hh = sunrise_local.hour
                    sunrise_mm = sunrise_local.minute
                    
                is_local = (tz_mode != 'UTC')
                start_res = parse_hour_minute(start_str, is_start=True, is_local_tz=is_local)
                end_res = parse_hour_minute(end_str, is_start=False, is_local_tz=is_local)
                
                shh, smm = start_res if start_res else (sunset_hh, sunset_mm)
                ehh, emm = end_res if end_res else (sunrise_hh, sunrise_mm)
                
                if tz_mode == 'UTC':
                    cand_starts = [
                        sunset_utc.replace(hour=shh, minute=smm, second=0, microsecond=0) + datetime.timedelta(days=d)
                        for d in [-1, 0, 1]
                    ]
                    cand_start = min(cand_starts, key=lambda dt: abs((dt - sunset_utc).total_seconds()))

                    cand_ends = [
                        sunrise_utc.replace(hour=ehh, minute=emm, second=0, microsecond=0) + datetime.timedelta(days=d)
                        for d in [-1, 0, 1]
                    ]
                    cand_end = min(cand_ends, key=lambda dt: abs((dt - sunrise_utc).total_seconds()))
                    
                    if cand_end < cand_start:
                        cand_end += datetime.timedelta(days=1)
                    self.start_night = cand_start
                    self.end_night = cand_end
                else:
                    import pytz
                    pacific = pytz.timezone('America/Los_Angeles')
                    local_start = pacific.localize(datetime.datetime(self.date_local.year, self.date_local.month, self.date_local.day, shh, smm))
                    end_day = self.date_local
                    if ehh < shh:
                        end_day = self.date_local + datetime.timedelta(days=1)
                    local_end = pacific.localize(datetime.datetime(end_day.year, end_day.month, end_day.day, ehh, emm))
                    self.start_night = local_start.astimezone(datetime.timezone.utc)
                    self.end_night = local_end.astimezone(datetime.timezone.utc)
                    
                # Recompute chunks (floor to whole minute for clean block times)
                self.start_night = self.start_night.replace(second=0, microsecond=0)
                self.end_night = self.end_night.replace(second=0, microsecond=0)
                total_seconds = (self.end_night - self.start_night).total_seconds()
                self.num_chunks = int(total_seconds // 60)
                self.chunk_times = [
                    self.start_night + datetime.timedelta(minutes=i)
                    for i in range(self.num_chunks)
                ]
                # Update solar times boundaries
                self.solar_times['sunset'] = self.start_night
                self.solar_times['sunrise'] = self.end_night
                # Constrain twilights to manual night boundaries
                for k in ['twilight_evening_18', 'twilight_evening_12']:
                    if k in self.solar_times:
                        self.solar_times[k] = max(self.solar_times[k], self.start_night)
                for k in ['twilight_morning_18', 'twilight_morning_12']:
                    if k in self.solar_times:
                        self.solar_times[k] = min(self.solar_times[k], self.end_night)
                print(f"SCHEDULER RECOMPUTED BOUNDS: start={self.start_night}, end={self.end_night}, num_chunks={self.num_chunks}", flush=True)
            except Exception as e:
                import traceback
                print("MANUAL BOUNDS ERROR:")
                traceback.print_exc()
                
        previous_start_chunks = {}
        if previous_schedule:
            for item in previous_schedule:
                t_name = item.get('target_name')
                start_time_str = item.get('start_time')
                if t_name and start_time_str:
                    c_idx = self.get_chunk_idx_from_time_str(start_time_str)
                    if c_idx is not None:
                        previous_start_chunks[t_name] = c_idx
                
        # Determine evening/morning twilight boundaries for standard star scheduling
        if getattr(self, 'manual_start_override', False) or (self.realtime_constraints and self.realtime_constraints.get('manual_limits_enabled')):
            eve_twil_start = self.start_night + datetime.timedelta(minutes=30)
            eve_twil_end = self.start_night + datetime.timedelta(hours=1.5)
            morn_twil_start = self.end_night - datetime.timedelta(hours=1.5)
            morn_twil_end = self.end_night - datetime.timedelta(minutes=30)
        else:
            eve_twil_start = self.solar_times['sunset'] + datetime.timedelta(minutes=30)
            eve_twil_end = self.solar_times['twilight_evening_18'] + datetime.timedelta(minutes=30)
            morn_twil_start = self.solar_times['twilight_morning_18'] - datetime.timedelta(minutes=30)
            morn_twil_end = self.solar_times['sunrise'] - datetime.timedelta(minutes=30)

        # Load standard stars database early
        standards_data = []
        import json
        import os
        base_dir = os.path.dirname(os.path.abspath(__file__))
        standards_path = os.path.join(base_dir, "static", "standards.json")
        if os.path.exists(standards_path):
            try:
                with open(standards_path, "r") as f:
                    standards_data = json.load(f)
            except Exception:
                pass
        if not standards_data:
            # Fallback default database
            standards_data = [
                {"name": "BD+284211", "ra": "21:51:11.07", "dec": "+28:51:51.80", "color": "blue", "quality": "good", "magnitude": 10.5, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "BD+174708", "ra": "22:11:31.37", "dec": "+18:05:34.20", "color": "red", "quality": "good", "magnitude": 9.5, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "HD19445", "ra": "03:08:25.86", "dec": "+26:20:05.70", "color": "red", "quality": "good", "magnitude": 8.0, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "G191B2B", "ra": "05:05:30.60", "dec": "+52:49:54.00", "color": "blue", "quality": "okay", "magnitude": 11.8, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "HD84937", "ra": "09:48:56.09", "dec": "+13:44:39.30", "color": "red", "quality": "okay", "magnitude": 8.3, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "Feige 34", "ra": "10:39:36.74", "dec": "+43:06:09.30", "color": "blue", "quality": "good", "magnitude": 11.2, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "HZ 44", "ra": "13:23:35.26", "dec": "+36:07:59.50", "color": "blue", "quality": "okay", "magnitude": 11.7, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "BD+262606", "ra": "14:49:02.35", "dec": "+25:42:09.10", "color": "red", "quality": "good", "magnitude": 9.7, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "Feige 110", "ra": "23:19:58.39", "dec": "-05:09:55.80", "color": "blue", "quality": "good", "magnitude": 11.8, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "LTT 377", "ra": "00:41:46.82", "dec": "-33:39:08.2", "color": "blue", "quality": "okay", "magnitude": 11.2, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "LTT 1788", "ra": "03:48:22.2", "dec": "-39:08:35", "color": "blue", "quality": "okay", "magnitude": 13.1, "exposure_times": {"Lick Shane 3m": 300}},
                {"name": "LTT 2415", "ra": "05:56:24.2", "dec": "-27:51:26", "color": "blue", "quality": "okay", "magnitude": 12.2, "exposure_times": {"Lick Shane 3m": 300}}
            ]

        if not auto_standards:
            sel_set = set(selected_standards or [])
            standards_data = [s for s in standards_data if s['name'] in sel_set]
        elif disabled_standards:
            standards_data = [s for s in standards_data if s['name'] not in disabled_standards]

        # Parse standard stars into Target objects
        standards = []
        for s_data in standards_data:
            standards.append({
                'target': Target(
                    name=s_data['name'],
                    ra=s_data['ra'],
                    dec=s_data['dec'],
                    magnitude=s_data['magnitude'],
                    priority=0.0,
                    allow_twilight=True
                ),
                'color': s_data['color'],
                'quality': s_data['quality'],
                'exposure_times': s_data.get('exposure_times', {})
            })

        # Apply standards_overrides to parsed standard stars
        if standards_overrides:
            for s in standards:
                name = s['target'].name
                if name in standards_overrides:
                    ovr = standards_overrides[name]
                    if ovr.get('manual_start_time'):
                        s['target'].manual_start_time = ovr['manual_start_time']
                    if ovr.get('manual_duration') is not None:
                        s['exposure_times'][self.telescope.name] = ovr['manual_duration'] * 60

        # Precompute target airmasses to optimize performance
        for t in targets:
            self.precompute_target_airmass(t)
        for s in standards:
            self.precompute_target_airmass(s['target'])

        # Precompute target visibility to optimize performance
        self.visibility_cache = {}
        all_t = targets + [s['target'] for s in standards]
        for t in all_t:
            if t.name not in self.visibility_cache:
                self.visibility_cache[t.name] = {
                    'manual_ignore': [self.is_chunk_valid(t, c, is_manual=True, ignore_scheduling_limits=True) for c in range(self.num_chunks)],
                    'auto_ignore': [self.is_chunk_valid(t, c, ignore_scheduling_limits=True) for c in range(self.num_chunks)],
                    'manual': [self.is_chunk_valid(t, c, is_manual=True) for c in range(self.num_chunks)],
                    'auto': [self.is_chunk_valid(t, c) for c in range(self.num_chunks)]
                }

        # Pre-schedule manual start standard stars
        reserved_chunks = set()
        manual_standard_blocks = []
        for s in standards:
            t = s['target']
            if t.manual_start_time:
                manual_chunk = self.get_chunk_idx_from_time_str(t.manual_start_time)
                if manual_chunk is not None:
                    t_name_tel = self.telescope.name
                    exp_seconds = s['exposure_times'].get(t_name_tel, 300)
                    dur_chunks = int(math.ceil(exp_seconds / 60.0))
                    
                    block_valid = True
                    for c_idx in range(manual_chunk, manual_chunk + dur_chunks):
                        if c_idx >= self.num_chunks or c_idx in reserved_chunks or not self.visibility_cache[t.name]['manual'][c_idx]:
                            block_valid = False
                            break
                    if block_valid:
                        reserved_chunks.update(range(manual_chunk, manual_chunk + dur_chunks))
                        airmass = self.get_airmass_for_target(t, self.chunk_times[manual_chunk])
                        block = ObservationBlock(
                            target=t,
                            start_time=self.chunk_times[manual_chunk],
                            duration_minutes=dur_chunks * 1,
                            airmass_start=airmass,
                            airmass_end=self.get_airmass_for_target(t, self.chunk_times[manual_chunk + dur_chunks - 1]),
                            airmass_median=get_median([self.get_airmass_for_target(t, self.chunk_times[c]) for c in range(manual_chunk, manual_chunk + dur_chunks)]),
                            priority=0.0,
                            comment=f"Calib: {s['color'].capitalize()} / {s['quality'].capitalize()}, Airmass {airmass:.2f}"
                        )
                        block.target.priority = 0.0
                        manual_standard_blocks.append(block)

        # Filter out pre-scheduled standard stars so they aren't processed in standard selection loops
        standards = [s for s in standards if not s['target'].manual_start_time]

        # Pre-schedule manual start science targets immediately and reserve their chunks
        manual_science_blocks = []
        manually_scheduled_names = set()

        # Target exposure calculations
        target_exposures_dict = {}
        extinction = float(self.realtime_constraints.get('extinction', 0.0))
        for t in targets:
            red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)
            target_exposures_dict[t.name] = {
                "red_exp": red_exp,
                "red_num": red_num,
                "blue_exp": blue_exp,
                "blue_num": blue_num,
                "duration_minutes": dur_mins
            }

        for t in targets:
            if t.manual_start_time:
                manual_chunk = self.get_chunk_idx_from_time_str(t.manual_start_time)
                if manual_chunk is not None:
                    dur_chunks = target_exposures_dict[t.name]["duration_minutes"]
                    block_valid = True
                    for c_idx in range(manual_chunk, manual_chunk + dur_chunks):
                        if c_idx >= self.num_chunks or c_idx in reserved_chunks or not self.visibility_cache[t.name]['manual'][c_idx]:
                            block_valid = False
                            break
                    if block_valid:
                        reserved_chunks.update(range(manual_chunk, manual_chunk + dur_chunks))
                        airmass = self.get_airmass_for_target(t, self.chunk_times[manual_chunk])
                        exp_info = target_exposures_dict[t.name]
                        comment_prefix = f"Slew: 7m. Blue: {exp_info['blue_num']}x{exp_info['blue_exp']:.0f}s, Red: {exp_info['red_num']}x{exp_info['red_exp']:.0f}s."
                        block_comment = f"{comment_prefix} {t.comment}" if t.comment else comment_prefix
                        block = ObservationBlock(
                            target=t,
                            start_time=self.chunk_times[manual_chunk],
                            duration_minutes=dur_chunks,
                            airmass_start=airmass,
                            airmass_end=self.get_airmass_for_target(t, self.chunk_times[manual_chunk + dur_chunks - 1]),
                            airmass_median=get_median([self.get_airmass_for_target(t, self.chunk_times[c]) for c in range(manual_chunk, manual_chunk + dur_chunks)]),
                            priority=t.priority,
                            comment=block_comment
                        )
                        manual_science_blocks.append(block)
                        manually_scheduled_names.add(t.name)

        remaining_targets = [t for t in targets if t.name not in manually_scheduled_names]

        # 1. Run preliminary solve to see what gets scheduled and if we need high-airmass calibrations
        prelim_solve = self._solve_internal(remaining_targets, reserved_chunks=set(reserved_chunks), previous_start_chunks=previous_start_chunks)
        all_scheduled_science = prelim_solve['blocks'] + manual_science_blocks
        
        need_high_airmass = False
        for b in all_scheduled_science:
            if b.airmass_median > 1.5:
                need_high_airmass = True
                break
                
        # 2. Determine standard stars twilight slots
        # Find twilight chunk boundaries
        t_eve_18 = self.solar_times['twilight_evening_18']
        eve_18_idx = 0
        for idx, c_time in enumerate(self.chunk_times):
            if c_time >= t_eve_18:
                eve_18_idx = idx
                break
                
        t_morn_18 = self.solar_times['twilight_morning_18']
        morn_18_idx = self.num_chunks - 1
        for idx, c_time in enumerate(self.chunk_times):
            if c_time >= t_morn_18:
                morn_18_idx = idx
                break
                
        # Determine evening slots (restricted to at least 30 minutes after sunset, chunk index 30)
        has_manual = bool(self.realtime_constraints and self.realtime_constraints.get('manual_limits_enabled'))
        eve_slot_1 = 0 if has_manual else 30
        eve_slot_2 = 5 if has_manual else 35
        # Check bright science target exception
        # Telescope brightness threshold: Lick is 15.5, Keck is 17.5
        bright_threshold = 17.5 if "Keck" in self.telescope.name else 15.5
        
        science_start_block = next((b for b in all_scheduled_science if b.start_time == self.chunk_times[0]), None)
        if science_start_block and science_start_block.target.magnitude < bright_threshold:
            # Shift evening slots
            eve_slot_1 = max(0 if has_manual else 30, int(science_start_block.duration_minutes))
            eve_slot_2 = eve_slot_1 + 5
            
        # Determine morning slots (restricted to at least 30 minutes before sunrise, chunk index self.num_chunks - 35)
        morn_slot_2 = self.num_chunks - 5 if has_manual else self.num_chunks - 35
        morn_slot_1 = morn_slot_2 - 5
        science_end_block = next((b for b in all_scheduled_science if b.end_time == self.chunk_times[-1]), None)
        if science_end_block and science_end_block.target.magnitude < bright_threshold:
            morn_slot_2 = min(self.num_chunks - 5 if has_manual else self.num_chunks - 35, self.num_chunks - 5 - int(science_end_block.duration_minutes))
            morn_slot_1 = morn_slot_2 - 5
            
        # 3. Load standard stars: already done early in solve()
        pass
            
        # 4. Search for the best standard star selection
        standard_blocks = list(manual_standard_blocks)

        def add_standard_block(star_dict, chunk_idx):
            target = star_dict['target']
            red_exp, red_num, blue_exp, blue_num, dur_chunks = get_target_exposure_details(target, self.moon, extinction, self.observatory.latitude)

            reserved_chunks.update(range(chunk_idx, chunk_idx + dur_chunks))

            airmass = self.get_airmass_for_target(target, self.chunk_times[chunk_idx])

            block = ObservationBlock(
                target=target,
                start_time=self.chunk_times[chunk_idx],
                duration_minutes=dur_chunks,
                airmass_start=airmass,
                airmass_end=self.get_airmass_for_target(target, self.chunk_times[chunk_idx + dur_chunks - 1]),
                airmass_median=get_median([self.get_airmass_for_target(target, self.chunk_times[c]) for c in range(chunk_idx, chunk_idx + dur_chunks)]),
                priority=0.0,
                comment=f"Slew: 7m. Blue: {blue_num}x{blue_exp:.0f}s, Red: {red_num}x{red_exp:.0f}s. Calib: {star_dict['color'].capitalize()} / {star_dict['quality'].capitalize()}, Airmass {airmass:.2f}"
            )
            block.target.priority = 0.0
            standard_blocks.append(block)

        if not auto_standards:
            # Sort standards by RA to schedule in logical sky order
            standards.sort(key=lambda s: s['target'].ra)

            # Find twilight chunks based on twilight boundaries
            twil_chunks = []
            for c_idx, c_time in enumerate(self.chunk_times):
                is_eve_twil = (eve_twil_start <= c_time <= eve_twil_end)
                is_morn_twil = (morn_twil_start <= c_time <= morn_twil_end)
                if is_eve_twil or is_morn_twil:
                    twil_chunks.append(c_idx)

            for s in standards:
                t = s['target']
                red_exp, red_num, blue_exp, blue_num, dur_chunks = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)

                # Helper search function with dynamic constraints relaxation
                def find_best_chunk(allowed_chunks, max_airmass):
                    bc = None
                    ba = float('inf')
                    for c_idx in allowed_chunks:
                        if c_idx + dur_chunks > self.num_chunks:
                            continue
                        if any(c in reserved_chunks for c in range(c_idx, c_idx + dur_chunks)):
                            continue

                        block_ok = True
                        for chunk_offset in range(dur_chunks):
                            if not self.telescope.is_visible(t.ra, t.dec, self.chunk_times[c_idx + chunk_offset], self.observatory):
                                block_ok = False
                                break
                        if not block_ok:
                            continue

                        airmass = self.get_airmass_for_target(t, self.chunk_times[c_idx])
                        if 0 < airmass <= max_airmass:
                            if airmass < ba:
                                ba = airmass
                                bc = c_idx
                    return bc, ba

                # Pass 1: twilight chunks, airmass <= 2.2
                best_c, best_airmass = find_best_chunk(twil_chunks, 2.2)

                # Pass 2: twilight chunks, airmass <= 2.5
                if best_c is None:
                    best_c, best_airmass = find_best_chunk(twil_chunks, 2.5)

                # Pass 3: all night chunks, airmass <= 2.2
                min_chunk = 0 if has_manual else 30
                all_chunks = [c for c in range(self.num_chunks) if c >= min_chunk]
                if best_c is None:
                    best_c, best_airmass = find_best_chunk(all_chunks, 2.2)

                # Pass 4: all night chunks, airmass <= 2.5
                if best_c is None:
                    best_c, best_airmass = find_best_chunk(all_chunks, 2.5)

                # Pass 5: all night chunks, any visibility (airmass <= 10.0)
                if best_c is None:
                    best_c, best_airmass = find_best_chunk(all_chunks, 10.0)

                if best_c is not None:
                    add_standard_block(s, best_c)
        else:
            # Auto selection: choose one for each of the 4 slots
            blue_standards = [s for s in standards if s['color'] == 'blue']
            red_standards = [s for s in standards if s['color'] == 'red']
            # Evening Blue (Slot 1)
            best_eb_score = -1.0
            s_eb = None
            dur_eb = 8
            for s in blue_standards:
                t = s['target']
                red_exp, red_num, blue_exp, blue_num, current_dur = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)
                if any(c in reserved_chunks or c >= self.num_chunks for c in range(eve_slot_1, eve_slot_1 + current_dur)):
                    continue
                if self.telescope.is_visible(t.ra, t.dec, self.chunk_times[eve_slot_1], self.observatory):
                    airmass = self.get_airmass_for_target(t, self.chunk_times[eve_slot_1])
                    if 0 < airmass <= 2.2:
                        score = 100.0 if s['quality'] == 'good' else 10.0
                        if need_high_airmass:
                            if 1.5 <= airmass <= 2.2: score += 20.0
                        else:
                            if airmass < 1.3: score += 20.0
                        if score > best_eb_score:
                            best_eb_score = score
                            s_eb = s
                            dur_eb = current_dur
            if s_eb is not None:
                add_standard_block(s_eb, eve_slot_1)
                eve_slot_2 = eve_slot_1 + dur_eb
            else:
                eve_slot_2 = eve_slot_1 + 8

            # Evening Red (Slot 2)
            best_er_score = -1.0
            s_er = None
            for s in red_standards:
                t = s['target']
                red_exp, red_num, blue_exp, blue_num, current_dur = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)
                if any(c in reserved_chunks or c >= self.num_chunks for c in range(eve_slot_2, eve_slot_2 + current_dur)):
                    continue
                if self.telescope.is_visible(t.ra, t.dec, self.chunk_times[eve_slot_2], self.observatory):
                    airmass = self.get_airmass_for_target(t, self.chunk_times[eve_slot_2])
                    if 0 < airmass <= 2.2:
                        score = 100.0 if s['quality'] == 'good' else 10.0
                        if need_high_airmass:
                            if 1.5 <= airmass <= 2.2: score += 20.0
                        else:
                            if airmass < 1.3: score += 20.0
                        if score > best_er_score:
                            best_er_score = score
                            s_er = s
            if s_er is not None:
                add_standard_block(s_er, eve_slot_2)
            # Morning slots scheduling: morn_slot_2 is red, morn_slot_1 is blue.
            morn_sequence_end = self.num_chunks - 5 if has_manual else self.num_chunks - 30
            
            # Morning Red (Slot 2)
            best_mr_score = -1.0
            s_mr = None
            dur_mr = 8
            for s in red_standards:
                t = s['target']
                red_exp, red_num, blue_exp, blue_num, current_dur = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)
                current_start = morn_sequence_end - current_dur
                if any(c in reserved_chunks or c < 0 for c in range(current_start, current_start + current_dur)):
                    continue
                if self.telescope.is_visible(t.ra, t.dec, self.chunk_times[current_start], self.observatory):
                    airmass = self.get_airmass_for_target(t, self.chunk_times[current_start])
                    if 0 < airmass <= 2.2:
                        score = 100.0 if s['quality'] == 'good' else 10.0
                        if need_high_airmass:
                            if 1.5 <= airmass <= 2.2: score += 20.0
                        else:
                            if airmass < 1.3: score += 20.0
                        if score > best_mr_score:
                            best_mr_score = score
                            s_mr = s
                            dur_mr = current_dur
            if s_mr is not None:
                morn_start_red = morn_sequence_end - dur_mr
                add_standard_block(s_mr, morn_start_red)
            else:
                morn_start_red = morn_sequence_end - 8

            # Morning Blue (Slot 1)
            best_mb_score = -1.0
            s_mb = None
            for s in blue_standards:
                t = s['target']
                red_exp, red_num, blue_exp, blue_num, current_dur = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)
                current_start = morn_start_red - current_dur
                if any(c in reserved_chunks or c < 0 for c in range(current_start, current_start + current_dur)):
                    continue
                if self.telescope.is_visible(t.ra, t.dec, self.chunk_times[current_start], self.observatory):
                    airmass = self.get_airmass_for_target(t, self.chunk_times[current_start])
                    if 0 < airmass <= 2.2:
                        score = 100.0 if s['quality'] == 'good' else 10.0
                        if need_high_airmass:
                            if 1.5 <= airmass <= 2.2: score += 20.0
                        else:
                            if airmass < 1.3: score += 20.0
                        if score > best_mb_score:
                            best_mb_score = score
                            s_mb = s
            if s_mb is not None:
                details_mb = get_target_exposure_details(s_mb['target'], self.moon, extinction, self.observatory.latitude)
                dur_mb = details_mb[4]
                morn_start_blue = morn_start_red - dur_mb
                add_standard_block(s_mb, morn_start_blue)
                
        # 6. Run final solver pass with the reserved standard chunks
        final_solve = self._solve_internal(remaining_targets, reserved_chunks, previous_start_chunks=previous_start_chunks)
        
        # Merge scheduled blocks
        scheduled_blocks = final_solve['blocks'] + standard_blocks + manual_science_blocks
        scheduled_blocks.sort(key=lambda b: b.start_time)
        
        # Detect empty blocks
        empty_blocks = []
        if len(final_solve['conflicts']) == 0 and len(scheduled_blocks) > 0:
            start_night_active = self.start_night + datetime.timedelta(minutes=30)
            end_night_active = self.end_night - datetime.timedelta(minutes=30)
            
            timeline_events = [(b.start_time, b.end_time) for b in scheduled_blocks]
            curr_time = start_night_active
            for b_start, b_end in timeline_events:
                if b_start > curr_time + datetime.timedelta(minutes=5):
                    gap_duration = (b_start - curr_time).total_seconds() / 60.0
                    empty_blocks.append({
                        'start_time': curr_time.isoformat(),
                        'end_time': b_start.isoformat(),
                        'duration_minutes': int(gap_duration)
                    })
                curr_time = max(curr_time, b_end)
                
            if curr_time + datetime.timedelta(minutes=5) < end_night_active:
                gap_duration = (end_night_active - curr_time).total_seconds() / 60.0
                empty_blocks.append({
                    'start_time': curr_time.isoformat(),
                    'end_time': end_night_active.isoformat(),
                    'duration_minutes': int(gap_duration)
                })
                
        # Generate airmass curve data for plotting for all targets
        airmass_plots = {}
        for t in targets:
            curve = []
            for c_idx in range(self.num_chunks):
                dt = self.chunk_times[c_idx]
                is_obs = self.visibility_cache[t.name]['auto'][c_idx]
                curve.append({
                    'time': dt.isoformat(),
                    'airmass': round(self.get_airmass_for_target(t, dt), 3),
                    'observable': is_obs
                })
            airmass_plots[t.name] = curve
            
        # Also plot the scheduled standard stars
        for block in standard_blocks:
            curve = []
            for c_idx in range(self.num_chunks):
                dt = self.chunk_times[c_idx]
                is_obs = self.visibility_cache[block.target.name]['auto'][c_idx]
                curve.append({
                    'time': dt.isoformat(),
                    'airmass': round(self.get_airmass_for_target(block.target, dt), 3),
                    'observable': is_obs
                })
            airmass_plots[block.target.name] = curve
            
        # Generate Moon airmass and altitude curve
        moon_plot = []
        if HAS_ASTRO_LIBS:
            try:
                loc = EarthLocation(lat=self.observatory.latitude*u.deg, lon=self.observatory.longitude*u.deg, height=self.observatory.elevation*u.m)
                obs = Observer(location=loc)
                times = Time(self.chunk_times)
                moon_coords = get_moon(times, location=loc)
                altazs = obs.altaz(times, moon_coords)
                for c_idx in range(self.num_chunks):
                    alt = altazs[c_idx].alt.degree
                    airmass = altazs[c_idx].secz.value if alt > 0 else 999.0
                    dt = self.chunk_times[c_idx]
                    moon_plot.append({
                        'time': dt.isoformat(),
                        'airmass': round(airmass, 3) if (alt > 0 and airmass < 10.0) else 999.0,
                        'alt': round(alt, 3)
                    })
            except Exception:
                for c_idx in range(self.num_chunks):
                    dt = self.chunk_times[c_idx]
                    d = datetime_to_d(dt)
                    m_ra, m_dec, _ = get_moon_position(d)
                    alt, _ = get_alt_az(dt, self.observatory.latitude, self.observatory.longitude, m_ra, m_dec)
                    airmass = get_airmass(alt)
                    moon_plot.append({
                        'time': dt.isoformat(),
                        'airmass': round(airmass, 3) if (alt > 0 and airmass < 10.0) else 999.0,
                        'alt': round(alt, 3)
                    })
        else:
            for c_idx in range(self.num_chunks):
                dt = self.chunk_times[c_idx]
                d = datetime_to_d(dt)
                m_ra, m_dec, _ = get_moon_position(d)
                alt, _ = get_alt_az(dt, self.observatory.latitude, self.observatory.longitude, m_ra, m_dec)
                airmass = get_airmass(alt)
                moon_plot.append({
                    'time': dt.isoformat(),
                    'airmass': round(airmass, 3) if (alt > 0 and airmass < 10.0) else 999.0,
                    'alt': round(alt, 3)
                })
            
        scheduled_names = {b.target.name for b in scheduled_blocks}
        conflicts = [c for c in (final_solve['conflicts'] + prelim_solve['conflicts']) if c not in scheduled_names]

        return {
            'blocks': [b.to_dict() for b in scheduled_blocks],
            'conflicts': conflicts,
            'unobservable': final_solve['unobservable'],
            'empty_blocks': empty_blocks,
            'moon_info': self.moon,
            'moon_plot': moon_plot,
            'airmass_plots': airmass_plots,
            'solar_times': {k: v.isoformat() for k, v in self.solar_times.items()}
        }

    def _solve_internal(self, targets: List[Target], reserved_chunks: Set[int], previous_start_chunks: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        """
        Schedules science targets using a priority-sequential Branch and Bound algorithm.
        Enforces precedence constraints (schedule_before) and manual schedule adjustments.
        Ignores chunks in reserved_chunks.
        """
        # Parse exposures and durations
        target_exposures_dict = {}
        extinction = float(getattr(self, 'realtime_constraints', {}).get('extinction', 0.0))
        for t in targets:
            red_exp, red_num, blue_exp, blue_num, dur_mins = get_target_exposure_details(t, self.moon, extinction, self.observatory.latitude)
            target_exposures_dict[t.name] = {
                "red_exp": red_exp,
                "red_num": red_num,
                "blue_exp": blue_exp,
                "blue_num": blue_num,
                "duration_minutes": dur_mins
            }
                
        # Parse manual start chunk indices
        manual_start_chunks: Dict[str, Optional[int]] = {}
        for t in targets:
            manual_start_chunks[t.name] = self.get_chunk_idx_from_time_str(t.manual_start_time)
            
        # Ensure visibility cache exists for all targets being solved
        if not hasattr(self, 'visibility_cache'):
            self.visibility_cache = {}
        for t in targets:
            if t.name not in self.visibility_cache:
                self.visibility_cache[t.name] = {
                    'manual_ignore': [self.is_chunk_valid(t, c, is_manual=True, ignore_scheduling_limits=True) for c in range(self.num_chunks)],
                    'auto_ignore': [self.is_chunk_valid(t, c, ignore_scheduling_limits=True) for c in range(self.num_chunks)],
                    'manual': [self.is_chunk_valid(t, c, is_manual=True) for c in range(self.num_chunks)],
                    'auto': [self.is_chunk_valid(t, c) for c in range(self.num_chunks)]
                }

        # Filter impossible targets and conflicts
        conflicts: List[str] = []
        unobservable_targets: List[str] = []
        observable_targets: List[Target] = []
        
        for t in targets:
            # 1. Check physical observability (ignoring reserved_chunks)
            has_physical_chunk = False
            manual_chunk = manual_start_chunks[t.name]
            if manual_chunk is not None:
                if manual_chunk < self.num_chunks and self.visibility_cache[t.name]['manual_ignore'][manual_chunk]:
                    has_physical_chunk = True
            else:
                for c_idx in range(self.num_chunks):
                    if self.visibility_cache[t.name]['auto_ignore'][c_idx]:
                        has_physical_chunk = True
                        break
            
            if not has_physical_chunk:
                unobservable_targets.append(t.name)
                continue
                
            # 2. Check scheduling availability (considering reserved_chunks)
            has_avail_chunk = False
            if manual_chunk is not None:
                if manual_chunk < self.num_chunks and manual_chunk not in reserved_chunks and self.visibility_cache[t.name]['manual'][manual_chunk]:
                    has_avail_chunk = True
            else:
                for c_idx in range(self.num_chunks):
                    if c_idx not in reserved_chunks and self.visibility_cache[t.name]['auto'][c_idx]:
                        has_avail_chunk = True
                        break
            
            if not has_avail_chunk:
                conflicts.append(t.name)
            else:
                observable_targets.append(t)
                
        # Partition observable targets by priority
        obs_targets_by_prio: Dict[float, List[Target]] = {}
        for t in observable_targets:
            obs_targets_by_prio.setdefault(t.priority, []).append(t)
            
        sorted_priorities = sorted(obs_targets_by_prio.keys())
        current_schedule: Dict[str, int] = {}
        manually_scheduled: Set[str] = set()
        
        # Pre-schedule manual start science targets immediately and reserve their chunks
        for t in observable_targets:
            manual_chunk = manual_start_chunks[t.name]
            if manual_chunk is not None:
                dur_chunks = target_exposures_dict[t.name]["duration_minutes"]
                block_valid = True
                for c_idx in range(manual_chunk, manual_chunk + dur_chunks):
                    if c_idx >= self.num_chunks or c_idx in reserved_chunks or not self.visibility_cache[t.name]['manual'][c_idx]:
                        block_valid = False
                        break
                if block_valid:
                    current_schedule[t.name] = manual_chunk
                    reserved_chunks.update(range(manual_chunk, manual_chunk + dur_chunks))
                    manually_scheduled.add(t.name)
                else:
                    conflicts.append(t.name)
                    
        previously_scheduled = set(current_schedule.keys())
        
        for prio in sorted_priorities:
            prio_targets = obs_targets_by_prio.get(prio, [])
            if not prio_targets:
                continue
                
            # S_active are previously scheduled science targets that are not manual
            S_active = [tg for tg in targets if tg.name in previously_scheduled and tg.name not in manually_scheduled]
            # new_active are the targets of current priority that are not manual
            new_active = [tg for tg in prio_targets if tg.name not in manually_scheduled]
            
            targets_to_schedule = S_active + new_active
            if not targets_to_schedule:
                continue
                
            durations: Dict[str, int] = {}
            for tg in targets:
                durations[tg.name] = target_exposures_dict[tg.name]["duration_minutes"]

            valid_slots: Dict[str, List[int]] = {}
            airmass_costs: Dict[str, Dict[int, float]] = {}
            
            for t in targets_to_schedule:
                dur_chunks = durations[t.name]
                slots = []
                costs = {}
                for s_idx in range(0, self.num_chunks - dur_chunks + 1):
                    block_valid = True
                    airmasses = []
                    for c_idx in range(s_idx, s_idx + dur_chunks):
                        if c_idx in reserved_chunks or not self.visibility_cache[t.name]['auto'][c_idx]:
                            block_valid = False
                            break
                        airmasses.append(self.get_airmass_for_target(t, self.chunk_times[c_idx]))
                    if block_valid:
                        slots.append(s_idx)
                        airmasses.sort()
                        mid = len(airmasses) // 2
                        median_airmass = airmasses[mid] if len(airmasses) % 2 != 0 else (airmasses[mid-1] + airmasses[mid]) / 2.0
                        
                        # Calculate twilight proximity penalty for non-standard targets
                        twilight_dist = 0.0
                        if not (t.priority == 0.0):
                            t_eve_18 = self.solar_times['twilight_evening_18']
                            t_morn_18 = self.solar_times['twilight_morning_18']
                            dists = []
                            for c_idx in range(s_idx, s_idx + dur_chunks):
                                c_time = self.chunk_times[c_idx]
                                if c_time < t_eve_18:
                                    dists.append((t_eve_18 - c_time).total_seconds() / 60.0)
                                elif c_time > t_morn_18:
                                    dists.append((c_time - t_morn_18).total_seconds() / 60.0)
                                else:
                                    dists.append(0.0)
                            twilight_dist = get_median(dists)
                            
                        costs[s_idx] = median_airmass + 1000.0 * twilight_dist
                valid_slots[t.name] = slots
                airmass_costs[t.name] = costs
                    
            # Search
            # Build precedence graph for topological sorting
            graph = {t.name: [] for t in targets_to_schedule}
            in_degree = {t.name: 0 for t in targets_to_schedule}
            
            for t in targets_to_schedule:
                if t.schedule_before:
                    for after in t.schedule_before:
                        if after in graph:
                            graph[t.name].append(after)
                            in_degree[after] += 1
            
            has_constraint = {}
            for t in targets_to_schedule:
                has_constraint[t.name] = (len(graph[t.name]) > 0) or (in_degree[t.name] > 0)
                
            topo_order = []
            zero_in = [name for name, deg in in_degree.items() if deg == 0 and has_constraint[name]]
            while zero_in:
                curr = zero_in.pop(0)
                topo_order.append(curr)
                for neighbor in graph[curr]:
                    in_degree[neighbor] -= 1
                    if in_degree[neighbor] == 0:
                        zero_in.append(neighbor)
                        
            # If there's a cycle, the remaining nodes won't be in topo_order. 
            # We just append them to the end with rank = infinity.
            topo_rank = {name: i for i, name in enumerate(topo_order)}
            
            targets_sorted_for_solve = sorted(
                targets_to_schedule,
                key=lambda x: (
                    not has_constraint[x.name],
                    topo_rank.get(x.name, 999999),
                    x.priority,
                    -durations[x.name]
                )
            )
            
            S_active_names = {t.name for t in S_active}
            new_active_names = {t.name for t in new_active}
            
            initial_schedule = {k: v for k, v in current_schedule.items() if k in manually_scheduled}
            
            def check_overlap(s1: int, d1: int, s2: int, d2: int) -> bool:
                return not (s1 + d1 <= s2 or s2 + d2 <= s1)
                
            # 1. Greedy initialization to establish a high-quality upper bound and speed up search
            greedy_sched = initial_schedule.copy()
            greedy_cost = 0.0
            for t in targets_sorted_for_solve:
                t_name = t.name
                t_dur = durations[t_name]
                slots = valid_slots[t_name]
                
                s_prev = current_schedule.get(t_name)
                if s_prev is None and previous_start_chunks is not None:
                    s_prev = previous_start_chunks.get(t_name)
                    
                if s_prev is not None and s_prev in slots:
                    sorted_slots = [s_prev] + sorted([s for s in slots if s != s_prev], key=lambda s: airmass_costs[t_name][s])
                else:
                    sorted_slots = sorted(slots, key=lambda s: airmass_costs[t_name][s])
                    
                placed = False
                for s in sorted_slots:
                    overlap = False
                    for p_name, p_start in greedy_sched.items():
                        if check_overlap(s, t_dur, p_start, durations[p_name]):
                            overlap = True
                            break
                    if overlap:
                        continue
                        
                    precedence_ok = True
                    for p_name, p_start in greedy_sched.items():
                        p_dur = durations[p_name]
                        if p_name in t.schedule_before:
                            if not (s + t_dur <= p_start):
                                precedence_ok = False
                                break
                        p_obj = next((tg for tg in targets if tg.name == p_name), None)
                        if p_obj is not None and t_name in p_obj.schedule_before:
                            if not (p_start + p_dur <= s):
                                precedence_ok = False
                                break
                    if not precedence_ok:
                        continue
                        
                    greedy_sched[t_name] = s
                    greedy_cost += airmass_costs[t_name][s]
                    placed = True
                    break
                    
                if not placed:
                    if t_name in new_active_names:
                        greedy_cost += 100000.0
                        
            # Only use greedy schedule as fallback if it scheduled all S_active targets (which are mandatory)
            has_all_s_active = all(name in greedy_sched for name in S_active_names)
            
            best_schedule = greedy_sched if has_all_s_active else None
            best_cost = greedy_cost if has_all_s_active else float('inf')
            
            # Precompute minimum possible costs for suffix-based pruning
            min_costs = [min(airmass_costs[t.name].values()) if airmass_costs[t.name] else 0.0 for t in targets_sorted_for_solve]
            suffix_min_costs = []
            current_sum = 0.0
            for val in reversed(min_costs):
                current_sum += val
                suffix_min_costs.append(current_sum)
            suffix_min_costs.reverse()
            suffix_min_costs.append(0.0) # For idx == len(targets_sorted_for_solve)
            
            search_iterations = 0
            max_search_iterations = 20000
            
            def search(idx: int, schedule: Dict[str, int], cost: float):
                nonlocal best_schedule, best_cost, search_iterations
                
                search_iterations += 1
                if search_iterations > max_search_iterations:
                    return
                
                if idx == len(targets_sorted_for_solve):
                    if cost < best_cost:
                        best_cost = cost
                        best_schedule = schedule.copy()
                    return
                
                target = targets_sorted_for_solve[idx]
                t_name = target.name
                t_dur = durations[t_name]
                
                # Check branch cost bound
                if cost + suffix_min_costs[idx] >= best_cost:
                    return
                    
                slots = valid_slots[t_name]
                s_prev = current_schedule.get(t_name)
                if s_prev is None and previous_start_chunks is not None:
                    s_prev = previous_start_chunks.get(t_name)
                if s_prev is not None and s_prev in slots:
                    other_slots = [s for s in slots if s != s_prev]
                    sorted_slots = [s_prev] + sorted(other_slots, key=lambda s: airmass_costs[t_name][s])
                else:
                    sorted_slots = sorted(slots, key=lambda s: airmass_costs[t_name][s])
                
                for s in sorted_slots:
                    overlap = False
                    for p_name, p_start in schedule.items():
                        if check_overlap(s, t_dur, p_start, durations[p_name]):
                            overlap = True
                            break
                    if overlap:
                        continue
                        
                    # Precedence constraints check
                    precedence_ok = True
                    for p_name, p_start in schedule.items():
                        p_dur = durations[p_name]
                        if p_name in target.schedule_before:
                            if not (s + t_dur <= p_start):
                                precedence_ok = False
                                break
                        p_obj = next((tg for tg in targets if tg.name == p_name), None)
                        if p_obj is not None and t_name in p_obj.schedule_before:
                            if not (p_start + p_dur <= s):
                                precedence_ok = False
                                break
                                
                    if not precedence_ok:
                        continue
                        
                    schedule[t_name] = s
                    search(idx + 1, schedule, cost + airmass_costs[t_name][s])
                    del schedule[t_name]
                
                # If target is new, we can skip it (with a large penalty)
                if t_name in new_active_names:
                    search(idx + 1, schedule, cost + 100000.0)
                    
            initial_schedule = {k: v for k, v in current_schedule.items() if k in manually_scheduled}
            search(0, initial_schedule, 0.0)
            
            if best_schedule is not None:
                current_schedule = best_schedule
                previously_scheduled = set(current_schedule.keys())
                for t in new_active:
                    if t.name not in current_schedule:
                        conflicts.append(t.name)
            else:
                for t in new_active:
                    conflicts.append(t.name)
                        
        scheduled_blocks: List[ObservationBlock] = []
        for t_name, start_idx in current_schedule.items():
            target = next(t for t in targets if t.name == t_name)
            dur_chunks = target_exposures_dict[t_name]["duration_minutes"]
            airmasses = []
            for c_idx in range(start_idx, start_idx + dur_chunks):
                airmasses.append(self.get_airmass_for_target(target, self.chunk_times[c_idx]))
            airmass_start = airmasses[0]
            airmass_end = airmasses[-1]
            airmasses.sort()
            mid = len(airmasses) // 2
            airmass_median = airmasses[mid] if len(airmasses) % 2 != 0 else (airmasses[mid-1] + airmasses[mid]) / 2.0
            
            exp_info = target_exposures_dict[t_name]
            comment_prefix = f"Slew: 7m. Blue: {exp_info['blue_num']}x{exp_info['blue_exp']:.0f}s, Red: {exp_info['red_num']}x{exp_info['red_exp']:.0f}s."
            block_comment = f"{comment_prefix} {target.comment}" if target.comment else comment_prefix
            block = ObservationBlock(
                target=target,
                start_time=self.chunk_times[start_idx],
                duration_minutes=dur_chunks,
                airmass_start=airmass_start,
                airmass_end=airmass_end,
                airmass_median=airmass_median,
                priority=target.priority,
                comment=block_comment
            )
            scheduled_blocks.append(block)
            
        return {
            'blocks': scheduled_blocks,
            'conflicts': conflicts,
            'unobservable': unobservable_targets
        }


