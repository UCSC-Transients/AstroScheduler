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
- [x] **LST Vertical Offset**: Increased margin-bottom of `lstAxisEl` to `20px` to prevent vertical overlap with twilight/sunset/sunrise marker labels.
- [x] **Table Layout Bouncing**: Added `border-left: 3px solid transparent;` to `.data-table tr` in style.css.
- [x] **Timeline Table Alignment (Off-by-one)**: Added empty `<th>` to `#schedule-table` `thead` to align with lock column.
- [x] **Airmass Chart Zoom & Reset**: Reset `originalXMin` / `originalXMax` on chart recreation, and reset Y-axis scale to dynamic defaults in `resetChartZoom`.
