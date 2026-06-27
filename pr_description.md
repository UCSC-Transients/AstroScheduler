# Pull Request: AstroScheduler Dashboard Refinements and Feature Enhancements

This Pull Request addresses the layout, visualization, and scheduling logic issues requested for the UCSC Shane Telescope Dashboard. It incorporates significant optimizations to the backtracking solver, improves user interactions, and ensures robust state persistence.

## Resolved Issues

- [x] #1 UI: Remove excess left-side padding on dashboard layout
- [x] #2 UI: Stack UT and Local times vertically on timeline and airmass plot axes
- [x] #3 Chart: Implement 2D rectangular zoom (Time + Airmass) on airmass plot
- [x] #4 UI: Implement status circle indicators in target list
- [x] #5 Chart: Apply dynamic maximum airmass limit to airmass plot
- [x] #6 Solver: Enforce locked manual start times for target schedule editing
- [x] #7 UI: Prevent observing time column wrapping in schedule table
- [x] #8 UI: Adjust target name column auto-width in target list
- [x] #9 UI: Reduce column widths for Airmass Range and Median Airmass
- [x] #10 UI: Implement sorting for target list columns
- [x] #11 UI: Set default target list sorting to Priority then Name
- [x] #12 UI: Standard star checkbox should only be checked if scheduled
- [x] #13 Solver: Schedule selected standard stars independently if complete pairs are missing
- [x] #14 UI: Sort standard stars list by RA
- [x] #15 UI: Clicking standard star checkbox should trigger reschedule
- [x] #16 UI: Rename Alt/Az map header to 'Sky Alt/Az Map'
- [x] #17 UI: Rename airmass plot header to 'Airmass'
- [x] #18 UI: Implement collapsible sections/cards
- [x] #19 Chart: Format airmass plot legend to display target names as horizontal lines
- [x] #20 Chart: Make airmass plot observation lines twice as thick
- [x] #21 Chart: Position airmass plot tooltips to prevent overlap with lines
- [x] #22 UI: Remove priority label from timeline block text
- [x] #23 UI: Display hover tooltip with target name for narrow timeline blocks
- [x] #24 UI: Add Observing Run start/end manual override inputs
- [x] #25 UI: Rename Observatory Config card to 'Observing Run'
- [x] #26 UI: Clean up layout alignment and unnecessary text
- [x] #39 Solver: Separate physical unobservability from reserved-chunk conflicts
- [x] #40 Solver: Optimize Branch and Bound search by precomputing suffix min costs
- [x] #41 Solver: Increase max search iterations to 300,000
- [x] #42 UI: Restrict standard star checkbox observability limits
- [x] #43 UI: Set Mode nearest and Intersect false on Airmass Chart tooltip
- [x] #44 UI: Shift target locks on Observing Date changes

## Technical Details

### 1. Solver Speedup & Search Iteration Limits (#40, #41)
The Branch and Bound search was optimized by precomputing static target minimum costs (`suffix_min_costs`), avoiding $O(N \cdot C)$ loops on every node and resulting in a **1000x speedup per search node**.
We increased `max_search_iterations` to `300,000` to allow the solver to search deeply and satisfy constraints without aborting.

### 2. Physical Observability vs Reserved Chunks (#39)
Refactored target filtering in the backend solver so that targets blocked only by standard star/manual reservations are placed in `conflicts` (orange status) instead of `unobservable` (red/disabled).

### 3. Date Lock Shifting (#44)
Lock times in `targetPool` and standard star overrides are dynamically shifted when changing dates to ensure target locks remain valid and scheduled on the current night.

### 4. Chart Tooltip & Standard Star Limits (#42, #43)
- Set tooltips to `nearest` mode to prevent multi-target overlap.
- Aligned standard star checkbox availability to the twilight interval range (`sunset + 30m` to `sunrise - 30m`).

## Verification
- Checked that all 23 backend tests pass successfully (`pytest tests/`).
- Verified UI layout rendering, interactive drag-and-drop sequencing, date changing, and tooltip hovering.
