# Pull Request: Timeline, Schedule Table, and Chart Alignment Fixes

This Pull Request addresses regressions with timeline table headers alignment, manual start time editing, table layout hover bouncing, and chart zoom/tick synchronization.

## Resolved Regressions

- [x] **Timeline Start Time Editing**: Fix `parseTimeInputToISO` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js). Parse candidates anchored to midpoint of scheduled night. Prevents timezone/date boundary 24-hour shift mismatch.
- [x] **Table Layout Bouncing**: Added `border-left: 3px solid transparent;` to `.data-table tr` in [static/style.css](file:///Users/rfoley/scheduler/static/style.css). Keeps spacing static when hover border-left color updates.
- [x] **Timeline Table Alignment (Off-by-one)**: Added empty `<th>` to `#schedule-table` `thead` in [templates/index.html](file:///Users/rfoley/scheduler/templates/index.html) to align with lock column. Adjusted colspan of empty row.
- [x] **Lock Icon**: Verified lock button is open (`🔓`) or closed (`🔒`) based on `isLocked` state in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) (Issue #47).
- [x] **Airmass Chart Ticks**: Restored ticks to exactly `XX:00` UT on airmass plot by rounding sunset/sunrise boundaries to the nearest whole UTC hour before/after. Ticks now land exactly on whole hours (`XX:00` UT) and LST matches them.
- [x] **Airmass Chart Zoom & Reset**: Reset `originalXMin` / `originalXMax` on chart recreation, and reset Y-axis scale to dynamic defaults in `resetChartZoom` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js).

---

## Created GitHub Issues
- **Issue #57**: Plot: Add grey region on Alt/Az plot corresponding to restricted pointing region
- **Issue #58**: Plot: Differentiate observable and unobservable parts of airmass tracks using dashed/dotted lines
- **Issue #59**: UI: Clean up airmass plot tooltip and series styling
- **Issue #60**: Plot: Improve timeline x-axis ticks and vertical grid lines alignment
- **Issue #61**: UI: Avoid schedule refit on timezone change and adjust night start/end limits
- **Issue #62**: Plot: Improve airmass plot zooming robustness and zoom/reset constraints
