import os
import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

def test_ui_visibility():
    # Boot server on port 8062
    server_process = subprocess.Popen(
        [sys.executable, "-u", "app.py"],
        env=dict(os.environ, PORT="8062", PYTHONUNBUFFERED="1")
    )
    time.sleep(5)  # Allow server to boot
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            # Record console and page errors
            console_logs = []
            page_errors = []
            page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: page_errors.append(err))
            
            # Intercept and fail /api/schedule requests to force local solver fallback
            page.route("**/api/schedule", lambda route: route.fulfill(
                status=500,
                content_type="application/json",
                body='{"detail": "Internal Server Error"}'
            ))
            
            print("Navigating to page with API offline...")
            page.goto("http://127.0.0.1:8062")
            
            # Wait for local solver fallback to run
            page.wait_for_timeout(4000)
            
            print("\n--- BROWSER LOGS ---")
            for log in console_logs:
                print("CONSOLE:", log)
            for err in page_errors:
                print("PAGE ERROR:", err)
            print("--------------------\n")
            
            # 1. Verify start/end observing times
            start_val = page.locator("#manual-night-start").get_attribute("placeholder") or ""
            end_val = page.locator("#manual-night-end").get_attribute("placeholder") or ""
            print(f"Night Start: {start_val!r}, Night End: {end_val!r}")
            assert start_val.strip(), "Night start time placeholder is empty"
            assert end_val.strip(), "Night end time placeholder is empty"
            assert ":" in start_val, f"Invalid night start time: {start_val}"
            assert ":" in end_val, f"Invalid night end time: {end_val}"
            
            # 2. Verify Moon Phase
            moon_phase = page.locator("#moon-phase-val").inner_text()
            print(f"Moon Phase: {moon_phase!r}")
            assert "N/A" not in moon_phase, "Moon phase display shows N/A"
            assert moon_phase.strip(), "Moon phase display is empty"
            
            # 3. Verify schedule timeline has scheduled blocks (not just empty message)
            timeline_blocks = page.locator(".timeline-block")
            timeline_block_count = timeline_blocks.count()
            print(f"Timeline Block Count: {timeline_block_count}")
            assert timeline_block_count > 0, "No scheduled blocks found in the timeline"
            
            # 4. Verify Airmass plot exists and has non-zero size
            airmass_chart = page.locator("canvas#airmassChart")
            assert airmass_chart.count() > 0, "Airmass chart canvas is missing"
            is_airmass_visible = airmass_chart.is_visible()
            print(f"Airmass Chart Visible: {is_airmass_visible}")
            assert is_airmass_visible, "Airmass chart canvas is not visible"
            
            # 5. Verify Alt/Az plot (polar chart) exists and has non-zero size
            polar_chart = page.locator("canvas#polarChart")
            assert polar_chart.count() > 0, "Alt/Az polar chart canvas is missing"
            is_polar_visible = polar_chart.is_visible()
            print(f"Alt/Az Polar Chart Visible: {is_polar_visible}")
            assert is_polar_visible, "Alt/Az polar chart canvas is not visible"
            
            print("\nAll UI visibility checks passed successfully!")
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()
