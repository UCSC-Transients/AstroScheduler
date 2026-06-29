# Pull Request: Standard Stars Observability and Target Classification Refinements

This Pull Request addresses the remaining issues with standard star manual scheduling boundaries, physical unobservability classification, tag naming consistency, and target list vertical scrolling.

## Resolved Issues

- [x] #14 Solver: Schedule selected standard stars independently if complete pairs are missing
- [x] #49 Workflow: Schedulable standard stars greyed out
- [x] Rename "Unschedulable" status tag to "Unobservable" for consistency
- [x] Fix manual scheduling of `Feige 34` when selected
- [x] Refine target unobservability checks (e.g. `2026nqo`, `2026lnx`, etc.) to distinguish scheduling airmass constraints from physical telescope pointing limits
- [x] Restore vertical scrollbar and sticky headers to the target list table

## Technical Details

### 1. Standard Star Observability & Manual Scheduling (#49)
- Updated `isStandardStarObservable` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) to dynamically calculate UTC offset and perform 10-minute resolution sampling.
- Relaxed twilight and night-limit boundaries in both backend solver ([scheduler.py](file:///Users/rfoley/scheduler/scheduler.py)) and frontend solver ([static/app.js](file:///Users/rfoley/scheduler/static/app.js)) when `auto_standards` is False, allowing checked standard stars to be manually scheduled all the way from sunset to sunrise. This fixes the issue where `Feige 34` (setting near sunset) could not be scheduled when selected.

### 2. Airmass Constraints vs Physical Telescope Limits
- Refactored `is_chunk_valid` in [scheduler.py](file:///Users/rfoley/scheduler/scheduler.py) and `isChunkValid` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) to support an `ignore_scheduling_limits` flag.
- When checking physical observability (to determine if a target is "Unobservable"/red or just "Not Scheduled"/orange), the solver now ignores soft scheduling limits (twilight, 1.7 airmass) and uses absolute telescope limits (pointing, alt >= 20 deg / airmass <= 2.92). This ensures targets like `2026nqo` which transit at airmasses > 1.7 but remain observable are placed in conflicts rather than marked unobservable.

### 3. Scrollbar & UI Polish
- Restored vertical scrollbar (`max-height: 400px; overflow-y: auto;`) and sticky table headers to the target list table container in [static/style.css](file:///Users/rfoley/scheduler/static/style.css).
- Changed "Unschedulable" labels to "Unobservable" in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) for tag naming consistency.

## Verification
- Added a unit test `test_feige34_observability_on_2026_06_27` to verify standard star scheduling near sunset.
- Added a unit test `test_high_airmass_conflict_not_unobservable` to verify airmass constraint partitioning.
- Verified that all 25 tests pass successfully.
