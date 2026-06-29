# Pull Request: Standard Stars Observability and Target Classification Refinements

This Pull Request addresses the remaining issues with standard star manual scheduling boundaries, physical unobservability classification, tag naming consistency, and target list vertical scrolling.

## Resolved Issues

- [x] #14 Solver: Schedule selected standard stars independently if complete pairs are missing
- [x] #49 Workflow: Schedulable standard stars greyed out
- [x] Rename "Unschedulable" status tag to "Unobservable" for consistency
- [x] Change standard star "Standby" status to "Not Scheduled" for consistency
- [x] Fix logic bug in `app.py` where targets marked as `"Unobservable"` in the payload were skipped by the backend solver in subsequent runs, preventing recalculation or scheduling when parameters (e.g. date) changed
- [x] Align `isStandardStarObservable` in the frontend to check if a continuous 5-minute block fits inside the `sunset + 30m` twilight constraint. This prevents checking standard stars that set before they can be fully observed
- [x] Restore vertical scrollbar and sticky headers to the target list table, showing 10 items (800px max-height) without scrolling

## Technical Details

### 1. Re-Evaluating Unobservable Targets (Logic Bug Fix)
Refactored the `/api/schedule` endpoint in [app.py](file:///Users/rfoley/scheduler/app.py) to not skip targets with calculated status `"Unobservable"`. Previously, once a target was flagged unobservable, it would be skipped by the backend on all subsequent runs, keeping it permanently unobservable even if the date or constraints changed. This resolves the issues with `2026nqo`, `2026lnx`, etc. being stuck as unobservable.

### 2. Standard Star Observability & Manual Limits (#49)
- Updated `isStandardStarObservable` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) to:
  1. Restrict checks to the twilight bounds (`sunset + 30m` to `sunrise - 30m`) matching the scheduler constraints.
  2. Verify that the star is visible for a continuous 5-minute block. This correctly handles `Feige 34` on `2026-06-27` (which is visible at `sunset + 30m` but sets at `sunset + 31m` - meaning a 5-minute block cannot fit, making it unobservable under original twilight rules).

### 3. Status Tag & Styling Polish
- Changed "Standby" status text for standard stars to "Not Scheduled" in [static/app.js](file:///Users/rfoley/scheduler/static/app.js).
- Changed "Unschedulable" labels to "Unobservable" in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) for consistency.
- Increased `.table-wrapper` `max-height` to `800px` in [static/style.css](file:///Users/rfoley/scheduler/static/style.css) so the target table displays 10 items without scrolling.

## Verification
- Added a unit test `test_feige34_observability_on_2026_06_27` to verify standard star scheduling near sunset.
- Added a unit test `test_high_airmass_conflict_not_unobservable` to verify airmass constraint partitioning.
- Verified that all 25 tests pass successfully.
