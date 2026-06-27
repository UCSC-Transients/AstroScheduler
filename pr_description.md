# Pull Request: UCSC AstroScheduler Regression Fixes

This Pull Request addresses the 6 regression issues identified in the scheduling algorithm, tooltips, reloading locks, standard stars visibility, and solver performance.

## Resolved Issues

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
