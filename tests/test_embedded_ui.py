"""Browser tests for the embeddable front end (#95) and the real-time actions (#94).

The page is served by the standalone app; a host page's config is injected with
add_init_script, and the host's API prefix is routed back to the local server.
"""

import json
import os
import socket
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from playwright.sync_api import sync_playwright

from astroscheduler.api import solve_dict

PORT = 8071
BASE = f"http://127.0.0.1:{PORT}"
NIGHT = "2026-10-15"

# Synthetic targets, well placed for an October night at Lick (RA in hours).
TARGETS = [
    {"name": "SN 2026aaa", "ra": 1.0, "dec": 20.0, "magnitude": 17.0, "priority": 1,
     "external_id": "fu-101"},
    {"name": "SN 2026bbb", "ra": 3.0, "dec": 30.0, "magnitude": 16.5, "priority": 2,
     "external_id": "fu-102"},
]


def _config(**extra):
    cfg = {
        "mode": "embedded",
        "apiBase": "/hostprefix/planner",
        "headers": {"X-CSRFToken": "test-token"},
        "site": {"id": "lick", "telescope": {"ha_limit_west": 5.6667}},
        "initial": {"date": NIGHT, "instrument": "kast", "targets": TARGETS},
    }
    cfg.update(extra)
    return "window.ASTROSCHEDULER_CONFIG = " + json.dumps(cfg) + ";"


@pytest.fixture(scope="module")
def server():
    proc = subprocess.Popen([sys.executable, "-u", "app.py"],
                            env=dict(os.environ, PORT=str(PORT), PYTHONUNBUFFERED="1"))
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=1).close()
            break
        except OSError:
            time.sleep(0.3)
    yield BASE
    proc.terminate()
    proc.wait()


@pytest.fixture
def host(server):
    """A page plus the solve requests it sent to the host's API prefix."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pg = browser.new_page()
        seen = []

        def forward(route, request):
            seen.append({"headers": request.headers, "body": request.post_data_json})
            route.continue_(url=f"{BASE}/api/schedule")

        pg.route("**/hostprefix/planner/api/schedule", forward)
        yield SimpleNamespace(page=pg, requests=seen)
        browser.close()


def _open(host, init_script):
    host.page.add_init_script(init_script)
    host.page.goto(BASE)
    return host.page


def test_embedded_mode_uses_host_config(host):
    page = _open(host, _config())
    page.wait_for_selector('tr[id="sched-row-SN 2026aaa"]', timeout=60000)

    assert host.requests, "the solve should go to the host's apiBase"
    req = host.requests[0]
    assert req["headers"].get("x-csrftoken") == "test-token"
    body = req["body"]
    assert body["date"] == NIGHT
    assert body["observatory"]["id"] == "lick"
    assert body["observatory"]["telescope"] == {"ha_limit_west": 5.6667}
    assert {t["external_id"] for t in body["targets"]} == {"fu-101", "fu-102"}

    # Host data, not browser storage; site, night and auto-update are fixed by the host.
    assert page.evaluate("Object.keys(window.localStorage)") == []
    assert page.locator("#obs-date").is_disabled()
    assert page.locator("#obs-select").is_disabled()
    assert not page.locator("#auto-update-toggle").is_visible()
    # The host page supplies the title and the targets.
    assert not page.locator(".header-logo").is_visible()
    assert page.locator("#mode-realtime-btn").is_visible()
    assert not page.locator("#load-sample-btn").is_visible()
    assert not page.locator("#yse-import-btn").is_visible()
    assert page.evaluate("window.AstroScheduler.config.mode") == "embedded"
    names = page.evaluate("window.AstroScheduler.getResult().blocks.map(b => b.external_id)")
    assert "fu-101" in names


def test_embedded_saved_result_is_shown_without_solving(host):
    saved = solve_dict({"date": NIGHT, "observatory": {"id": "lick"}, "targets": TARGETS})
    initial = {"date": NIGHT, "instrument": "kast", "targets": TARGETS, "result": saved}
    page = _open(host, _config(initial=initial))
    page.wait_for_selector('tr[id="sched-row-SN 2026aaa"]', timeout=20000)
    page.wait_for_timeout(1000)
    assert host.requests == []


def test_reopened_plan_seeds_the_first_solve(host):
    """initial.previous_schedule goes out with the first solve only (#106)."""
    seed = [{"target_name": "SN 2026aaa", "external_id": "fu-101", "start_time": "2026-10-16T05:00:00+00:00"}]
    initial = {"date": NIGHT, "instrument": "kast", "targets": TARGETS, "previous_schedule": seed}
    page = _open(host, _config(initial=initial))
    page.wait_for_selector('tr[id="sched-row-SN 2026aaa"]', timeout=60000)
    assert host.requests[0]["body"]["previous_schedule"] == seed

    page.locator("#run-schedule-btn").click()
    page.wait_for_timeout(3000)
    assert len(host.requests) >= 2
    second = host.requests[-1]["body"]["previous_schedule"]
    assert second and second != seed  # now the blocks on screen
    assert {"fu-101", "fu-102"} <= {b["external_id"] for b in second}


def test_realtime_actions_and_hook(host):
    page = _open(host, _config())
    page.wait_for_selector('tr[id="sched-row-SN 2026aaa"]', timeout=60000)
    page.evaluate("""() => {
        window.__events = [];
        window.AstroScheduler.hooks.onObservationEvent = e => { window.__events.push(e); };
    }""")
    page.locator("#mode-realtime-btn").click()
    page.select_option("#rt-active-target", "SN 2026aaa")

    page.get_by_role("button", name="Start Observation", exact=True).click()
    page.wait_for_selector('#rt-log-table tr.rt-log-row[data-action="start"]')
    events = page.evaluate("window.__events")
    assert events[0]["action"] == "start"
    assert events[0]["external_id"] == "fu-101"
    assert events[0]["planned_start"]

    # Failed needs a reason: without one nothing is recorded.
    page.get_by_role("button", name="Failed", exact=True).click()
    assert len(page.evaluate("window.__events")) == 1

    page.select_option("#rt-reason", "weather")
    page.fill("#rt-comment", "clouds")
    page.select_option("#rt-active-target", "SN 2026aaa")
    page.get_by_role("button", name="Failed", exact=True).click()
    page.wait_for_selector('#rt-log-table tr.rt-log-row[data-action="fail"]')
    fail = page.evaluate("window.__events")[1]
    assert (fail["action"], fail["reason"], fail["note"]) == ("fail", "weather", "clouds")
    status = page.evaluate("window.AstroScheduler.getTargets().find(t => t.name === 'SN 2026aaa').status")
    assert status == "Failed"

    # A hook that rejects cancels the action.
    page.evaluate("""() => {
        window.AstroScheduler.hooks.onObservationEvent = () => Promise.reject(new Error('host said no'));
    }""")
    page.select_option("#rt-active-target", "SN 2026bbb")
    page.select_option("#rt-reason", "deprioritized")
    page.get_by_role("button", name="Punted", exact=True).click()
    page.wait_for_timeout(500)
    status = page.evaluate("window.AstroScheduler.getTargets().find(t => t.name === 'SN 2026bbb').status")
    assert status in (None, "")
    assert "host said no" in page.locator("#rt-log-terminal").input_value()


def test_standalone_actions_work_without_a_hook(server):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(server)
        page.wait_for_timeout(1500)
        with page.expect_response("**/api/schedule", timeout=60000):
            page.locator("#run-schedule-btn").click()
        page.wait_for_selector("#schedule-table tr[id^='sched-row-']", timeout=20000)
        page.locator("#mode-realtime-btn").click()
        assert page.locator("#rt-active-target option").count() > 0
        page.get_by_role("button", name="Completed", exact=True).click()
        page.wait_for_selector('#rt-log-table tr.rt-log-row[data-action="complete"]')
        browser.close()


def test_standalone_import_from_yse_pz(server):
    """The import dialog with the server's YSE_PZ proxy routed: no network, no stored token."""
    nights = {"base_url": "https://yse.example.org/yse/", "nights": [
        {"id": 12, "date": NIGHT, "telescope": "Shane", "night_type": "Full", "site": "lick", "instrument": "kast"}]}
    targets = [dict(t, ra="01:00:00.00" if t["name"].endswith("aaa") else "03:00:00.00",
                    dec="+20:00:00.0" if t["name"].endswith("aaa") else "+30:00:00.0",
                    url="https://yse.example.org/yse/transient_detail/%s/" % t["name"].replace(" ", ""))
               for t in TARGETS]
    imported = {"night": {"id": 12, "date": NIGHT}, "observatory": {"id": "lick", "lat": 37.3414, "lon": -121.6429,
                "elevation": 1283.0, "timezone": "America/Los_Angeles"}, "instrument": "kast",
                "targets": targets, "warnings": ["SN 2026bbb: last detection 9 days before the night"]}
    bodies = []

    def proxy(route, request):
        bodies.append(request.post_data_json)
        data = nights if request.url.endswith("/nights") else imported
        route.fulfill(status=200, content_type="application/json", body=json.dumps(data))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("**/api/yse_pz/*", proxy)
        page.goto(server)
        page.wait_for_timeout(1000)
        page.locator("#yse-import-btn").click()
        page.fill("#yse-token", "synthetic-token")
        page.locator("#yse-list-btn").click()
        page.wait_for_selector("#yse-night-select option[value='12']", state="attached")
        page.locator("#yse-import-go").click()
        page.wait_for_selector("#targets-table a[href*='transient_detail/SN2026aaa']")

        assert bodies[0] == {"token": "synthetic-token"}
        assert bodies[1] == {"token": "synthetic-token", "night_id": "12"}
        assert page.locator("#obs-date").input_value() == NIGHT
        assert "Imported 2 target(s)" in page.locator("#yse-import-status").inner_text()
        assert "last detection" in page.locator("#rt-log-terminal").input_value()
        ids = page.evaluate("window.AstroScheduler.getTargets().map(t => t.external_id)")
        assert sorted(ids) == ["fu-101", "fu-102"]
        stored = page.evaluate("Object.values(window.localStorage).join(' ')")
        assert "synthetic-token" not in stored
        browser.close()
