"""Standalone entry point: ``python app.py`` runs the AstroScheduler web app.

The app itself lives in ``astroscheduler.server``; this file keeps the old command working.
"""

from astroscheduler.server import *  # noqa: F401,F403
from astroscheduler.server import main, run_schedule_logic  # noqa: F401  (app exists only with the server extra)

if __name__ == "__main__":
    main()
