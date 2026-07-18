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
            page.wait_for_timeout(4000)
            page.check("#auto-update-toggle")
            
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
            
            # 6. Verify Schedule Table has the Red/Blue exposure headers
            schedule_headers = page.locator("#schedule-table th").all_inner_texts()
            print("Schedule headers:", schedule_headers)
            assert "Red Exp (s)" in schedule_headers
            assert "Red N" in schedule_headers
            assert "Blue Exp (s)" in schedule_headers
            assert "Blue N" in schedule_headers

            # 7. Verify Target List table does NOT have Red/Blue exposure headers
            targets_headers = page.locator("#targets-table th").all_inner_texts()
            print("Targets headers:", targets_headers)
            assert "Red Exp (s)" not in targets_headers
            assert "Red N" not in targets_headers
            assert "Blue Exp (s)" not in targets_headers
            assert "Blue N" not in targets_headers
            assert "Total Time (s)" in targets_headers
            
            print("\nAll UI visibility checks passed successfully!")
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()


def test_exposure_linkage_bugs():
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
            
            page.on("console", lambda msg: print(f"BROWSER CONSOLE [{msg.type}]:", msg.text))
            page.on("pageerror", lambda err: print("BROWSER ERROR:", err))
            
            # Navigate
            page.goto("http://127.0.0.1:8063")
            page.wait_for_timeout(2000)
            page.check("#auto-update-toggle")
            
            # Set fixed observing date to ensure deterministic scheduling
            page.locator("#obs-date").fill("2026-07-14")
            page.locator("#obs-date").dispatch_event("change")
            page.wait_for_timeout(1000)
            
            # Load sample targets
            page.locator("button#load-sample-btn").click()
            
            # Wait dynamically for the schedule table to render
            page.wait_for_selector("#schedule-table tr[id^='sched-row-']", timeout=25000)
            
            # Find a science target row in schedule table
            rows = page.locator("#schedule-table tbody tr")
            row_count = rows.count()
            target_row = None
            for i in range(row_count):
                row_id = rows.nth(i).get_attribute("id") or ""
                if row_id.startswith("sched-row-") and not any(cal in row_id for cal in ["BD+", "Feige", "HZ", "HD19445"]):
                    target_row = rows.nth(i)
                    break
            
            assert target_row is not None, "No scheduled science target row found!"
            target_name = target_row.get_attribute("id").replace("sched-row-", "")
            print(f"Testing linkage on target: {target_name}")
            
            # Click the lock button to lock the target at this time slot
            target_row.locator("button").first.click()
            page.wait_for_timeout(1000)
            
            # Get input elements
            # Inputs inside the row: 
            # 0: start, 1: end, 2: duration, 3: blue_num, 4: blue_exp, 5: red_num, 6: red_exp
            blue_num_input = target_row.locator("input").nth(3)
            blue_exp_input = target_row.locator("input").nth(4)
            red_num_input = target_row.locator("input").nth(5)
            red_exp_input = target_row.locator("input").nth(6)
            
            # Read initial values/placeholders
            init_red_num = red_num_input.input_value() or red_num_input.get_attribute("placeholder") or "2"
            init_blue_num = blue_num_input.input_value() or blue_num_input.get_attribute("placeholder") or "1"
            init_red_num_val = int(init_red_num)
            init_blue_num_val = int(init_blue_num)
            print(f"Initial counts: Red N = {init_red_num_val}, Blue N = {init_blue_num_val}")
            
            try:
                # Test Bug 1 & 2: Edit red_exp to 300
                print("Editing red_exp to 300...")
                red_exp_input.fill("300")
                red_exp_input.blur()
                
                # Wait for Red N value to be populated in the input field
                # red_num is now inputs[5]
                page.wait_for_function(
                    "name => { const row = document.getElementById('sched-row-' + name); if (!row) return false; const inputs = row.querySelectorAll('input'); return inputs.length >= 7 && inputs[5].value !== ''; }",
                    arg=target_name,
                    timeout=20000
                )
                
                # Re-locate inputs after table re-render
                target_row = page.locator(f'tr[id="sched-row-{target_name}"]')
                blue_num_input = target_row.locator("input").nth(3)
                blue_exp_input = target_row.locator("input").nth(4)
                red_num_input = target_row.locator("input").nth(5)
                red_exp_input = target_row.locator("input").nth(6)
                
                new_red_num = int(red_num_input.input_value())
                new_blue_num = int(blue_num_input.input_value())
                new_blue_exp = blue_exp_input.input_value()
                
                print(f"After editing red_exp to 300: Red N = {new_red_num}, Blue N = {new_blue_num}, Blue Exp = {new_blue_exp}")
                
                # Verify Bug 1: changing exposure time does not change number of exposures of either arm (if within bounds)
                assert new_red_num == init_red_num_val, f"Expected red_num to remain {init_red_num_val}, but got {new_red_num}"
                assert new_blue_num == init_blue_num_val, f"Expected blue_num to remain {init_blue_num_val}, but got {new_blue_num}"
                
                # Verify Bug 2: other arm inputs are not blank
                assert new_blue_exp.strip() != "", "Blue exposure time input became blank!"
                
                # Test Bug 3: Exceed maximum exposure time (red max is 600s)
                total_time_target = 800.0 * new_red_num
                print(f"Editing red_exp to 800 (total time target = {total_time_target}s)...")
                red_exp_input.fill("800")
                red_exp_input.blur()
                
                # Wait for Red N to be updated to 3 (as 1600s redistributed yields 3 exposures)
                # red_num is inputs[5]
                page.wait_for_function(
                    "name => { const row = document.getElementById('sched-row-' + name); if (!row) return false; const inputs = row.querySelectorAll('input'); return inputs.length >= 7 && inputs[5].value === '3'; }",
                    arg=target_name,
                    timeout=20000
                )
                
                # Re-locate inputs
                target_row = page.locator(f'tr[id="sched-row-{target_name}"]')
                red_num_input = target_row.locator("input").nth(5)
                red_exp_input = target_row.locator("input").nth(6)
                
                final_red_exp = float(red_exp_input.input_value())
                final_red_num = int(red_num_input.input_value())
                final_total_time = final_red_exp * final_red_num
                
                print(f"After editing red_exp to 800: Red Exp = {final_red_exp}, Red N = {final_red_num}, Total = {final_total_time}")
                
                # Verify Bug 3: redistributed correctly, total time is equal to total time set (1600) and exp <= 600
                assert final_red_exp <= 600.0, f"Expected red exposure time to be capped/redistributed under 600.0s, but got {final_red_exp}"
                assert abs(final_total_time - total_time_target) < 1.0, f"Expected total exposure time to be {total_time_target}s, but got {final_total_time}"
            except Exception as test_exc:
                screenshot_path = "linkage_bug_screenshot.png"
                page.screenshot(path=screenshot_path, full_page=True)
                print(f"Test failed. Saved failure screenshot to {screenshot_path}")
                print("--- START HTML CONTENT ---")
                print(page.content())
                print("--- END HTML CONTENT ---")
                raise test_exc
            
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()

