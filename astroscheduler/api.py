"""
Typed library API for the AstroScheduler solver.

    from astroscheduler.api import SolveRequest, SiteSpec, TargetSpec, solve

    result = solve(SolveRequest(
        date=datetime.date(2026, 10, 15),
        site=SiteSpec(id="lick"),
        targets=[TargetSpec(name="SN 2026abc", ra="01:02:03", dec="+20:00:00",
                            magnitude=17.5, priority=1, external_id="followup-123")],
    ))
    for block in result.blocks:
        print(block.target_name, block.start_time, block.external_id)

``solve_dict`` is the JSON-in/JSON-out form used by the web app's ``POST /api/schedule``;
both go through the same code path. Only the standard library and ``astroscheduler.core``
are used, so the API needs no web framework.
"""

import datetime
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, List, Optional, Tuple

from . import __version__
from .core import Keck1Telescope, Keck2Telescope, Observatory, Scheduler, ShaneTelescope, Target, Telescope, load_sites

# Bumped when a field is removed or changes meaning; adding fields does not bump it.
SCHEMA_VERSION = 1

# Statuses that mean a target is finished for the night and must not be scheduled again.
DONE_STATUSES = ("Skipped", "Failed", "Punted", "Observed")

# Default sites (telescopes.json). 'telescope_class' is kept for callers of the old dict.
_TELESCOPE_CLASSES = {'lick': ShaneTelescope, 'keck1': Keck1Telescope, 'keck2': Keck2Telescope}
OBSERVATORIES: Dict[str, Dict[str, Any]] = {
    site_id: {**info, 'telescope_class': _TELESCOPE_CLASSES.get(site_id, Telescope)}
    for site_id, info in load_sites().items()
}


def _opt_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _opt_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_date(value: Any) -> datetime.date:
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if not value:
        raise ValueError("Missing 'date' parameter")
    return datetime.datetime.strptime(str(value), "%Y-%m-%d").date()


def _parse_iso(value: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass
class SiteSpec:
    """Where the night is observed. ``id`` picks a known site; other fields override it.

    ``telescope`` overrides the site's telescope limits field by field, for example
    ``{"ha_limit_west": 5.6667, "airmass_limit": 2.0}``. An unknown ``id`` with a full
    ``telescope`` dict (at least ``name``) and coordinates defines a new site.
    """

    id: str = 'lick'
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    elevation: Optional[float] = None
    timezone: Optional[str] = None
    telescope: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "SiteSpec":
        data = data or {}
        return cls(
            id=data.get('id') or 'lick',
            name=data.get('name'),
            latitude=_opt_float(data.get('latitude', data.get('lat'))),
            longitude=_opt_float(data.get('longitude', data.get('lon'))),
            elevation=_opt_float(data.get('elevation')),
            timezone=data.get('timezone'),
            telescope=data.get('telescope'),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    def resolve(self) -> Tuple[Observatory, Telescope]:
        sites = load_sites()
        custom = self.id not in sites and bool(self.telescope and self.telescope.get('name'))
        if custom:
            if None in (self.latitude, self.longitude, self.elevation):
                raise ValueError("A custom site needs latitude, longitude and elevation")
            info = {'name': self.name or self.id, 'lat': self.latitude, 'lon': self.longitude,
                    'elevation': self.elevation, 'timezone': self.timezone or 'UTC', 'telescope': {}}
        else:
            info = sites.get(self.id, sites['lick'])
        observatory = Observatory(
            self.name or info['name'],
            self.latitude if self.latitude is not None else float(info['lat']),
            self.longitude if self.longitude is not None else float(info['lon']),
            self.elevation if self.elevation is not None else float(info['elevation']),
            timezone=self.timezone or info['timezone'],
        )
        telescope = Telescope.from_spec({**info['telescope'], **(self.telescope or {})})
        return observatory, telescope


@dataclass
class TargetSpec:
    """One target to schedule. ``external_id`` is an opaque caller id echoed on the result."""

    name: str
    ra: Any
    dec: Any
    magnitude: float
    priority: float = 1.0
    allow_twilight: bool = False
    high_airmass: bool = False
    sn_mode: str = "normal"
    comment: str = ""
    manual_start_time: Optional[str] = None
    manual_duration: Optional[float] = None
    schedule_before: Optional[List[str]] = None
    status: Optional[str] = None
    red_exptime: Optional[float] = None
    red_num: Optional[int] = None
    blue_exptime: Optional[float] = None
    blue_num: Optional[int] = None
    external_id: Optional[str] = None
    # Slew + acquisition minutes; None uses the default (7).
    overhead_minutes: Optional[float] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TargetSpec":
        external_id = data.get('external_id')
        return cls(
            name=data.get('name'),
            ra=data.get('ra'),
            dec=data.get('dec'),
            magnitude=float(data.get('magnitude')),
            priority=float(data.get('priority', 1.0)),
            allow_twilight=bool(data.get('allow_twilight', False)),
            high_airmass=bool(data.get('high_airmass', False)),
            sn_mode=data.get('sn_mode', 'normal'),
            comment=data.get('comment', ''),
            manual_start_time=data.get('manual_start_time'),
            manual_duration=_opt_float(data.get('manual_duration')),
            schedule_before=data.get('schedule_before'),
            status=data.get('status'),
            red_exptime=_opt_float(data.get('red_exptime')),
            red_num=_opt_int(data.get('red_num')),
            blue_exptime=_opt_float(data.get('blue_exptime')),
            blue_num=_opt_int(data.get('blue_num')),
            external_id=None if external_id in (None, "") else str(external_id),
            overhead_minutes=_opt_float(data.get('overhead_minutes')),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_target(self) -> Target:
        return Target(**{f.name: getattr(self, f.name) for f in fields(self)})


@dataclass
class SolveRequest:
    """Everything one solve needs. ``from_dict`` accepts the ``/api/schedule`` JSON payload."""

    date: datetime.date
    site: SiteSpec = field(default_factory=SiteSpec)
    targets: List[TargetSpec] = field(default_factory=list)
    instrument: str = 'kast'
    disabled_standards: List[str] = field(default_factory=list)
    selected_standards: List[str] = field(default_factory=list)
    auto_standards: bool = True
    standards_overrides: Optional[Dict[str, Any]] = None
    realtime_constraints: Dict[str, Any] = field(default_factory=dict)
    night_start_override: Optional[str] = None
    night_end_override: Optional[str] = None
    previous_schedule: Optional[List[Dict[str, Any]]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SolveRequest":
        return cls(
            date=_parse_date(data.get('date')),
            site=SiteSpec.from_dict(data.get('observatory') or data.get('site')),
            targets=[TargetSpec.from_dict(t) for t in data.get('targets', [])],
            instrument=data.get('instrument', 'kast'),
            disabled_standards=list(data.get('disabled_standards', [])),
            selected_standards=list(data.get('selected_standards', [])),
            auto_standards=bool(data.get('auto_standards', True)),
            standards_overrides=data.get('standards_overrides'),
            realtime_constraints=data.get('realtime_constraints') or {},
            night_start_override=data.get('night_start_override'),
            night_end_override=data.get('night_end_override'),
            previous_schedule=data.get('previous_schedule'),
        )

    def to_dict(self) -> Dict[str, Any]:
        out = asdict(self)
        out['date'] = self.date.isoformat()
        out['observatory'] = self.site.to_dict()
        del out['site']
        return out


@dataclass
class Block:
    """One scheduled block. Times are ISO 8601 UTC strings."""

    target_name: str
    start_time: str
    end_time: str
    duration_minutes: int
    airmass_start: float
    airmass_end: float
    airmass_median: float
    priority: Optional[float] = None
    comment: str = ""
    external_id: Optional[str] = None
    kind: str = "science"
    # Structured plan: {"red": {"exptime": s, "num": n}, "blue": {...}}
    exposures: Optional[Dict[str, Dict[str, Any]]] = None
    # {"slew_acq_min", "red_readout_s", "blue_readout_s", "red_erase_s", "blue_erase_s"}
    overhead: Optional[Dict[str, float]] = None
    exposure_source: Optional[str] = None  # standard | override | manual_duration | lookup
    instrument: Optional[str] = None
    # Fields added by newer solver versions that this class does not name yet.
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Block":
        names = {f.name for f in fields(cls)} - {'extra'}
        known = {k: v for k, v in data.items() if k in names}
        return cls(**known, extra={k: v for k, v in data.items() if k not in names})

    def to_dict(self) -> Dict[str, Any]:
        out = {f.name: getattr(self, f.name) for f in fields(self) if f.name != 'extra'}
        out.update(self.extra)
        return out


@dataclass
class SolveResult:
    """The solver's answer. ``conflicts`` and ``unobservable`` are target names;
    ``external_ids`` maps names back to caller ids."""

    blocks: List[Block]
    conflicts: List[str] = field(default_factory=list)
    unobservable: List[str] = field(default_factory=list)
    empty_blocks: List[Dict[str, Any]] = field(default_factory=list)
    moon_info: Dict[str, Any] = field(default_factory=dict)
    moon_plot: List[Dict[str, Any]] = field(default_factory=list)
    airmass_plots: Dict[str, Any] = field(default_factory=dict)
    solar_times: Dict[str, str] = field(default_factory=dict)
    external_ids: Dict[str, str] = field(default_factory=dict)
    solver_version: str = __version__
    schema_version: int = SCHEMA_VERSION

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SolveResult":
        return cls(
            blocks=[Block.from_dict(b) for b in data.get('blocks', [])],
            conflicts=list(data.get('conflicts', [])),
            unobservable=list(data.get('unobservable', [])),
            empty_blocks=list(data.get('empty_blocks', [])),
            moon_info=dict(data.get('moon_info', {})),
            moon_plot=list(data.get('moon_plot', [])),
            airmass_plots=dict(data.get('airmass_plots', {})),
            solar_times=dict(data.get('solar_times', {})),
            external_ids=dict(data.get('external_ids', {})),
            solver_version=data.get('solver_version', __version__),
            schema_version=int(data.get('schema_version', SCHEMA_VERSION)),
        )

    def to_dict(self) -> Dict[str, Any]:
        out = {f.name: getattr(self, f.name) for f in fields(self)}
        out['blocks'] = [b.to_dict() for b in self.blocks]
        return out


def _apply_night_overrides(scheduler: Scheduler, start: Optional[str], end: Optional[str]) -> None:
    """Clamp the night to a caller-given window (e.g. a half night)."""
    if start:
        try:
            dt = _parse_iso(start)
            scheduler.start_night = dt
            scheduler.solar_times['sunset'] = dt
            if scheduler.solar_times['twilight_evening_18'] < dt:
                scheduler.solar_times['twilight_evening_18'] = dt
            if scheduler.solar_times['twilight_evening_12'] < dt:
                scheduler.solar_times['twilight_evening_12'] = dt
        except Exception:
            pass
    if end:
        try:
            dt = _parse_iso(end)
            scheduler.end_night = dt
            scheduler.solar_times['sunrise'] = dt
            if scheduler.solar_times['twilight_morning_18'] > dt:
                scheduler.solar_times['twilight_morning_18'] = dt
            if scheduler.solar_times['twilight_morning_12'] > dt:
                scheduler.solar_times['twilight_morning_12'] = dt
        except Exception:
            pass

    if start or end:
        # Floor to whole minute for clean block.start_time values
        scheduler.start_night = scheduler.start_night.replace(second=0, microsecond=0)
        scheduler.end_night = scheduler.end_night.replace(second=0, microsecond=0)
        total_seconds = (scheduler.end_night - scheduler.start_night).total_seconds()
        if total_seconds > 0:
            scheduler.num_chunks = int(total_seconds // 60)
            scheduler.chunk_times = [
                scheduler.start_night + datetime.timedelta(minutes=i)
                for i in range(scheduler.num_chunks)
            ]


def _schedulable_targets(request: SolveRequest) -> List[Target]:
    """Drop targets that are finished for the night or fainter than the magnitude limit."""
    rt = request.realtime_constraints or {}
    extinction = float(rt.get('extinction', 0.0) or 0.0)
    mag_limit = _opt_float(rt.get('mag_limit'))

    targets = []
    for spec in request.targets:
        # Compare raw magnitude + extinction against the limit
        if mag_limit is not None and (spec.magnitude + extinction) > mag_limit:
            continue
        if spec.status in DONE_STATUSES:
            continue
        targets.append(spec.to_target())
    return targets


def solve(request: SolveRequest) -> SolveResult:
    """Schedule one night. Raises ValueError for an invalid request."""
    observatory, telescope = request.site.resolve()
    targets = _schedulable_targets(request)

    scheduler = Scheduler(observatory, telescope, request.date)
    _apply_night_overrides(scheduler, request.night_start_override, request.night_end_override)

    raw = scheduler.solve(
        targets,
        instrument=request.instrument,
        disabled_standards=set(request.disabled_standards),
        selected_standards=request.selected_standards,
        auto_standards=request.auto_standards,
        realtime_constraints=request.realtime_constraints,
        standards_overrides=request.standards_overrides,
        previous_schedule=request.previous_schedule,
    )
    return SolveResult.from_dict(raw)


def solve_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """JSON-in/JSON-out form of ``solve``, used by ``POST /api/schedule``."""
    return solve(SolveRequest.from_dict(data)).to_dict()
