# UCSC AstroScheduler

UCSC AstroScheduler is a modern, real-time observation scheduling and planning dashboard designed specifically for the **Lick Shane 3m Telescope**. It combines a high-performance Python constraint solver backend with a rich, glassmorphic web dashboard frontend, providing observers with interactive sky visualizations, real-time target status tracking, and automated calibration star sequencing.

## Features

- **Dynamic Sky Map (Alt/Az Polar Plot)**: Live circular canvas rendering showing current target tracks across the sky (Zenith to Horizon) mapped with corresponding priority colors.
- **Double-Axis Airmass Chart**: Interactive airmass curves showing targets throughout the night, with a secondary top axis for **Local Sidereal Time (LST)** and dual **UT/Local** labels at the bottom.
- **Target Ingestion & Management**: Easily drag-and-drop or select target coordinate text files, with support for sexagesimal formats (`HH:MM:SS`, `DD:MM:SS`) and magnitude/priority float fields.
- **Standard Stars Calibration**: Automatically selects and schedules optimal blue and red standard stars (constrained to at least 30 minutes after sunset / before sunrise) to match the science target requirements.
- **Real-Time Observing Mode**: Reschedule blocks on the fly "starting from now" with active pointing checks, HA limits (East: -05:40, West: +03:45), and live electronic log comments.
- **One Solver**: the Python solver behind `POST /api/schedule` is the only solver. If a solve fails, the page shows the error and keeps the current schedule.
- **Real-Time Observing Log**: Start, Completed, Failed and Punted actions record what happened (Failed and Punted take one or more reasons), and finished targets are skipped on the next re-solve.

## Repository Layout

```
├── astroscheduler/       # The installable package
│   ├── core.py           # Observation scheduling constraint solver (no web dependencies)
│   ├── server.py         # Web server application (FastAPI & HTTP server fallback)
│   ├── static/
│   │   ├── app.js        # Frontend application logic (embeddable; see below)
│   │   ├── style.css     # Glassmorphism dark-mode responsive layout styling
│   │   └── standards.json # Standard calibration stars database
│   └── templates/
│       └── index.html    # Main dashboard user interface
├── app.py                # `python app.py` entry point (runs astroscheduler.server)
├── scheduler.py          # Compatibility alias for astroscheduler.core
├── tests/
│   └── test_scheduler.py # Backend solver unit tests
├── pyproject.toml        # Package metadata and dependencies
├── requirements.txt      # Development install (package + server + test tools)
└── .github/
    └── workflows/        # GitHub Actions continuous integration workflow
```

## Getting Started

### 1. Prerequisites

- Python 3.8+ for the solver library; the web app and browser tests are tested on 3.10 and 3.11
- Modern Web Browser (Chrome, Firefox, Safari)

### 2. Installation

Clone the repository and install the required dependencies:

```bash
git clone https://github.com/UCSC-Transients/AstroScheduler.git
cd AstroScheduler
pip install -r requirements.txt
```

`requirements.txt` installs the package in editable mode with the `server` and `test` extras.

To use only the solver as a library (for example from another web app), install the package
without extras. It needs only astropy, astroplan, numpy and pytz:

```bash
pip install "astroscheduler @ git+https://github.com/UCSC-Transients/AstroScheduler@<tag>"
```

Add the `server` extra (`astroscheduler[server]`) for the standalone web app.

### Using the solver as a library

```python
import datetime
from astroscheduler.api import SolveRequest, SiteSpec, TargetSpec, solve

result = solve(SolveRequest(
    date=datetime.date(2026, 10, 15),          # local evening date of the night
    site=SiteSpec(id="lick"),                   # or "keck1" / "keck2"; fields override
    targets=[TargetSpec(name="SN 2026abc", ra="01:02:03", dec="+20:00:00",
                        magnitude=17.5, priority=1, external_id="followup-123")],
))
for block in result.blocks:                     # kind is "science" or "standard"
    print(block.kind, block.target_name, block.start_time, block.external_id)
```

`external_id` is an opaque id of the caller's (for example a YSE_PZ follow-up id). It comes
back on every block, `result.external_ids` maps conflict and unobservable names to it, and
`previous_schedule` entries may match on it. `SolveRequest.from_dict` accepts the
`POST /api/schedule` JSON payload, and `SolveResult.to_dict()` is that endpoint's response.

Site and telescope limits (dec range, hour-angle limits, alt/az keep-out zones, guiding
ceiling, airmass limits, slew times) live in `astroscheduler/telescopes.json`. A caller can
override any of them for one solve, e.g. `SiteSpec(id="lick", telescope={"ha_limit_west": 5.6667})`,
or describe a new site with an unknown `id`, coordinates and a full `telescope` dict. The
airmass limits can also be set per solve with `realtime_constraints={"airmass_limit": 2.0}`.

Each block carries its exposure plan as data: `exposures` (`red`/`blue` exposure time and
count), `overhead` (slew + acquisition minutes, readout and erase seconds) and
`exposure_source` (`lookup`, `override`, `manual_duration` or `standard`). A target's
`overhead_minutes` replaces the default 7-minute slew + acquisition.

### Embedding the planner in another web app

The front end can run inside a host page (YSE_PZ does this):

1. Serve `astroscheduler.frontend.STATIC_DIR` from the host, for example through Django's
   `STATICFILES_DIRS`.
2. Return `astroscheduler.frontend.render_page(static_url, config)` from a view. It is the
   full planner page, with its assets under `static_url` and `config` injected safely as
   `window.ASTROSCHEDULER_CONFIG`. Show it in a same-origin frame: the planner's stylesheet
   resets global selectors (`body`, `.card`, `.btn`) that a host's own CSS also uses.
3. Provide a same-origin endpoint at `apiBase + "/api/schedule"` that accepts the
   `/api/schedule` payload, for example by calling `astroscheduler.api.solve_dict`.

The config looks like this:

```html
<script>
window.ASTROSCHEDULER_CONFIG = {
  mode: "embedded",                       // fixes site and night, hides auto-update
  apiBase: "/myapp/planner",              // POSTs go to apiBase + "/api/schedule"
  staticBase: "/static/astroscheduler",
  headers: {"X-CSRFToken": "..."},        // added to every POST
  site: {id: "lick", telescope: {ha_limit_west: 5.6667}},
  initial: {date: "2026-10-15", instrument: "kast",
            targets: [/* TargetSpec dicts with external_id */],
            result: null,                 // a saved SolveResult is shown without solving
            previous_schedule: []}        // re-opened plan: [{target_name, external_id, start_time}],
                                          // sent with the first solve so blocks keep their places
};
</script>
```

In embedded mode nothing is written to browser storage, and a full re-solve happens only
when the user presses Recalculate. The host can listen through `window.AstroScheduler.hooks`:
`onObservationEvent(event)` for Start/Completed/Failed/Punted (the event's `reasons` lists
the reason codes and `reason` is the first; return a rejected Promise to cancel the action) and `onScheduleResult(result, request)` after each solve.
`window.AstroScheduler.getResult()` and `getTargets()` read the current state, for example to
save a plan. With no config, the app behaves as the standalone app.

### Importing a night from YSE_PZ

In the standalone app, **Import from YSE_PZ** (next to the file upload) asks for your
YSE_PZ API token, lists the classical nights you can plan, and imports one: its date, site,
instrument and targets (each keeps its YSE_PZ follow-up id, and its name links to the
YSE_PZ page). The server makes the calls to YSE_PZ on the page's behalf, because a browser
page cannot call YSE_PZ directly. The token is used for those calls only; it is never
stored or logged.

The YSE_PZ address defaults to the production site; set `ASTROSCHEDULER_YSE_PZ_URL` (for
example `https://ziggy.ucolick.org/yse_experimental/`) to use another one. The planner
endpoints must be turned on in that YSE_PZ (`ASTROSCHEDULER_ENABLED`).

### Using AstroScheduler with YSE_PZ

AstroScheduler works on its own, and inside [YSE_PZ](https://github.com/Young-Supernova-Experiment/YSE_PZ)
with the same code. There are two modes:

- **Standalone:** run `python app.py`. **Import from YSE_PZ** (see above) brings in one
  classical night's targets with your API token. Plans live in your browser.
- **Embedded in YSE_PZ:** YSE_PZ installs this package, solves on its server with
  `astroscheduler.api.solve`, and shows this front end in a frame on its "Plan this night"
  page (`frontend.render_page` and `window.ASTROSCHEDULER_CONFIG`). YSE_PZ is then the system
  of record: it supplies the targets, and stores the saved plan versions and what happened at
  the telescope (through `window.AstroScheduler.hooks.onObservationEvent`). Its observer guide
  is `docs/astroscheduler.md` in the YSE_PZ repository.

Who owns what: solving, scheduling, standard stars, site limits and exposure models live here;
targets, plans, approvals, outcomes and exports live in YSE_PZ.

**Releases.** YSE_PZ pins a tagged release, never a branch:

```
astroscheduler @ https://github.com/UCSC-Transients/AstroScheduler/archive/refs/tags/vX.Y.Z.tar.gz
```

To release:
1. Bump `astroscheduler/__init__.py` (`__version__`, semver).
2. Add a `CHANGELOG.md` entry, and merge the PR.
3. Tag the merge commit on `main` and push the tag:

   ```bash
   git fetch origin
   git tag -a vX.Y.Z -m "AstroScheduler X.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

4. Then a YSE_PZ PR moves its pin to the new tag.

The package must keep working with YSE_PZ's dependencies: Python 3.8, astropy 5.0/5.2.2,
astroplan 0.8, numpy 1.22.4 and pytz 2018.3. CI's `py38-pins` job checks this.

### Performance

A solve takes a few seconds for a typical night. Measured on Python 3.8 with YSE_PZ's pins,
at Lick, with random synthetic targets, on one laptop:

| Targets | 10 | 20 | 40 | 60 | 100 |
| --- | --- | --- | --- | --- | --- |
| Solve, s | 3.2 | 3.6 | 7.2 | 13 | 23 |

About 1 s of that is the night's twilight calculation, which is cached for later solves of the
same night. `tests/test_performance.py` guards the 40-target case.

### 3. Running the Server

Start the web application server:

```bash
python app.py
```

The application will start on `http://127.0.0.1:8055` (set `PORT` to change it). If FastAPI/Uvicorn is not present, it automatically falls back to serving via Python's built-in `http.server`.

### 4. Running Tests

Run the automated Python backend unit tests:

```bash
PYTHONPATH=. pytest tests/test_scheduler.py tests/test_kast_exposures.py
```

`PYTHONPATH=. pytest` runs everything, including the Playwright browser tests
(`python -m playwright install chromium` first).

---

*Developed for Lick Observatory and the UCSC Transients Group.*
