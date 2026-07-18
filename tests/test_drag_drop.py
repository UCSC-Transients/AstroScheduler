import os
import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

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
                if cells.count() < 3:
                    continue
                name = cells.nth(2).inner_text().strip()
                time_input = cells.nth(1).locator("input[type=text]")
                if time_input.count() > 0:
                    time_val = time_input.nth(0).input_value()
                else:
                    time_val = cells.nth(1).inner_text().strip()
                original_blocks.append({"name": name, "time": time_val})
                
            # Perform first drag-and-drop: drag first block to second block
            blocks = page.locator(".timeline-block")
            assert blocks.count() >= 3, "Timeline should render scheduled blocks"
            b0_name = blocks.nth(0).inner_text().split("\n")[0].strip()
            b1_name = blocks.nth(1).inner_text().split("\n")[0].strip()
            b2_name = blocks.nth(2).inner_text().split("\n")[0].strip()
            
            page.evaluate("""
                (args) => {
                    const srcName = args[0];
                    const dstName = args[1];
                    const src = Array.from(document.querySelectorAll('.timeline-block')).find(el => el.firstElementChild && el.firstElementChild.innerText.trim() === srcName);
                    const dst = Array.from(document.querySelectorAll('.timeline-block')).find(el => el.firstElementChild && el.firstElementChild.innerText.trim() === dstName);
                    if (!src || !dst) return;
                    
                    const dataTransfer = new DataTransfer();
                    const dragStartEvent = new DragEvent('dragstart', {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: dataTransfer
                    });
                    src.dispatchEvent(dragStartEvent);
                    
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
            # 1. Touched blocks should swap times
            b0_first = next(x for x in after_first if x["name"] == b0_name)
            b1_first = next(x for x in after_first if x["name"] == b1_name)
            b0_orig = next(x for x in original_blocks if x["name"] == b0_name)
            b1_orig = next(x for x in original_blocks if x["name"] == b1_name)
            
            assert b0_first["time"] == b1_orig["time"], f"{b0_name} should swap times with {b1_name}"
            assert b1_first["time"] == b0_orig["time"], f"{b1_name} should swap times with {b0_name}"
            
            # 2. Untouched blocks must NOT change times when auto-update is off
            for orig in original_blocks:
                if orig["name"] in [b0_name, b1_name]:
                    continue
                af = next(x for x in after_first if x["name"] == orig["name"])
                assert orig["time"] == af["time"], f"Untouched block {orig['name']} should not have shifted times"
                
            # Perform second drag-and-drop: drag block 2 to block 0's new position
            page.evaluate("""
                (args) => {
                    const srcName = args[0];
                    const dstName = args[1];
                    const src = Array.from(document.querySelectorAll('.timeline-block')).find(el => el.firstElementChild && el.firstElementChild.innerText.trim() === srcName);
                    const dst = Array.from(document.querySelectorAll('.timeline-block')).find(el => el.firstElementChild && el.firstElementChild.innerText.trim() === dstName);
                    if (!src || !dst) return;
                    
                    const dataTransfer = new DataTransfer();
                    const dragStartEvent = new DragEvent('dragstart', {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: dataTransfer
                    });
                    src.dispatchEvent(dragStartEvent);
                    
                    const dropEvent = new DragEvent('drop', {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: dataTransfer
                    });
                    dst.dispatchEvent(dropEvent);
                }
            """, [b2_name, b0_name])
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
                
            # Verification:
            # 1. Second drag/drop successfully registered
            idx_b2 = next(i for i, x in enumerate(after_second) if x["name"] == b2_name)
            idx_b0 = next(i for i, x in enumerate(after_second) if x["name"] == b0_name)
            assert idx_b2 < idx_b0, f"Second drag/drop did not swap {b2_name} and {b0_name} correctly"
            
            # 2. Block 2 should now start at what was Block 0's start time after first swap
            b2_second = next(x for x in after_second if x["name"] == b2_name)
            assert b2_second["time"] == b0_first["time"], f"{b2_name} should swap times with {b0_name}"
            
            browser.close()
    finally:
        server_process.terminate()
        server_process.wait()
