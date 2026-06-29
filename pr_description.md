# Pull Request: Standard Stars Observability and Partitioning Refinements

This Pull Request addresses the remaining issues with standard star visibility rendering on the UI and correct classification of schedulable targets.

## Resolved Issues

- [x] #14 Solver: Schedule selected standard stars independently if complete pairs are missing
- [x] #49 Workflow: Schedulable standard stars greyed out

## Technical Details

### 1. Standard Star Observability Check (#49)
Updated `isStandardStarObservable` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) to:
- Dynamically compute UTC offset using `observatory.lon` instead of hardcoded `8.109` hours.
- Perform a 10-minute resolution loop across the entire night (from sunset to sunrise), preventing narrow visibility windows (such as `Feige 34` on `2026-06-27`) from being missed.

### 2. Physical observability vs scheduling conflicts (#14)
Refactored the frontend's local solver `solveInternal` in [static/app.js](file:///Users/rfoley/scheduler/static/app.js) to separate physical visibility checks from reserved chunk conflicts, matching the backend's behavior. Targets blocked only by other scheduled targets (reserved chunks) are now correctly marked as `conflicts` ("Not Scheduled" / orange) instead of `unobservable` ("Unschedulable" / red / disabled).

## Verification
- Added a unit test `test_feige34_observability_on_2026_06_27` in [tests/test_scheduler.py](file:///Users/rfoley/scheduler/tests/test_scheduler.py).
- Verified that all 24 tests pass successfully.
