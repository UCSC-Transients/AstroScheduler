"""Import from YSE_PZ in the standalone app (#104). YSE_PZ's HTTP calls are mocked."""

import io
import json
import urllib.error
from unittest import mock

import pytest

from astroscheduler import yse_pz

NIGHTS = {"nights": [{"id": 12, "date": "2026-10-15", "telescope": "Shane", "night_type": "Full",
                      "site": "lick", "instrument": "kast"}]}
TARGETS = {"night": {"id": 12, "date": "2026-10-15"}, "observatory": {"id": "lick"}, "instrument": "kast",
           "targets": [{"name": "SN 2026aaa", "ra": "01:00:00.00", "dec": "+20:00:00.0", "magnitude": 17.2,
                        "priority": 1.0, "external_id": "101", "url": "https://example.org/sn"}],
           "warnings": []}


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _urlopen_returning(body, seen=None):
    def fake(request, timeout=None):
        if seen is not None:
            seen.append(request)
        return _Response(json.dumps(body).encode())
    return fake


def _http_error(code):
    def fake(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, code, "error", {}, None)
    return fake


@pytest.fixture(autouse=True)
def yse_pz_url(monkeypatch):
    monkeypatch.setenv("ASTROSCHEDULER_YSE_PZ_URL", "https://yse.example.org/yse")


def test_lists_nights_with_the_token():
    seen = []
    with mock.patch("urllib.request.urlopen", _urlopen_returning(NIGHTS, seen)):
        status, body = yse_pz.handle("nights", {"token": "abc123"})
    assert status == 200
    assert body["nights"][0]["id"] == 12
    assert seen[0].full_url == "https://yse.example.org/yse/api/observing_nights/"
    assert seen[0].get_header("Authorization") == "Token abc123"


def test_imports_one_night():
    seen = []
    with mock.patch("urllib.request.urlopen", _urlopen_returning(TARGETS, seen)):
        status, body = yse_pz.handle("import", {"token": "abc123", "night_id": "12"})
    assert status == 200
    assert body["targets"][0]["external_id"] == "101"
    assert seen[0].full_url == "https://yse.example.org/yse/api/observing_nights/12/planner_targets/"


def test_the_request_cannot_choose_the_url():
    seen = []
    payload = {"token": "abc123", "night_id": "12", "base_url": "http://169.254.169.254/", "url": "http://evil/"}
    with mock.patch("urllib.request.urlopen", _urlopen_returning(TARGETS, seen)):
        yse_pz.handle("import", payload)
    assert seen[0].full_url.startswith("https://yse.example.org/yse/")


@pytest.mark.parametrize("payload, status", [
    ({}, 400),
    ({"token": "has space"}, 400),
    ({"token": "abc", "night_id": "twelve"}, 400),
])
def test_bad_input(payload, status):
    action = "import" if "night_id" in payload else "nights"
    with mock.patch("urllib.request.urlopen") as urlopen:
        got, body = yse_pz.handle(action, payload)
    assert got == status and body["detail"]
    urlopen.assert_not_called()


def test_rejected_token():
    with mock.patch("urllib.request.urlopen", _http_error(401)):
        status, body = yse_pz.handle("nights", {"token": "abc123"})
    assert status == 401 and "token" in body["detail"]


def test_unreachable_host():
    def fake(request, timeout=None):
        raise urllib.error.URLError("no route")
    with mock.patch("urllib.request.urlopen", fake):
        status, body = yse_pz.handle("nights", {"token": "abc123"})
    assert status == 502 and "yse.example.org" in body["detail"]


def test_non_http_base_url_is_refused(monkeypatch):
    monkeypatch.setenv("ASTROSCHEDULER_YSE_PZ_URL", "file:///etc/passwd")
    with mock.patch("urllib.request.urlopen") as urlopen:
        status, _ = yse_pz.handle("nights", {"token": "abc123"})
    assert status == 500
    urlopen.assert_not_called()


def test_server_route():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    from astroscheduler.server import app

    with mock.patch("urllib.request.urlopen", _urlopen_returning(NIGHTS)):
        response = TestClient(app).post("/api/yse_pz/nights", json={"token": "abc123"})
    assert response.status_code == 200
    assert response.json()["nights"][0]["telescope"] == "Shane"
