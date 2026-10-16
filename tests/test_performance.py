"""Solve-time headroom (#110): a busy night must solve well inside a web request's budget.

Embedded in YSE_PZ, a solve runs inside the request. The bound is generous, so that slow CI
runners pass; it fails only if the solver regresses badly (40 targets took about 21 s before
#110 and about 7 s after, on a laptop).
"""

import datetime
import random
import time

from astroscheduler.api import SolveRequest, TargetSpec, solve


def _night(n, seed=1):
    rnd = random.Random(seed)
    return [TargetSpec(name="SN%03d" % i, ra="%02d:%02d:00" % (rnd.randint(18, 27) % 24, rnd.randint(0, 59)),
                       dec="%+03d:00:00" % rnd.randint(-20, 60), magnitude=round(rnd.uniform(15, 19.5), 1),
                       priority=rnd.choice([1, 2, 3, 4, 5]), external_id=str(i)) for i in range(n)]


def test_forty_targets_solve_well_inside_a_request():
    request = SolveRequest(date=datetime.date(2026, 10, 20), targets=_night(40))
    started = time.monotonic()
    result = solve(request)
    elapsed = time.monotonic() - started
    print("40 targets: %.1f s, %d blocks" % (elapsed, len(result.blocks)))
    assert result.blocks
    assert elapsed < 45, "40 targets took %.1f s" % elapsed
