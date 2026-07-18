import os
import sys
import time
import subprocess
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

def parse_time(time_str):
    return datetime.strptime(time_str.strip(), "%H:%M")

def format_time(dt):
    return dt.strftime("%H:%M")

def test_drag_drop_behavior():
    # Start server on a unique port for this test
    server_process = subprocess.Popen(
        [sys.executable, "-u", "app.py"],
        env=dict(os.environ, PORT="8077", PYTHONUNBUFFERED="1")
    )
    time.sleep(4)
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.on("console", lambda msg: print(f"CONSOLE: {msg.text}"))
            page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))
            
            # Navigating to page
            page.goto("http://127.0.0.1:8077")
            page.evaluate("localStorage.clear();")
            page.reload()
            page.wait_for_timeout(2000)
            
            # 1. Verify Auto-Update defaults to off
            toggle = page.locator("#auto-update-toggle")
            assert not toggle.is_checked(), "Auto-update toggle should default to unchecked"
            
            # Load sample targets to populate timeline
            page.click("button#load-sample-btn")
            page.wait_for_timeout(3000)
            
            # Get original blocks
            original_blocks = []
            rows = page.locator("#schedule-table tbody tr")
            for i in range(rows.count()):
                cells = rows.nth(i).locator("td")
                if cells.count() < 5:
                    continue
                name = cells.nth(2).inner_text().strip()
                time_input = cells.nth(1).locator("input[type=text]")
                if time_input.count() > 0:
                    time_val = time_input.nth(0).input_value()
                else:
                    time_val = cells.nth(1).inner_text().strip()
                
                dur_input = cells.nth(4).locator("input")
                if dur_input.count() > 0:
                    dur_val = int(dur_input.nth(0).input_value())
                else:
                    dur_val = int(cells.nth(4).inner_text().strip())
                    
                original_blocks.append({"name": name, "time": time_val, "duration": dur_val})
                
            # Perform first drag-and-drop on the timeline: drag block 0 to block 1
            blocks = page.locator(".timeline-block")
            assert blocks.count() >= 3, "Timeline should render scheduled blocks"
            b0_name = blocks.nth(0).inner_text().split("\n")[0].strip()
            b1_name = blocks.nth(1).inner_text().split("\n")[0].strip()
            b2_name = blocks.nth(2).inner_text().split("\n")[0].strip()
            
            print(f"Original b0={b0_name}, b1={b1_name}, b2={b2_name}")
            
            page.evaluate("""
                (args) => {
                    const srcName = args[0];
                    const dstName = args[1];
                    const src = Array.from(document.querySelectorAll('.timeline-block')).find(el => el.firstElementChild && el.firstElementChild.innerText.trim() === srcName);
                    const dst = Array.from(document.querySelectorAll('.timeline-block')).find(el => el.firstElementChild && el.firstElementChild.innerText.trim() === dstName);
                    console.log("Timeline drag source:", srcName, src ? "found" : "not found");
                    console.log("Timeline drag target:", dstName, dst ? "found" : "not found");
                    if (!src || !dst) return;
                    
                    const dataTransfer = new DataTransfer();
                    dataTransfer.setData('text/plain', srcName);
                    
                    const dropEvent = new DragEvent('drop', {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: dataTransfer
                    });
                    dst.dispatchEvent(dropEvent);
                }
            """, [b0_name, b1_name])
            page.wait_for_timeout(2000)
            
            # Read after first drag/drop
            after_first = []
            rows = page.locator("#schedule-table tbody tr")
            for i in range(rows.count()):
                cells = rows.nth(i).locator("td")
                if cells.count() < 3:
                    continue
                name = cells.nth(2).inner_text().strip()
                time_input = cells.nth(1).locator("input[type=text]")
                if time_input.count() > 0:
                    time_val = time_input.nth(0).input_value()
                else:
                    time_val = cells.nth(1).inner_text().strip()
                after_first.append({"name": name, "time": time_val})
                
            # Verification:
            # 1. Touched blocks should adjust times sequentially based on new order
            b0_first = next(x for x in after_first if x["name"] == b0_name)
            b1_first = next(x for x in after_first if x["name"] == b1_name)
            b0_orig = next(x for x in original_blocks if x["name"] == b0_name)
            b1_orig = next(x for x in original_blocks if x["name"] == b1_name)
            
            # Since b0 (HZ 44) was dragged to b1 (BD+262606), BD+262606 is now first and HZ 44 is second.
            # BD+262606 starts at original b0 start time.
            assert b1_first["time"] == b0_orig["time"], f"{b1_name} should start at original {b0_name} time"
            
            # HZ 44 starts at BD+262606's new start + BD+262606 duration
            t_start_b1 = parse_time(b1_first["time"])
            t_expected_b0 = t_start_b1 + timedelta(minutes=b1_orig["duration"])
            assert b0_first["time"] == format_time(t_expected_b0), f"{b0_name} should start right after {b1_name} ends"
            
            # Perform second drag-and-drop on the schedule table: drag block 2 to block 0 (which is now BD+262606)
            print(f"Dragging on table: {b2_name} to {b1_name}")
            page.evaluate("""
                (args) => {
                    const srcName = args[0];
                    const dstName = args[1];
                    const src = document.getElementById('sched-row-' + srcName);
                    const dst = document.getElementById('sched-row-' + dstName);
                    console.log("Table drag source:", srcName, src ? "found" : "not found");
                    console.log("Table drag target:", dstName, dst ? "found" : "not found");
                    if (!src || !dst) return;
                    
                    const dataTransfer = new DataTransfer();
                    dataTransfer.setData('text/plain', srcName);
                    
                    const dropEvent = new DragEvent('drop', {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: dataTransfer
                    });
                    dst.dispatchEvent(dropEvent);
                }
            """, [b2_name, b1_name])
            page.wait_for_timeout(2000)
            
            # Read after second drag/drop
            after_second = []
            rows = page.locator("#schedule-table tbody tr")
            for i in range(rows.count()):
                cells = rows.nth(i).locator("td")
                if cells.count() < 3:
                    continue
                name = cells.nth(2).inner_text().strip()
                time_input = cells.nth(1).locator("input[type=text]")
                if time_input.count() > 0:
                    time_val = time_input.nth(0).input_value()
                else:
                    time_val = cells.nth(1).inner_text().strip()
                after_second.append({"name": name, "time": time_val})
                
            # Verify if second drag/drop registered
            idx_b2 = next(i for i, x in enumerate(after_second) if x["name"] == b2_name)
            idx_b1 = next(i for i, x in enumerate(after_second) if x["name"] == b1_name)
            assert idx_b2 < idx_b1, f"Second drag/drop did not swap {b2_name} and {b1_name} correctly"
            
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()
