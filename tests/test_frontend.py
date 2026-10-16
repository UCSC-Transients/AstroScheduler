"""The planner page for the standalone server and host apps (#103)."""

import json
import os
import re

import pytest

from astroscheduler import frontend


def test_assets_live_under_the_given_static_url():
    page = frontend.render_page("/host/static/astroscheduler/")
    assert '<link rel="stylesheet" href="/host/static/astroscheduler/style.css">' in page
    assert '<script src="/host/static/astroscheduler/app.js"></script>' in page
    assert "{{" not in page
    assert "../static" not in page
    assert "ASTROSCHEDULER_CONFIG =" not in page  # no config: the standalone app


def test_static_dir_has_the_assets():
    for name in ("app.js", "style.css", "standards.json"):
        assert os.path.isfile(os.path.join(frontend.STATIC_DIR, name))


def test_config_is_injected_before_app_js_and_escaped():
    config = {"mode": "embedded", "initial": {"targets": [{"name": "x</script><script>alert(1)</script>"}]}}
    page = frontend.render_page("/s", config)
    head, _, tail = page.partition("window.ASTROSCHEDULER_CONFIG = ")
    assert tail, "config script missing"
    assert tail.index('<script src="/s/app.js">') > 0  # config comes first
    payload = tail.split(";</script>", 1)[0]
    assert "</script>" not in payload and "<" not in payload
    decoded = json.loads(payload)
    assert decoded["initial"]["targets"][0]["name"] == "x</script><script>alert(1)</script>"
    assert decoded["staticBase"] == "/s"


def test_chart_js_is_pinned_with_integrity():
    page = frontend.render_page()
    match = re.search(r'<script src="(https://cdn\.jsdelivr\.net/npm/chart\.js[^"]*)"\s+integrity="(sha384-[^"]+)"', page)
    assert match, "Chart.js must be loaded by exact version with an integrity hash"
    assert "@4.5.1/" in match.group(1)


def test_standalone_server_serves_the_rendered_page():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    from astroscheduler.server import app

    client = TestClient(app)
    page = client.get("/")
    assert page.status_code == 200
    assert '<script src="/static/app.js"></script>' in page.text
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/templates/index.html").status_code == 404
