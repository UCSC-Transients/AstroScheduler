import sys
import os

# Ensure repository root is in Python path for test discovery
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

# Tests call solver internals outside a solve; keep astropy offline for the whole run, as the
# standalone app does (library solves are scoped by astroscheduler.core.fast_astrometry).
from astroscheduler.core import use_offline_iers_globally  # noqa: E402

use_offline_iers_globally()
