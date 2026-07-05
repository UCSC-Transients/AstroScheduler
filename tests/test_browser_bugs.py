import time
import os
import sys
import subprocess
from playwright.sync_api import sync_playwright

def trigger_and_wait(page, action_fn):
    # Wait for the exact schedule request triggered by the action
    with page.expect_response(lambda r: "/api/schedule" in r.url and r.status == 200, timeout=30000):
        action_fn()
    # Give UI a brief moment to finish DOM updates
    page.wait_for_timeout(500)

def test_bugs():
    # Start local HTTP server for integration test
    server_process = subprocess.Popen(
        [sys.executable, "-u", "app.py"],
        env=dict(os.environ, PORT="8055", PYTHONUNBUFFERED="1")
    )
    time.sleep(3) # Let Uvicorn boot
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.on("console", lambda msg: print("BROWSER CONSOLE:", msg.text))
            page.on("pageerror", lambda err: print("BROWSER ERROR:", err))
            
            # Navigate and wait for the initial automatic schedule request to finish
            with page.expect_response(lambda r: "/api/schedule" in r.url and r.status == 200, timeout=30000):
                page.goto("http://127.0.0.1:8055")
            page.wait_for_timeout(500)
            
            # Force date to 2026-06-18 to ensure valid IERS data
            date_input = page.locator("#obs-date")
            date_input.fill("2026-06-18")
            trigger_and_wait(page, lambda: date_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            # 1. see if timezone and timeline time default to UT
            tz_select = page.locator("#tz-select")
            assert tz_select.input_value() == "UTC", f"Expected default display timezone to be 'UTC', got '{tz_select.input_value()}'"
            
            header = page.locator("#schedule-time-header")
            assert header.inner_text() == "Time (UT)", f"Expected default header to be 'Time (UT)', got '{header.inner_text()}'"
            
            # Load sample targets
            trigger_and_wait(page, lambda: page.locator("button#load-sample-btn").click())
            
            # Verify timeline ticks show UT primary
            ticks = page.locator(".timeline-axis .timeline-tick")
            assert ticks.count() > 0, "No timeline ticks rendered!"
            first_tick_html = ticks.first.inner_html()
            assert "Loc" in first_tick_html, f"Expected UT primary timeline (with 'Loc' secondary), got: {first_tick_html}"
            
            # Monitor API requests during subsequent actions
            request_count = 0
            def handle_request(request):
                nonlocal request_count
                if "/api/schedule" in request.url:
                    request_count += 1
            page.on("request", handle_request)
            
            # 2. change night limits timezone to local - no refit
            manual_tz = page.locator("#manual-night-tz")
            manual_tz.select_option("obs")
            page.wait_for_timeout(1000)
            
            assert request_count == 0, f"Changing limits timezone to Local triggered {request_count} refit request(s)!"
            assert tz_select.input_value() == "obs", "Display timezone dropdown did not sync to Local!"
            
            first_tick_html = page.locator(".timeline-axis .timeline-tick").first.inner_html()
            assert "UT" in first_tick_html, f"Expected Local primary timeline (with 'UT' secondary), got: {first_tick_html}"
            
            # 3. change night limits timezone back to UT - no refit
            manual_tz.select_option("UTC")
            page.wait_for_timeout(1000)
            
            assert request_count == 0, f"Changing limits timezone back to UT triggered {request_count} refit request(s)!"
            assert tz_select.input_value() == "UTC", "Display timezone dropdown did not sync to UT!"
            first_tick_html = page.locator(".timeline-axis .timeline-tick").first.inner_html()
            assert "Loc" in first_tick_html, f"Expected UT primary timeline (with 'Loc' secondary), got: {first_tick_html}"
            
            # 4. change night start to 08:00 UT
            request_count = 0
            start_input = page.locator("#manual-night-start")
            start_input.fill("08:00")
            trigger_and_wait(page, lambda: start_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            assert request_count > 0, "Changing night start time did not trigger refit!"
            
            # Check start times in table
            rows = page.locator("#schedule-table tbody tr")
            row_count = rows.count()
            science_scheduled = 0
            for i in range(row_count):
                row_text = rows.nth(i).inner_text()
                is_science = not any(calib in row_text for calib in ["BD+", "Feige", "HZ ", "HD19445"])
                if is_science:
                    science_scheduled += 1
                time_val = rows.nth(i).locator("input[type=text]").first.input_value()
                hh = int(time_val.split(":")[0])
                assert hh >= 8, f"Target scheduled before 08:00 UT! Time: {time_val}"
                
            assert science_scheduled > 0, f"Expected some science targets to remain, got {science_scheduled}"
            
            # 5. delete night start time
            request_count = 0
            start_input.fill("")
            trigger_and_wait(page, lambda: start_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            assert request_count > 0, "Clearing night start time did not trigger refit!"
            
            earliest_time = page.locator("#schedule-table tbody tr").first.locator("input[type=text]").first.input_value()
            earliest_hh = int(earliest_time.split(":")[0])
            assert earliest_hh < 8, f"Schedule did not revert to original! Earliest time: {earliest_time}"
            
            # 6. change night end to 10:00 UT
            request_count = 0
            end_input = page.locator("#manual-night-end")
            end_input.fill("10:00")
            trigger_and_wait(page, lambda: end_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            assert request_count > 0, "Changing night end time did not trigger refit!"
            
            rows = page.locator("#schedule-table tbody tr")
            row_count = rows.count()
            science_scheduled = 0
            for i in range(row_count):
                row_text = rows.nth(i).inner_text()
                is_science = not any(calib in row_text for calib in ["BD+", "Feige", "HZ ", "HD19445"])
                if is_science:
                    science_scheduled += 1
                end_val = rows.nth(i).locator("input[type=text]").nth(1).input_value()
                ehh = int(end_val.split(":")[0])
                emm = int(end_val.split(":")[1])
                assert ehh < 10 or (ehh == 10 and emm == 0), f"Target scheduled after 10:00 UT! Time: {end_val}"
                
            assert science_scheduled > 0, f"Expected some science targets to remain, got {science_scheduled}"
            
            # 7. make sure priority 1 and priority 3 targets are adjacent, toggle lock
            end_input.fill("")
            trigger_and_wait(page, lambda: end_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            vega_in_sched = page.locator("#schedule-table tbody tr", has_text="Vega").count()
            alpha_in_sched = page.locator("#schedule-table tbody tr", has_text="Alpha Centauri").count()
            assert vega_in_sched > 0, "Vega not scheduled!"
            assert alpha_in_sched > 0, "Alpha Centauri not scheduled!"
            
            blocks = page.locator(".timeline-block")
            block_count = blocks.count()
            block_info = []
            for i in range(block_count):
                el = blocks.nth(i)
                name = el.inner_text().strip()
                class_attr = el.get_attribute("class")
                prio = None
                if "priority-1" in class_attr:
                    prio = 1
                elif "priority-3" in class_attr:
                    prio = 3
                elif "priority-2" in class_attr:
                    prio = 2
                elif "priority-0" in class_attr:
                    prio = 0
                
                style = el.get_attribute("style")
                left_str = [s for s in style.split(";") if "left" in s][0].split(":")[1].replace("%", "").strip()
                left_val = float(left_str)
                block_info.append({"name": name, "prio": prio, "left": left_val})
            
            block_info.sort(key=lambda x: x["left"])
            
            has_adjacent = False
            for i in range(len(block_info) - 1):
                p1 = block_info[i]["prio"]
                p2 = block_info[i+1]["prio"]
                if (p1 == 1 and p2 == 3) or (p1 == 3 and p2 == 1):
                    has_adjacent = True
                    break
            
            assert has_adjacent, "No adjacent priority 1 and priority 3 targets on timeline!"
            
            # Click the lock button on Vega in the schedule table
            vega_row = page.locator("#schedule-table tbody tr", has_text="Vega").first
            lock_btn = vega_row.locator("button").first
            lock_btn.click()
            page.wait_for_timeout(1000)
            
            # Verify lock state
            assert "🔒" in lock_btn.inner_text(), "Locking Vega failed!"
            
            alpha_in_sched = page.locator("#schedule-table tbody tr", has_text="Alpha Centauri").count()
            assert alpha_in_sched > 0, "Locking Vega caused Alpha Centauri to drop from schedule!"
            
            # With Vega locked, change exposure time in the schedule table (which should trigger a refit)
            duration_input = vega_row.locator("input[type=number]").first
            duration_input.fill("45")
            trigger_and_wait(page, lambda: duration_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            # Verify exposure time is updated and Vega stays locked
            vega_row_updated = page.locator("#schedule-table tbody tr", has_text="Vega").first
            duration_input_updated = vega_row_updated.locator("input[type=number]").first
            assert duration_input_updated.input_value() == "45", "Vega exposure time was not updated!"
            
            lock_btn_updated = vega_row_updated.locator("button").first
            assert "🔒" in lock_btn_updated.inner_text(), "Vega did not stay locked after exposure time change!"
            
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()
