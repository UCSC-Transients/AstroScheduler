import os
import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

def test_new_features():
    # Boot server on port 8063
    server_process = subprocess.Popen(
        [sys.executable, "-u", "app.py"],
        env=dict(os.environ, PORT="8063", PYTHONUNBUFFERED="1")
    )
    time.sleep(5)  # Allow server to boot
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            # Navigating to page
            page.goto("http://127.0.0.1:8063")
            page.evaluate("localStorage.clear();")
            page.reload()
            page.wait_for_timeout(3000)
            
            # 1. Verify Auto-Update Toggle exists and defaults to off
            toggle = page.locator("#auto-update-toggle")
            assert toggle.is_visible(), "Auto-update toggle is not visible"
            assert not toggle.is_checked(), "Auto-update toggle should default to unchecked (off)"
            
            # 2. Verify Alerts Panel collapsible sections
            # Add an unobservable target to trigger High alert
            page.click("#t-name")
            page.fill("#t-name", "UnobservableTarget")
            page.fill("#t-ra", "12.0")
            page.fill("#t-dec", "-80.0") # unreachable dec for Lick Observatory
            page.fill("#t-mag", "15.0")
            page.click("#target-form button[type='submit']")
            page.wait_for_timeout(1000)
            
            # Manual recalculate to trigger scheduling since auto-update is off
            page.click("#run-schedule-btn")
            page.wait_for_selector("#high-alerts-body", timeout=10000)
            
            # Check high severity alerts body is uncollapsed
            high_body = page.locator("#high-alerts-body")
            assert high_body.is_visible(), "High severity alerts section should be visible"
            assert "collapsed" not in (high_body.get_attribute("class") or ""), "High alerts body should not be collapsed"
            
            # Check low severity alerts body is collapsed (e.g. if we have any low alerts)
            # Empty blocks should trigger a low alert.
            low_body = page.locator("#low-alerts-body")
            if low_body.is_visible():
                assert "collapsed" in (low_body.get_attribute("class") or ""), "Low alerts body should be collapsed by default"
                
            print("All new features tests passed successfully.")
            
    finally:
        server_process.terminate()
        server_process.wait()
