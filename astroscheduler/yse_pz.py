"""Import a classical night's targets from YSE_PZ into the standalone app (#104).

The browser cannot call YSE_PZ directly (YSE_PZ sends no CORS headers), so the standalone
server fetches on its behalf with the user's YSE_PZ API token. The YSE_PZ address is fixed by
configuration, never taken from the request, so the server cannot be used to fetch arbitrary
URLs. The token is used for the one request and is never stored or logged.

    ASTROSCHEDULER_YSE_PZ_URL   YSE_PZ base URL (default: the production site)

YSE_PZ endpoints used: ``GET api/observing_nights/`` (Young-Supernova-Experiment/YSE_PZ#658)
and ``GET api/observing_nights/<id>/planner_targets/`` (#655).
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Tuple

DEFAULT_BASE_URL = "https://ziggy.ucolick.org/yse/"
TIMEOUT_SECONDS = 20


class YsePzError(Exception):
    """A failure to show the user; ``status`` is the HTTP status the server returns."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def base_url() -> str:
    url = (os.environ.get("ASTROSCHEDULER_YSE_PZ_URL") or DEFAULT_BASE_URL).strip()
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise YsePzError("ASTROSCHEDULER_YSE_PZ_URL must be an http(s) URL", 500)
    return url if url.endswith("/") else url + "/"


def _clean_token(token: Any) -> str:
    token = (token or "").strip() if isinstance(token, str) else ""
    if not token or len(token) > 200 or any(c.isspace() for c in token):
        raise YsePzError("Enter your YSE_PZ API token (Profile > API token in YSE_PZ).", 400)
    return token


def _get(path: str, token: str) -> Any:
    url = urllib.parse.urljoin(base_url(), path)
    request = urllib.request.Request(url, headers={
        "Authorization": "Token %s" % token,
        "Accept": "application/json",
        "User-Agent": "AstroScheduler",
    })
    host = urllib.parse.urlparse(url).netloc
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise YsePzError("YSE_PZ did not accept the token.", 401)
        if exc.code == 404:
            raise YsePzError("Not found on YSE_PZ (or its planner is not enabled there).", 404)
        raise YsePzError("YSE_PZ returned HTTP %d." % exc.code, 502)
    except (urllib.error.URLError, OSError) as exc:
        raise YsePzError("Could not reach YSE_PZ at %s (%s)." % (host, getattr(exc, "reason", exc)), 502)
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise YsePzError("YSE_PZ sent a response that is not JSON (is the token right?).", 502)


def list_nights(token: Any) -> Dict[str, Any]:
    """The classical nights the token's user may plan, as YSE_PZ lists them."""
    data = _get("api/observing_nights/", _clean_token(token))
    nights = data.get("nights") if isinstance(data, dict) else None
    if not isinstance(nights, list):
        raise YsePzError("Unexpected response from YSE_PZ's night list.", 502)
    return {"base_url": base_url(), "nights": nights}


def night_targets(token: Any, night_id: Any) -> Dict[str, Any]:
    """One night's targets, site and instrument in AstroScheduler's schema."""
    try:
        night = int(night_id)
    except (TypeError, ValueError):
        raise YsePzError("Choose a night to import.", 400)
    data = _get("api/observing_nights/%d/planner_targets/" % night, _clean_token(token))
    if not isinstance(data, dict) or not isinstance(data.get("targets"), list):
        raise YsePzError("Unexpected response from YSE_PZ's planner targets.", 502)
    return data


def handle(action: str, payload: Any) -> Tuple[int, Dict[str, Any]]:
    """``(status, body)`` for ``POST /api/yse_pz/<action>``; shared by both servers."""
    payload = payload if isinstance(payload, dict) else {}
    try:
        if action == "nights":
            return 200, list_nights(payload.get("token"))
        if action == "import":
            return 200, night_targets(payload.get("token"), payload.get("night_id"))
        return 404, {"detail": "Unknown action"}
    except YsePzError as exc:
        return exc.status, {"detail": str(exc)}
