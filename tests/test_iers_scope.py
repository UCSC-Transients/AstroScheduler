"""Importing or solving must not change astropy's process-wide IERS settings (#101).

Each check runs in a fresh interpreter: this test session sets the options globally
(conftest.py), as the standalone app does.
"""

import os
import subprocess
import sys
import textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(code):
    result = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=ROOT,
                            capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def test_import_leaves_astropy_settings_alone():
    _run("""
        from astropy.utils.iers import conf
        snapshot = lambda: ({n: getattr(conf, n) for n in ("auto_download", "auto_max_age")}, dict(vars(conf)))
        before = snapshot()
        import astroscheduler.core, astroscheduler.api
        assert snapshot() == before, (before, snapshot())
    """)


def test_solve_is_offline_inside_and_restores_after():
    _run("""
        import datetime
        from astropy.utils.iers import conf
        from astroscheduler.core import fast_astrometry
        from astroscheduler.api import SolveRequest, TargetSpec, solve
        before = (conf.auto_download, conf.auto_max_age, dict(vars(conf)))
        with fast_astrometry():
            assert conf.auto_download is False
            assert conf.auto_max_age is None
        result = solve(SolveRequest(date=datetime.date(2026, 10, 15), auto_standards=False,
                                    targets=[TargetSpec(name="t", ra="01:00:00", dec="+20:00:00",
                                                        magnitude=17, priority=1)]))
        assert result.blocks
        assert (conf.auto_download, conf.auto_max_age, dict(vars(conf))) == before
    """)
