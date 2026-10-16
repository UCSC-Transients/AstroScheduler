# Changelog

Versions follow [semantic versioning](https://semver.org). Each release is a git tag
(`v1.0.0`, ...) that other apps can pin, for example
`astroscheduler @ git+https://github.com/UCSC-Transients/AstroScheduler@v1.0.0`.

## 1.2.0 (2026-10)

- **Re-opened plans:** `initial.previous_schedule` in `window.ASTROSCHEDULER_CONFIG` is sent
  with the first solve, so a host re-opening a saved plan gets a stable re-solve. Later solves
  use the blocks on screen (#106).
- **Fix:** Recalculate never sent the blocks on screen as `previous_schedule`. The page compared
  the site with `result.observatory`, which solve results don't carry, so every re-solve started
  from scratch. It now compares the site and night of the last request.

## 1.1.0 (2026-10)

- **Host page renderer:** `astroscheduler.frontend.render_page(static_url, config)` returns
  the planner page with its assets under any URL and the config injected safely;
  `frontend.STATIC_DIR` is the package's static files. The standalone server uses the same
  renderer, and no longer serves package files outside `/static/` (#103).
- **Embedded chrome:** embedded mode hides the app title, the telescope badge, "Load Samples"
  and the import button; the Planning / Real-Time buttons stay (#103).
- **Chart.js** is pinned to 4.5.1 with a subresource-integrity hash (#103).
- **Import from YSE_PZ** (standalone): the "Import from YSE_PZ" panel lists your classical
  nights and imports one night's targets, site, instrument and date, through two server proxy
  endpoints (`POST /api/yse_pz/nights`, `POST /api/yse_pz/import`). The YSE_PZ address comes
  from `ASTROSCHEDULER_YSE_PZ_URL`, never from the request. The API token is never stored or
  logged (#104).
- **Links:** target names link to their page when the target has a `url`, for example YSE_PZ's
  transient page (#83).

## 1.0.1 (2026-10)

- Importing `astroscheduler` no longer changes astropy's process-wide IERS settings. The
  offline options (no downloads, degraded accuracy accepted) now apply only inside each solve
  (`fast_astrometry`), and options the installed astropy lacks are skipped. On astropy 5.0 the
  old import left a stray `iers_degraded_accuracy` attribute that broke a host app's own
  `iers.conf.set_temp` calls (seen in YSE_PZ). The standalone app still sets them globally (#101).

## 1.0.0 (2026-10)

First tagged release: AstroScheduler as an installable library that also runs standalone.

- **Package:** `astroscheduler` installs on Python 3.8+ (astropy ≥5.0, astroplan ≥0.8,
  numpy ≥1.22, pytz). The web app is the `server` extra. `python app.py` works as before (#91).
- **Precision:** the precise astropy path runs again on astropy 5.0 through 7. Twilights, moon
  and airmass previously fell back silently to low-precision formulas, so schedules can shift by
  a few minutes. Solves stay fast (#90).
- **Library API:** `astroscheduler.api.solve(SolveRequest) -> SolveResult`, with optional
  per-target `external_id`, block `kind`, and `solver_version`/`schema_version` (#92).
- **Sites and limits:** `telescopes.json` holds site coordinates and telescope limits; callers
  can override any limit per solve or define a new site. Airmass limits can be overridden (#88).
- **Exposure plan:** blocks carry structured `exposures`, `overhead` and `exposure_source`;
  targets accept `overhead_minutes` (#89).
- **One solver:** the client-side JavaScript solver is removed; a failed solve shows an error
  and keeps the schedule (#93).
- **Real-time actions:** Start, Completed, Failed and Punted work and fill the observing log;
  Failed and Punted need a reason (#94).
- **Embedding:** `window.ASTROSCHEDULER_CONFIG` and `window.AstroScheduler.hooks` let a host
  app (YSE_PZ) run the planner inside its own pages (#95).
