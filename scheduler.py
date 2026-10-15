"""Backwards-compatible alias: ``import scheduler`` is ``astroscheduler.core``."""

import sys

from astroscheduler import core as _core

sys.modules[__name__] = _core
