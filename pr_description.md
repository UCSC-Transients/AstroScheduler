# Pull Request: Timeline, Schedule Table, and Chart Alignment Fixes

This Pull Request addresses regressions with timeline table headers alignment, manual start time editing, table layout hover bouncing, and chart zoom/tick/pointing limits synchronization.

## Resolved Regressions and Features

- [x] **Timeline Start Time Editing & Display timezone desync**: Save/load `currentTimezone` in `localStorage`, and update UI on change timezone without calling backend. Renamed labels in index.html to Display Timezone and Night Limits Timezone. Format `t.manual_start_time` dynamically using display timezone when fallback is used.
- [x] **Store locked start/end times as ISO strings**: Prevent desync by storing raw UTC ISO strings directly in target object manual properties rather than formatting as HH:MM when locking.
- [x] **Timezone change schedule refit**: Avoid schedule refit on display timezone changes; just re-render UI.
- [x] **Alt/Az Restricted Pointing Region**: Draw grey ring/sector on polar map based on altitude and azimuth limits.
- [x] **Dashed/Dotted Airmass Tracks**: Calculate and return `observable` flag from backend and style airmass profiles using Chart.js segment styling (dashed when observable, dotted when not).
- [x] **Chart Crash Fix**: Safely retrieve dataset's data array via `ctx.chart.data.datasets[ctx.datasetIndex].data` in the segment border-dash callback to prevent Chart.js crashes.
- [x] **Airmass Tooltip Cleanup**: Filter out night profile series from tooltip and use point style horizontal line markers.
- [x] **Timeline Plot Tick & LST Alignment**: Pad timeline start/end to whole hours, draw vertical hourly grid lines, and render bottom UT/Local ticks and top LST ticks at whole hours. Ticks now show the active Display Timezone prominently as the primary label.
- [x] **Dynamic column header text**: Dynamically updates schedule table time column header text to "Time (UT)" or "Time (Local)" depending on selected display timezone.
- [x] **LST Vertical Offset**: Increased margin-bottom of `lstAxisEl` to `20px` to prevent vertical overlap with twilight/sunset/sunrise marker labels.
- [x] **Table Layout Bouncing**: Added `border-left: 3px solid transparent;` to `.data-table tr` in style.css.
- [x] **Timeline Table Alignment (Off-by-one)**: Added empty `<th>` to `#schedule-table` `thead` to align with lock column.
- [x] **Airmass Chart Zoom & Reset**: Reset `originalXMin` / `originalXMax` on chart recreation, and reset Y-axis scale to dynamic defaults in `resetChartZoom`.
- [x] **Manual Night Limits UTC Date Alignment**: Solvers automatically align manual boundary hours (`08:00 UT`, etc.) to the closest sunset/sunrise date rather than raw hour replacements, preventing out-of-bounds schedules.
- [x] **Twilight Constraints Clamping**: All astronomical and nautical twilights are constrained (clamped) to the manual night start/end boundaries, forcing the scheduler to respect manual limits for all science targets.
- [x] **Immediate Target Lock Feedback**: Flipped lock state icon (`🔒` / `🔓`) in DOM instantly to keep UI responsive before refit request completes.
- [x] **Target Locking No-Refit**: Toggling a target's lock state updates its constraint and icon instantly but skips the full rescheduling/refitting cycle to prevent shifting other scheduled targets. Changing a locked target's exposure time still triggers a full reschedule correctly.
- [x] **Fallback Solver Bounds Crash**: Fixed client-side fallback solver index crash when night end limit is short.
- [x] **Astropy Airmass Fallback**: Automatically falls back to analytical geometric airmass calculation if Astropy raises polar motion/IERS coordinate exceptions.
- [x] **Solver Greedy Pass and Priority 3 Disappearance Fix**: Added a fast greedy initialization pass to establish a cost upper bound and fallback schedule in both Python and local JS solvers. Prevents priority 3.0 targets from disappearing when search limits are reached.
- [x] **Solver Search Iterations Limit Reduction**: Reduced search iterations limits (Python to 20,000, JS to 10,000) to ensure immediate page loading and solver responsiveness.
- [x] **Fixed JS Fallback ReferenceError**: Fixed `ReferenceError` on undefined `previousStartChunks` in the client-side local JS fallback solver.
- [x] **Robust Integration Tests**: Automated Uvicorn server lifecycle and verified all features and lock transitions (including user's 15-target list on 2026-06-19 observing night) using synchronized Playwright tests.



