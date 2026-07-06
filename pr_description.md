# Pull Request: Solver Performance and Target Disappearance Fixes

This Pull Request addresses the scheduler hang, timeout issues, and priority 3 target disappearance when scheduling large target lists.

## Resolved Issues and Features

- [x] **Solver Greedy Pass and Priority 3 Disappearance Fix**: Added a fast greedy initialization pass to establish a cost upper bound and fallback schedule in both Python and local JS solvers. Prevents priority 3.0 targets from disappearing when search limits are reached.
- [x] **Solver Search Iterations Limit Reduction**: Reduced search iterations limits (Python to 20,000, JS to 10,000) to ensure immediate page loading and solver responsiveness.
- [x] **Fixed JS Fallback ReferenceError**: Fixed `ReferenceError` on undefined `previousStartChunks` in the client-side local JS fallback solver.
- [x] **Robust Integration Tests**: Automated Uvicorn server lifecycle and verified all features and lock transitions (including user's 15-target list on 2026-06-19 observing night) using synchronized Playwright tests.
