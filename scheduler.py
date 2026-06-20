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
    import astropy.units as u
    from astropy.time import Time
    from astropy.coordinates import EarthLocation, SkyCoord, get_moon, AltAz
    from astroplan import Observer, FixedTarget
    HAS_ASTRO_LIBS = True
except ImportError:
    HAS_ASTRO_LIBS = False


import re

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
        return val_float / 15.0 if is_ra else val_float

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
        return val_float / 15.0 if is_ra else val_float
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
                 schedule_before: Optional[List[str]] = None):
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
        
    def calculate_exposure_time(self, moon_phase: float, moon_separation: float) -> float:
        """
        Calculate target exposure time in seconds, accounting for moon illumination
        fraction and angular separation.
        """
        # Base exposure time at magnitude 15 under dark skies
        base_exp = 100.0 * (2.512 ** (self.magnitude - 15.0))
        
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
                 airmass_start: float, airmass_end: float, airmass_median: float):
        self.target = target
        self.start_time = start_time
        self.duration_minutes = duration_minutes
        self.airmass_start = airmass_start
        self.airmass_end = airmass_end
        self.airmass_median = airmass_median
        
    @property
    def end_time(self) -> datetime.datetime:
        return self.start_time + datetime.timedelta(minutes=self.duration_minutes)

    def to_dict(self) -> Dict[str, Any]:
        return {
            'target_name': self.target.name,
            'start_time': self.start_time.isoformat(),
            'end_time': self.end_time.isoformat(),
            'duration_minutes': self.duration_minutes,
            'airmass_start': round(self.airmass_start, 3),
            'airmass_end': round(self.airmass_end, 3),
            'airmass_median': round(self.airmass_median, 3),
            'priority': self.target.priority,
            'comment': self.target.comment
        }


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
        
        # Discretize night into 5-minute chunks from sunset to sunrise
        self.start_night = self.solar_times['sunset']
        self.end_night = self.solar_times['sunrise']
        total_seconds = (self.end_night - self.start_night).total_seconds()
        self.num_chunks = int(total_seconds // 300)
        
        self.chunk_times = [
            self.start_night + datetime.timedelta(minutes=5 * i)
            for i in range(self.num_chunks)
        ]
        
    def get_airmass_for_target(self, target: Target, dt_utc: datetime.datetime) -> float:
        """Compute target airmass at dt_utc."""
        if HAS_ASTRO_LIBS:
            try:
                loc = EarthLocation(lat=self.observatory.latitude*u.deg, lon=self.observatory.longitude*u.deg, height=self.observatory.elevation*u.m)
                obs = Observer(location=loc)
                t = Time(dt_utc)
                ft = FixedTarget(coord=SkyCoord(ra=target.ra*u.hourangle, dec=target.dec*u.deg), name=target.name)
                altaz = obs.altaz(t, ft)
                alt = altaz.alt.degree
                if alt <= 0:
                    return 999.0
                return altaz.secz.value
            except Exception:
                pass
        alt, _ = get_alt_az(dt_utc, self.observatory.latitude, self.observatory.longitude, target.ra, target.dec)
        return get_airmass(alt)

    def is_chunk_valid(self, target: Target, chunk_idx: int) -> bool:
        """Check if a target can be observed in a given chunk."""
        t = self.chunk_times[chunk_idx]
        
        # 1. Twilight check
        # Standard: 18-degree twilight limit
        t_eve_18 = self.solar_times['twilight_evening_18']
        t_morn_18 = self.solar_times['twilight_morning_18']
        
        if not target.allow_twilight:
            # Must be strictly within 18-deg twilight
            if not (t_eve_18 <= t <= t_morn_18):
                return False
        else:
            # Allowed as early as 30 minutes after sunset, up to 30 minutes before sunrise
            limit_start = self.solar_times['sunset'] + datetime.timedelta(minutes=30)
            limit_end = self.solar_times['sunrise'] - datetime.timedelta(minutes=30)
            if not (limit_start <= t <= limit_end):
                return False
                
        # 2. Telescope pointing limits (Dec, Hour Angle)
        if not self.telescope.is_visible(target.ra, target.dec, t, self.observatory):
            return False
            
        # 3. Airmass limit
        airmass = self.get_airmass_for_target(target, t)
        airmass_limit = 2.2 if target.high_airmass else 1.7
        if airmass <= 0 or airmass > airmass_limit:
            return False
            
        # 4. Real-time Pointing Limits (HA, Altitude)
        rt = getattr(self, 'realtime_constraints', {})
        ha_limit = rt.get('ha_limit')
        if ha_limit is not None:
            lst = get_lst(t, self.observatory.longitude)
            ha = get_hour_angle(lst, target.ra)
            if abs(ha) > ha_limit:
                return False
                
        alt_limit = rt.get('alt_limit')
        if alt_limit is not None and alt_limit != "":
            try:
                alt_limit_val = float(alt_limit)
                if airmass > 0:
                    alt = math.degrees(math.asin(1.0 / airmass))
                else:
                    alt = 0.0
                if alt < alt_limit_val:
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

    def solve(self, targets: List[Target], disabled_standards: Optional[Set[str]] = None, realtime_constraints: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Main entry point for scheduling. Schedules standard stars first, then science targets.
        """
        self.realtime_constraints = realtime_constraints or {}
        
        # 1. Run preliminary solve to see what gets scheduled and if we need high-airmass calibrations
        prelim_solve = self._solve_internal(targets, reserved_chunks=set())
        scheduled_science = prelim_solve['blocks']
        
        need_high_airmass = False
        for b in scheduled_science:
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
                
        # Determine evening slots (restricted to at least 30 minutes after sunset, chunk index 6)
        eve_slot_1 = 6
        eve_slot_2 = 7
        # Check bright science target exception
        # Telescope brightness threshold: Lick is 15.5, Keck is 17.5
        bright_threshold = 17.5 if "Keck" in self.telescope.name else 15.5
        
        science_start_block = next((b for b in scheduled_science if b.start_time == self.chunk_times[0]), None)
        if science_start_block and science_start_block.target.magnitude < bright_threshold:
            # Shift evening slots
            eve_slot_1 = max(6, int(science_start_block.duration_minutes // 5))
            eve_slot_2 = eve_slot_1 + 1
            
        # Determine morning slots (restricted to at least 30 minutes before sunrise, chunk index self.num_chunks - 7)
        morn_slot_2 = self.num_chunks - 7
        morn_slot_1 = morn_slot_2 - 1
        science_end_block = next((b for b in scheduled_science if b.end_time == self.chunk_times[-1]), None)
        if science_end_block and science_end_block.target.magnitude < bright_threshold:
            morn_slot_2 = min(self.num_chunks - 7, self.num_chunks - 1 - int(science_end_block.duration_minutes // 5))
            morn_slot_1 = morn_slot_2 - 1
            
        # 3. Load standard stars
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
            
        if disabled_standards:
            standards_data = [s for s in standards_data if s['name'] not in disabled_standards]
            
        # Parse standard stars into Target objects
        standards = []
        for s_data in standards_data:
            standards.append({
                'target': Target(
                    name=s_data['name'],
                    ra=s_data['ra'],
                    dec=s_data['dec'],
                    magnitude=s_data.get('magnitude', 10.0),
                    priority=0.0,
                    allow_twilight=True
                ),
                'color': s_data['color'],
                'quality': s_data['quality'],
                'exposure_times': s_data.get('exposure_times', {})
            })
            
        # 4. Search for the best standard star selection
        blue_standards = [s for s in standards if s['color'] == 'blue']
        red_standards = [s for s in standards if s['color'] == 'red']
        
        best_selection = None
        best_score = -1.0
        
        # We need S_eb (Evening Blue), S_er (Evening Red)
        # S_mb (Morning Blue), S_mr (Morning Red)
        for s_eb in blue_standards:
            # Check evening slot 1 validity
            t_eb = s_eb['target']
            if not self.telescope.is_visible(t_eb.ra, t_eb.dec, self.chunk_times[eve_slot_1], self.observatory):
                continue
            airmass_eb = self.get_airmass_for_target(t_eb, self.chunk_times[eve_slot_1])
            if airmass_eb > 2.2 or airmass_eb <= 0:
                continue
                
            for s_er in red_standards:
                # Check evening slot 2 validity
                t_er = s_er['target']
                if not self.telescope.is_visible(t_er.ra, t_er.dec, self.chunk_times[eve_slot_2], self.observatory):
                    continue
                airmass_er = self.get_airmass_for_target(t_er, self.chunk_times[eve_slot_2])
                if airmass_er > 2.2 or airmass_er <= 0:
                    continue
                    
                # Now try morning candidates (allowing empty morning pair if not visible)
                # Loop through morning blue/red
                morn_options = [(None, None, 0.0, 999.0, 999.0)] # (s_mb, s_mr, score_add, airmass_mb, airmass_mr)
                for s_mb in blue_standards:
                    t_mb = s_mb['target']
                    if not self.telescope.is_visible(t_mb.ra, t_mb.dec, self.chunk_times[morn_slot_1], self.observatory):
                        continue
                    airmass_mb = self.get_airmass_for_target(t_mb, self.chunk_times[morn_slot_1])
                    if airmass_mb > 2.2 or airmass_mb <= 0:
                        continue
                        
                    for s_mr in red_standards:
                        t_mr = s_mr['target']
                        if not self.telescope.is_visible(t_mr.ra, t_mr.dec, self.chunk_times[morn_slot_2], self.observatory):
                            continue
                        airmass_mr = self.get_airmass_for_target(t_mr, self.chunk_times[morn_slot_2])
                        if airmass_mr > 2.2 or airmass_mr <= 0:
                            continue
                            
                        # Found valid morning pair
                        score_add = 50.0
                        if s_mb['quality'] == 'good': score_add += 10.0
                        if s_mr['quality'] == 'good': score_add += 10.0
                        morn_options.append((s_mb, s_mr, score_add, airmass_mb, airmass_mr))
                        
                for s_mb, s_mr, morn_score, airmass_mb, airmass_mr in morn_options:
                    # Calculate total score
                    score = 100.0 + morn_score
                    if s_eb['quality'] == 'good': score += 10.0
                    if s_er['quality'] == 'good': score += 10.0
                    
                    # Airmass match scoring
                    if need_high_airmass:
                        # Blue pair {s_eb, s_mb}
                        if s_mb is not None:
                            b_low = (airmass_eb < 1.3 or airmass_mb < 1.3)
                            b_high = (1.5 <= airmass_eb <= 2.2 or 1.5 <= airmass_mb <= 2.2)
                            if b_low and b_high:
                                score += 40.0
                            else:
                                score += 10.0
                        else:
                            if airmass_eb < 1.3: score += 10.0
                            
                        # Red pair {s_er, s_mr}
                        if s_mr is not None:
                            r_low = (airmass_er < 1.3 or airmass_mr < 1.3)
                            r_high = (1.5 <= airmass_er <= 2.2 or 1.5 <= airmass_mr <= 2.2)
                            if r_low and r_high:
                                score += 40.0
                            else:
                                score += 10.0
                        else:
                            if airmass_er < 1.3: score += 10.0
                    else:
                        if airmass_eb < 1.3: score += 10.0
                        if airmass_er < 1.3: score += 10.0
                        if s_mb is not None and airmass_mb < 1.3: score += 10.0
                        if s_mr is not None and airmass_mr < 1.3: score += 10.0
                        
                    if score > best_score:
                        best_score = score
                        best_selection = (s_eb, s_er, s_mb, s_mr, eve_slot_1, eve_slot_2, morn_slot_1, morn_slot_2)
                        
        # 5. Lock standard slots and add standard blocks
        reserved_chunks = set()
        standard_blocks = []
        
        if best_selection is not None:
            s_eb, s_er, s_mb, s_mr, es1, es2, ms1, ms2 = best_selection
            
            def add_standard_block(star_dict, chunk_idx):
                target = star_dict['target']
                t_name_tel = self.telescope.name
                exp_seconds = star_dict['exposure_times'].get(t_name_tel, 300)
                dur_chunks = int(math.ceil(exp_seconds / 300.0))
                
                reserved_chunks.update(range(chunk_idx, chunk_idx + dur_chunks))
                
                airmass = self.get_airmass_for_target(target, self.chunk_times[chunk_idx])
                
                block = ObservationBlock(
                    target=target,
                    start_time=self.chunk_times[chunk_idx],
                    duration_minutes=dur_chunks * 5,
                    airmass_start=airmass,
                    airmass_end=airmass,
                    airmass_median=airmass
                )
                block.target.comment = f"Calib: {star_dict['color'].capitalize()} / {star_dict['quality'].capitalize()}, Airmass {airmass:.2f}"
                block.target.priority = 0.0
                standard_blocks.append(block)
                
            add_standard_block(s_eb, es1)
            add_standard_block(s_er, es2)
            if s_mb is not None:
                add_standard_block(s_mb, ms1)
            if s_mr is not None:
                add_standard_block(s_mr, ms2)
                
        # 6. Run final solver pass with the reserved standard chunks
        final_solve = self._solve_internal(targets, reserved_chunks)
        
        # Merge scheduled blocks
        scheduled_blocks = final_solve['blocks'] + standard_blocks
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
                curve.append({
                    'time': dt.isoformat(),
                    'airmass': round(self.get_airmass_for_target(t, dt), 3)
                })
            airmass_plots[t.name] = curve
            
        # Also plot the scheduled standard stars
        for block in standard_blocks:
            curve = []
            for c_idx in range(self.num_chunks):
                dt = self.chunk_times[c_idx]
                curve.append({
                    'time': dt.isoformat(),
                    'airmass': round(self.get_airmass_for_target(block.target, dt), 3)
                })
            airmass_plots[block.target.name] = curve
            
        # Generate Moon airmass and altitude curve
        moon_plot = []
        for c_idx in range(self.num_chunks):
            dt = self.chunk_times[c_idx]
            if HAS_ASTRO_LIBS:
                try:
                    loc = EarthLocation(lat=self.observatory.latitude*u.deg, lon=self.observatory.longitude*u.deg, height=self.observatory.elevation*u.m)
                    t = Time(dt)
                    moon_coord = get_moon(t, location=loc)
                    obs = Observer(location=loc)
                    altaz = obs.altaz(t, moon_coord)
                    alt = altaz.alt.degree
                    airmass = altaz.secz.value if alt > 0 else 999.0
                except Exception:
                    d = datetime_to_d(dt)
                    m_ra, m_dec, _ = get_moon_position(d)
                    alt, _ = get_alt_az(dt, self.observatory.latitude, self.observatory.longitude, m_ra, m_dec)
                    airmass = get_airmass(alt)
            else:
                d = datetime_to_d(dt)
                m_ra, m_dec, _ = get_moon_position(d)
                alt, _ = get_alt_az(dt, self.observatory.latitude, self.observatory.longitude, m_ra, m_dec)
                airmass = get_airmass(alt)
                
            moon_plot.append({
                'time': dt.isoformat(),
                'airmass': round(airmass, 3) if (alt > 0 and airmass < 10.0) else 999.0,
                'alt': round(alt, 3)
            })
            
        return {
            'blocks': [b.to_dict() for b in scheduled_blocks],
            'conflicts': final_solve['conflicts'],
            'unobservable': final_solve['unobservable'],
            'empty_blocks': empty_blocks,
            'moon_info': self.moon,
            'moon_plot': moon_plot,
            'airmass_plots': airmass_plots,
            'solar_times': {k: v.isoformat() for k, v in self.solar_times.items()}
        }

    def _solve_internal(self, targets: List[Target], reserved_chunks: Set[int]) -> Dict[str, Any]:
        """
        Schedules science targets using a priority-sequential Branch and Bound algorithm.
        Enforces precedence constraints (schedule_before) and manual schedule adjustments.
        Ignores chunks in reserved_chunks.
        """
        # Parse exposures and durations
        target_exposures: Dict[str, float] = {}
        for t in targets:
            if t.manual_duration is not None:
                target_exposures[t.name] = t.manual_duration * 60.0
            else:
                sep = get_separation(t.ra, t.dec, self.moon['ra'], self.moon['dec'])
                target_exposures[t.name] = t.calculate_exposure_time(self.moon['phase'], sep)
                
        # Parse manual start chunk indices
        manual_start_chunks: Dict[str, Optional[int]] = {}
        for t in targets:
            manual_start_chunks[t.name] = self.get_chunk_idx_from_time_str(t.manual_start_time)
            
        # Filter impossible targets
        unobservable_targets: List[str] = []
        observable_targets: List[Target] = []
        
        for t in targets:
            # Check if has any valid chunk
            has_any_valid_chunk = False
            manual_chunk = manual_start_chunks[t.name]
            if manual_chunk is not None:
                if manual_chunk not in reserved_chunks and self.is_chunk_valid(t, manual_chunk):
                    has_any_valid_chunk = True
            else:
                for c_idx in range(self.num_chunks):
                    if c_idx not in reserved_chunks and self.is_chunk_valid(t, c_idx):
                        has_any_valid_chunk = True
                        break
            if not has_any_valid_chunk:
                unobservable_targets.append(t.name)
            else:
                observable_targets.append(t)
                
        # Partition observable targets by priority
        obs_targets_by_prio: Dict[float, List[Target]] = {}
        for t in observable_targets:
            obs_targets_by_prio.setdefault(t.priority, []).append(t)
            
        sorted_priorities = sorted(obs_targets_by_prio.keys())
        current_schedule: Dict[str, int] = {}
        conflicts: List[str] = []
        
        for prio in sorted_priorities:
            prio_targets = obs_targets_by_prio.get(prio, [])
            if not prio_targets:
                continue
                
            targets_to_schedule = []
            for p in sorted_priorities:
                if p <= prio:
                    targets_to_schedule.extend(obs_targets_by_prio.get(p, []))
                    
            durations: Dict[str, int] = {}
            valid_slots: Dict[str, List[int]] = {}
            airmass_costs: Dict[str, Dict[int, float]] = {}
            
            for t in targets_to_schedule:
                dur_chunks = int(math.ceil(target_exposures[t.name] / 300.0))
                durations[t.name] = dur_chunks
                
                manual_chunk = manual_start_chunks[t.name]
                if manual_chunk is not None:
                    # Enforce locked manual start time
                    block_valid = True
                    airmasses = []
                    for c_idx in range(manual_chunk, manual_chunk + dur_chunks):
                        if c_idx >= self.num_chunks or c_idx in reserved_chunks or not self.is_chunk_valid(t, c_idx):
                            block_valid = False
                            break
                        airmasses.append(self.get_airmass_for_target(t, self.chunk_times[c_idx]))
                    if block_valid:
                        valid_slots[t.name] = [manual_chunk]
                        airmasses.sort()
                        mid = len(airmasses) // 2
                        median_airmass = airmasses[mid] if len(airmasses) % 2 != 0 else (airmasses[mid-1] + airmasses[mid]) / 2.0
                        airmass_costs[t.name] = {manual_chunk: median_airmass}
                    else:
                        valid_slots[t.name] = []
                        airmass_costs[t.name] = {}
                else:
                    slots = []
                    costs = {}
                    for s_idx in range(self.num_chunks - dur_chunks + 1):
                        block_valid = True
                        airmasses = []
                        for c_idx in range(s_idx, s_idx + dur_chunks):
                            if c_idx in reserved_chunks or not self.is_chunk_valid(t, c_idx):
                                block_valid = False
                                break
                            airmasses.append(self.get_airmass_for_target(t, self.chunk_times[c_idx]))
                        if block_valid:
                            slots.append(s_idx)
                            airmasses.sort()
                            mid = len(airmasses) // 2
                            median_airmass = airmasses[mid] if len(airmasses) % 2 != 0 else (airmasses[mid-1] + airmasses[mid]) / 2.0
                            costs[s_idx] = median_airmass
                    valid_slots[t.name] = slots
                    airmass_costs[t.name] = costs
                    
            # Search
            targets_sorted_for_solve = sorted(
                targets_to_schedule,
                key=lambda x: (x.priority, -durations[x.name])
            )
            
            best_schedule: Optional[Dict[str, int]] = None
            best_cost = float('inf')
            
            def check_overlap(s1: int, d1: int, s2: int, d2: int) -> bool:
                return not (s1 + d1 <= s2 or s2 + d2 <= s1)
                
            def search(idx: int, schedule: Dict[str, int], cost: float):
                nonlocal best_schedule, best_cost
                
                if idx == len(targets_sorted_for_solve):
                    if cost < best_cost:
                        best_cost = cost
                        best_schedule = schedule.copy()
                    return
                    
                target = targets_sorted_for_solve[idx]
                t_name = target.name
                t_dur = durations[t_name]
                
                # Check branch cost bound
                remaining_lb = 0.0
                for r_idx in range(idx, len(targets_sorted_for_solve)):
                    r_target = targets_sorted_for_solve[r_idx]
                    r_costs = airmass_costs[r_target.name].values()
                    if r_costs:
                        remaining_lb += min(r_costs)
                if cost + remaining_lb >= best_cost:
                    return
                    
                slots = valid_slots[t_name]
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
                        # If target must be before p_name
                        if p_name in target.schedule_before:
                            if not (s + t_dur <= p_start):
                                precedence_ok = False
                                break
                        # If p_name must be before target
                        p_obj = next(tg for tg in targets_sorted_for_solve if tg.name == p_name)
                        if t_name in p_obj.schedule_before:
                            if not (p_start + p_dur <= s):
                                precedence_ok = False
                                break
                                
                    if not precedence_ok:
                        continue
                        
                    schedule[t_name] = s
                    search(idx + 1, schedule, cost + airmass_costs[t_name][s])
                    del schedule[t_name]
                    
            search(0, {}, 0.0)
            
            if best_schedule is not None:
                current_schedule = best_schedule
            else:
                for t in prio_targets:
                    t_dur = durations[t.name]
                    fit_found = False
                    for s in valid_slots[t.name]:
                        overlap = False
                        for p_name, p_start in current_schedule.items():
                            if check_overlap(s, t_dur, p_start, durations[p_name]):
                                overlap = True
                                break
                        if not overlap:
                            precedence_ok = True
                            for p_name, p_start in current_schedule.items():
                                p_dur = durations[p_name]
                                if p_name in t.schedule_before:
                                    if not (s + t_dur <= p_start):
                                        precedence_ok = False
                                        break
                                p_obj = next(tg for tg in targets_sorted_for_solve if tg.name == p_name)
                                if t.name in p_obj.schedule_before:
                                    if not (p_start + p_dur <= s):
                                        precedence_ok = False
                                        break
                            if precedence_ok:
                                fit_found = True
                                current_schedule[t.name] = s
                                break
                    if not fit_found:
                        conflicts.append(t.name)
                        
        scheduled_blocks: List[ObservationBlock] = []
        for t_name, start_idx in current_schedule.items():
            target = next(t for t in targets if t.name == t_name)
            dur_chunks = int(math.ceil(target_exposures[t_name] / 300.0))
            airmasses = []
            for c_idx in range(start_idx, start_idx + dur_chunks):
                airmasses.append(self.get_airmass_for_target(target, self.chunk_times[c_idx]))
            airmass_start = airmasses[0]
            airmass_end = airmasses[-1]
            airmasses.sort()
            mid = len(airmasses) // 2
            airmass_median = airmasses[mid] if len(airmasses) % 2 != 0 else (airmasses[mid-1] + airmasses[mid]) / 2.0
            
            block = ObservationBlock(
                target=target,
                start_time=self.chunk_times[start_idx],
                duration_minutes=dur_chunks * 5,
                airmass_start=airmass_start,
                airmass_end=airmass_end,
                airmass_median=airmass_median
            )
            scheduled_blocks.append(block)
            
        return {
            'blocks': scheduled_blocks,
            'conflicts': conflicts,
            'unobservable': unobservable_targets
        }

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
                # Find closest chunk by UTC hour/minute matching
                for idx, c_time in enumerate(self.chunk_times):
                    if c_time.hour == hh and abs(c_time.minute - mm) < 5:
                        return idx
                return None
            except Exception:
                return None
        
        best_idx = None
        min_diff = float('inf')
        for idx, c_time in enumerate(self.chunk_times):
            diff = abs((c_time - dt).total_seconds())
            if diff < min_diff:
                min_diff = diff
                best_idx = idx
        if min_diff < 300:
            return best_idx
        return None
