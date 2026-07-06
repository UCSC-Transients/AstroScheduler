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
            
            # 8. Add target 2026pbk (priority 3), lock it, change exposure to 20m, start to 06:48, and verify priority 3 targets remain scheduled
            page.locator("input#t-name").fill("2026pbk")
            page.locator("input#t-ra").fill("18:00:00")
            page.locator("input#t-dec").fill("+40:00:00")
            page.locator("input#t-mag").fill("12.0")
            page.locator("select#t-prio").select_option("3")
            page.locator("select#t-sn").select_option("classification")
            
            trigger_and_wait(page, lambda: page.locator("#target-form button[type=submit]").click())
            
            pbk_row = page.locator("#schedule-table tbody tr", has_text="2026pbk").first
            pbk_lock_btn = pbk_row.locator("button").first
            pbk_lock_btn.click()
            page.wait_for_timeout(1000)
            
            pbk_dur_input = pbk_row.locator("input[type=number]").first
            pbk_dur_input.fill("20")
            trigger_and_wait(page, lambda: pbk_dur_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            pbk_row_updated = page.locator("#schedule-table tbody tr", has_text="2026pbk").first
            pbk_start_input = pbk_row_updated.locator("input[type=text]").nth(0)
            pbk_start_input.fill("06:48")
            trigger_and_wait(page, lambda: pbk_start_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            alpha_in_sched_final = page.locator("#schedule-table tbody tr", has_text="Alpha Centauri").count()
            assert alpha_in_sched_final > 0, "Changing locked priority 3 target exposure/start caused Alpha Centauri to disappear!"
            
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()

def test_user_target_list_solving():
    # Start local HTTP server on port 8056 for this integration test
    server_process = subprocess.Popen(
        [sys.executable, "-u", "app.py"],
        env=dict(os.environ, PORT="8056", PYTHONUNBUFFERED="1")
    )
    time.sleep(3) # Let Uvicorn boot
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.on("console", lambda msg: print("BROWSER CONSOLE:", msg.text))
            page.on("pageerror", lambda err: print("BROWSER ERROR:", err))
            
            # Navigate and wait for the initial automatic schedule request
            with page.expect_response(lambda r: "/api/schedule" in r.url and r.status == 200, timeout=30000):
                page.goto("http://127.0.0.1:8056")
            page.wait_for_timeout(500)
            
            # Dismiss confirmation dialog for clearing targets
            page.on("dialog", lambda dialog: dialog.accept())
            page.locator("button#clear-targets-btn").click()
            page.wait_for_timeout(1000)

            # Force date to 2026-06-19
            date_input = page.locator("#obs-date")
            date_input.fill("2026-06-19")
            date_input.evaluate("node => node.dispatchEvent(new Event('change'))")
            page.wait_for_timeout(1000)
            
            # Add all 15 targets from user's actual targets
            targets_data = [
                ("2026pjc", "23 06 55.00", "-00 39 39.45", "19.50"),
                ("2026nhr", "13 53 38.98", "+24 49 13.91", "20.42"),
                ("2026pbk", "14 47 24.04", "+50 28 01.03", "19.88"),
                ("2026pdd", "22 56 41.78", "+19 18 28.32", "19.26"),
                ("2026pel", "16 41 15.56", "+39 17 13.56", "17.26"),
                ("2026nlu", "23 25 00.95", "+14 58 54.47", "18.04"),
                ("2025rbs", "22 37 03.64", "+34 25 07.95", "18.59"),
                ("2026lda", "22 14 40.69", "+05 04 50.83", "17.71"),
                ("2026osq", "21 11 25.33", "+14 14 29.57", "17.19"),
                ("2026nym", "20 58 27.43", "+00 20 26.95", "19.76"),
                ("2026mho", "20 07 38.31", "-21 07 06.24", "15.82"),
                ("2026pir", "17 33 39.74", "+04 22 36.66", "16.84"),
                ("2026kyv", "17 33 03.67", "-03 45 29.01", "18.38"),
                ("2026nab", "16 20 28.85", "+36 44 11.37", "19.42"),
                ("2026ejy", "16 10 00.27", "+00 42 20.66", "16.62")
            ]
            
            for name, ra, dec, mag in targets_data:
                page.locator("input#t-name").fill(name)
                page.locator("input#t-ra").fill(ra)
                page.locator("input#t-dec").fill(dec)
                page.locator("input#t-mag").fill(mag)
                page.locator("select#t-prio").select_option("3")
                page.locator("select#t-sn").select_option("classification")
                trigger_and_wait(page, lambda: page.locator("#target-form button[type=submit]").click())
            
            # Enter manual start and duration in targets-table for 2026pbk
            pbk_row = page.locator("#target-row-2026pbk")
            dur_input = pbk_row.locator("input[type=number]").nth(2)
            dur_input.fill("20")
            trigger_and_wait(page, lambda: dur_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            pbk_row_updated = page.locator("#target-row-2026pbk")
            start_input = pbk_row_updated.locator("input[type=text]").nth(0)
            start_input.fill("06:48")
            trigger_and_wait(page, lambda: start_input.evaluate("node => node.dispatchEvent(new Event('change'))"))
            
            # Count scheduled targets in the schedule table
            rows = page.locator("#schedule-table tbody tr")
            scheduled_count = rows.count()
            
            # Count scheduled science targets (prio 3)
            scheduled_science = 0
            for i in range(scheduled_count):
                row_text = rows.nth(i).inner_text()
                is_science = not any(calib in row_text for calib in ["BD+", "Feige", "HZ ", "HD19445"])
                if is_science:
                    scheduled_science += 1
            
            # Verify other priority 3 targets did not disappear
            assert scheduled_science > 1, f"All priority 3 targets disappeared! Only {scheduled_science} science target scheduled."
            
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()
