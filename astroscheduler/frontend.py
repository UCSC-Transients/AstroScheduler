"""The planner page, for the standalone server and for host apps that embed it.

A host app (YSE_PZ) serves ``STATIC_DIR`` under some URL (for example through Django's
``STATICFILES_DIRS``) and returns ``render_page(static_url, config)`` from a view, usually in
a same-origin frame: ``static/style.css`` resets global selectors (``body``, ``.card``,
``.btn``) that a host's own CSS also uses. ``config`` becomes
``window.ASTROSCHEDULER_CONFIG`` (see the README, "Embedding the planner").
"""

import json
import os
from typing import Any, Dict, Optional

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(PACKAGE_DIR, "static")
TEMPLATE_PATH = os.path.join(PACKAGE_DIR, "templates", "index.html")


def _script_json(value: Any) -> str:
    """JSON that is safe inside an inline <script>: no "</script>", "<!--" or line separators."""
    text = json.dumps(value)
    for raw, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                         (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(raw, escaped)
    return text


def render_page(static_url: str = "/static", config: Optional[Dict[str, Any]] = None) -> str:
    """The full planner page with its assets under ``static_url``.

    With a ``config``, it is injected before ``app.js`` as ``window.ASTROSCHEDULER_CONFIG``;
    ``staticBase`` defaults to ``static_url``. Without one, the page is the standalone app.
    """
    static_url = static_url.rstrip("/")
    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        page = f.read()
    script = ""
    if config is not None:
        config = dict(config)
        config.setdefault("staticBase", static_url)
        script = "<script>window.ASTROSCHEDULER_CONFIG = %s;</script>" % _script_json(config)
    return page.replace("{{STATIC_URL}}", static_url).replace("{{ASTROSCHEDULER_CONFIG}}", script)
