// AstroScheduler Frontend Logic with Client-Side Solver Fallback

function formatRA(raHours) {
    if (isNaN(raHours)) return "";
    const h = Math.floor(raHours);
    const mDec = (raHours - h) * 60.0;
    const m = Math.floor(mDec);
    const s = ((mDec - m) * 60.0);
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s.toFixed(1)).padStart(4, '0');
    return `${hh}:${mm}:${ss}`;
}

function formatDec(decDeg) {
    if (isNaN(decDeg)) return "";
    const sign = decDeg < 0 ? "-" : "+";
    const absDec = Math.abs(decDeg);
    const d = Math.floor(absDec);
    const mDec = (absDec - d) * 60.0;
    const m = Math.floor(mDec);
    const s = Math.round((mDec - m) * 60.0);
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return `${sign}${dd}:${mm}:${ss}`;
}

function parseCoordinate(val, isRa = false) {
    if (typeof val === 'number') {
        return isRa ? val / 15.0 : val;
    }
    const s = String(val).trim();
    if (!s) return NaN;

    // Check for sexagesimal formats
    let cleaned = s.replace(/[hmsd°'"hmsHMSD\u2032\u2033]/g, ' ');
    cleaned = cleaned.replace(/:/g, ' ');
    const parts = cleaned.split(/\s+/).filter(Boolean);

    if (parts.length > 1) {
        let sign = 1.0;
        let firstPart = parts[0];
        if (firstPart.startsWith("-")) {
            sign = -1.0;
            firstPart = firstPart.slice(1);
        } else if (firstPart.startsWith("+")) {
            firstPart = firstPart.slice(1);
        }

        const d = parseFloat(firstPart);
        const m = parseFloat(parts[1]) || 0.0;
        const sec = parseFloat(parts[2]) || 0.0;

        const decimalVal = sign * (d + m / 60.0 + sec / 3600.0);
        return decimalVal;
    }

    const valFloat = parseFloat(s);
    if (isNaN(valFloat)) return NaN;
    return isRa ? valFloat / 15.0 : valFloat;
}

// Global Application State
let targetPool = [];
let airmassChart = null;
let currentBlocksList = [];
let lastScheduleResult = null;
let currentTimezone = 'obs';
let standardStars = [];
let disabledStandards = new Set();
let selectedStandards = new Set();
let autoStandardsMode = true;

// Initial Setup on Page Load
document.addEventListener("DOMContentLoaded", () => {
    // Set default date to 2026-06-18 (user's target date)
    document.getElementById("obs-date").value = "2026-06-18";

    // Add Event Listeners
    document.getElementById("target-form").addEventListener("submit", handleAddTarget);
    document.getElementById("run-schedule-btn").addEventListener("click", triggerScheduling);
    document.getElementById("load-sample-btn").addEventListener("click", loadSampleTargets);
    document.getElementById("clear-targets-btn").addEventListener("click", clearAllTargets);
    document.getElementById("obs-date").addEventListener("change", triggerScheduling);

    // Load local storage if available, otherwise load samples
    const stored = localStorage.getItem("targetPool");
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                targetPool = parsed.map((t, idx) => {
                    const clean = {
                        name: t.name || "Unnamed",
                        ra: 0.0,
                        dec: 0.0,
                        magnitude: 12.0,
                        priority: 2.0,
                        sn_mode: t.sn_mode || "normal",
                        allow_twilight: !!t.allow_twilight,
                        high_airmass: !!t.high_airmass,
                        comment: t.comment || "",
                        manual_start_time: t.manual_start_time || null,
                        manual_duration: (t.manual_duration !== undefined && t.manual_duration !== null) ? parseFloat(t.manual_duration) : null,
                        schedule_before: Array.isArray(t.schedule_before) ? t.schedule_before : [],
                        status: t.status || null,
                        inputIndex: t.inputIndex !== undefined ? t.inputIndex : idx
                    };

                    if (typeof t.ra === 'number') clean.ra = t.ra;
                    else {
                        const parsedRa = parseCoordinate(t.ra, true);
                        clean.ra = isNaN(parsedRa) ? 0.0 : parsedRa;
                    }

                    if (typeof t.dec === 'number') clean.dec = t.dec;
                    else {
                        const parsedDec = parseCoordinate(t.dec, false);
                        clean.dec = isNaN(parsedDec) ? 0.0 : parsedDec;
                    }

                    if (t.magnitude !== undefined && t.magnitude !== null) {
                        const val = parseFloat(t.magnitude);
                        if (!isNaN(val)) clean.magnitude = val;
                    }

                    if (t.priority !== undefined && t.priority !== null) {
                        const val = parseFloat(t.priority);
                        if (!isNaN(val)) clean.priority = val;
                    }

                    if (t.manual_duration !== undefined && t.manual_duration !== null) {
                        const val = parseFloat(t.manual_duration);
                        if (!isNaN(val)) clean.manual_duration = val;
                    }

                    return clean;
                });
                renderTargetsTable();
                triggerScheduling();
            } else {
                loadSampleTargets();
            }
        } catch (e) {
            console.error("Error parsing targetPool from localStorage, loading samples:", e);
            loadSampleTargets();
        }
    } else {
        loadSampleTargets();
    }

    // Register drag & drop zone for file upload
    const dropZone = document.getElementById("target-drag-drop");
    if (dropZone) {
        dropZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            dropZone.classList.add("dragover");
        });
        dropZone.addEventListener("dragleave", () => {
            dropZone.classList.remove("dragover");
        });
        dropZone.addEventListener("drop", (e) => {
            e.preventDefault();
            dropZone.classList.remove("dragover");
            const file = e.dataTransfer.files[0];
            if (file) {
                processTargetFile(file);
            }
        });
    }

    // Load standard stars and init drag zoom
    loadStandardStars();
    initAirmassChartDragZoom();
    updateNightOverridePlaceholders();
    renderTerminalLog();
});


// ==============================================================================
// TARGET POOL CRUD OPERATIONS
// ==============================================================================

function handleAddTarget(e) {
    e.preventDefault();

    const name = document.getElementById("t-name").value.trim();
    const raRaw = document.getElementById("t-ra").value.trim();
    const decRaw = document.getElementById("t-dec").value.trim();
    const magnitude = parseFloat(document.getElementById("t-mag").value);
    const priority = parseFloat(document.getElementById("t-prio").value);
    const sn_mode = document.getElementById("t-sn").value;
    const allow_twilight = document.getElementById("t-twilight").checked;
    const high_airmass = document.getElementById("t-airmass").checked;
    const comment = document.getElementById("t-comment").value.trim();

    const ra = parseCoordinate(raRaw, true);
    const dec = parseCoordinate(decRaw, false);

    if (isNaN(ra) || isNaN(dec)) {
        alert("Could not parse Right Ascension or Declination. Please verify sexagesimal or decimal format.");
        return;
    }

    // Check if target name already exists
    const existingIdx = targetPool.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    const existing = existingIdx >= 0 ? targetPool[existingIdx] : null;

    const targetObj = {
        name,
        ra,
        dec,
        magnitude,
        priority,
        sn_mode,
        allow_twilight,
        high_airmass,
        comment,
        manual_start_time: existing ? existing.manual_start_time : null,
        manual_duration: existing ? existing.manual_duration : null,
        schedule_before: existing ? existing.schedule_before : [],
        inputIndex: existing ? (existing.inputIndex !== undefined ? existing.inputIndex : targetPool.length) : targetPool.length
    };

    if (existingIdx >= 0) {
        targetPool[existingIdx] = targetObj;
    } else {
        targetPool.push(targetObj);
    }

    saveAndRefresh();
    document.getElementById("target-form").reset();
}

function deleteTarget(name) {
    targetPool = targetPool.filter(t => t.name !== name);
    saveAndRefresh();
}

function editTarget(name) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;

    document.getElementById("t-name").value = target.name;
    document.getElementById("t-ra").value = formatRA(target.ra);
    document.getElementById("t-dec").value = formatDec(target.dec);
    document.getElementById("t-mag").value = target.magnitude;
    document.getElementById("t-prio").value = target.priority;
    document.getElementById("t-sn").value = target.sn_mode;
    document.getElementById("t-twilight").checked = target.allow_twilight;
    document.getElementById("t-airmass").checked = target.high_airmass;
    document.getElementById("t-comment").value = target.comment;

    document.getElementById("target-form").scrollIntoView({ behavior: 'smooth' });
}

function clearAllTargets() {
    if (confirm("Are you sure you want to clear all targets?")) {
        targetPool = [];
        saveAndRefresh();
    }
}

function loadSampleTargets() {
    targetPool = [
        { name: "Vega", ra: 18.616, dec: 38.78, magnitude: 0.0, priority: 1.0, sn_mode: "classification", allow_twilight: true, high_airmass: false, comment: "Standard calibrator, bright", manual_start_time: null, manual_duration: null, schedule_before: [] },
        { name: "M57 Ring Nebula", ra: 18.893, dec: 33.03, magnitude: 8.8, priority: 1.0, sn_mode: "normal", allow_twilight: false, high_airmass: false, comment: "Central planetary nebula core", manual_start_time: null, manual_duration: null, schedule_before: [] },
        { name: "NGC 6791", ra: 19.348, dec: 37.77, magnitude: 9.5, priority: 2.0, sn_mode: "normal", allow_twilight: false, high_airmass: false, comment: "Old open cluster", manual_start_time: null, manual_duration: null, schedule_before: [] },
        { name: "Cygnus X-1", ra: 19.972, dec: 35.20, magnitude: 8.9, priority: 2.0, sn_mode: "high_sn", allow_twilight: false, high_airmass: false, comment: "High mass X-ray binary", manual_start_time: null, manual_duration: null, schedule_before: [] },
        { name: "M27 Dumbbell", ra: 19.993, dec: 22.72, magnitude: 7.5, priority: 1.0, sn_mode: "high_sn", allow_twilight: false, high_airmass: false, comment: "Bright planetary nebula", manual_start_time: null, manual_duration: null, schedule_before: [] },
        { name: "Albireo", ra: 19.512, dec: 27.96, magnitude: 3.1, priority: 1.0, sn_mode: "normal", allow_twilight: false, high_airmass: false, comment: "Double star separation check", manual_start_time: null, manual_duration: null, schedule_before: [] },
        { name: "Alpha Centauri", ra: 14.656, dec: -60.83, magnitude: -0.27, priority: 3.0, sn_mode: "classification", allow_twilight: false, high_airmass: false, comment: "Wrong hemisphere", manual_start_time: null, manual_duration: null, schedule_before: [] }
    ].map((t, idx) => ({ ...t, inputIndex: idx }));
    saveAndRefresh();
}

function saveAndRefresh(rebuildTable = true) {
    localStorage.setItem("targetPool", JSON.stringify(targetPool));
    if (rebuildTable) {
        renderTargetsTable();
    }
    triggerScheduling();
}


// ==============================================================================
// UI RENDERING HELPERS
// ==============================================================================

let currentSortField = 'priority';
let currentSortAsc = true;

function sortTargetPool() {
    if (currentSortField === 'schedule') {
        // Already sorted in changeTargetSorting
        return;
    }
    targetPool.sort((a, b) => {
        let valA, valB;
        if (currentSortField === 'priority') {
            valA = a.priority !== undefined ? parseFloat(a.priority) : 0;
            valB = b.priority !== undefined ? parseFloat(b.priority) : 0;
            if (valA !== valB) {
                return currentSortAsc ? (valA - valB) : (valB - valA);
            }
            return a.name.localeCompare(b.name);
        } else if (currentSortField === 'input') {
            valA = a.inputIndex !== undefined ? a.inputIndex : 0;
            valB = b.inputIndex !== undefined ? b.inputIndex : 0;
        } else if (currentSortField === 'name') {
            return currentSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
        } else if (currentSortField === 'magnitude') {
            valA = a.magnitude !== undefined ? parseFloat(a.magnitude) : 0;
            valB = b.magnitude !== undefined ? parseFloat(b.magnitude) : 0;
        } else if (currentSortField === 'ra') {
            valA = a.ra !== undefined ? parseFloat(a.ra) : 0;
            valB = b.ra !== undefined ? parseFloat(b.ra) : 0;
        } else if (currentSortField === 'dec') {
            valA = a.dec !== undefined ? parseFloat(a.dec) : 0;
            valB = b.dec !== undefined ? parseFloat(b.dec) : 0;
        }

        if (valA < valB) return currentSortAsc ? -1 : 1;
        if (valA > valB) return currentSortAsc ? 1 : -1;
        return a.name.localeCompare(b.name);
    });
}

function setTargetSort(field) {
    if (currentSortField === field) {
        currentSortAsc = !currentSortAsc;
    } else {
        currentSortField = field;
        currentSortAsc = true;
    }
    // Update the dropdown value to match header click
    const select = document.getElementById("sort-select");
    if (select) {
        if (field === 'priority') select.value = 'prio';
        else if (field === 'name') select.value = 'name';
        else if (field === 'ra') select.value = 'ra';
        else if (field === 'magnitude') select.value = 'mag';
        else select.value = 'input';
    }
    renderTargetsTable();
}

function changeTargetSorting(val) {
    if (val === 'input') {
        currentSortField = 'input';
        currentSortAsc = true;
    } else if (val === 'name') {
        currentSortField = 'name';
        currentSortAsc = true;
    } else if (val === 'ra') {
        currentSortField = 'ra';
        currentSortAsc = true;
    } else if (val === 'mag') {
        currentSortField = 'magnitude';
        currentSortAsc = true;
    } else if (val === 'prio') {
        currentSortField = 'priority';
        currentSortAsc = true;
    } else if (val === 'schedule') {
        currentSortField = 'schedule';
        targetPool.sort((a, b) => {
            const idxA = lastScheduleResult ? lastScheduleResult.blocks.findIndex(bl => bl.target_name === a.name) : -1;
            const idxB = lastScheduleResult ? lastScheduleResult.blocks.findIndex(bl => bl.target_name === b.name) : -1;
            const posA = idxA !== -1 ? idxA : 999999;
            const posB = idxB !== -1 ? idxB : 999999;
            if (posA !== posB) return posA - posB;
            return a.name.localeCompare(b.name);
        });
        updateSortIcons();
        renderTargetsTable();
        return;
    }
    renderTargetsTable();
}

function updateSortIcons() {
    const fields = ['name', 'ra', 'dec', 'magnitude', 'priority'];
    fields.forEach(f => {
        const el = document.getElementById(`sort-icon-${f}`);
        if (el) {
            if (currentSortField === f) {
                el.innerText = currentSortAsc ? " ▲" : " ▼";
                el.style.color = "#38bdf8";
            } else {
                el.innerText = "";
            }
        }
    });
}

function renderTargetsTable() {
    const tbody = document.querySelector("#targets-table tbody");
    if (targetPool.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" class="text-center">No targets in pool</td></tr>`;
        return;
    }

    sortTargetPool();

    tbody.innerHTML = targetPool.map(t => {
        const statusText = getTargetStatus(t, lastScheduleResult);

        let rowClass = "";
        if (statusText === "Unobservable") {
            rowClass = "status-row-unobservable";
        }

        let statusClass = "status-pill status-not-scheduled";
        let dotClass = "status-dot-not-scheduled";
        let indicatorColor = "#f97316";

        if (statusText === "Observed") {
            statusClass = "status-pill status-observed";
            dotClass = "status-dot-observed";
            indicatorColor = "#10b981";
        } else if (statusText === "Scheduled") {
            statusClass = "status-pill status-scheduled";
            dotClass = "status-dot-scheduled";
            indicatorColor = "#10b981";
        } else if (statusText === "Not Scheduled") {
            statusClass = "status-pill status-not-scheduled";
            dotClass = "status-dot-not-scheduled";
            indicatorColor = "#f97316";
        } else if (statusText === "Failed") {
            statusClass = "status-pill status-failed";
            dotClass = "status-dot-failed";
            indicatorColor = "#ef4444";
        } else if (statusText === "Punted") {
            statusClass = "status-pill status-punted";
            dotClass = "status-dot-punted";
            indicatorColor = "#ef4444";
        } else if (statusText === "Skipped") {
            statusClass = "status-pill status-skipped";
            dotClass = "status-dot-skipped";
            indicatorColor = "#ef4444";
        } else if (statusText === "Unobservable") {
            statusClass = "status-pill status-unobservable";
            dotClass = "status-dot-unobservable";
            indicatorColor = "#64748b";
        }

        return `
            <tr id="target-row-${t.name}" data-target="${t.name}"
                class="${rowClass}"
                onmouseenter="highlightTarget('${t.name}')"
                onmouseleave="unhighlightTarget('${t.name}')"
                onclick="stickyHighlightTarget('${t.name}')"
                style="cursor: pointer;">
                <td style="text-align: center; width: 30px;">
                    <span class="status-indicator-circle" id="indicator-${t.name}" style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: ${indicatorColor}; vertical-align: middle; transition: background-color 0.3s ease;"></span>
                </td>
                <td><strong>${t.name}</strong></td>
                <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-primary);">${formatRA(t.ra)}</td>
                <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-primary);">${formatDec(t.dec)}</td>
                <td>
                    <input type="number" step="0.1" value="${t.magnitude.toFixed(1)}"
                           onchange="updateTargetField('${t.name}', 'magnitude', this.value)"
                           onclick="event.stopPropagation();" style="width: 60px;">
                </td>
                <td>
                    <input type="number" step="0.1" value="${t.priority}"
                           onchange="updateTargetField('${t.name}', 'priority', this.value)"
                           onclick="event.stopPropagation();" style="width: 60px;">
                </td>
                <td>
                    <select onchange="updateTargetField('${t.name}', 'sn_mode', this.value)"
                            onclick="event.stopPropagation();" style="width: 110px;">
                        <option value="classification" ${t.sn_mode === 'classification' ? 'selected' : ''}>Classification</option>
                        <option value="normal" ${t.sn_mode === 'normal' ? 'selected' : ''}>Normal</option>
                        <option value="high_sn" ${t.sn_mode === 'high_sn' ? 'selected' : ''}>High S/N</option>
                    </select>
                </td>
                <td>
                    <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem;" onclick="event.stopPropagation();">
                        <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                            <input type="checkbox" ${t.allow_twilight ? 'checked' : ''}
                                   onchange="updateTargetCheckbox('${t.name}', 'allow_twilight', this.checked)"> Twil
                        </label>
                        <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                            <input type="checkbox" ${t.high_airmass ? 'checked' : ''}
                                   onchange="updateTargetCheckbox('${t.name}', 'high_airmass', this.checked)"> Airmass
                        </label>
                    </div>
                </td>
                <td>
                    <input type="text" placeholder="HH:MM" value="${t.manual_start_time ? formatTimeForTimezone(t.manual_start_time, currentTimezone) : ''}"
                           onchange="updateTargetManualStart('${t.name}', this.value)"
                           onclick="event.stopPropagation();" style="width: 75px; font-family: monospace; text-align: center;">
                </td>
                <td>
                    <input type="number" placeholder="min" min="0" value="${t.manual_duration !== null && t.manual_duration !== undefined ? t.manual_duration : ''}"
                           onchange="updateTargetField('${t.name}', 'manual_duration', this.value)"
                           onclick="event.stopPropagation();" style="width: 65px; text-align: center;">
                </td>
                <td><span class="${statusClass}" id="status-${t.name}"><span class="target-status-dot ${dotClass}"></span>${statusText}</span></td>
                <td>
                    <input type="text" value="${t.comment || ''}"
                           onchange="updateTargetField('${t.name}', 'comment', this.value)"
                           onclick="event.stopPropagation();" style="width: 100%; min-width: 120px;">
                </td>
                <td>
                    <div class="action-links" onclick="event.stopPropagation();">
                        <button onclick="deleteTarget('${t.name}')" class="action-link delete-link">Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    updateSortIcons();
    populateActiveTargetSelect();
}

function updateTargetField(name, field, val) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;

    if (field === 'magnitude') {
        target.magnitude = parseFloat(val) || 0.0;
    } else if (field === 'priority') {
        target.priority = parseFloat(val) || 1.0;
    } else if (field === 'sn_mode') {
        target.sn_mode = val;
    } else if (field === 'comment') {
        target.comment = val;
    } else if (field === 'manual_start_time') {
        target.manual_start_time = val.trim() || null;
    } else if (field === 'manual_duration') {
        target.manual_duration = val.trim() ? parseFloat(val) : null;
    } else if (field === 'ra') {
        const parsed = parseCoordinate(val, true);
        if (!isNaN(parsed)) {
            target.ra = parsed;
        }
    } else if (field === 'dec') {
        const parsed = parseCoordinate(val, false);
        if (!isNaN(parsed)) {
            target.dec = parsed;
        }
    }
    saveAndRefresh(false);
}

function updateTargetCheckbox(name, field, checked) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;

    target[field] = !!checked;
    saveAndRefresh(false);
}

function clearAllOverrides() {
    targetPool.forEach(t => {
        t.manual_start_time = null;
        t.manual_duration = null;
        t.schedule_before = [];
        if (t.status === "Observed") {
            t.status = "";
        }
    });
    saveAndRefresh();
}

let stickyHighlightedTarget = null;

function highlightTarget(name) {
    const row = document.getElementById(`target-row-${name}`);
    if (row) row.classList.add("row-highlighted");

    const schedRow = document.getElementById(`sched-row-${name}`);
    if (schedRow) schedRow.classList.add("row-highlighted");

    const block = document.querySelector(`.timeline-block[data-target="${name}"]`);
    if (block) block.classList.add("block-highlighted");
}

function unhighlightTarget(name) {
    if (stickyHighlightedTarget === name) return;

    const row = document.getElementById(`target-row-${name}`);
    if (row) row.classList.remove("row-highlighted");

    const schedRow = document.getElementById(`sched-row-${name}`);
    if (schedRow) schedRow.classList.remove("row-highlighted");

    const block = document.querySelector(`.timeline-block[data-target="${name}"]`);
    if (block) block.classList.remove("block-highlighted");
}

function stickyHighlightTarget(name) {
    if (stickyHighlightedTarget) {
        const prev = stickyHighlightedTarget;
        stickyHighlightedTarget = null;
        unhighlightTarget(prev);
    }

    stickyHighlightedTarget = name;
    highlightTarget(name);

    // Scroll target pool row into view
    const targetRow = document.getElementById(`target-row-${name}`);
    if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Scroll schedule row into view
    const schedRow = document.getElementById(`sched-row-${name}`);
    if (schedRow) {
        schedRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Scroll timeline block into view
    const block = document.querySelector(`.timeline-block[data-target="${name}"]`);
    if (block) {
        block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Sync with Real-Time Active Target Select
    const activeTargetSelect = document.getElementById("rt-active-target");
    if (activeTargetSelect) {
        const hasOption = Array.from(activeTargetSelect.options).some(opt => opt.value === name);
        if (hasOption) {
            activeTargetSelect.value = name;
        }
    }
}

// Timezone & Formatting Utilities
function formatTimeForTimezone(isoStr, tz) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return "";

    if (tz === 'UTC') {
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const mm = String(date.getUTCMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } else if (tz === 'browser') {
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    } else if (tz === 'obs') {
        try {
            const options = { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false };
            const formatted = new Intl.DateTimeFormat("en-US", options).format(date);
            return formatted;
        } catch (e) {
            const pdtDate = new Date(date.getTime() - 7 * 60 * 60 * 1000);
            const hh = String(pdtDate.getUTCHours()).padStart(2, '0');
            const mm = String(pdtDate.getUTCMinutes()).padStart(2, '0');
            return `${hh}:${mm}`;
        }
    } else if (tz && tz.startsWith('UTC')) {
        const offsetStr = tz.replace('UTC', '');
        const offset = parseFloat(offsetStr) || 0;
        const tzDate = new Date(date.getTime() + offset * 60 * 60 * 1000);
        const hh = String(tzDate.getUTCHours()).padStart(2, '0');
        const mm = String(tzDate.getUTCMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    return isoStr.substring(11, 16);
}

function parseTimeInputToISO(timeStr, dateStr, tz) {
    if (!timeStr) return null;
    const parts = timeStr.trim().split(':');
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm)) return null;

    let sunset = null;
    let sunrise = null;
    if (lastScheduleResult && lastScheduleResult.solar_times) {
        sunset = new Date(lastScheduleResult.solar_times.sunset);
        sunrise = new Date(lastScheduleResult.solar_times.sunrise);
    } else {
        const dateParts = dateStr.split('-');
        const year = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1;
        const day = parseInt(dateParts[2], 10);
        const localNoon = new Date(year, month, day, 12, 0, 0);
        const offsetHours = 8.109; // Lick offset W
        const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
        const solarTimes = getSolarTimesFallback(utcNoon, 37.3414, -121.6429, 1283);
        sunset = solarTimes.sunset;
        sunrise = solarTimes.sunrise;
    }

    function makeDateForDay(baseDate) {
        const year = baseDate.getUTCFullYear();
        const month = baseDate.getUTCMonth();
        const day = baseDate.getUTCDate();

        let date;
        if (tz === 'UTC') {
            date = new Date(Date.UTC(year, month, day, hh, mm));
        } else if (tz === 'browser') {
            const localYear = baseDate.getFullYear();
            const localMonth = baseDate.getMonth();
            const localDay = baseDate.getDate();
            date = new Date(localYear, localMonth, localDay, hh, mm);
        } else if (tz === 'obs') {
            const temp = new Date(Date.UTC(year, month, day, hh, mm));
            let offsetHours = -7;
            try {
                const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
                const formatted = formatter.format(temp);
                const match = formatted.match(/GMT([-+]\d+(\.\d+)?)/);
                if (match) {
                    offsetHours = parseFloat(match[1]);
                }
            } catch (e) {}
            date = new Date(Date.UTC(year, month, day, hh - offsetHours, mm));
        } else if (tz && tz.startsWith('UTC')) {
            const offsetStr = tz.replace('UTC', '');
            const offset = parseFloat(offsetStr) || 0;
            date = new Date(Date.UTC(year, month, day, hh - offset, mm));
        } else {
            date = new Date(Date.UTC(year, month, day, hh, mm));
        }
        return date;
    }

    const candA = makeDateForDay(sunset);
    const candB = makeDateForDay(sunrise);

    const tSunset = sunset.getTime();
    const tSunrise = sunrise.getTime();
    const tA = candA.getTime();
    const tB = candB.getTime();

    const aInNight = (tA >= tSunset - 5 * 60 * 1000 && tA <= tSunrise + 5 * 60 * 1000);
    const bInNight = (tB >= tSunset - 5 * 60 * 1000 && tB <= tSunrise + 5 * 60 * 1000);

    if (aInNight) {
        return candA.toISOString();
    } else if (bInNight) {
        return candB.toISOString();
    } else {
        const midPoint = (tSunset + tSunrise) / 2;
        const diffA = Math.abs(tA - midPoint);
        const diffB = Math.abs(tB - midPoint);
        return (diffA < diffB ? candA : candB).toISOString();
    }
}

function formatLST(lstVal) {
    if (isNaN(lstVal)) return "";
    const hours = Math.floor(lstVal);
    const mins = Math.floor((lstVal - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} LST`;
}

function getLickTimezoneOffsetHours(date) {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
        const formatted = formatter.format(date);
        const match = formatted.match(/GMT([-+]\d+(\.\d+)?)/);
        if (match) {
            return parseFloat(match[1]);
        }
    } catch (e) {}
    const month = date.getMonth();
    return (month >= 2 && month <= 10) ? -7 : -8;
}

function changeTimezone(val) {
    currentTimezone = val;
    if (lastScheduleResult) {
        updateScheduleUI(lastScheduleResult);
    }
}

function getSchedulingPayloadWithTargets(targetsList) {
    const date = document.getElementById("obs-date").value;
    const disabledArray = Array.from(disabledStandards);

    const extinction = parseFloat(document.getElementById("rt-extinction")?.value) || 0.0;
    const magLimitInput = document.getElementById("rt-mag-limit")?.value;
    const mag_limit = (magLimitInput !== undefined && magLimitInput !== "") ? parseFloat(magLimitInput) : null;

    const haLimitEastInput = document.getElementById("rt-ha-limit-east")?.value;
    const ha_limit_east = (haLimitEastInput !== undefined && haLimitEastInput !== "") ? parseFloat(haLimitEastInput) : null;

    const haLimitWestInput = document.getElementById("rt-ha-limit-west")?.value;
    const ha_limit_west = (haLimitWestInput !== undefined && haLimitWestInput !== "") ? parseFloat(haLimitWestInput) : null;

    const altLimitInput = document.getElementById("rt-alt-limit")?.value;
    const alt_limit = (altLimitInput !== undefined && altLimitInput !== "") ? parseFloat(altLimitInput) : null;

    const altMaxInput = document.getElementById("rt-alt-max")?.value;
    const alt_max = (altMaxInput !== undefined && altMaxInput !== "") ? parseFloat(altMaxInput) : null;

    const decMinInput = document.getElementById("rt-dec-min")?.value;
    const dec_min = (decMinInput !== undefined && decMinInput !== "") ? parseFloat(decMinInput) : null;

    const decMaxInput = document.getElementById("rt-dec-max")?.value;
    const dec_max = (decMaxInput !== undefined && decMaxInput !== "") ? parseFloat(decMaxInput) : null;

    const azMinInput = document.getElementById("rt-az-min")?.value;
    const az_min = (azMinInput !== undefined && azMinInput !== "") ? parseFloat(azMinInput) : null;

    const azMaxInput = document.getElementById("rt-az-max")?.value;
    const az_max = (azMaxInput !== undefined && azMaxInput !== "") ? parseFloat(azMaxInput) : null;

    const manualStartInput = document.getElementById("manual-night-start")?.value || "";
    const manualEndInput = document.getElementById("manual-night-end")?.value || "";
    const manualTz = document.getElementById("manual-night-tz")?.value || "UTC";

    const manual_limits_enabled = !!(manualStartInput.trim() || manualEndInput.trim());

    let night_start_override = null;
    let night_end_override = null;

    if (manual_limits_enabled) {
        try {
            const dateParts = date.split('-');
            const localNoon = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0);
            const lickOffset = getLickTimezoneOffsetHours(localNoon);
            const offsetHours = -lickOffset;
            const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
            const solarTimes = getSolarTimesFallback(utcNoon, 37.3414, -121.6429, 1283);

            let sunset = new Date(solarTimes.sunset);
            let sunrise = new Date(solarTimes.sunrise);

            const startParts = manualStartInput.trim() ? manualStartInput.split(':').map(Number) : [];
            const isStartValid = startParts.length === 2 && !isNaN(startParts[0]) && !isNaN(startParts[1]);
            const endParts = manualEndInput.trim() ? manualEndInput.split(':').map(Number) : [];
            const isEndValid = endParts.length === 2 && !isNaN(endParts[0]) && !isNaN(endParts[1]);

            let shh, smm, ehh, emm;

            if (manualTz === 'UTC') {
                if (isStartValid) {
                    [shh, smm] = startParts;
                    sunset.setUTCHours(shh, smm, 0, 0);
                }
                if (isEndValid) {
                    [ehh, emm] = endParts;
                    sunrise.setUTCHours(ehh, emm, 0, 0);
                }
                if (sunrise.getTime() < sunset.getTime()) {
                    sunrise.setTime(sunrise.getTime() + 24 * 60 * 60 * 1000);
                }
            } else {
                const yr = parseInt(dateParts[0]);
                const mo = parseInt(dateParts[1]) - 1;
                const dy = parseInt(dateParts[2]);
                const offsetMs = offsetHours * 60 * 60 * 1000;

                const sunsetLocal = new Date(sunset.getTime() - offsetMs);
                const sunriseLocal = new Date(sunrise.getTime() - offsetMs);

                if (isStartValid) {
                    [shh, smm] = startParts;
                } else {
                    shh = sunsetLocal.getUTCHours();
                    smm = sunsetLocal.getUTCMinutes();
                }

                if (isEndValid) {
                    [ehh, emm] = endParts;
                } else {
                    ehh = sunriseLocal.getUTCHours();
                    emm = sunriseLocal.getUTCMinutes();
                }

                const candStartLocal = new Date(Date.UTC(yr, mo, dy, shh, smm) + offsetMs);
                let endDayOffset = 0;
                if (ehh < shh) {
                    endDayOffset = 24 * 60 * 60 * 1000;
                }
                const candEndLocal = new Date(Date.UTC(yr, mo, dy, ehh, emm) + offsetMs + endDayOffset);

                sunset = candStartLocal;
                sunrise = candEndLocal;
            }

            night_start_override = sunset.toISOString();
            night_end_override = sunrise.toISOString();
        } catch (e) {
            console.error("Error parsing manual night limits", e);
        }
    }

    const realtime_constraints = {
        extinction,
        mag_limit,
        ha_limit_east,
        ha_limit_west,
        alt_limit,
        alt_max,
        dec_min,
        dec_max,
        az_min,
        az_max,
        manual_limits_enabled,
        manual_limit_start: manualStartInput.trim(),
        manual_limit_end: manualEndInput.trim(),
        manual_limit_tz: manualTz
    };

    return {
        date,
        observatory: {
            name: "Lick Observatory",
            lat: 37.3414,
            lon: -121.6429,
            elevation: 1283
        },
        targets: targetsList,
        disabled_standards: disabledArray,
        selected_standards: Array.from(selectedStandards),
        auto_standards: autoStandardsMode,
        realtime_constraints,
        manual_limits_enabled,
        manual_limit_start: manualStartInput.trim(),
        manual_limit_end: manualEndInput.trim(),
        manual_limit_tz: manualTz,
        night_start_override,
        night_end_override
    };
}

function updateTargetManualStart(name, val, timezone = currentTimezone) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;

    if (!val.trim()) {
        target.manual_start_time = null;
        if (target.status === "Observed") {
            target.status = "";
        }
    } else {
        const dateStr = document.getElementById("obs-date").value;
        const iso = parseTimeInputToISO(val, dateStr, timezone);
        if (iso) {
            target.manual_start_time = iso;
        } else {
            target.manual_start_time = val.trim();
        }
    }
    saveAndRefresh();
}

function isTimesClose(t1, t2) {
    if (!t1 || !t2) return false;
    const d1 = new Date(t1).getTime();
    const d2 = new Date(t2).getTime();
    return Math.abs(d1 - d2) <= 60 * 1000;
}

function updateTargetManualDuration(name, val) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    
    const newVal = val.trim() ? parseFloat(val) : null;
    const isPinned = target.manual_start_time !== null && target.manual_start_time !== undefined && target.manual_start_time !== "";

    if (isPinned && newVal !== null) {
        const backupPool = JSON.parse(JSON.stringify(targetPool));
        const tempTarget = backupPool.find(t => t.name === name);
        tempTarget.manual_duration = newVal;
        
        const requestPayload = getSchedulingPayloadWithTargets(backupPool);
        const result = runLocalJSSolver(requestPayload);
        
        const block = result.blocks.find(b => b.target_name === name);
        const isScheduledCorrectly = block && isTimesClose(block.start_time, target.manual_start_time);
        
        if (result.conflicts.includes(name) || !isScheduledCorrectly) {
            alert(`Cannot update duration: Changing duration of locked target "${name}" introduces a scheduling conflict.`);
            if (lastScheduleResult) {
                updateScheduleUI(lastScheduleResult);
            }
            return;
        }
    }

    target.manual_duration = newVal;
    saveAndRefresh();
}

function updateTargetManualEnd(name, val, timezone = currentTimezone) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;

    if (!val.trim()) {
        target.manual_duration = null;
        saveAndRefresh();
        return;
    }

    const dateStr = document.getElementById("obs-date").value;
    const endIso = parseTimeInputToISO(val, dateStr, timezone);
    if (!endIso) return;

    let startIso = target.manual_start_time;
    if (!startIso && lastScheduleResult) {
        const block = lastScheduleResult.blocks.find(b => b.target_name === name);
        if (block) {
            startIso = block.start_time;
        }
    }

    if (!startIso) return;

    const durationMin = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / (60 * 1000));
    if (durationMin <= 0) return;

    const isPinned = target.manual_start_time !== null && target.manual_start_time !== undefined && target.manual_start_time !== "";
    if (isPinned) {
        const backupPool = JSON.parse(JSON.stringify(targetPool));
        const tempTarget = backupPool.find(t => t.name === name);
        tempTarget.manual_duration = durationMin;
        
        const requestPayload = getSchedulingPayloadWithTargets(backupPool);
        const result = runLocalJSSolver(requestPayload);
        
        const block = result.blocks.find(b => b.target_name === name);
        const isScheduledCorrectly = block && isTimesClose(block.start_time, target.manual_start_time);
        
        if (result.conflicts.includes(name) || !isScheduledCorrectly) {
            alert(`Cannot update end time: Changing end time of locked target "${name}" introduces a scheduling conflict.`);
            if (lastScheduleResult) {
                updateScheduleUI(lastScheduleResult);
            }
            return;
        }
    }

    target.manual_start_time = startIso;
    target.manual_duration = durationMin;
    saveAndRefresh();
}

// Drag & Drop and Standard Stars
function updateNightOverridePlaceholders() {
    const tzSelect = document.getElementById("manual-night-tz");
    const startInput = document.getElementById("manual-night-start");
    const endInput = document.getElementById("manual-night-end");
    if (!tzSelect || !startInput || !endInput) return;

    if (tzSelect.value === 'UTC') {
        startInput.placeholder = "HH:MM (UT)";
        endInput.placeholder = "HH:MM (UT)";
    } else {
        startInput.placeholder = "HH:MM (Loc)";
        endInput.placeholder = "HH:MM (Loc)";
    }
}

async function loadStandardStars() {
    try {
        const res = await fetch("/static/standards.json");
        if (res.ok) {
            standardStars = await res.json();
        } else {
            throw new Error("Failed to load standards");
        }
    } catch (e) {
        console.warn("Could not load standards.json, using fallback.");
        standardStars = [
            {"name": "BD+284211", "ra": "21:51:11.07", "dec": "+28:51:51.80", "color": "blue", "quality": "good", "magnitude": 10.5},
            {"name": "BD+174708", "ra": "22:11:31.37", "dec": "+18:05:34.20", "color": "red", "quality": "good", "magnitude": 9.5},
            {"name": "HD19445", "ra": "03:08:25.86", "dec": "+26:20:05.70", "color": "red", "quality": "good", "magnitude": 8.0},
            {"name": "G191B2B", "ra": "05:05:30.60", "dec": "+52:49:54.00", "color": "blue", "quality": "okay", "magnitude": 11.8},
            {"name": "HD84937", "ra": "09:48:56.09", "dec": "+13:44:39.30", "color": "red", "quality": "okay", "magnitude": 8.3},
            {"name": "Feige 34", "ra": "10:39:36.74", "dec": "+43:06:09.30", "color": "blue", "quality": "good", "magnitude": 11.2},
            {"name": "HZ 44", "ra": "13:23:35.26", "dec": "+36:07:59.50", "color": "blue", "quality": "okay", "magnitude": 11.7},
            {"name": "BD+262606", "ra": "14:49:02.35", "dec": "+25:42:09.10", "color": "red", "quality": "good", "magnitude": 9.7},
            {"name": "Feige 110", "ra": "23:19:58.39", "dec": "-05:09:55.80", "color": "blue", "quality": "good", "magnitude": 11.8},
            {"name": "LTT 377", "ra": "00:41:46.82", "dec": "-33:39:08.2", "color": "blue", "quality": "okay", "magnitude": 11.2},
            {"name": "LTT 1788", "ra": "03:48:22.2", "dec": "-39:08:35", "color": "blue", "quality": "okay", "magnitude": 13.1},
            {"name": "LTT 2415", "ra": "05:56:24.2", "dec": "-27:51:26", "color": "blue", "quality": "okay", "magnitude": 12.2}
        ];
    }
    standardStars.sort((a, b) => parseCoordinate(a.ra, true) - parseCoordinate(b.ra, true));
    renderStandardsTable();
}

function renderStandardsTable() {
    const tbody = document.querySelector("#standards-table tbody");
    if (!tbody) return;

    if (standardStars.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center">No standard stars loaded</td></tr>`;
        return;
    }

    const obs = { lat: 37.3414, lon: -121.6429, elevation: 1283 };
    const scheduledNames = currentBlocksList.filter(b => b.priority === 0.0).map(b => b.target_name);

    tbody.innerHTML = standardStars.map(s => {
        const isScheduled = scheduledNames.includes(s.name);
        const isChecked = autoStandardsMode ? isScheduled : selectedStandards.has(s.name);
        const raDecParsed = {
            ra: parseCoordinate(s.ra, true),
            dec: parseCoordinate(s.dec, false)
        };
        const isObs = isStandardStarObservable(raDecParsed, null, obs);

        let rowClass = "";
        let statusText = "Standby";
        let statusClass = "status-unobservable";
        let checkDisabledAttr = "";

        if (!isObs) {
            rowClass = "status-row-unobservable";
            statusText = "Unobservable";
            statusClass = "status-unobservable";
            checkDisabledAttr = "disabled";
        } else if (isScheduled) {
            rowClass = "status-row-scheduled";
            statusText = "Scheduled";
            statusClass = "status-scheduled";
        } else if (isChecked) {
            rowClass = "status-row-scheduled";
            statusText = "Selected";
            statusClass = "status-scheduled";
        }

        const badgeColor = s.color === "blue" ? "badge-color-blue" : "badge-color-red";

        return `
            <tr class="${rowClass}">
                <td>
                    <input type="checkbox" ${isChecked ? "checked" : ""} ${checkDisabledAttr}
                           onchange="toggleStandardUse('${s.name}', this.checked)">
                </td>
                <td><strong>${s.name}</strong></td>
                <td><span class="badge ${badgeColor}">${s.color}</span></td>
                <td><span style="text-transform: capitalize;">${s.quality}</span></td>
                <td>${s.magnitude.toFixed(1)}</td>
                <td style="font-family: monospace; font-size: 0.85rem;">${s.ra}</td>
                <td style="font-family: monospace; font-size: 0.85rem;">${s.dec}</td>
                <td>
                    <span class="status-pill ${statusClass}">
                        ${statusText}
                    </span>
                </td>
            </tr>
        `;
    }).join("");
}

function toggleStandardUse(name, checked) {
    if (autoStandardsMode) {
        autoStandardsMode = false;
        const scheduledNames = currentBlocksList.filter(b => b.priority === 0.0).map(b => b.target_name);
        selectedStandards = new Set(scheduledNames);
        const btn = document.getElementById("reset-auto-standards-btn");
        if (btn) btn.style.display = "inline-block";
    }
    if (checked) {
        selectedStandards.add(name);
    } else {
        selectedStandards.delete(name);
    }
    renderStandardsTable();
    triggerScheduling();
}

function resetToAutoStandards() {
    autoStandardsMode = true;
    selectedStandards.clear();
    const btn = document.getElementById("reset-auto-standards-btn");
    if (btn) btn.style.display = "none";
    renderStandardsTable();
    triggerScheduling();
}

function isStandardStarObservable(s, solar_times, observatory) {
    const dec = typeof s.dec === 'number' ? s.dec : parseCoordinate(s.dec, false);
    if (dec < -35.0 || dec > 72.0) return false;

    const dateInput = document.getElementById("obs-date").value;
    const dateParts = dateInput.split('-');
    const localNoon = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0);
    const lickOffset = getLickTimezoneOffsetHours(localNoon);
    const offsetHours = -lickOffset;
    const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
    const st = solar_times || getSolarTimesFallback(utcNoon, observatory.lat, observatory.lon, observatory.elevation);

    const sunsetDate = new Date(st.sunset);
    const sunriseDate = new Date(st.sunrise);
    const eveTime = new Date(sunsetDate.getTime() + 30 * 60 * 1000);
    const mornTime = new Date(sunriseDate.getTime() - 30 * 60 * 1000);

    const altAzEve = getAltAz(eveTime, observatory.lat, observatory.lon, s.ra, s.dec);
    const altAzMorn = getAltAz(mornTime, observatory.lat, observatory.lon, s.ra, s.dec);

    const airmassEve = getAirmass(altAzEve.alt);
    const airmassMorn = getAirmass(altAzMorn.alt);

    const isShaneEve = isShaneVisible(s, eveTime, observatory);
    const isShaneMorn = isShaneVisible(s, mornTime, observatory);

    const validEve = isShaneEve && airmassEve > 0 && airmassEve <= 2.2;
    const validMorn = isShaneMorn && airmassMorn > 0 && airmassMorn <= 2.2;

    return validEve || validMorn;
}

function isShaneVisible(t, dt, observatory) {
    const dec = typeof t.dec === 'number' ? t.dec : parseCoordinate(t.dec, false);
    if (dec < -35.0 || dec > 72.0) return false;

    const ra = typeof t.ra === 'number' ? t.ra : parseCoordinate(t.ra, true);
    const lon = observatory.lon;
    const lst = getLst(dt, lon);
    const ha = getHourAngle(lst, ra);
    if (ha < -5.6667 || ha > 3.75) return false;
    return true;
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    processTargetFile(file);
}

function processTargetFile(file) {
    const reader = new FileReader();
    reader.onload = function(evt) {
        const text = evt.target.result;
        const parsed = parseTargetsText(text);
        if (parsed.length > 0) {
            const startIndex = targetPool.length;
            parsed.forEach((t, idx) => {
                t.inputIndex = startIndex + idx;
            });
            targetPool = targetPool.concat(parsed);
            localStorage.setItem("targetPool", JSON.stringify(targetPool));
            renderTargetsTable();
            triggerScheduling();
            logToTerminal(`Successfully uploaded ${parsed.length} targets.`);
        } else {
            logToTerminal("No valid targets found in the file.");
        }
    };
    reader.readAsText(file);
}

function parseTargetsText(text) {
    const lines = text.split("\n");
    const newTargets = [];

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith("#")) continue;

        const parts = line.split(/[,\s]+/).map(p => p.trim()).filter(Boolean);
        if (parts.length < 4) continue;

        const name = parts[0];
        const raStr = parts[1];
        const decStr = parts[2];
        const magStr = parts[3];

        const ra = parseCoordinate(raStr, true);
        const dec = parseCoordinate(decStr, false);
        const magnitude = parseFloat(magStr);

        if (isNaN(ra) || isNaN(dec) || isNaN(magnitude)) continue;

        let priority = 2.0;
        if (parts.length >= 5) {
            const prioVal = parseFloat(parts[4]);
            if (!isNaN(prioVal)) priority = prioVal;
        }

        let allow_twilight = false;
        let high_airmass = false;
        let sn_mode = "normal";
        let comment = "";

        if (parts.length >= 6) {
            const flags = parts[5].toLowerCase();
            if (flags.includes("twil")) allow_twilight = true;
            if (flags.includes("airmass")) high_airmass = true;
            if (flags.includes("high_sn")) sn_mode = "high_sn";
            else if (flags.includes("class")) sn_mode = "classification";
        }

        if (parts.length >= 7) {
            const commentStartIdx = line.indexOf(parts[6]);
            if (commentStartIdx !== -1) {
                comment = line.substring(commentStartIdx).trim();
            }
        }

        newTargets.push({
            name, ra, dec, magnitude, priority, sn_mode, allow_twilight, high_airmass, comment,
            manual_start_time: null, manual_duration: null, schedule_before: []
        });
    }
    return newTargets;
}

// Real-Time Dashboard Panel Actions
function setMode(mode) {
    if (mode === 'realtime') {
        document.getElementById("mode-realtime-btn").classList.add("active");
        document.getElementById("mode-planning-btn").classList.remove("active");
        document.querySelectorAll(".real-time-only").forEach(el => {
            if (el.tagName === 'TH' || el.tagName === 'TD') {
                el.style.display = "table-cell";
            } else {
                el.style.display = "block";
            }
        });
        logToTerminal("Observing environment switched to Real-Time Mode.");
    } else {
        document.getElementById("mode-planning-btn").classList.add("active");
        document.getElementById("mode-realtime-btn").classList.remove("active");
        document.querySelectorAll(".real-time-only").forEach(el => el.style.display = "none");
        logToTerminal("Observing environment switched to Planning Mode.");
    }
}

function updateRealTimeParameters() {
    logToTerminal("Real-time constraints modified. Re-calculating...");
    triggerScheduling();
}

function logObservationEvent(msg) {
    let obsLog = [];
    try {
        const stored = localStorage.getItem("observationLog");
        if (stored) obsLog = JSON.parse(stored);
    } catch (e) {}

    const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + " UT";
    obsLog.push(`[${timeStr}] ${msg}`);
    localStorage.setItem("observationLog", JSON.stringify(obsLog));
    renderTerminalLog();
}

function renderTerminalLog() {
    const term = document.getElementById("rt-log-terminal");
    if (!term) return;
    let obsLog = [];
    try {
        const stored = localStorage.getItem("observationLog");
        if (stored) obsLog = JSON.parse(stored);
    } catch (e) {}
    term.value = obsLog.join("\n");
    term.scrollTop = term.scrollHeight;
}

function logCommentFromInput() {
    const input = document.getElementById("rt-comment");
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    logObservationEvent(`COMMENT: ${val}`);
    input.value = "";
}

function logToTerminal(msg) {
    console.log(`[App Log] ${msg}`);
}

function clearRealTimeLog() {
    localStorage.removeItem("observationLog");
    renderTerminalLog();
}

function getTargetStatus(t, lastScheduleResult) {
    if (t.status === "Observed") return "Observed";
    if (t.status === "Failed") return "Failed";
    if (t.status === "Punted") return "Punted";
    if (t.status === "Skipped") return "Skipped";
    if (t.status === "Unobservable") return "Unobservable";

    if (lastScheduleResult) {
        if (lastScheduleResult.blocks && lastScheduleResult.blocks.some(b => b.target_name === t.name)) {
            return "Scheduled";
        }
        if (lastScheduleResult.unobservable && lastScheduleResult.unobservable.includes(t.name)) {
            return "Unobservable";
        }
        if (lastScheduleResult.conflicts && lastScheduleResult.conflicts.includes(t.name)) {
            return "Not Scheduled";
        }
    }
    return "Not Scheduled";
}

function populateActiveTargetSelect() {
    const select = document.getElementById("rt-active-target");
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = "";
    
    // Add all targets in targetPool that are not Observed, Failed, Punted, Skipped
    const schedulable = targetPool.filter(t => !["Observed", "Failed", "Punted", "Skipped"].includes(t.status));
    
    schedulable.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.innerText = t.name;
        select.appendChild(opt);
    });
    if (currentVal && schedulable.some(t => t.name === currentVal)) {
        select.value = currentVal;
    }
}

function startObservation() {
    const name = document.getElementById("rt-active-target").value;
    if (!name) return;
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    
    const now = new Date();
    target.manual_start_time = now.toISOString();
    target.status = "Observed";
    
    logObservationEvent(`Started observation of target: ${name}`);
    saveAndRefresh();
}

function failObservation() {
    const name = document.getElementById("rt-active-target").value;
    if (!name) return;
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    
    target.status = "Failed";
    target.manual_start_time = null;
    
    const tz = document.getElementById("manual-night-tz")?.value || "UTC";
    const now = new Date();
    let hhStr, mmStr;
    if (tz === "UTC") {
        hhStr = String(now.getUTCHours()).padStart(2, '0');
        mmStr = String(now.getUTCMinutes()).padStart(2, '0');
    } else {
        const localNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
        const lickOffset = getLickTimezoneOffsetHours(localNoon);
        const lickNow = new Date(now.getTime() + lickOffset * 60 * 60 * 1000);
        hhStr = String(lickNow.getUTCHours()).padStart(2, '0');
        mmStr = String(lickNow.getUTCMinutes()).padStart(2, '0');
    }
    
    document.getElementById("manual-night-start").value = `${hhStr}:${mmStr}`;
    logObservationEvent(`Observation of target ${name} FAILED. Advancing night start to ${hhStr}:${mmStr} ${tz}.`);
    saveAndRefresh();
}

function puntObservation() {
    const name = document.getElementById("rt-active-target").value;
    if (!name) return;
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    
    target.status = "Punted";
    target.manual_start_time = null;
    
    const tz = document.getElementById("manual-night-tz")?.value || "UTC";
    const now = new Date();
    let hhStr, mmStr;
    if (tz === "UTC") {
        hhStr = String(now.getUTCHours()).padStart(2, '0');
        mmStr = String(now.getUTCMinutes()).padStart(2, '0');
    } else {
        const localNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
        const lickOffset = getLickTimezoneOffsetHours(localNoon);
        const lickNow = new Date(now.getTime() + lickOffset * 60 * 60 * 1000);
        hhStr = String(lickNow.getUTCHours()).padStart(2, '0');
        mmStr = String(lickNow.getUTCMinutes()).padStart(2, '0');
    }
    
    document.getElementById("manual-night-start").value = `${hhStr}:${mmStr}`;
    logObservationEvent(`Observation of target ${name} PUNTED. Advancing night start to ${hhStr}:${mmStr} ${tz}.`);
    saveAndRefresh();
}

async function recalculateStartingNow() {
    if (!lastScheduleResult || !lastScheduleResult.solar_times) {
        logToTerminal("No active schedule to recalculate starting 'now'.");
        return;
    }

    const solar = lastScheduleResult.solar_times;
    const sunsetMs = new Date(solar.sunset).getTime();
    const sunriseMs = new Date(solar.sunrise).getTime();

    let nowMs = Date.now();
    if (nowMs < sunsetMs || nowMs > sunriseMs) {
        // Simulating now to be 2 hours after sunset if outside observing window
        nowMs = sunsetMs + 2 * 60 * 60 * 1000;
        logToTerminal(`Simulating 'Now' (2 hours after sunset): ${new Date(nowMs).toLocaleTimeString()}`);
    } else {
        logToTerminal(`Recalculating schedule starting from: ${new Date(nowMs).toLocaleTimeString()}`);
    }

    // Inject start_from into real-time constraints and trigger scheduling
    const date = document.getElementById("obs-date").value;
    const disabledArray = Array.from(disabledStandards);

    const extinction = parseFloat(document.getElementById("rt-extinction")?.value) || 0.0;
    const magLimitInput = document.getElementById("rt-mag-limit")?.value;
    const mag_limit = (magLimitInput !== undefined && magLimitInput !== "") ? parseFloat(magLimitInput) : null;

    const haLimitEastInput = document.getElementById("rt-ha-limit-east")?.value;
    const ha_limit_east = (haLimitEastInput !== undefined && haLimitEastInput !== "") ? parseFloat(haLimitEastInput) : null;

    const haLimitWestInput = document.getElementById("rt-ha-limit-west")?.value;
    const ha_limit_west = (haLimitWestInput !== undefined && haLimitWestInput !== "") ? parseFloat(haLimitWestInput) : null;

    const altLimitInput = document.getElementById("rt-alt-limit")?.value;
    const alt_limit = (altLimitInput !== undefined && altLimitInput !== "") ? parseFloat(altLimitInput) : null;

    const altMaxInput = document.getElementById("rt-alt-max")?.value;
    const alt_max = (altMaxInput !== undefined && altMaxInput !== "") ? parseFloat(altMaxInput) : null;

    const decMinInput = document.getElementById("rt-dec-min")?.value;
    const dec_min = (decMinInput !== undefined && decMinInput !== "") ? parseFloat(decMinInput) : null;

    const decMaxInput = document.getElementById("rt-dec-max")?.value;
    const dec_max = (decMaxInput !== undefined && decMaxInput !== "") ? parseFloat(decMaxInput) : null;

    const azMinInput = document.getElementById("rt-az-min")?.value;
    const az_min = (azMinInput !== undefined && azMinInput !== "") ? parseFloat(azMinInput) : null;

    const azMaxInput = document.getElementById("rt-az-max")?.value;
    const az_max = (azMaxInput !== undefined && azMaxInput !== "") ? parseFloat(azMaxInput) : null;

    const realtime_constraints = {
        extinction,
        mag_limit,
        ha_limit_east,
        ha_limit_west,
        alt_limit,
        alt_max,
        dec_min,
        dec_max,
        az_min,
        az_max,
        start_from: new Date(nowMs).toISOString()
    };

    const requestPayload = {
        date,
        observatory: {
            name: "Lick Observatory",
            lat: 37.3414,
            lon: -121.6429,
            elevation: 1283
        },
        targets: targetPool,
        disabled_standards: disabledArray,
        selected_standards: Array.from(selectedStandards),
        auto_standards: autoStandardsMode,
        realtime_constraints
    };

    try {
        const response = await fetch("/api/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload)
        });
        if (!response.ok) throw new Error("HTTP server offline");
        const result = await response.json();
        updateScheduleUI(result);
        logToTerminal("Recalculate successfully completed.");
    } catch (e) {
        logToTerminal("Backend unavailable, running local JS recalculation fallback.");
        const result = runLocalJSSolver(requestPayload);
        updateScheduleUI(result);
    }
}


// ==============================================================================
// SERVER INTERACTION OR CLIENT-SIDE FALLBACK SOLVER
// ==============================================================================

async function triggerScheduling() {
    if (targetPool.length === 0) {
        clearScheduleUI();
        return;
    }

    const requestPayload = getSchedulingPayloadWithTargets(targetPool);

    if (window.location.protocol === 'file:') {
        console.warn("Local file protocol detected. Running local JS scheduling solver fallback synchronously...");
        const result = runLocalJSSolver(requestPayload);
        updateScheduleUI(result);
        return;
    }

    try {
        const response = await fetch("/api/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
            throw new Error("HTTP server offline");
        }

        const result = await response.json();
        updateScheduleUI(result);

    } catch (error) {
        console.warn("Backend API unavailable. Running local JS scheduling solver fallback...");
        const result = runLocalJSSolver(requestPayload);
        updateScheduleUI(result);
    }
}

function updateScheduleUI(result) {
    lastScheduleResult = result;
    const { blocks, conflicts, unobservable, empty_blocks, moon_info, moon_plot, airmass_plots, solar_times } = result;

    // Sync selectedStandards with actually scheduled standards
    const scheduledNames = blocks.filter(b => b.priority === 0.0).map(b => b.target_name);
    if (!autoStandardsMode) {
        selectedStandards = new Set(Array.from(selectedStandards).filter(name => scheduledNames.includes(name)));
    }

    document.getElementById("moon-phase-val").innerText = `${(moon_info.phase * 100).toFixed(0)}% illuminated`;
    document.getElementById("moon-ra-val").innerText = moon_info.ra.toFixed(1);
    document.getElementById("moon-dec-val").innerText = moon_info.dec.toFixed(1);

    const moonPic = document.getElementById("moon-phase-pic");
    const moonIllum = moon_info.phase;
    moonPic.style.boxShadow = `inset ${32 * (1 - moonIllum)}px 0px 0px rgba(15, 16, 27, 0.95), 0px 0px 15px #e2e8f0`;

    let targetPoolChanged = false;
    unobservable.forEach(name => {
        const target = targetPool.find(t => t.name === name);
        if (target && target.status !== "Skipped") {
            target.status = "Skipped";
            logObservationEvent(`Target ${name} is unobservable and automatically marked as Skipped.`);
            targetPoolChanged = true;
        }
    });

    if (targetPoolChanged) {
        localStorage.setItem("targetPool", JSON.stringify(targetPool));
        renderTargetsTable();
        triggerScheduling();
        return;
    }

    targetPool.forEach(t => {
        const statusPill = document.getElementById(`status-${t.name}`);
        const indicator = document.getElementById(`indicator-${t.name}`);
        const statusText = getTargetStatus(t, result);

        let statusClass = "status-pill status-not-scheduled";
        let dotClass = "status-dot-not-scheduled";
        let indicatorColor = "#94a3b8";

        if (statusText === "Observed") {
            statusClass = "status-pill status-observed";
            dotClass = "status-dot-observed";
            indicatorColor = "#10b981";
        } else if (statusText === "Scheduled") {
            statusClass = "status-pill status-scheduled";
            dotClass = "status-dot-scheduled";
            indicatorColor = "#f59e0b";
        } else if (statusText === "Not Scheduled") {
            statusClass = "status-pill status-not-scheduled";
            dotClass = "status-dot-not-scheduled";
            indicatorColor = "#94a3b8";
        } else if (statusText === "Failed") {
            statusClass = "status-pill status-failed";
            dotClass = "status-dot-failed";
            indicatorColor = "#ef4444";
        } else if (statusText === "Punted") {
            statusClass = "status-pill status-punted";
            dotClass = "status-dot-punted";
            indicatorColor = "#ef4444";
        } else if (statusText === "Skipped") {
            statusClass = "status-pill status-skipped";
            dotClass = "status-dot-skipped";
            indicatorColor = "#ef4444";
        } else if (statusText === "Unobservable") {
            statusClass = "status-pill status-unobservable";
            dotClass = "status-dot-unobservable";
            indicatorColor = "#64748b";
        }

        if (indicator) {
            indicator.style.backgroundColor = indicatorColor;
        }

        if (statusPill) {
            statusPill.className = statusClass;
            statusPill.innerHTML = `<span class="target-status-dot ${dotClass}"></span>${statusText}`;
        }
    });

    targetPool.forEach(t => {
        const row = document.getElementById(`target-row-${t.name}`);
        if (!row) return;

        if (unobservable.includes(t.name)) {
            row.classList.add("status-row-unobservable");
        } else {
            row.classList.remove("status-row-unobservable");
        }
    });

    const schedBody = document.querySelector("#schedule-table tbody");
    if (blocks.length === 0) {
        schedBody.innerHTML = `<tr><td colspan="7" class="text-center" style="color: var(--text-muted);">No targets could be scheduled due to conflicts or visibility limits.</td></tr>`;
    } else {
        schedBody.innerHTML = blocks.map(b => {
            const startVal = formatTimeForTimezone(b.start_time, 'UTC');
            const endVal = formatTimeForTimezone(b.end_time, 'UTC');

            const target = targetPool.find(t => t.name === b.target_name);

            let timeCell = "";
            let durationCell = "";

            if (target) {
                // Science target: editable start time and duration/exposure time
                const isPinned = target.manual_start_time !== null && target.manual_start_time !== undefined && target.manual_start_time !== "";
                timeCell = `
                    <div style="display: flex; align-items: center; gap: 4px;" onclick="event.stopPropagation();">
                        ${isPinned ? `<span style="color: #f59e0b; font-size: 0.8rem; cursor: pointer;" title="Unpin start time" onclick="updateTargetManualStart('${b.target_name}', '')">🔒</span>` : ''}
                        <input type="text" value="${startVal}"
                               onchange="updateTargetManualStart('${b.target_name}', this.value, 'UTC')"
                               style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid ${isPinned ? '#f59e0b' : 'var(--border-color)'}; background: ${isPinned ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255, 255, 255, 0.05)'}; color: #fff;"
                               title="${isPinned ? 'Pinned start time' : 'Enter start time to pin'}">
                        <span>- </span>
                        <input type="text" value="${endVal}"
                               onchange="updateTargetManualEnd('${b.target_name}', this.value, 'UTC')"
                               style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: #fff;"
                               title="Enter end time to set duration">
                    </div>
                `;
                durationCell = `
                    <input type="number" min="1" step="1" value="${b.duration_minutes}"
                           onchange="updateTargetManualDuration('${b.target_name}', this.value)"
                           style="width: 55px; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: #fff;"
                           onclick="event.stopPropagation();">
                `;
            } else {
                // Standard star: static display
                timeCell = `<strong>${startVal} - ${endVal}</strong>`;
                durationCell = `${b.duration_minutes}`;
            }

            return `
                <tr id="sched-row-${b.target_name}" data-target="${b.target_name}"
                    onmouseenter="highlightTarget('${b.target_name}')"
                    onmouseleave="unhighlightTarget('${b.target_name}')"
                    onclick="stickyHighlightTarget('${b.target_name}')"
                    style="cursor: pointer;">
                    <td>${timeCell}</td>
                    <td><strong>${b.target_name}</strong></td>
                    <td><span class="badge" style="background: rgba(139, 92, 246, 0.1); border-color: rgba(139, 92, 246, 0.3); color: #c084fc;">P${b.priority}</span></td>
                    <td>${durationCell}</td>
                    <td>${b.airmass_start.toFixed(2)} - ${b.airmass_end.toFixed(2)}</td>
                    <td><span style="font-weight:600; color:var(--accent-cyan);">${b.airmass_median.toFixed(2)}</span></td>
                    <td><span style="font-size: 0.85rem; color: var(--text-secondary);">${b.comment}</span></td>
                    <td class="real-time-only" style="display: ${document.getElementById("mode-realtime-btn") && document.getElementById("mode-realtime-btn").classList.contains("active") ? 'table-cell' : 'none'};">
                        <span class="status-pill status-scheduled">On Track</span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderTimeline(blocks, solar_times, moon_plot);
    renderAlerts(conflicts, unobservable, empty_blocks, blocks.length);
    renderAirmassChart(airmass_plots, blocks, solar_times, moon_plot);
    drawPolarSkyMap(blocks, targetPool, solar_times);
    renderStandardsTable();
    renderObservingLogTable(blocks);
}


// ==============================================================================
// VISUAL TIMELINE BUILDER
// ==============================================================================

function handleTimelineReorder(draggedName, targetName, isRightHalf) {
    const draggedTarget = targetPool.find(t => t.name === draggedName);
    const targetTarget = targetPool.find(t => t.name === targetName);
    
    if (!draggedTarget) return;

    if (!draggedTarget.schedule_before) draggedTarget.schedule_before = [];
    if (targetTarget && !targetTarget.schedule_before) targetTarget.schedule_before = [];

    if (!isRightHalf) {
        // Dropped on the left half (in front of target)
        // draggedTarget must schedule before targetName
        if (!draggedTarget.schedule_before.includes(targetName)) {
            draggedTarget.schedule_before.push(targetName);
        }
        // clear targetName scheduling before draggedTarget to prevent circularity
        if (targetTarget) {
            targetTarget.schedule_before = targetTarget.schedule_before.filter(name => name !== draggedName);
        }
    } else {
        // Dropped on the right half (behind target)
        // targetName must schedule before draggedTarget
        if (targetTarget) {
            if (!targetTarget.schedule_before.includes(draggedName)) {
                targetTarget.schedule_before.push(draggedName);
            }
        }
        // clear draggedTarget scheduling before targetName to prevent circularity
        draggedTarget.schedule_before = draggedTarget.schedule_before.filter(name => name !== targetName);
    }

    saveAndRefresh();
}

function renderTimeline(blocks, solar_times, moon_plot) {
    const container = document.getElementById("timeline-container");
    container.innerHTML = "";
    currentBlocksList = blocks;

    if (blocks.length === 0) {
        container.innerHTML = `<div class="timeline-empty-message">No targets scheduled. Adjust priority or metadata to resolve conflicts.</div>`;
        return;
    }

    const nightStart = new Date(solar_times.sunset);
    const nightEnd = new Date(solar_times.sunrise);
    const nightDurationMs = nightEnd.getTime() - nightStart.getTime();

    // 1. Build LST axis (top)
    const lstAxisEl = document.createElement("div");
    lstAxisEl.className = "timeline-lst-axis";
    lstAxisEl.style.position = "relative";
    lstAxisEl.style.height = "18px";
    lstAxisEl.style.width = "100%";
    lstAxisEl.style.marginBottom = "4px";

    for (let i = 0; i <= 5; i++) {
        const pct = (i / 5) * 100;
        const tickTime = new Date(nightStart.getTime() + (i / 5) * nightDurationMs);
        const obsLon = -121.6429; // Lick Shane
        const lstVal = getLst(tickTime, obsLon);

        const tickEl = document.createElement("div");
        tickEl.className = "timeline-tick lst-tick";
        tickEl.style.left = `${pct}%`;
        tickEl.style.position = "absolute";
        tickEl.style.transform = "translateX(-50%)";
        tickEl.style.fontSize = "0.7rem";
        tickEl.style.color = "#c084fc";
        tickEl.innerText = formatLST(lstVal);

        lstAxisEl.appendChild(tickEl);
    }
    container.appendChild(lstAxisEl);

    // 2. Build and append the Moon visibility bar if data exists
    if (moon_plot && moon_plot.length > 0) {
        const moonBar = document.createElement("div");
        moonBar.className = "moon-visibility-bar";

        let segmentStart = null;
        for (let i = 0; i < moon_plot.length; i++) {
            const pt = moon_plot[i];
            const ptTime = new Date(pt.time);

            if (ptTime >= nightStart && ptTime <= nightEnd) {
                const isVisible = pt.alt > 0;
                if (isVisible && segmentStart === null) {
                     segmentStart = ptTime;
                } else if (!isVisible && segmentStart !== null) {
                     drawMoonSegment(moonBar, segmentStart, ptTime, nightStart, nightDurationMs);
                     segmentStart = null;
                }
            }
        }
        if (segmentStart !== null) {
            drawMoonSegment(moonBar, segmentStart, nightEnd, nightStart, nightDurationMs);
        }

        container.appendChild(moonBar);
    }

    function drawMoonSegment(bar, start, end, nightStart, nightDurationMs) {
        const leftPct = ((start.getTime() - nightStart.getTime()) / nightDurationMs) * 100;
        const widthPct = ((end.getTime() - start.getTime()) / nightDurationMs) * 100;

        const segment = document.createElement("div");
        segment.className = "moon-segment";
        segment.style.left = `${Math.max(0, leftPct)}%`;
        segment.style.width = `${Math.min(100, widthPct)}%`;
        segment.title = `Moon above horizon: ${start.toISOString().substring(11, 16)} - ${end.toISOString().substring(11, 16)}`;
        bar.appendChild(segment);
    }

    // 3. Build the target observation blocks wrapper
    const blocksWrapper = document.createElement("div");
    blocksWrapper.className = "timeline-blocks-wrapper";

    // Draw twilight regions in background
    const eve18Ms = new Date(solar_times.twilight_evening_18).getTime();
    const morn18Ms = new Date(solar_times.twilight_morning_18).getTime();

    if (eve18Ms > nightStart.getTime()) {
        const leftPct = 0;
        const widthPct = ((eve18Ms - nightStart.getTime()) / nightDurationMs) * 100;
        const eveTwilightEl = document.createElement("div");
        eveTwilightEl.className = "timeline-twilight-region evening";
        eveTwilightEl.style.left = `${leftPct}%`;
        eveTwilightEl.style.width = `${widthPct}%`;
        blocksWrapper.appendChild(eveTwilightEl);
    }

    if (morn18Ms < nightEnd.getTime()) {
        const leftPct = ((morn18Ms - nightStart.getTime()) / nightDurationMs) * 100;
        const widthPct = ((nightEnd.getTime() - morn18Ms) / nightDurationMs) * 100;
        const mornTwilightEl = document.createElement("div");
        mornTwilightEl.className = "timeline-twilight-region morning";
        mornTwilightEl.style.left = `${leftPct}%`;
        mornTwilightEl.style.width = `${widthPct}%`;
        blocksWrapper.appendChild(mornTwilightEl);
    }

    // Draw twilight/sunrise/sunset vertical marker lines
    const timelineMarkers = [
        { time: new Date(solar_times.sunset), label: "Sunset" },
        { time: new Date(solar_times.twilight_evening_12), label: "12° Twil (Eve)" },
        { time: new Date(solar_times.twilight_evening_18), label: "18° Twil (Eve)" },
        { time: new Date(solar_times.twilight_morning_18), label: "18° Twil (Morn)" },
        { time: new Date(solar_times.twilight_morning_12), label: "12° Twil (Morn)" },
        { time: new Date(solar_times.sunrise), label: "Sunrise" }
    ];

    timelineMarkers.forEach(m => {
        const mTime = m.time.getTime();
        if (mTime >= nightStart.getTime() && mTime <= nightEnd.getTime()) {
            const pct = ((mTime - nightStart.getTime()) / nightDurationMs) * 100;

            const lineEl = document.createElement("div");
            lineEl.className = "timeline-marker-line";
            lineEl.style.left = `${pct}%`;

            const labelEl = document.createElement("div");
            labelEl.className = "timeline-marker-label";
            labelEl.innerText = m.label;
            lineEl.appendChild(labelEl);

            blocksWrapper.appendChild(lineEl);
        }
    });

    // Draw science blocks
    let lastPriority = null;
    let lastShade = 'normal';

    blocks.forEach((b, idx) => {
        let shade = 'normal';
        if (b.priority === lastPriority) {
            shade = lastShade === 'normal' ? 'alt' : 'normal';
        }
        lastPriority = b.priority;
        lastShade = shade;

        const bStart = new Date(b.start_time);
        const bEnd = new Date(b.end_time);

        const leftPct = ((bStart.getTime() - nightStart.getTime()) / nightDurationMs) * 100;
        const widthPct = ((bEnd.getTime() - bStart.getTime()) / nightDurationMs) * 100;

        const blockEl = document.createElement("div");

        // Map float priority to integer group class
        let prioGroup = 1;
        if (b.priority === 0.0) {
            prioGroup = 0;
        } else if (b.priority <= 1.0) {
            prioGroup = 1;
        } else if (b.priority <= 2.0) {
            prioGroup = 2;
        } else {
            prioGroup = 3;
        }

        blockEl.className = `timeline-block priority-${prioGroup} shade-${shade}`;
        blockEl.style.left = `${leftPct}%`;
        blockEl.style.width = `${widthPct}%`;
        blockEl.setAttribute("data-target", b.target_name);
        blockEl.innerHTML = `<span>${b.target_name}</span>`;

        const obsLon = -121.6429;
        const bStartLST = formatLST(getLst(bStart, obsLon));
        const bEndLST = formatLST(getLst(bEnd, obsLon));
        blockEl.title = `${b.target_name}\nUT: ${formatTimeForTimezone(b.start_time, 'UTC')} - ${formatTimeForTimezone(b.end_time, 'UTC')}\nLoc: ${formatTimeForTimezone(b.start_time, 'obs')} - ${formatTimeForTimezone(b.end_time, 'obs')}\nLST: ${bStartLST} - ${bEndLST}\nMedian Airmass: ${b.airmass_median}`;

        // Enable drag & drop for manual scheduling
        if (b.priority > 0) {
            blockEl.draggable = true;
            blockEl.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/plain", b.target_name);
                blockEl.classList.add("dragging");
            });
            blockEl.addEventListener("dragend", () => {
                blockEl.classList.remove("dragging");
            });
        }

        // Register dragover and drop on all blocks (including standard stars and locked blocks)
        blockEl.addEventListener("dragover", (e) => {
            e.preventDefault();
        });
        blockEl.addEventListener("drop", (e) => {
            e.preventDefault();
            const draggedName = e.dataTransfer.getData("text/plain");
            if (draggedName && draggedName !== b.target_name) {
                const rect = blockEl.getBoundingClientRect();
                const relX = e.clientX - rect.left;
                const isRightHalf = relX > rect.width / 2;
                handleTimelineReorder(draggedName, b.target_name, isRightHalf);
            }
        });

        // Hover and Click Highlight Event Listeners
        blockEl.addEventListener("mouseenter", (e) => {
            highlightTarget(b.target_name);
            const span = blockEl.querySelector("span");
            if (span && span.scrollWidth > blockEl.clientWidth) {
                const tooltip = document.getElementById("timeline-tooltip");
                if (tooltip) {
                    tooltip.innerHTML = `
                        <div class="timeline-tooltip-title">${b.target_name}</div>
                        <div class="timeline-tooltip-detail">UT: ${formatTimeForTimezone(b.start_time, 'UTC')} - ${formatTimeForTimezone(b.end_time, 'UTC')}</div>
                        <div class="timeline-tooltip-detail">Loc: ${formatTimeForTimezone(b.start_time, 'obs')} - ${formatTimeForTimezone(b.end_time, 'obs')}</div>
                        <div class="timeline-tooltip-detail">LST: ${bStartLST} - ${bEndLST}</div>
                        <div class="timeline-tooltip-detail">Median Airmass: ${typeof b.airmass_median === 'number' ? b.airmass_median.toFixed(2) : b.airmass_median}</div>
                    `;
                    tooltip.style.display = "block";
                }
            }
        });
        blockEl.addEventListener("mousemove", (e) => {
            const tooltip = document.getElementById("timeline-tooltip");
            if (tooltip && tooltip.style.display === "block") {
                tooltip.style.left = `${e.pageX + 15}px`;
                tooltip.style.top = `${e.pageY + 15}px`;
            }
        });
        blockEl.addEventListener("mouseleave", () => {
            unhighlightTarget(b.target_name);
            const tooltip = document.getElementById("timeline-tooltip");
            if (tooltip) {
                tooltip.style.display = "none";
            }
        });
        blockEl.addEventListener("click", () => {
            stickyHighlightTarget(b.target_name);
        });

        blocksWrapper.appendChild(blockEl);
    });

    // 4. Render Axis Ticks (bottom) showing UT and Local
    const axisEl = document.createElement("div");
    axisEl.className = "timeline-axis";
    axisEl.style.position = "relative";
    axisEl.style.height = "40px";
    axisEl.style.width = "100%";
    axisEl.style.marginTop = "30px";

    // Find all integer UT hours within nightStart and nightEnd
    const ticks = [];
    const firstHour = new Date(nightStart);
    firstHour.setUTCMinutes(0, 0, 0);
    if (firstHour.getTime() < nightStart.getTime()) {
        firstHour.setUTCHours(firstHour.getUTCHours() + 1);
    }
    let curHour = new Date(firstHour);
    while (curHour.getTime() <= nightEnd.getTime()) {
        ticks.push(new Date(curHour));
        curHour.setUTCHours(curHour.getUTCHours() + 1);
    }

    // Draw thin vertical lines on timeline for every UT hour
    ticks.forEach(tickTime => {
        const pct = ((tickTime.getTime() - nightStart.getTime()) / nightDurationMs) * 100;
        if (pct >= 0 && pct <= 100) {
            const vLine = document.createElement("div");
            vLine.style.position = "absolute";
            vLine.style.left = `${pct}%`;
            vLine.style.top = "0";
            vLine.style.bottom = "0";
            vLine.style.width = "1px";
            vLine.style.backgroundColor = "rgba(255, 255, 255, 0.08)";
            vLine.style.pointerEvents = "none";
            blocksWrapper.appendChild(vLine);
        }
    });

    // Compute skip step to prevent overlapping labels (at least 60px between labels)
    const containerWidth = container.clientWidth || 800;
    const totalHours = nightDurationMs / (3600 * 1000);
    const hourSpacing = containerWidth / totalHours;
    let labelSkipStep = 1;
    while (labelSkipStep * hourSpacing < 60 && labelSkipStep < 24) {
        labelSkipStep++;
    }

    ticks.forEach((tickTime, idx) => {
        if (idx % labelSkipStep !== 0) return;

        const pct = ((tickTime.getTime() - nightStart.getTime()) / nightDurationMs) * 100;
        const utStr = formatTimeForTimezone(tickTime, 'UTC');
        const locStr = formatTimeForTimezone(tickTime, 'obs');

        const tickEl = document.createElement("div");
        tickEl.className = "timeline-tick";
        tickEl.style.left = `${pct}%`;
        tickEl.style.position = "absolute";
        tickEl.style.transform = "translateX(-50%)";
        tickEl.style.fontSize = "0.7rem";
        tickEl.style.textAlign = "center";
        tickEl.innerHTML = `<div>${utStr} UT</div><div style="font-size:0.6rem; color:var(--text-muted);">${locStr} Loc</div>`;

        axisEl.appendChild(tickEl);
    });

    // Draw vertical red "NOW" line if in real-time mode
    if (document.getElementById("mode-realtime-btn") && document.getElementById("mode-realtime-btn").classList.contains("active")) {
        const nowMs = Date.now();
        const nightStartMs = nightStart.getTime();
        const nightEndMs = nightEnd.getTime();
        if (nowMs >= nightStartMs && nowMs <= nightEndMs) {
            const nowPct = ((nowMs - nightStartMs) / nightDurationMs) * 100;
            const nowLine = document.createElement("div");
            nowLine.style.position = "absolute";
            nowLine.style.left = `${nowPct}%`;
            nowLine.style.top = "0";
            nowLine.style.bottom = "0";
            nowLine.style.width = "2px";
            nowLine.style.backgroundColor = "#ef4444";
            nowLine.style.zIndex = "10";
            nowLine.style.boxShadow = "0 0 6px rgba(239, 68, 68, 0.8)";
            blocksWrapper.appendChild(nowLine);
        }
    }

    container.appendChild(blocksWrapper);
    container.appendChild(axisEl);
}


// ==============================================================================
// ALERTS CONSOLE RENDERER
// ==============================================================================

function renderAlerts(conflicts, unobservable, empty_blocks, scheduled_count) {
    const consoleEl = document.getElementById("alerts-console");
    consoleEl.innerHTML = "";

    const scheduledNames = currentBlocksList ? currentBlocksList.map(b => b.target_name) : [];
    const filteredConflicts = conflicts.filter(name => !scheduledNames.includes(name));

    const items = [];

    filteredConflicts.forEach(name => {
        const t = targetPool.find(target => target.name === name);
        items.push(`
            <div class="alert-item alert-danger">
                <div>
                    <div class="alert-title">Conflict: Target "${name}" (Priority ${t ? t.priority : 'N/A'}) cannot be scheduled</div>
                    <div class="alert-desc">It overlaps with other targets at this priority level. Action: Try changing its priority, enabling twilight observations, or allowing higher airmass.</div>
                </div>
            </div>
        `);
    });

    if (scheduled_count > 0 && empty_blocks.length > 0) {
        const totalUnused = empty_blocks.reduce((acc, b) => acc + b.duration_minutes, 0);
        const listStr = empty_blocks.map(b => {
            const start = new Date(b.start_time).toISOString().substring(11, 16);
            const end = new Date(b.end_time).toISOString().substring(11, 16);
            return `${start}-${end} (${b.duration_minutes}m)`;
        }).join(', ');

        items.push(`
            <div class="alert-item alert-warning" style="background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3); color: #93c5fd;">
                <div>
                    <div class="alert-title">Unused Time Remaining: ${totalUnused} minutes empty</div>
                    <div class="alert-desc">The telescope has free slots during: ${listStr}. Consider adding lower-priority targets to fill the night.</div>
                </div>
            </div>
        `);
    }

    if (items.length > 0) {
        consoleEl.innerHTML = items.join('');
        consoleEl.style.display = "block";
    } else {
        consoleEl.style.display = "none";
    }
}


// ==============================================================================
// CHART.JS AIRMASS PLOT (INVERTED Y-AXIS)
// ==============================================================================

function getRgba(hex, alpha) {
    if (!hex.startsWith('#')) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function renderAirmassChart(airmass_plots, blocks, solar_times, moon_plot) {
    const canvas = document.getElementById("airmassChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const sunsetMs = new Date(solar_times.sunset).getTime();
    const sunriseMs = new Date(solar_times.sunrise).getTime();

    let maxObsAirmass = 0;
    blocks.forEach(b => {
        const plotData = airmass_plots[b.target_name];
        if (plotData) {
            const startMs = new Date(b.start_time).getTime();
            const endMs = new Date(b.end_time).getTime();
            plotData.forEach(p => {
                const timeMs = new Date(p.time).getTime();
                if (timeMs >= startMs && timeMs <= endMs) {
                    if (p.airmass > 0 && p.airmass < 10) {
                        if (p.airmass > maxObsAirmass) {
                            maxObsAirmass = p.airmass;
                        }
                    }
                }
            });
        }
    });
    const dynamicMaxY = Math.max(1.7, maxObsAirmass > 0 ? (maxObsAirmass + 0.1) : 2.5);
    currentMaxAirmass = dynamicMaxY;

    const datasets = [];
    const colorPalette = [
        '#ef4444', '#f59e0b', '#10b981', '#06b6d4',
        '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
    ];

    let colorIdx = 0;

    // Plot Moon airmass curve if available (solid grey line)
    if (moon_plot && moon_plot.length > 0) {
        const moonPoints = moon_plot.map(p => {
            return {
                x: new Date(p.time).getTime(),
                y: (p.airmass > 10.0 || p.airmass <= 0) ? null : p.airmass
            };
        });
        datasets.push({
            label: 'Moon',
            data: moonPoints,
            borderColor: '#64748b',
            borderWidth: 2.5,
            fill: false,
            tension: 0.1,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: 'y'
        });
    }

    Object.keys(airmass_plots).forEach(tName => {
        const plotData = airmass_plots[tName];
        const color = colorPalette[colorIdx % colorPalette.length];
        colorIdx++;

        const block = blocks.find(b => b.target_name === tName);

        const fullNightPoints = plotData.map(p => {
            return {
                x: new Date(p.time).getTime(),
                y: (p.airmass > 10.0 || p.airmass <= 0) ? null : p.airmass
            };
        });

        // Dotted lines with lower opacity (0.25)
        datasets.push({
            label: `${tName} (Night Profile)`,
            data: fullNightPoints,
            borderColor: getRgba(color, 0.25),
            borderWidth: 1.5,
            borderDash: [4, 4],
            fill: false,
            tension: 0.1,
            pointRadius: 0
        });

        if (block) {
            const startMs = new Date(block.start_time).getTime();
            const endMs = new Date(block.end_time).getTime();

            const scheduledPoints = plotData.map(p => {
                const timeMs = new Date(p.time).getTime();
                const inRange = (timeMs >= startMs && timeMs <= endMs);
                return {
                    x: timeMs,
                    y: (inRange && p.airmass <= 10.0 && p.airmass > 0) ? p.airmass : null
                };
            });

            datasets.push({
                label: tName,
                data: scheduledPoints,
                borderColor: color,
                borderWidth: 8,
                fill: false,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 4
            });
        }
    });

    if (airmassChart) {
        airmassChart.solar_times = solar_times;
        airmassChart.data.datasets = datasets;
        airmassChart.options.scales.y.max = dynamicMaxY;
        
        // update X axis bounds if not currently zoomed
        const isCurrentlyZoomed = (originalXMin !== null && originalXMax !== null) && 
                                  (airmassChart.options.scales.x.min !== originalXMin || airmassChart.options.scales.x.max !== originalXMax);
        if (!isCurrentlyZoomed) {
            airmassChart.options.scales.x.min = sunsetMs;
            airmassChart.options.scales.x.max = sunriseMs;
            if (airmassChart.options.scales.x2) {
                airmassChart.options.scales.x2.min = sunsetMs;
                airmassChart.options.scales.x2.max = sunriseMs;
            }
        }
        originalXMin = sunsetMs;
        originalXMax = sunriseMs;
        
        airmassChart.update('none');
        return;
    }

    // Twilight Plugin to draw gradients & vertical lines in Chart.js
    const twilightPlugin = {
        id: 'twilightPlugin',
        beforeDraw: (chart) => {
            const chartCtx = chart.ctx;
            const xAxis = chart.scales.x;
            const yAxis = chart.scales.y;

            const st = chart.solar_times || solar_times;
            if (!xAxis || !yAxis || !st) return;

            const sunsetMs = new Date(st.sunset).getTime();
            const sunriseMs = new Date(st.sunrise).getTime();
            const eve12Ms = new Date(st.twilight_evening_12).getTime();
            const morn12Ms = new Date(st.twilight_morning_12).getTime();
            const eve18Ms = new Date(st.twilight_evening_18).getTime();
            const morn18Ms = new Date(st.twilight_morning_18).getTime();

            const xSunset = xAxis.getPixelForValue(sunsetMs);
            const xSunrise = xAxis.getPixelForValue(sunriseMs);
            const xEve12 = xAxis.getPixelForValue(eve12Ms);
            const xMorn12 = xAxis.getPixelForValue(morn12Ms);
            const xEve18 = xAxis.getPixelForValue(eve18Ms);
            const xMorn18 = xAxis.getPixelForValue(morn18Ms);

            const chartArea = chart.chartArea;

            // Draw Evening twilight gradient
            if (xSunset >= chartArea.left && xEve18 <= chartArea.right) {
                const gradEve = chartCtx.createLinearGradient(xSunset, 0, xEve18, 0);
                gradEve.addColorStop(0, 'rgba(251, 191, 36, 0.15)');
                gradEve.addColorStop(0.5, 'rgba(59, 130, 246, 0.1)');
                gradEve.addColorStop(1, 'rgba(15, 23, 42, 0)');
                chartCtx.fillStyle = gradEve;
                chartCtx.fillRect(xSunset, chartArea.top, xEve18 - xSunset, chartArea.bottom - chartArea.top);
            }

            // Draw Morning twilight gradient
            if (xMorn18 >= chartArea.left && xSunrise <= chartArea.right) {
                const gradMorn = chartCtx.createLinearGradient(xMorn18, 0, xSunrise, 0);
                gradMorn.addColorStop(0, 'rgba(15, 23, 42, 0)');
                gradMorn.addColorStop(0.5, 'rgba(59, 130, 246, 0.1)');
                gradMorn.addColorStop(1, 'rgba(251, 191, 36, 0.15)');
                chartCtx.fillStyle = gradMorn;
                chartCtx.fillRect(xMorn18, chartArea.top, xSunrise - xMorn18, chartArea.bottom - chartArea.top);
            }

            // Draw marker lines and text labels
            chartCtx.save();
            chartCtx.lineWidth = 1.5;
            chartCtx.setLineDash([4, 4]);

            const markers = [
                { x: xSunset, label: 'Sunset', color: 'rgba(251, 191, 36, 0.7)' },
                { x: xEve12, label: '12° Twil (Eve)', color: 'rgba(59, 130, 246, 0.6)' },
                { x: xEve18, label: '18° Twil (Eve)', color: 'rgba(139, 92, 246, 0.6)' },
                { x: xMorn18, label: '18° Twil (Morn)', color: 'rgba(139, 92, 246, 0.6)' },
                { x: xMorn12, label: '12° Twil (Morn)', color: 'rgba(59, 130, 246, 0.6)' },
                { x: xSunrise, label: 'Sunrise', color: 'rgba(251, 191, 36, 0.7)' }
            ];

            markers.forEach(m => {
                if (m.x >= chartArea.left && m.x <= chartArea.right) {
                    chartCtx.strokeStyle = m.color;
                    chartCtx.beginPath();
                    chartCtx.moveTo(m.x, chartArea.top);
                    chartCtx.lineTo(m.x, chartArea.bottom);
                    chartCtx.stroke();

                    chartCtx.fillStyle = '#94a3b8';
                    chartCtx.font = '9px Inter';
                    chartCtx.textAlign = 'center';
                    chartCtx.fillText(m.label, m.x, chartArea.top - 5);
                }
            });

            // If in real-time mode, draw a vertical red line for "NOW"
            if (document.getElementById("mode-realtime-btn") && document.getElementById("mode-realtime-btn").classList.contains("active")) {
                const nowMs = Date.now();
                const xNow = xAxis.getPixelForValue(nowMs);
                if (xNow >= chartArea.left && xNow <= chartArea.right) {
                    chartCtx.strokeStyle = '#ef4444';
                    chartCtx.lineWidth = 2;
                    chartCtx.setLineDash([]);
                    chartCtx.beginPath();
                    chartCtx.moveTo(xNow, chartArea.top);
                    chartCtx.lineTo(xNow, chartArea.bottom);
                    chartCtx.stroke();

                    chartCtx.fillStyle = '#ef4444';
                    chartCtx.font = 'bold 9px Inter';
                    chartCtx.textAlign = 'center';
                    chartCtx.fillText('NOW', xNow, chartArea.top - 5);
                }
            }

            chartCtx.restore();
        }
    };

    // Box Zoom Overlay Drawer Plugin
    const boxZoomPlugin = {
        id: 'boxZoomPlugin',
        afterDraw: (chart) => {
            if (isDragging && dragStart && dragEnd) {
                const chartCtx = chart.ctx;
                const chartArea = chart.chartArea;

                chartCtx.save();
                chartCtx.fillStyle = 'rgba(6, 182, 212, 0.15)';
                chartCtx.strokeStyle = '#06b6d4';
                chartCtx.lineWidth = 1;

                const startX = dragStart.x;
                const endX = dragEnd.x;
                const startY = dragStart.y;
                const endY = dragEnd.y;

                chartCtx.fillRect(startX, startY, endX - startX, endY - startY);
                chartCtx.strokeRect(startX, startY, endX - startX, endY - startY);
                chartCtx.restore();
            }
        }
    };

    airmassChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        plugins: [twilightPlugin, boxZoomPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 25,
                    bottom: 30
                }
            },
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#94a3b8',
                        font: { family: 'Inter', size: 11 },
                        usePointStyle: false,
                        boxWidth: 30,
                        boxHeight: 2,
                        filter: function(item, chart) {
                            return !item.text.includes("(Night Profile)");
                        }
                    }
                },
                tooltip: {
                    position: 'nearest',
                    caretPadding: 20,
                    yAlign: 'bottom',
                    callbacks: {
                        title: function(tooltipItems) {
                            if (tooltipItems.length > 0) {
                                const val = tooltipItems[0].parsed.x;
                                const date = new Date(val);
                                const utStr = formatTimeForTimezone(date, 'UTC');
                                const locStr = formatTimeForTimezone(date, 'obs');
                                const lstStr = formatLST(getLst(date, -121.6429));
                                return `UT: ${utStr} | Loc: ${locStr} | LST: ${lstStr}`;
                            }
                            return '';
                        },
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label = label.replace(" (Obs Window)", "");
                            }
                            if (context.parsed.y !== null && context.parsed.y !== undefined && !isNaN(context.parsed.y)) {
                                label += `: Airmass ${context.parsed.y.toFixed(2)}`;
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: sunsetMs,
                    max: sunriseMs,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        padding: 25,
                        callback: function(value, index, ticks) {
                            const date = new Date(value);
                            return [
                                formatTimeForTimezone(date, 'UTC') + ' UT',
                                formatTimeForTimezone(date, 'obs') + ' Loc'
                            ];
                        },
                        color: '#94a3b8',
                        font: { family: 'Inter' }
                    }
                },
                x2: {
                    type: 'linear',
                    position: 'top',
                    min: sunsetMs,
                    max: sunriseMs,
                    grid: { drawOnChartArea: false },
                    ticks: {
                        callback: function(value, index, ticks) {
                            const date = new Date(value);
                            const obsLon = -121.6429;
                            const lstVal = getLst(date, obsLon);
                            return formatLST(lstVal);
                        },
                        color: '#c084fc',
                        font: { family: 'Inter', size: 10 }
                    }
                },
                y: {
                    reverse: true,
                    min: 1.0,
                    max: dynamicMaxY,
                    title: {
                        display: true,
                        text: 'Airmass (sec z)',
                        color: '#94a3b8',
                        font: { family: 'Inter', weight: 'bold' }
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8', font: { family: 'Inter' } }
                }
            }
        }
    });

    originalXMin = sunsetMs;
    originalXMax = sunriseMs;
    airmassChart.solar_times = solar_times;
}

let originalXMin = null;
let originalXMax = null;
let currentMaxAirmass = 2.5;
let isDragging = false;
let dragStart = null;
let dragEnd = null;

function initAirmassChartDragZoom() {
    const canvas = document.getElementById("airmassChart");
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
        if (!airmassChart) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const chartArea = airmassChart.chartArea;
        if (x >= chartArea.left && x <= chartArea.right && y >= chartArea.top && y <= chartArea.bottom) {
            isDragging = true;
            dragStart = { x, y };
            dragEnd = { x, y };

            if (originalXMin === null) {
                originalXMin = airmassChart.scales.x.min || airmassChart.scales.x.ticks[0].value;
                originalXMax = airmassChart.scales.x.max || airmassChart.scales.x.ticks[airmassChart.scales.x.ticks.length - 1].value;
            }
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDragging || !airmassChart) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(airmassChart.chartArea.left, Math.min(e.clientX - rect.left, airmassChart.chartArea.right));
        const y = Math.max(airmassChart.chartArea.top, Math.min(e.clientY - rect.top, airmassChart.chartArea.bottom));
        dragEnd.x = x;
        dragEnd.y = y;

        airmassChart.draw();

        // Draw the transparent zoom selection rectangle
        const ctx = airmassChart.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1;
        ctx.strokeRect(dragStart.x, dragStart.y, dragEnd.x - dragStart.x, dragEnd.y - dragStart.y);
        ctx.fillRect(dragStart.x, dragStart.y, dragEnd.x - dragStart.x, dragEnd.y - dragStart.y);
        ctx.restore();
    });

    canvas.addEventListener('mouseup', (e) => {
        if (!isDragging || !airmassChart) return;
        isDragging = false;

        const startX = dragStart.x;
        const endX = dragEnd.x;
        const startY = dragStart.y;
        const endY = dragEnd.y;

        if (Math.abs(endX - startX) > 5 || Math.abs(endY - startY) > 5) {
            const xAxis = airmassChart.scales.x;
            const yAxis = airmassChart.scales.y;

            const val1X = xAxis.getValueForPixel(startX);
            const val2X = xAxis.getValueForPixel(endX);
            const minX = Math.min(val1X, val2X);
            const maxX = Math.max(val1X, val2X);

            const val1Y = yAxis.getValueForPixel(startY);
            const val2Y = yAxis.getValueForPixel(endY);
            const minY = Math.min(val1Y, val2Y);
            const maxY = Math.max(val1Y, val2Y);

            airmassChart.options.scales.x.min = minX;
            airmassChart.options.scales.x.max = maxX;
            if (airmassChart.options.scales.x2) {
                airmassChart.options.scales.x2.min = minX;
                airmassChart.options.scales.x2.max = maxX;
            }

            airmassChart.options.scales.y.min = Math.max(1.0, minY);
            airmassChart.options.scales.y.max = Math.min(10.0, maxY);

            airmassChart.update();
        } else {
            airmassChart.draw();
        }

        dragStart = null;
        dragEnd = null;
    });
}

function zoomChart(factor) {
    if (!airmassChart) return;

    const xAxis = airmassChart.scales.x;
    if (!xAxis) return;

    if (originalXMin === null) {
        originalXMin = xAxis.min;
        originalXMax = xAxis.max;
    }

    const currentMin = airmassChart.options.scales.x.min !== undefined ? airmassChart.options.scales.x.min : xAxis.min;
    const currentMax = airmassChart.options.scales.x.max !== undefined ? airmassChart.options.scales.x.max : xAxis.max;

    const center = (currentMin + currentMax) / 2;
    const halfRange = (currentMax - currentMin) / 2;

    const newHalfRange = halfRange * (1 - factor);

    const newMin = center - newHalfRange;
    const newMax = center + newHalfRange;

    if (newMin < originalXMin) {
        airmassChart.options.scales.x.min = originalXMin;
        if (airmassChart.options.scales.x2) airmassChart.options.scales.x2.min = originalXMin;
    } else {
        airmassChart.options.scales.x.min = newMin;
        if (airmassChart.options.scales.x2) airmassChart.options.scales.x2.min = newMin;
    }

    if (newMax > originalXMax) {
        airmassChart.options.scales.x.max = originalXMax;
        if (airmassChart.options.scales.x2) airmassChart.options.scales.x2.max = originalXMax;
    } else {
        airmassChart.options.scales.x.max = newMax;
        if (airmassChart.options.scales.x2) airmassChart.options.scales.x2.max = newMax;
    }

    airmassChart.update();
}

function resetChartZoom() {
    if (!airmassChart) return;

    if (originalXMin !== null) {
        airmassChart.options.scales.x.min = originalXMin;
        airmassChart.options.scales.x.max = originalXMax;
        if (airmassChart.options.scales.x2) {
            airmassChart.options.scales.x2.min = originalXMin;
            airmassChart.options.scales.x2.max = originalXMax;
        }

        airmassChart.options.scales.y.min = 1.0;
        airmassChart.options.scales.y.max = currentMaxAirmass;

        airmassChart.update();

        originalXMin = null;
        originalXMax = null;
    }
}


// ==============================================================================
// CLIENT-SIDE ASTRONOMICAL SCHEDULING SOLVER FALLBACK
// ==============================================================================

function datetimeToD(date) {
    const j2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
    return (date.getTime() - j2000.getTime()) / (1000 * 60 * 60 * 24);
}

function getLst(date, lon) {
    const d = datetimeToD(date);
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24.0;
    let lst = (gmst + lon / 15.0) % 24.0;
    if (lst < 0) lst += 24.0;
    return lst;
}

function getHourAngle(lst, ra) {
    let ha = lst - ra;
    ha = (ha + 12.0) % 24.0 - 12.0;
    return ha;
}

function getAltAz(date, lat, lon, ra, dec) {
    const lst = getLst(date, lon);
    const ha = getHourAngle(lst, ra);

    const haRad = (ha * 15.0) * Math.PI / 180.0;
    const decRad = dec * Math.PI / 180.0;
    const latRad = lat * Math.PI / 180.0;

    let sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    sinAlt = Math.max(-1.0, Math.min(1.0, sinAlt));
    const altRad = Math.asin(sinAlt);
    const alt = altRad * 180.0 / Math.PI;

    const cosAlt = Math.cos(altRad);
    let az = 0.0;
    if (cosAlt > 1e-9) {
        let cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * cosAlt);
        cosAz = Math.max(-1.0, Math.min(1.0, cosAz));
        az = Math.acos(cosAz) * 180.0 / Math.PI;
        if (Math.sin(haRad) > 0) {
            az = 360.0 - az;
        }
    }
    return { alt, az };
}

function getAirmass(alt) {
    if (alt <= 0) return 999.0;
    const zRad = (90.0 - alt) * Math.PI / 180.0;
    const cosZ = Math.cos(zRad);
    if (cosZ < 1e-4) return 999.0;
    return 1.0 / cosZ;
}

function getSunPosition(d) {
    const g = ((357.529 + 0.98560028 * d) % 360.0) * Math.PI / 180.0;
    const q = ((280.459 + 0.98564736 * d) % 360.0) * Math.PI / 180.0;
    const l = q + (1.915 * Math.PI / 180.0) * Math.sin(g) + (0.020 * Math.PI / 180.0) * Math.sin(2 * g);
    const obliq = (23.439 - 0.0000004 * d) * Math.PI / 180.0;

    const sinDec = Math.sin(obliq) * Math.sin(l);
    const dec = Math.asin(sinDec) * 180.0 / Math.PI;
    const cosL = Math.cos(l);
    const raRad = Math.atan2(Math.cos(obliq) * Math.sin(l), cosL);
    let ra = (raRad * 180.0 / Math.PI) % 360.0;
    if (ra < 0) ra += 360.0;
    return { ra: ra / 15.0, dec };
}

function getMoonPosition(d) {
    const l = ((218.316 + 13.176396 * d) % 360.0) * Math.PI / 180.0;
    const m = ((134.963 + 13.064993 * d) % 360.0) * Math.PI / 180.0;
    const f = ((93.272 + 13.229350 * d) % 360.0) * Math.PI / 180.0;
    const dElon = ((297.850 + 12.190749 * d) % 360.0) * Math.PI / 180.0;

    const lambdaM = l + (6.289 * Math.PI / 180.0) * Math.sin(m);
    const obliq = 23.439 * Math.PI / 180.0;

    const sinDec = Math.sin(lambdaM) * Math.sin(obliq);
    const dec = Math.asin(sinDec) * 180.0 / Math.PI;
    const raRad = Math.atan2(Math.cos(obliq) * Math.sin(lambdaM), Math.cos(lambdaM));
    let ra = (raRad * 180.0 / Math.PI) % 360.0;
    if (ra < 0) ra += 360.0;

    const phase = 0.5 * (1.0 - Math.cos(dElon));
    return { ra: ra / 15.0, dec, phase };
}

function getSeparation(ra1, dec1, ra2, dec2) {
    const ra1Rad = (ra1 * 15.0) * Math.PI / 180.0;
    const dec1Rad = dec1 * Math.PI / 180.0;
    const ra2Rad = (ra2 * 15.0) * Math.PI / 180.0;
    const dec2Rad = dec2 * Math.PI / 180.0;

    let cosTheta = Math.sin(dec1Rad) * Math.sin(dec2Rad) + Math.cos(dec1Rad) * Math.cos(dec2Rad) * Math.cos(ra1Rad - ra2Rad);
    cosTheta = Math.max(-1.0, Math.min(1.0, cosTheta));
    return Math.acos(cosTheta) * 180.0 / Math.PI;
}

function getSolarTimesFallback(dateUtc, lat, lon, elevation) {
    const noon = new Date(Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate(), 12, 0, 0));
    const d = datetimeToD(noon);
    const sun = getSunPosition(d);

    const lstNoon = getLst(noon, lon);
    const haNoon = getHourAngle(lstNoon, sun.ra);
    const transit = new Date(noon.getTime() - haNoon * 60 * 60 * 1000);

    const latRad = lat * Math.PI / 180.0;
    const decRad = sun.dec * Math.PI / 180.0;

    function timeForAltitude(h0Deg) {
        const h0Rad = h0Deg * Math.PI / 180.0;
        const numerator = Math.sin(h0Rad) - Math.sin(latRad) * Math.sin(decRad);
        const denominator = Math.cos(latRad) * Math.cos(decRad);
        if (denominator === 0) return { rise: null, set: null };
        const cosH0 = numerator / denominator;
        if (cosH0 > 1.0 || cosH0 < -1.0) return { rise: null, set: null };
        const h0RadVal = Math.acos(cosH0);
        const h0Hours = (h0RadVal * 180.0 / Math.PI) / 15.0;

        const setTime = new Date(transit.getTime() + h0Hours * 60 * 60 * 1000);
        const riseTime = new Date(transit.getTime() - h0Hours * 60 * 60 * 1000);
        return { rise: riseTime, set: setTime };
    }

    const h0Sunset = -0.833 - 1.15 * Math.sqrt(elevation) / 60.0;
    let sunsetObj = timeForAltitude(h0Sunset);
    let twi18Obj = timeForAltitude(-18.0);
    let twi12Obj = timeForAltitude(-12.0);

    let sunset = sunsetObj.set || new Date(transit.getTime() + 6 * 60 * 60 * 1000);
    let sunrise = sunsetObj.rise || new Date(transit.getTime() - 6 * 60 * 60 * 1000);
    let twiEve18 = twi18Obj.set || sunset;
    let twiMorn18 = twi18Obj.rise || sunrise;
    let twiEve12 = twi12Obj.set || sunset;
    let twiMorn12 = twi12Obj.rise || sunrise;

    if (sunrise < sunset) {
        sunrise = new Date(sunrise.getTime() + 24 * 60 * 60 * 1000);
    }
    if (twiMorn18 < twiEve18) {
        twiMorn18 = new Date(twiMorn18.getTime() + 24 * 60 * 60 * 1000);
    }
    if (twiMorn12 < twiEve12) {
        twiMorn12 = new Date(twiMorn12.getTime() + 24 * 60 * 60 * 1000);
    }

    return {
        sunset,
        sunrise,
        twilight_evening_18: twiEve18,
        twilight_morning_18: twiMorn18,
        twilight_evening_12: twiEve12,
        twilight_morning_12: twiMorn12
    };
}

function calculateExposure(target, moonPhase, moonSep, extinction = 0.0, latitude = 37.3414) {
    const zDeg = Math.abs(latitude - target.dec);
    let meridianAirmass = 999.0;
    if (zDeg < 90.0) {
        meridianAirmass = 1.0 / Math.cos(zDeg * Math.PI / 180.0);
    }

    let baseExp = 100.0 * Math.pow(2.512, target.magnitude - 15.0);
    baseExp = baseExp * Math.pow(2.512, extinction * meridianAirmass);

    const snMults = { classification: 0.5, normal: 1.0, high_sn: 2.0 };
    const snMult = snMults[target.sn_mode] || 1.0;
    const moonFactor = 1.0 + 5.0 * moonPhase * Math.exp(-moonSep / 30.0);
    const totalExp = baseExp * snMult * moonFactor;
    return Math.max(60.0, Math.min(7200.0, totalExp));
}

function runLocalJSSolver(payload) {
    const { date, observatory, targets } = payload;
    const activeTargets = targets.filter(t => !["Skipped", "Unobservable", "Failed", "Punted"].includes(t.status));
    const dateParts = date.split('-');

    const localNoon = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0);
    const lickOffset = getLickTimezoneOffsetHours(localNoon);
    const offsetHours = -lickOffset;
    const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);

    const solarTimes = getSolarTimesFallback(utcNoon, observatory.lat, observatory.lon, observatory.elevation);

    let sunset = solarTimes.sunset;
    let sunrise = solarTimes.sunrise;

    if (payload.night_start_override) {
        sunset = new Date(payload.night_start_override);
        solarTimes.sunset = sunset;
        if (solarTimes.twilight_evening_18 < sunset) solarTimes.twilight_evening_18 = sunset;
    }
    if (payload.night_end_override) {
        sunrise = new Date(payload.night_end_override);
        solarTimes.sunrise = sunrise;
        if (solarTimes.twilight_morning_18 > sunrise) solarTimes.twilight_morning_18 = sunrise;
    }

    const totalDurationMs = sunrise.getTime() - sunset.getTime();
    const numChunks = Math.floor(totalDurationMs / (60 * 1000));

    const chunkTimes = [];
    for (let i = 0; i < numChunks; i++) {
        chunkTimes.push(new Date(sunset.getTime() + i * 1 * 60 * 1000));
    }

    const midTime = new Date(sunset.getTime() + totalDurationMs / 2);
    const dMid = datetimeToD(midTime);
    const moon = getMoonPosition(dMid);

    function getAirmassForTarget(t, dt) {
        const altAz = getAltAz(dt, observatory.lat, observatory.lon, t.ra, t.dec);
        return getAirmass(altAz.alt);
    }

    function isShaneVisible(t, dt) {
        if (t.dec < -35.0 || t.dec > 72.0) return false;
        const lst = getLst(dt, observatory.lon);
        const ha = getHourAngle(lst, t.ra);
        // East -05:40 (-5.67h), West +03:45 (+3.75h)
        if (ha < -5.6667 || ha > 3.75) return false;
        return true;
    }

    function isChunkValid(t, cIdx, isManual = false) {
        const dt = chunkTimes[cIdx];

        // Twilight check
        if (!isManual) {
            if (!t.allow_twilight) {
                if (dt < solarTimes.twilight_evening_18 || dt > solarTimes.twilight_morning_18) {
                    return false;
                }
            } else {
                const limitStart = new Date(sunset.getTime() + 30 * 60 * 1000);
                const limitEnd = new Date(sunrise.getTime() - 30 * 60 * 1000);
                if (dt < limitStart || dt > limitEnd) {
                    return false;
                }
            }
        }

        // Pointing check
        if (!isManual && !isShaneVisible(t, dt)) return false;

        // Airmass check
        const airmass = getAirmassForTarget(t, dt);
        if (isManual) {
            if (airmass <= 0) return false;
        } else {
            const limitAirmass = t.high_airmass ? 2.2 : 1.7;
            if (airmass <= 0 || airmass > limitAirmass) return false;
        }

        // Real-time limits
        if (!isManual) {
            const rt = payload.realtime_constraints || {};
            
            // Dec limit
            const decMin = (rt.dec_min !== undefined && rt.dec_min !== null && rt.dec_min !== "") ? parseFloat(rt.dec_min) : -35.0;
            const decMax = (rt.dec_max !== undefined && rt.dec_max !== null && rt.dec_max !== "") ? parseFloat(rt.dec_max) : 72.0;
            if (t.dec < decMin || t.dec > decMax) return false;

            // Alt limit
            const altMin = (rt.alt_limit !== undefined && rt.alt_limit !== null && rt.alt_limit !== "") ? parseFloat(rt.alt_limit) : 20.0;
            const altMax = (rt.alt_max !== undefined && rt.alt_max !== null && rt.alt_max !== "") ? parseFloat(rt.alt_max) : 90.0;
            const altAz = getAltAz(dt, observatory.lat, observatory.lon, t.ra, t.dec);
            if (altAz.alt < altMin || altAz.alt > altMax) return false;

            // Az limit
            const azMin = (rt.az_min !== undefined && rt.az_min !== null && rt.az_min !== "") ? parseFloat(rt.az_min) : 0.0;
            const azMax = (rt.az_max !== undefined && rt.az_max !== null && rt.az_max !== "") ? parseFloat(rt.az_max) : 360.0;
            if (azMin <= azMax) {
                if (altAz.az < azMin || altAz.az > azMax) return false;
            } else {
                if (altAz.az < azMin && altAz.az > azMax) return false;
            }

            // HA limit
            const ha_east = rt.ha_limit_east !== undefined && rt.ha_limit_east !== null && rt.ha_limit_east !== "" ? parseFloat(rt.ha_limit_east) : -5.6667;
            const ha_west = rt.ha_limit_west !== undefined && rt.ha_limit_west !== null && rt.ha_limit_west !== "" ? parseFloat(rt.ha_limit_west) : 3.75;
            const lst = getLst(dt, observatory.lon);
            const ha = getHourAngle(lst, t.ra);
            if (ha < ha_east || ha > ha_west) return false;
        }

        return true;
    }

    function getChunkIdxFromTimeStr(timeStr) {
        if (!timeStr) return null;
        timeStr = timeStr.trim();
        if (!timeStr) return null;

        let targetTime = null;
        if (timeStr.includes("T")) {
            const parsed = new Date(timeStr);
            if (!isNaN(parsed.getTime())) {
                targetTime = parsed;
            }
        }

        if (targetTime) {
            let bestIdx = null;
            let minDiff = Infinity;
            for (let i = 0; i < chunkTimes.length; i++) {
                const diff = Math.abs(chunkTimes[i].getTime() - targetTime.getTime());
                if (diff < minDiff) {
                    minDiff = diff;
                    bestIdx = i;
                }
            }
            if (minDiff < 1800000) { // 30 minutes
                return bestIdx;
            }
        } else if (timeStr.includes(":")) {
            const parts = timeStr.split(":");
            const hh = parseInt(parts[0], 10);
            const mm = parseInt(parts[1], 10);
            if (isNaN(hh) || isNaN(mm)) return null;

            for (let i = 0; i < chunkTimes.length; i++) {
                const ct = chunkTimes[i];
                const ctHH = ct.getUTCHours();
                const ctMM = ct.getUTCMinutes();
                const diffMin = Math.abs((ctHH - hh) * 60 + (ctMM - mm));
                if (diffMin < 30 || diffMin > 1410) {
                    return i;
                }
            }
            for (let i = 0; i < chunkTimes.length; i++) {
                const ct = chunkTimes[i];
                const ctHH = ct.getHours();
                const ctMM = ct.getMinutes();
                const diffMin = Math.abs((ctHH - hh) * 60 + (ctMM - mm));
                if (diffMin < 30 || diffMin > 1410) {
                    return i;
                }
            }
        }
        return null;
    }

    // Sort and calculate exposures
    const targetExposures = {};
    activeTargets.forEach(t => {
        if (t.manual_duration !== null && t.manual_duration !== undefined) {
            targetExposures[t.name] = t.manual_duration * 60.0;
        } else {
            const sep = getSeparation(t.ra, t.dec, moon.ra, moon.dec);
            const extinction = (payload.realtime_constraints && payload.realtime_constraints.extinction !== undefined) ? parseFloat(payload.realtime_constraints.extinction) : 0.0;
            targetExposures[t.name] = calculateExposure(t, moon.phase, sep, extinction, observatory.lat);
        }
    });

    const durations = {};
    activeTargets.forEach(t => {
        durations[t.name] = Math.ceil(targetExposures[t.name] / 60.0);
    });

    // Pre-schedule manual start science targets immediately and reserve their chunks
    const reservedChunks = new Set();
    const manualScienceBlocks = [];
    const manuallyScheduledNames = new Set();

    activeTargets.forEach(t => {
        const manualChunk = getChunkIdxFromTimeStr(t.manual_start_time);
        if (manualChunk !== null) {
            const durChunks = durations[t.name];
            let blockValid = true;
            for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                if (c >= numChunks || reservedChunks.has(c) || !isChunkValid(t, c, true)) {
                    blockValid = false;
                    break;
                }
            }
            if (blockValid) {
                for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                    reservedChunks.add(c);
                }
                const air = getAirmassForTarget(t, chunkTimes[manualChunk]);
                const airmasses = [];
                for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                    airmasses.push(getAirmassForTarget(t, chunkTimes[c]));
                }
                airmasses.sort((a,b)=>a-b);
                const mid = Math.floor(airmasses.length / 2);
                const medianAir = airmasses.length % 2 !== 0 ? airmasses[mid] : (airmasses[mid-1] + airmasses[mid]) / 2.0;

                manualScienceBlocks.push({
                    target_name: t.name,
                    ra: t.ra,
                    dec: t.dec,
                    start_time: chunkTimes[manualChunk].toISOString(),
                    end_time: (manualChunk + durChunks < numChunks) ? chunkTimes[manualChunk + durChunks].toISOString() : sunrise.toISOString(),
                    duration_minutes: durChunks * 1,
                    airmass_start: air,
                    airmass_end: getAirmassForTarget(t, chunkTimes[manualChunk + durChunks - 1]),
                    airmass_median: medianAir,
                    priority: t.priority,
                    comment: t.comment
                });
                manuallyScheduledNames.add(t.name);
            }
        }
    });

    const remainingTargets = activeTargets.filter(t => !manuallyScheduledNames.has(t.name));

    // 1. Run preliminary solve to see what gets scheduled and if we need high-airmass calibrations
    const prelimSolve = solveInternal(remainingTargets, new Set(reservedChunks));
    const scheduledScience = prelimSolve.blocks;

    let needHighAirmass = false;
    for (let i = 0; i < scheduledScience.length; i++) {
        if (scheduledScience[i].airmass_median > 1.5) {
            needHighAirmass = true;
            break;
        }
    }

    // Determine evening/morning twilight boundaries for standard star scheduling
    let eveTwilStart, eveTwilEnd, mornTwilStart, mornTwilEnd;
    if (payload.manual_limits_enabled) {
        eveTwilStart = sunset;
        eveTwilEnd = new Date(sunset.getTime() + 1.5 * 60 * 60 * 1000);
        mornTwilStart = new Date(sunrise.getTime() - 1.5 * 60 * 60 * 1000);
        mornTwilEnd = sunrise;
    } else {
        eveTwilStart = sunset;
        eveTwilEnd = new Date(new Date(solarTimes.twilight_evening_18).getTime() + 30 * 60 * 1000);
        mornTwilStart = new Date(new Date(solarTimes.twilight_morning_18).getTime() - 30 * 60 * 1000);
        mornTwilEnd = sunrise;
    }

    // 2. Determine standard stars twilight slots (restricted to at least 30 minutes after sunset / chunk 30)
    let eveSlot1 = 30;
    let eveSlot2 = 35;
    const brightThreshold = 15.5; // Lick Shane threshold

    const scienceStartBlock = scheduledScience.find(b => new Date(b.start_time).getTime() === chunkTimes[0].getTime());
    if (scienceStartBlock) {
        const sciTarget = remainingTargets.find(t => t.name === scienceStartBlock.target_name);
        if (sciTarget && sciTarget.magnitude < brightThreshold) {
            eveSlot1 = Math.max(30, Math.ceil(scienceStartBlock.duration_minutes));
            eveSlot2 = eveSlot1 + 5;
        }
    }

    let mornSlot2 = numChunks - 35;
    let mornSlot1 = mornSlot2 - 5;
    const scienceEndBlock = scheduledScience.find(b => new Date(b.end_time).getTime() === chunkTimes[numChunks - 1].getTime());
    if (scienceEndBlock) {
        const sciTarget = remainingTargets.find(t => t.name === scienceEndBlock.target_name);
        if (sciTarget && sciTarget.magnitude < brightThreshold) {
            mornSlot2 = Math.min(numChunks - 35, numChunks - 5 - Math.ceil(scienceEndBlock.duration_minutes));
            mornSlot1 = mornSlot2 - 5;
        }
    }

    // 3. Load standard stars database
    let standardsData = [
        {"name": "BD+284211", "ra": 21.853, "dec": 28.86, "color": "blue", "quality": "good", "magnitude": 10.5},
        {"name": "BD+174708", "ra": 22.192, "dec": 18.09, "color": "red", "quality": "good", "magnitude": 9.5},
        {"name": "HD19445", "ra": 3.140, "dec": 26.33, "color": "red", "quality": "good", "magnitude": 8.0},
        {"name": "G191B2B", "ra": 5.092, "dec": 52.83, "color": "blue", "quality": "okay", "magnitude": 11.8},
        {"name": "HD84937", "ra": 9.816, "dec": 13.74, "color": "red", "quality": "okay", "magnitude": 8.3},
        {"name": "Feige 34", "ra": 10.660, "dec": 43.10, "color": "blue", "quality": "good", "magnitude": 11.2},
        {"name": "HZ 44", "ra": 13.393, "dec": 36.13, "color": "blue", "quality": "okay", "magnitude": 11.7},
        {"name": "BD+262606", "ra": 14.817, "dec": 25.70, "color": "red", "quality": "good", "magnitude": 9.7},
        {"name": "Feige 110", "ra": 23.333, "dec": -5.16, "color": "blue", "quality": "good", "magnitude": 11.8},
        {"name": "LTT 377", "ra": 0.696, "dec": -33.65, "color": "blue", "quality": "okay", "magnitude": 11.2},
        {"name": "LTT 1788", "ra": 3.806, "dec": -39.14, "color": "blue", "quality": "okay", "magnitude": 13.1},
        {"name": "LTT 2415", "ra": 5.940, "dec": -27.86, "color": "blue", "quality": "okay", "magnitude": 12.2}
    ];

    if (payload.auto_standards === false) {
        const selectedSet = new Set(payload.selected_standards || []);
        standardsData = standardsData.filter(s => selectedSet.has(s.name));
    } else if (payload.disabled_standards) {
        const disabledSet = new Set(payload.disabled_standards);
        standardsData = standardsData.filter(s => !disabledSet.has(s.name));
    }

    const standardBlocks = [];

    function addStandardBlock(starObj, chunkIdx) {
        const targetObj = {
            name: starObj.name,
            ra: starObj.ra,
            dec: starObj.dec,
            magnitude: starObj.magnitude,
            priority: 0.0,
            allow_twilight: true,
            high_airmass: false,
            comment: `Calib: ${starObj.color.charAt(0).toUpperCase() + starObj.color.slice(1)} / ${starObj.quality.charAt(0).toUpperCase() + starObj.quality.slice(1)}, Airmass ${getAirmassForTarget(starObj, chunkTimes[chunkIdx]).toFixed(2)}`
        };
        const durChunks = 5; // 5 min block
        for (let c = chunkIdx; c < chunkIdx + durChunks; c++) {
            reservedChunks.add(c);
        }
        const air = getAirmassForTarget(starObj, chunkTimes[chunkIdx]);
        standardBlocks.push({
            target_name: targetObj.name,
            ra: starObj.ra,
            dec: starObj.dec,
            start_time: chunkTimes[chunkIdx].toISOString(),
            end_time: (chunkIdx + durChunks < numChunks) ? chunkTimes[chunkIdx + durChunks].toISOString() : sunrise.toISOString(),
            duration_minutes: durChunks * 1,
            airmass_start: air,
            airmass_end: air,
            airmass_median: air,
            priority: 0.0,
            comment: targetObj.comment
        });
    }

    if (payload.auto_standards === false) {
        // Sort standards by RA to schedule in logical sky order
        standardsData.sort((a, b) => a.ra - b.ra);

        // Find twilight chunks based on twilight boundaries
        const twilChunks = [];
        for (let i = 0; i < numChunks; i++) {
            const cTime = chunkTimes[i];
            const isEveTwil = (eveTwilStart.getTime() <= cTime.getTime() && cTime.getTime() <= eveTwilEnd.getTime());
            const isMornTwil = (mornTwilStart.getTime() <= cTime.getTime() && cTime.getTime() <= mornTwilEnd.getTime());
            if (isEveTwil || isMornTwil) {
                twilChunks.push(i);
            }
        }

        standardsData.forEach(s => {
            function findBestChunk(allowedChunks, maxAirmass) {
                let bc = null;
                let ba = Infinity;
                const durChunks = 5;
                for (let j = 0; j < allowedChunks.length; j++) {
                    const cIdx = allowedChunks[j];
                    if (cIdx + durChunks > numChunks) continue;
                    
                    let hasReserved = false;
                    for (let c = cIdx; c < cIdx + durChunks; c++) {
                        if (reservedChunks.has(c)) {
                            hasReserved = true;
                            break;
                        }
                    }
                    if (hasReserved) continue;
                    
                    let visible = true;
                    for (let c = cIdx; c < cIdx + durChunks; c++) {
                        if (!isShaneVisible(s, chunkTimes[c])) {
                            visible = false;
                            break;
                        }
                    }
                    if (!visible) continue;

                    const air = getAirmassForTarget(s, chunkTimes[cIdx]);
                    if (air > 0 && air <= maxAirmass) {
                        if (air < ba) {
                            ba = air;
                            bc = cIdx;
                        }
                    }
                }
                return { bestC: bc, bestAirmass: ba };
            }

            // Pass 1: twilight chunks, airmass <= 2.2
            let res = findBestChunk(twilChunks, 2.2);

            // Pass 2: twilight chunks, airmass <= 2.5
            if (res.bestC === null) {
                res = findBestChunk(twilChunks, 2.5);
            }

            // Pass 3: all night chunks, airmass <= 2.2
            const allChunks = Array.from({length: numChunks}, (_, i) => i);
            if (res.bestC === null) {
                res = findBestChunk(allChunks, 2.2);
            }

            // Pass 4: all night chunks, airmass <= 2.5
            if (res.bestC === null) {
                res = findBestChunk(allChunks, 2.5);
            }

            // Pass 5: all night chunks, any visibility (airmass <= 10.0)
            if (res.bestC === null) {
                res = findBestChunk(allChunks, 10.0);
            }

            if (res.bestC !== null) {
                addStandardBlock(s, res.bestC);
            }
        });
    } else {
        const blueStandards = standardsData.filter(s => s.color === 'blue');
        const redStandards = standardsData.filter(s => s.color === 'red');

        let s_eb = null;
        let s_er = null;
        let s_mb = null;
        let s_mr = null;

        // Evening Blue (Slot 1)
        let best_eb_score = -1.0;
        blueStandards.forEach(s => {
            for (let c = eveSlot1; c < eveSlot1 + 5; c++) {
                if (reservedChunks.has(c)) return;
            }
            if (!isShaneVisible(s, chunkTimes[eveSlot1])) return;
            const air = getAirmassForTarget(s, chunkTimes[eveSlot1]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 10.0 : 5.0;
                if (needHighAirmass) {
                    if (air >= 1.5 && air <= 2.2) score += 20.0;
                } else {
                    if (air < 1.3) score += 20.0;
                }
                if (score > best_eb_score) {
                    best_eb_score = score;
                    s_eb = s;
                }
            }
        });

        // Evening Red (Slot 2)
        let best_er_score = -1.0;
        redStandards.forEach(s => {
            for (let c = eveSlot2; c < eveSlot2 + 5; c++) {
                if (reservedChunks.has(c)) return;
            }
            if (!isShaneVisible(s, chunkTimes[eveSlot2])) return;
            const air = getAirmassForTarget(s, chunkTimes[eveSlot2]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 10.0 : 5.0;
                if (needHighAirmass) {
                    if (air >= 1.5 && air <= 2.2) score += 20.0;
                } else {
                    if (air < 1.3) score += 20.0;
                }
                if (score > best_er_score) {
                    best_er_score = score;
                    s_er = s;
                }
            }
        });

        // Morning Blue (Slot 1)
        let best_mb_score = -1.0;
        blueStandards.forEach(s => {
            for (let c = mornSlot1; c < mornSlot1 + 5; c++) {
                if (reservedChunks.has(c)) return;
            }
            if (!isShaneVisible(s, chunkTimes[mornSlot1])) return;
            const air = getAirmassForTarget(s, chunkTimes[mornSlot1]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 10.0 : 5.0;
                if (needHighAirmass) {
                    if (air >= 1.5 && air <= 2.2) score += 20.0;
                } else {
                    if (air < 1.3) score += 20.0;
                }
                if (score > best_mb_score) {
                    best_mb_score = score;
                    s_mb = s;
                }
            }
        });

        // Morning Red (Slot 2)
        let best_mr_score = -1.0;
        redStandards.forEach(s => {
            for (let c = mornSlot2; c < mornSlot2 + 5; c++) {
                if (reservedChunks.has(c)) return;
            }
            if (!isShaneVisible(s, chunkTimes[mornSlot2])) return;
            const air = getAirmassForTarget(s, chunkTimes[mornSlot2]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 10.0 : 5.0;
                if (needHighAirmass) {
                    if (air >= 1.5 && air <= 2.2) score += 20.0;
                } else {
                    if (air < 1.3) score += 20.0;
                }
                if (score > best_mr_score) {
                    best_mr_score = score;
                    s_mr = s;
                }
            }
        });

        if (s_eb !== null) addStandardBlock(s_eb, eveSlot1);
        if (s_er !== null) addStandardBlock(s_er, eveSlot2);
        if (s_mb !== null) addStandardBlock(s_mb, mornSlot1);
        if (s_mr !== null) addStandardBlock(s_mr, mornSlot2);
    }

    // 4. Run final solve with reserved standard blocks
    const finalSolve = solveInternal(remainingTargets, reservedChunks);
    const scheduledBlocks = [...finalSolve.blocks, ...standardBlocks, ...manualScienceBlocks];
    scheduledBlocks.sort((a,b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

    // Gaps (empty blocks)
    const empty_blocks = [];
    if (finalSolve.conflicts.length === 0 && scheduledBlocks.length > 0) {
        const startActive = new Date(sunset.getTime() + 30 * 60 * 1000);
        const endActive = new Date(sunrise.getTime() - 30 * 60 * 1000);

        let curr = startActive;
        scheduledBlocks.forEach(b => {
            const bStart = new Date(b.start_time);
            const bEnd = new Date(b.end_time);
            if (bStart > new Date(curr.getTime() + 5 * 60 * 1000)) {
                empty_blocks.push({
                    start_time: curr.toISOString(),
                    end_time: b.start_time,
                    duration_minutes: Math.round((bStart.getTime() - curr.getTime()) / (60 * 1000))
                });
            }
            curr = bEnd > curr ? bEnd : curr;
        });

        if (new Date(curr.getTime() + 5 * 60 * 1000) < endActive) {
            empty_blocks.push({
                start_time: curr.toISOString(),
                end_time: endActive.toISOString(),
                duration_minutes: Math.round((endActive.getTime() - curr.getTime()) / (60 * 1000))
            });
        }
    }

    // Airmass curves (including standard stars)
    const airmass_plots = {};
    targets.forEach(t => {
        const curve = [];
        for (let i = 0; i < numChunks; i++) {
            curve.push({
                time: chunkTimes[i].toISOString(),
                airmass: getAirmassForTarget(t, chunkTimes[i])
            });
        }
        airmass_plots[t.name] = curve;
    });

    standardBlocks.forEach(block => {
        const star = standardsData.find(s => s.name === block.target_name);
        const curve = [];
        for (let i = 0; i < numChunks; i++) {
            curve.push({
                time: chunkTimes[i].toISOString(),
                airmass: getAirmassForTarget(star, chunkTimes[i])
            });
        }
        airmass_plots[block.target_name] = curve;
    });

    // Moon altitude/airmass curve
    const moon_plot = [];
    for (let i = 0; i < numChunks; i++) {
        const dt = chunkTimes[i];
        const altAz = getAltAz(dt, observatory.lat, observatory.lon, moon.ra, moon.dec);
        const airmass = getAirmass(altAz.alt);
        moon_plot.push({
            time: dt.toISOString(),
            airmass: (altAz.alt > 0 && airmass < 10.0) ? airmass : 999.0,
            alt: altAz.alt
        });
    }

    return {
        blocks: scheduledBlocks,
        conflicts: finalSolve.conflicts,
        unobservable: finalSolve.unobservable,
        empty_blocks,
        moon_info: moon,
        moon_plot,
        airmass_plots,
        solar_times: {
            sunset: sunset.toISOString(),
            sunrise: sunrise.toISOString(),
            twilight_evening_18: solarTimes.twilight_evening_18.toISOString(),
            twilight_morning_18: solarTimes.twilight_morning_18.toISOString(),
            twilight_evening_12: solarTimes.twilight_evening_12.toISOString(),
            twilight_morning_12: solarTimes.twilight_morning_12.toISOString()
        }
    };

    // Internal solve helper function
    function solveInternal(targetsList, reserved) {
        const targetExps = {};
        const extinction = (payload.realtime_constraints && payload.realtime_constraints.extinction !== undefined) ? parseFloat(payload.realtime_constraints.extinction) : 0.0;
        targetsList.forEach(t => {
            if (t.manual_duration !== null && t.manual_duration !== undefined) {
                targetExps[t.name] = t.manual_duration * 60.0;
            } else {
                const sep = getSeparation(t.ra, t.dec, moon.ra, moon.dec);
                targetExps[t.name] = calculateExposure(t, moon.phase, sep, extinction, observatory.lat);
            }
        });

        const manualStartChunks = {};
        targetsList.forEach(t => {
            manualStartChunks[t.name] = getChunkIdxFromTimeStr(t.manual_start_time);
        });

        const durations = {};
        targetsList.forEach(t => {
            durations[t.name] = Math.ceil(targetExps[t.name] / 60.0);
        });

        const unobservable = [];
        const observable = [];

        targetsList.forEach(t => {
            let hasAnyValid = false;
            const manualChunk = manualStartChunks[t.name];
            if (manualChunk !== null) {
                if (!reserved.has(manualChunk) && isChunkValid(t, manualChunk, true)) {
                    hasAnyValid = true;
                }
            } else {
                for (let c = 0; c < numChunks; c++) {
                    if (!reserved.has(c) && isChunkValid(t, c)) {
                        hasAnyValid = true;
                        break;
                    }
                }
            }
            if (!hasAnyValid) {
                unobservable.push(t.name);
            } else {
                observable.push(t);
            }
        });

        const targetsByPrio = {};
        targetsList.forEach(t => {
            if (!targetsByPrio[t.priority]) targetsByPrio[t.priority] = [];
            targetsByPrio[t.priority].push(t);
        });
        const sortedPrios = Object.keys(targetsByPrio).map(Number).sort((a,b)=>a-b);

        const obsTargetsByPrio = {};
        observable.forEach(t => {
            if (!obsTargetsByPrio[t.priority]) obsTargetsByPrio[t.priority] = [];
            obsTargetsByPrio[t.priority].push(t);
        });

        let currentSchedule = {}; // name -> startChunk
        const conflicts = [];

        // Pre-schedule manual start science targets immediately and reserve their chunks
        observable.forEach(t => {
            const manualChunk = manualStartChunks[t.name];
            if (manualChunk !== null) {
                const durChunks = durations[t.name];
                let blockValid = true;
                for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                    if (c >= numChunks || reserved.has(c) || !isChunkValid(t, c, true)) {
                        blockValid = false;
                        break;
                    }
                }
                if (blockValid) {
                    currentSchedule[t.name] = manualChunk;
                    for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                        reserved.add(c);
                    }
                } else {
                    conflicts.push(t.name);
                }
            }
        });

        sortedPrios.forEach(prio => {
            const prioTargets = (obsTargetsByPrio[prio] || []).filter(tg => currentSchedule[tg.name] === undefined);
            if (prioTargets.length === 0) return;

            const targetsToSchedule = [];
            sortedPrios.forEach(p => {
                if (p <= prio) {
                    targetsToSchedule.push(...(obsTargetsByPrio[p] || []).filter(tg => currentSchedule[tg.name] === undefined));
                }
            });

            const validSlots = {};
            const airmassCosts = {};

            targetsToSchedule.forEach(t => {
                const durChunks = durations[t.name];
                const slots = [];
                const costs = {};

                for (let s = 0; s <= numChunks - durChunks; s++) {
                    let blockValid = true;
                    const airmasses = [];
                    for (let c = s; c < s + durChunks; c++) {
                        if (reserved.has(c) || !isChunkValid(t, c)) {
                            blockValid = false;
                            break;
                        }
                        airmasses.push(getAirmassForTarget(t, chunkTimes[c]));
                    }

                    if (blockValid) {
                        slots.push(s);
                        airmasses.sort((a,b)=>a-b);
                        const mid = Math.floor(airmasses.length / 2);
                        const median = airmasses.length % 2 !== 0 ? airmasses[mid] : (airmasses[mid-1] + airmasses[mid]) / 2.0;
                        costs[s] = median;
                    }
                }

                validSlots[t.name] = slots;
                airmassCosts[t.name] = costs;
            });

            const solverTargets = [...targetsToSchedule].sort((a,b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return durations[b.name] - durations[a.name];
            });

            let bestSchedule = null;
            let bestCost = Infinity;
            let searchIterations = 0;
            const maxSearchIterations = 2000;
            let aborted = false;

            function overlap(s1, d1, s2, d2) {
                return !(s1 + d1 <= s2 || s2 + d2 <= s1);
            }

            function search(idx, sched, cost) {
                if (aborted) return;
                searchIterations++;
                if (searchIterations > maxSearchIterations) {
                    aborted = true;
                    return;
                }
                if (idx === solverTargets.length) {
                    if (cost < bestCost) {
                        bestCost = cost;
                        bestSchedule = Object.assign({}, sched);
                    }
                    return;
                }

                const target = solverTargets[idx];
                const name = target.name;
                const dur = durations[name];

                let lb = 0;
                for (let r = idx; r < solverTargets.length; r++) {
                    const rName = solverTargets[r].name;
                    const rCosts = Object.values(airmassCosts[rName] || {});
                    if (rCosts.length > 0) {
                        lb += Math.min(...rCosts);
                    }
                }

                if (cost + lb >= bestCost) return;

                const slots = validSlots[name] || [];
                const sortedSlots = [...slots].sort((a,b) => airmassCosts[name][a] - airmassCosts[name][b]);

                for (let i = 0; i < sortedSlots.length; i++) {
                    if (aborted) return;
                    const s = sortedSlots[i];
                    let isOverlap = false;
                    const keys = Object.keys(sched);
                    for (let k = 0; k < keys.length; k++) {
                        const pName = keys[k];
                        if (overlap(s, dur, sched[pName], durations[pName])) {
                            isOverlap = true;
                            break;
                        }
                    }
                    if (isOverlap) continue;

                    let precedenceOk = true;
                    const keysSched = Object.keys(sched);
                    for (let k = 0; k < keysSched.length; k++) {
                        const pName = keysSched[k];
                        const pStart = sched[pName];
                        const pDur = durations[pName];

                        if (target.schedule_before && target.schedule_before.includes(pName)) {
                            if (!(s + dur <= pStart)) {
                                precedenceOk = false;
                                break;
                            }
                        }

                        const pObj = solverTargets.find(tg => tg.name === pName);
                        if (pObj && pObj.schedule_before && pObj.schedule_before.includes(name)) {
                            if (!(pStart + pDur <= s)) {
                                precedenceOk = false;
                                break;
                            }
                        }
                    }

                    if (!precedenceOk) continue;

                    sched[name] = s;
                    search(idx + 1, sched, cost + airmassCosts[name][s]);
                    delete sched[name];
                }
            }

            search(0, {}, 0);

            if (bestSchedule !== null) {
                const manualSched = {};
                observable.forEach(t => {
                    if (manualStartChunks[t.name] !== null && currentSchedule[t.name] !== undefined) {
                        manualSched[t.name] = currentSchedule[t.name];
                    }
                });
                currentSchedule = Object.assign(manualSched, bestSchedule);
            } else {
                prioTargets.forEach(t => {
                    const dur = durations[t.name];
                    let fit = false;
                    const slots = validSlots[t.name] || [];
                    for (let i = 0; i < slots.length; i++) {
                        const s = slots[i];
                        let isOverlap = false;
                        const keys = Object.keys(currentSchedule);
                        for (let k = 0; k < keys.length; k++) {
                            const pName = keys[k];
                            if (overlap(s, dur, currentSchedule[pName], durations[pName])) {
                                isOverlap = true;
                                break;
                            }
                        }
                        if (!isOverlap) {
                            let precedenceOk = true;
                            const keysSched = Object.keys(currentSchedule);
                            for (let k = 0; k < keysSched.length; k++) {
                                const pName = keysSched[k];
                                const pStart = currentSchedule[pName];
                                const pDur = durations[pName];

                                if (t.schedule_before && t.schedule_before.includes(pName)) {
                                    if (!(s + dur <= pStart)) {
                                        precedenceOk = false;
                                        break;
                                    }
                                }

                                const pObj = solverTargets.find(tg => tg.name === pName);
                                if (pObj && pObj.schedule_before && pObj.schedule_before.includes(t.name)) {
                                    if (!(pStart + pDur <= s)) {
                                        precedenceOk = false;
                                        break;
                                    }
                                }
                            }
                            if (precedenceOk) {
                                fit = true;
                                currentSchedule[t.name] = s;
                                break;
                            }
                        }
                    }
                    if (!fit) {
                        conflicts.push(t.name);
                    }
                });
            }
        });

        const blocksList = [];
        Object.keys(currentSchedule).forEach(name => {
            const target = targetsList.find(t => t.name === name);
            const startIdx = currentSchedule[name];
            const durChunks = durations[name];

            const airmasses = [];
            for (let c = startIdx; c < startIdx + durChunks; c++) {
                airmasses.push(getAirmassForTarget(target, chunkTimes[c]));
            }

            const startAir = airmasses[0];
            const endAir = airmasses[airmasses.length - 1];
            const sortedAir = [...airmasses].sort((a,b)=>a-b);
            const mid = Math.floor(sortedAir.length / 2);
            const medianAir = sortedAir.length % 2 !== 0 ? sortedAir[mid] : (sortedAir[mid-1] + sortedAir[mid]) / 2.0;

            blocksList.push({
                target_name: name,
                start_time: chunkTimes[startIdx].toISOString(),
                end_time: (startIdx + durChunks < numChunks) ? chunkTimes[startIdx + durChunks].toISOString() : sunrise.toISOString(),
                duration_minutes: durChunks * 1,
                airmass_start: startAir,
                airmass_end: endAir,
                airmass_median: medianAir,
                priority: target.priority,
                comment: target.comment
            });
        });

        return {
            blocks: blocksList,
            conflicts,
            unobservable
        };
    }
}

// ==============================================================================
// SKY ALT/AZ POLAR MAP RENDERING
// ==============================================================================
function drawPolarSkyMap(blocks, targetPool, solar_times) {
    const canvas = document.getElementById("polarChart");
    if (!canvas) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    const size = Math.min(rect.width, 350) || 300;
    canvas.width = size * window.devicePixelRatio;
    canvas.height = size * window.devicePixelRatio;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Clear and draw sky background
    ctx.fillStyle = "#0b0f19";
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const rMax = (size / 2) - 25; // outer circle radius (horizon)

    // Draw outer horizon circle
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rMax, 0, 2 * Math.PI);
    ctx.stroke();

    // Draw concentric elevation circles (Alt = 30, Alt = 60)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    [30, 60].forEach(alt => {
        const r = rMax * ((90 - alt) / 90);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        ctx.font = "8px Inter";
        ctx.fillText(`${alt}°`, cx + 2, cy - r + 8);
    });

    // Draw radial azimuth grid lines (N-S, E-W)
    ctx.beginPath();
    ctx.moveTo(cx, cy - rMax);
    ctx.lineTo(cx, cy + rMax);
    ctx.moveTo(cx - rMax, cy);
    ctx.lineTo(cx + rMax, cy);
    ctx.stroke();

    // Draw cardinal direction labels
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px Inter";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.fillText("N", cx, cy - rMax - 12);
    ctx.fillText("S", cx, cy + rMax + 12);
    ctx.fillText("E", cx + rMax + 12, cy);
    ctx.fillText("W", cx - rMax - 12, cy);

    // Map of colors for scheduled blocks (matching airmass chart)
    const colorPalette = [
        '#ef4444', '#f59e0b', '#10b981', '#06b6d4',
        '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
    ];

    const obs = { lat: 37.3414, lon: -121.6429 };

    blocks.forEach((b, idx) => {
        const color = colorPalette[idx % colorPalette.length];

        let ra = b.ra;
        let dec = b.dec;
        if (ra === undefined || dec === undefined) {
            const target = targetPool.find(t => t.name === b.target_name);
            if (target) {
                ra = target.ra;
                dec = target.dec;
            } else {
                const std = standardStars.find(s => s.name === b.target_name);
                if (std) {
                    ra = typeof std.ra === 'number' ? std.ra : parseCoordinate(std.ra, true);
                    dec = typeof std.dec === 'number' ? std.dec : parseCoordinate(std.dec, false);
                }
            }
        }
        if (ra === undefined || dec === undefined || isNaN(ra) || isNaN(dec)) return;

        const bStart = new Date(b.start_time);
        const bEnd = new Date(b.end_time);
        const durationMs = bEnd.getTime() - bStart.getTime();

        const points = [];
        const stepMs = Math.max(5 * 60 * 1000, durationMs / 10);

        for (let timeMs = bStart.getTime(); timeMs <= bEnd.getTime(); timeMs += stepMs) {
            const t = new Date(timeMs);
            const altAz = getAltAz(t, obs.lat, obs.lon, ra, dec);
            if (altAz.alt > 0) {
                points.push(altAz);
            }
        }
        const altAzEnd = getAltAz(bEnd, obs.lat, obs.lon, ra, dec);
        if (altAzEnd.alt > 0) {
            points.push(altAzEnd);
        }

        if (points.length === 0) return;

        function altAzToXY(alt, az) {
            const r = rMax * ((90 - alt) / 90);
            const angleRad = (az - 90) * Math.PI / 180;
            return {
                x: cx + r * Math.cos(angleRad),
                y: cy + r * Math.sin(angleRad)
            };
        }

        ctx.beginPath();
        const startPt = altAzToXY(points[0].alt, points[0].az);
        ctx.moveTo(startPt.x, startPt.y);

        for (let i = 1; i < points.length; i++) {
            const pt = altAzToXY(points[i].alt, points[i].az);
            ctx.lineTo(pt.x, pt.y);
        }

        ctx.strokeStyle = color;
        const isSel = (stickyHighlightedTarget === b.target_name);
        ctx.lineWidth = isSel ? 4.5 : 2.5;
        ctx.stroke();

        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(startPt.x, startPt.y, 2, 0, 2 * Math.PI);
        ctx.fill();

        const endPt = altAzToXY(points[points.length - 1].alt, points[points.length - 1].az);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(endPt.x, endPt.y, 4, 0, 2 * Math.PI);
        ctx.fill();

        ctx.fillStyle = isSel ? "#fff" : "#94a3b8";
        ctx.font = isSel ? "bold 10px Inter" : "9px Inter";
        ctx.textAlign = "left";
        ctx.fillText(b.target_name, endPt.x + 6, endPt.y);
    });
}

function toggleCollapse(btn) {
    const header = btn.parentElement;
    const card = header.parentElement;
    const body = card.querySelector(".card-body-collapse");
    if (body) {
        body.classList.toggle("collapsed");
        if (body.classList.contains("collapsed")) {
            btn.innerText = "+";
        } else {
            btn.innerText = "−";
        }
    }
}

function renderObservingLogTable(blocks) {
    const tbody = document.querySelector("#rt-log-table tbody");
    if (!tbody) return;

    const scheduledNames = blocks.map(b => b.target_name);
    const entries = [];

    // 1. Add all scheduled blocks (both science targets and standard stars)
    blocks.forEach(b => {
        const isStandard = (b.priority === 0.0);
        const target = isStandard ? null : targetPool.find(t => t.name === b.target_name);
        
        entries.push({
            isStandard: isStandard,
            target: target,
            name: b.target_name,
            startTime: b.start_time,
            endTime: b.end_time,
            duration: b.duration_minutes,
            airmassStart: b.airmass_start,
            airmassEnd: b.airmass_end,
            airmassMedian: b.airmass_median,
            comment: isStandard ? b.comment : (target ? target.comment : b.comment),
            status: isStandard ? "Scheduled" : (target ? getTargetStatus(target, lastScheduleResult) : "Scheduled"),
            sortTime: new Date(b.start_time).getTime()
        });
    });

    // 2. Add manually flagged targets that are not in blocks
    targetPool.forEach(t => {
        if (["Observed", "Failed", "Punted", "Skipped"].includes(t.status) && !scheduledNames.includes(t.name)) {
            const timeMs = t.manual_start_time ? new Date(t.manual_start_time).getTime() : Infinity;
            entries.push({
                isStandard: false,
                target: t,
                name: t.name,
                startTime: t.manual_start_time || null,
                endTime: null,
                duration: t.manual_duration || 0,
                airmassStart: null,
                airmassEnd: null,
                airmassMedian: null,
                comment: t.comment || "",
                status: t.status,
                sortTime: timeMs
            });
        }
    });

    // Sort chronologically by sortTime
    entries.sort((a, b) => a.sortTime - b.sortTime);

    if (entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="color: var(--text-muted); padding: 15px;">No log entries.</td></tr>`;
        return;
    }

    tbody.innerHTML = entries.map(entry => {
        let indicatorColor = "#94a3b8"; // Default Grey
        if (entry.status === "Observed") indicatorColor = "#10b981"; // Green
        else if (entry.status === "Scheduled") indicatorColor = "#f59e0b"; // Yellow
        else if (entry.status === "Failed" || entry.status === "Punted" || entry.status === "Skipped") indicatorColor = "#ef4444"; // Red
        else if (entry.status === "Unobservable") indicatorColor = "#000000"; // Black

        const statusDot = `<span class="status-indicator-circle" style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: ${indicatorColor}; vertical-align: middle;"></span>`;

        if (entry.isStandard) {
            const startVal = formatTimeForTimezone(entry.startTime, 'UTC');
            const endVal = formatTimeForTimezone(entry.endTime, 'UTC');
            return `
                <tr>
                    <td style="text-align: center;">${statusDot}</td>
                    <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-muted);">${startVal} - ${endVal}</td>
                    <td><strong>${entry.name}</strong></td>
                    <td style="text-align: center; color: var(--text-muted);">${entry.duration}</td>
                    <td style="text-align: center; color: var(--text-muted);">${entry.airmassStart.toFixed(2)} - ${entry.airmassEnd.toFixed(2)}</td>
                    <td style="text-align: center; font-weight: 600; color: var(--text-muted);">${entry.airmassMedian.toFixed(2)}</td>
                    <td style="color: var(--text-muted); font-style: italic;">${entry.comment}</td>
                </tr>
            `;
        } else {
            const t = entry.target;
            const startVal = entry.startTime ? formatTimeForTimezone(entry.startTime, 'UTC') : '';
            const endVal = entry.endTime ? formatTimeForTimezone(entry.endTime, 'UTC') : '';
            
            const isPinned = t.manual_start_time !== null && t.manual_start_time !== undefined && t.manual_start_time !== "";

            const timeHtml = `
                <div style="display: flex; align-items: center; gap: 4px;" onclick="event.stopPropagation();">
                    ${isPinned ? `<span style="color: #f59e0b; font-size: 0.8rem; cursor: pointer;" title="Unpin start time" onclick="updateTargetManualStart('${t.name}', '')">🔒</span>` : ''}
                    <input type="text" value="${startVal}"
                           placeholder="HH:MM"
                           onchange="updateTargetFieldByIndex(${t.inputIndex}, 'manual_start_time', this.value)"
                           style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid ${isPinned ? '#f59e0b' : 'var(--border-color)'}; background: ${isPinned ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255, 255, 255, 0.05)'}; color: #fff;">
                    <span>- </span>
                    <input type="text" value="${endVal}"
                           placeholder="HH:MM"
                           onchange="updateTargetManualEndByIndex(${t.inputIndex}, this.value)"
                           style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: #fff;">
                </div>
            `;

            const nameHtml = `
                <input type="text" value="${t.name}"
                       onchange="updateTargetFieldByIndex(${t.inputIndex}, 'name', this.value)"
                       onclick="event.stopPropagation();"
                       style="width: 100%; font-weight: bold; background: transparent; border: none; color: #fff; padding: 2px;">
            `;

            const durationHtml = `
                <input type="number" min="1" step="1" value="${entry.duration || ''}"
                       onchange="updateTargetFieldByIndex(${t.inputIndex}, 'manual_duration', this.value)"
                       onclick="event.stopPropagation();"
                       style="width: 55px; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: #fff;">
            `;

            const commentHtml = `
                <input type="text" value="${t.comment || ''}"
                       onchange="updateTargetFieldByIndex(${t.inputIndex}, 'comment', this.value)"
                       onclick="event.stopPropagation();"
                       style="width: 100%; background: transparent; border: none; color: #fff; padding: 2px;">
            `;

            const airmassRangeStr = (entry.airmassStart !== null && entry.airmassEnd !== null) ? `${entry.airmassStart.toFixed(2)} - ${entry.airmassEnd.toFixed(2)}` : '--';
            const airmassMedianStr = entry.airmassMedian !== null ? entry.airmassMedian.toFixed(2) : '--';

            return `
                <tr id="rt-log-row-${t.name}" onmouseenter="highlightTarget('${t.name}')" onmouseleave="unhighlightTarget('${t.name}')" onclick="stickyHighlightTarget('${t.name}')" style="cursor: pointer;">
                    <td style="text-align: center;">${statusDot}</td>
                    <td>${timeHtml}</td>
                    <td>${nameHtml}</td>
                    <td style="text-align: center;">${durationHtml}</td>
                    <td style="text-align: center; color: var(--text-secondary);">${airmassRangeStr}</td>
                    <td style="text-align: center; font-weight: 600; color: var(--accent-cyan);">${airmassMedianStr}</td>
                    <td>${commentHtml}</td>
                </tr>
            `;
        }
    }).join('');
}

function updateTargetFieldByIndex(index, field, val) {
    const target = targetPool.find(t => t.inputIndex === index);
    if (!target) return;

    if (field === 'manual_start_time') {
        if (!val.trim()) {
            target.manual_start_time = null;
            if (target.status === "Observed") {
                target.status = "";
            }
        } else {
            const dateStr = document.getElementById("obs-date").value;
            const iso = parseTimeInputToISO(val, dateStr, currentTimezone);
            if (iso) {
                target.manual_start_time = iso;
            } else {
                target.manual_start_time = val.trim();
            }
        }
    } else if (field === 'manual_duration') {
        target.manual_duration = val.trim() ? parseFloat(val) : null;
    } else if (field === 'name') {
        target.name = val.trim();
    } else if (field === 'comment') {
        target.comment = val;
    }

    if (field === 'name') {
        saveAndRefresh(true);
    } else {
        saveAndRefresh(false);
    }
}

function updateTargetManualEndByIndex(index, val) {
    const target = targetPool.find(t => t.inputIndex === index);
    if (!target) return;

    if (!val.trim()) {
        target.manual_duration = null;
        saveAndRefresh(false);
        return;
    }

    const dateStr = document.getElementById("obs-date").value;
    const endIso = parseTimeInputToISO(val, dateStr, currentTimezone);
    if (!endIso) return;

    let startIso = target.manual_start_time;
    if (!startIso && lastScheduleResult) {
        const block = lastScheduleResult.blocks.find(b => b.target_name === target.name);
        if (block) {
            startIso = block.start_time;
        }
    }

    if (!startIso) return;

    const durationMin = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / (60 * 1000));
    if (durationMin <= 0) return;

    const isPinned = target.manual_start_time !== null && target.manual_start_time !== undefined && target.manual_start_time !== "";
    if (isPinned) {
        const backupPool = JSON.parse(JSON.stringify(targetPool));
        const tempTarget = backupPool.find(t => t.inputIndex === index);
        tempTarget.manual_duration = durationMin;
        
        const requestPayload = getSchedulingPayloadWithTargets(backupPool);
        const result = runLocalJSSolver(requestPayload);
        
        const block = result.blocks.find(b => b.target_name === target.name);
        const isScheduledCorrectly = block && isTimesClose(block.start_time, target.manual_start_time);
        
        if (result.conflicts.includes(target.name) || !isScheduledCorrectly) {
            alert(`Cannot update end time: Changing end time of locked target "${target.name}" introduces a scheduling conflict.`);
            if (lastScheduleResult) {
                updateScheduleUI(lastScheduleResult);
            }
            return;
        }
    }

    target.manual_start_time = startIso;
    target.manual_duration = durationMin;
    saveAndRefresh(false);
}

function resetCustomConstraints() {
    targetPool.forEach(t => {
        t.schedule_before = [];
    });
    saveAndRefresh();
}
