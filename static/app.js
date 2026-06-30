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
// Stars auto-disabled after scheduling because they were not picked by the scheduler
let autoDisabledStandards = new Set();

// Issue #16: Manual standard star selection mode tracking
let autoStandardsMode = true;
let selectedStandards = new Set();

// Target list sort state
let targetSortField = 'none';
let targetSortAsc = true;
let targetDisplayOrder = [];
let alertsDismissed = false;
let lastObsDate = null;

// Issue #32: Lock mechanism — tracks which targets have a locked start time
// Value is 'start' when locked, absent when unlocked
let lockedTargets = new Map();

function syncLockedTargets() {
    lockedTargets.clear();
    targetPool.forEach(t => {
        if (t.manual_start_time && !t.lock_type) {
            t.lock_type = 'start';
        }
        if (t.lock_type) {
            lockedTargets.set(t.name, t.lock_type);
        }
    });
    standardStars.forEach(s => {
        if (s.manual_start_time && !s.lock_type) {
            s.lock_type = 'start';
        }
        if (s.lock_type) {
            lockedTargets.set(s.name, s.lock_type);
        }
    });
}

// Initial Setup on Page Load
document.addEventListener("DOMContentLoaded", async () => {
    // Restore date from localStorage if present
    const storedDate = localStorage.getItem("obsDate");
    if (storedDate) {
        document.getElementById("obs-date").value = storedDate;
    } else {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        document.getElementById("obs-date").value = `${yyyy}-${mm}-${dd}`;
    }
    
    // Restore timezone from localStorage if present
    const storedTZ = localStorage.getItem("currentTimezone");
    if (storedTZ) {
        currentTimezone = storedTZ;
        const tzSelect = document.getElementById("tz-select");
        if (tzSelect) tzSelect.value = storedTZ;
    }
    lastObsDate = document.getElementById("obs-date").value;

    // Issue #28: Trigger reschedule when date changes, and adjust locked times to match the new night
    document.getElementById("obs-date").addEventListener("change", () => {
        const newDateStr = document.getElementById("obs-date").value;
        if (lastObsDate && lastObsDate !== newDateStr) {
            const dOld = new Date(lastObsDate);
            const dNew = new Date(newDateStr);
            const diffTime = dNew.getTime() - dOld.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays !== 0) {
                const shiftTime = (timeStr) => {
                    if (!timeStr) return null;
                    const d = new Date(timeStr);
                    if (isNaN(d.getTime())) return timeStr;
                    d.setDate(d.getDate() + diffDays);
                    return d.toISOString();
                };
                
                targetPool.forEach(t => {
                    if (t.manual_start_time) t.manual_start_time = shiftTime(t.manual_start_time);
                    if (t.manual_end_time) t.manual_end_time = shiftTime(t.manual_end_time);
                });
                standardStars.forEach(s => {
                    if (s.manual_start_time) s.manual_start_time = shiftTime(s.manual_start_time);
                    if (s.manual_end_time) s.manual_end_time = shiftTime(s.manual_end_time);
                });
                
                localStorage.setItem("targetPool", JSON.stringify(targetPool));
                
                const overrides = {};
                standardStars.forEach(s => {
                    if (s.manual_start_time || s.manual_duration !== null || s.lock_type || (s.schedule_before && s.schedule_before.length > 0)) {
                        overrides[s.name] = {
                            manual_start_time: s.manual_start_time || null,
                            manual_end_time: s.manual_end_time || null,
                            manual_duration: s.manual_duration !== undefined ? s.manual_duration : null,
                            lock_type: s.lock_type || null,
                            schedule_before: s.schedule_before || []
                        };
                    }
                });
                localStorage.setItem("standardsOverrides", JSON.stringify(overrides));
            }
        }
        lastObsDate = newDateStr;
        localStorage.setItem("obsDate", newDateStr);
        triggerScheduling();
    });
    
    // Add Event Listeners
    document.getElementById("target-form").addEventListener("submit", handleAddTarget);
    document.getElementById("run-schedule-btn").addEventListener("click", triggerScheduling);
    document.getElementById("load-sample-btn").addEventListener("click", loadSampleTargets);
    document.getElementById("clear-targets-btn").addEventListener("click", clearAllTargets);
    
    // Issue #16: Load manual standards mode state
    const storedAuto = localStorage.getItem("autoStandardsMode");
    if (storedAuto !== null) {
        autoStandardsMode = storedAuto === "true";
    }
    const storedSelected = localStorage.getItem("selectedStandards");
    if (storedSelected) {
        try {
            const parsed = JSON.parse(storedSelected);
            if (Array.isArray(parsed)) {
                selectedStandards = new Set(parsed);
            }
        } catch(e) {}
    }
    const resetBtn = document.getElementById("reset-auto-standards-btn");
    if (resetBtn) {
        resetBtn.style.display = autoStandardsMode ? "none" : "inline-block";
    }

    // Load local storage if available, otherwise load samples
    const stored = localStorage.getItem("targetPool");
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                targetPool = parsed.map(t => {
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
                        manual_end_time: t.manual_end_time || null,
                        lock_type: t.lock_type || null,
                        manual_duration: null,
                        schedule_before: Array.isArray(t.schedule_before) ? t.schedule_before : []
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
                
                // Sync lockedTargets map
                syncLockedTargets();
                
                renderTargetsTable();
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
    await loadStandardStars();
    initAirmassChartDragZoom();
    triggerScheduling();
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
        schedule_before: existing ? existing.schedule_before : []
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
    saveState();
    renderTargetsTable();
    triggerScheduling();
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
    ];
    saveAndRefresh();
}

function saveAndRefresh() {
    localStorage.setItem("targetPool", JSON.stringify(targetPool));
    localStorage.setItem("autoStandardsMode", autoStandardsMode);
    localStorage.setItem("selectedStandards", JSON.stringify(Array.from(selectedStandards)));
    localStorage.setItem("currentTimezone", currentTimezone);
    
    const standards_overrides = {};
    standardStars.forEach(s => {
        if (s.manual_start_time || s.manual_duration !== null || s.lock_type || (s.schedule_before && s.schedule_before.length > 0)) {
            standards_overrides[s.name] = {
                manual_start_time: s.manual_start_time || null,
                manual_end_time: s.manual_end_time || null,
                manual_duration: s.manual_duration !== undefined ? s.manual_duration : null,
                lock_type: s.lock_type || null,
                schedule_before: s.schedule_before || []
            };
        }
    });
    localStorage.setItem("standardsOverrides", JSON.stringify(standards_overrides));
    
    syncLockedTargets();
    renderTargetsTable();
    triggerScheduling();
};


// ==============================================================================
// UI RENDERING HELPERS
// ==============================================================================

// Issue #19: Collapsible card sections
function toggleCollapse(btn) {
    const body = btn.closest('.card-header-toggle').nextElementSibling;
    if (!body || !body.classList.contains('card-body-collapse')) return;
    const collapsed = body.classList.toggle('collapsed');
    btn.textContent = collapsed ? '+' : '−';
}

// Issue #11: Target list column sorting
// Issue #11: Target list column sorting
function sortDisplayOrder() {
    if (!targetSortField || targetSortField === 'none' || targetSortField === 'input') {
        targetDisplayOrder = targetPool.map(t => t.name);
        return;
    }
    
    if (targetSortField === 'schedule') {
        const scheduledOrder = {};
        currentBlocksList.forEach((b, i) => {
            scheduledOrder[b.target_name] = i;
        });
        targetDisplayOrder.sort((a, b) => {
            const idxA = scheduledOrder[a] !== undefined ? scheduledOrder[a] : Infinity;
            const idxB = scheduledOrder[b] !== undefined ? scheduledOrder[b] : Infinity;
            return idxA - idxB;
        });
        return;
    }
    
    targetDisplayOrder.sort((nameA, nameB) => {
        const a = targetPool.find(t => t.name === nameA);
        const b = targetPool.find(t => t.name === nameB);
        if (!a || !b) return 0;
        
        let va = a[targetSortField];
        let vb = b[targetSortField];
        if (targetSortField === 'magnitude') {
            va = a.magnitude;
            vb = b.magnitude;
        } else if (targetSortField === 'priority') {
            va = a.priority;
            vb = b.priority;
        }
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return targetSortAsc ? -1 : 1;
        if (va > vb) return targetSortAsc ? 1 : -1;
        return 0;
    });
}

function changeTargetSorting(val) {
    if (val === 'input') {
        targetSortField = 'none';
    } else if (val === 'name') {
        targetSortField = 'name';
        targetSortAsc = true;
    } else if (val === 'ra') {
        targetSortField = 'ra';
        targetSortAsc = true;
    } else if (val === 'mag') {
        targetSortField = 'magnitude';
        targetSortAsc = true;
    } else if (val === 'prio') {
        targetSortField = 'priority';
        targetSortAsc = true;
    } else if (val === 'schedule') {
        targetSortField = 'schedule';
        targetSortAsc = true;
    }
    
    ['name', 'ra', 'dec', 'magnitude', 'priority'].forEach(f => {
        const el = document.getElementById('sort-icon-' + f);
        if (el) el.textContent = '';
    });
    
    sortDisplayOrder();
    renderTargetsTable();
}

function setTargetSort(field) {
    if (targetSortField === field) {
        targetSortAsc = !targetSortAsc;
    } else {
        targetSortField = field;
        targetSortAsc = true;
    }
    // Update sort icons
    ['name', 'ra', 'dec', 'magnitude', 'priority', 'sn_mode'].forEach(f => {
        const el = document.getElementById('sort-icon-' + f);
        if (el) el.textContent = '';
    });
    const activeIcon = document.getElementById('sort-icon-' + field);
    if (activeIcon) activeIcon.textContent = targetSortAsc ? ' ▲' : ' ▼';
    
    sortDisplayOrder();
    renderTargetsTable();
}

function renderTargetsTable() {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const tbody = document.querySelector("#targets-table tbody");
    if (targetPool.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" class="text-center">No targets in pool</td></tr>`;
        window.scrollTo(scrollX, scrollY);
        return;
    }

    // Sync targetDisplayOrder with targetPool (keep existing, remove deleted, append new)
    const poolNames = new Set(targetPool.map(t => t.name));
    targetDisplayOrder = targetDisplayOrder.filter(name => poolNames.has(name));
    const displaySet = new Set(targetDisplayOrder);
    targetPool.forEach(t => {
        if (!displaySet.has(t.name)) {
            targetDisplayOrder.push(t.name);
        }
    });

    // Determine which targets are currently scheduled
    const scheduledNames = new Set(currentBlocksList.map(b => b.target_name));

    const sorted = targetDisplayOrder.map(name => targetPool.find(t => t.name === name)).filter(Boolean);

    const conflicts = lastScheduleResult?.conflicts || [];
    const unobservable = lastScheduleResult?.unobservable || [];

    tbody.innerHTML = sorted.map(t => {
        const isScheduled = scheduledNames.has(t.name);
        const scheduledBlock = currentBlocksList.find(b => b.target_name === t.name);

        let statusClass = "status-not-scheduled";
        let statusDotColor = "#f97316";
        let statusText = "Not Scheduled";
        
        if (t.status === "Observed") {
            statusClass = "status-observed";
            statusDotColor = "#10b981";
            statusText = "Observed";
        } else if (t.status === "Skipped") {
            statusClass = "status-skipped";
            statusDotColor = "#6b7280";
            statusText = "Skipped";
        } else if (t.status === "Failed") {
            statusClass = "status-failed";
            statusDotColor = "#ef4444";
            statusText = "Failed";
        } else if (t.status === "Punted") {
            statusClass = "status-punted";
            statusDotColor = "#3b82f6";
            statusText = "Punted";
        } else if (unobservable.includes(t.name)) {
            statusClass = "status-unobservable";
            statusDotColor = "#ef4444";
            statusText = "Unobservable";
        } else if (isScheduled) {
            statusClass = "status-scheduled";
            statusDotColor = "#eab308";
            statusText = "Scheduled";
        }

        const circleColor = isScheduled ? '#eab308' : (unobservable.includes(t.name) ? '#ef4444' : '#f97316');
        const circleTitle = isScheduled ? 'Scheduled' : (unobservable.includes(t.name) ? 'Unobservable' : 'Not Scheduled');
        const statusCircle = `<span title="${circleTitle}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${circleColor};"></span>`;

        const scheduledStartStr = scheduledBlock 
            ? formatTimeForTimezone(scheduledBlock.start_time, currentTimezone) 
            : (t.manual_start_time ? formatTimeForTimezone(t.manual_start_time, currentTimezone) : '');
        const scheduledDuration = scheduledBlock ? scheduledBlock.duration_minutes : (t.manual_duration !== null && t.manual_duration !== undefined ? t.manual_duration : '');

        const rowClass = unobservable.includes(t.name) ? "status-row-unobservable" : "";

        return `
            <tr id="target-row-${t.name}" data-target="${t.name}" class="${rowClass}"
                onmouseenter="highlightTarget('${t.name}')" 
                onmouseleave="unhighlightTarget('${t.name}')" 
                onclick="stickyHighlightTarget('${t.name}')"
                style="cursor: pointer;">
                <td style="text-align:center;">${statusCircle}</td>
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
                    <input type="text" placeholder="HH:MM" value="${scheduledStartStr}" 
                           onchange="updateTargetField('${t.name}', 'manual_start_time', this.value)" 
                           onclick="event.stopPropagation();" style="width: 75px; font-family: monospace; text-align: center;">
                </td>
                <td>
                    <input type="number" placeholder="min" min="0" value="${scheduledDuration}" 
                           onchange="updateTargetField('${t.name}', 'manual_duration', this.value)" 
                           onclick="event.stopPropagation();" style="width: 65px; text-align: center;">
                </td>
                <td><span class="status-pill ${statusClass}" id="status-${t.name}"><span class="target-status-dot" style="background:${statusDotColor};"></span>${statusText}</span></td>
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

    window.scrollTo(scrollX, scrollY);
}

function updateTargetField(name, field, val) {
    const target = targetPool.find(t => t.name === name) || standardStars.find(s => s.name === name);
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
        updateTargetManualStart(name, val);
        return;
    } else if (field === 'manual_duration') {
        updateTargetManualDuration(name, val);
        return;
    } else if (field === 'manual_end_time') {
        updateTargetManualEnd(name, val);
        return;
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
    saveAndRefresh();
}

function updateTargetManualStart(name, val) {
    const target = targetPool.find(t => t.name === name) || standardStars.find(s => s.name === name);
    if (!target) return;
    
    if (!val.trim()) {
        target.manual_start_time = null;
        target.manual_end_time = null;
        target.lock_type = null;
        lockedTargets.delete(name);
    } else {
        const dateStr = document.getElementById("obs-date").value;
        const iso = parseTimeInputToISO(val, dateStr, currentTimezone);
        if (iso) {
            target.manual_start_time = iso;
        } else {
            target.manual_start_time = val.trim();
        }
        target.lock_type = 'start';
        lockedTargets.set(name, 'start');
        
        // Calculate new manual end time based on start time and duration
        const duration = target.manual_duration !== null && target.manual_duration !== undefined ? target.manual_duration : 30;
        const startDate = new Date(target.manual_start_time);
        if (!isNaN(startDate.getTime())) {
            const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
            target.manual_end_time = endDate.toISOString();
        }
    }
    saveAndRefresh();
}

function updateTargetManualEnd(name, val) {
    const target = targetPool.find(t => t.name === name) || standardStars.find(s => s.name === name);
    if (!target) return;
    
    if (!val.trim()) {
        target.manual_start_time = null;
        target.manual_end_time = null;
        target.lock_type = null;
        lockedTargets.delete(name);
    } else {
        const dateStr = document.getElementById("obs-date").value;
        const iso = parseTimeInputToISO(val, dateStr, currentTimezone);
        if (iso) {
            target.manual_end_time = iso;
        } else {
            target.manual_end_time = val.trim();
        }
        target.lock_type = 'end';
        lockedTargets.set(name, 'end');
        
        // Calculate new manual start time based on end time and duration
        const duration = target.manual_duration !== null && target.manual_duration !== undefined ? target.manual_duration : 30;
        const endDate = new Date(target.manual_end_time);
        if (!isNaN(endDate.getTime())) {
            const startDate = new Date(endDate.getTime() - duration * 60 * 1000);
            target.manual_start_time = startDate.toISOString();
        }
    }
    saveAndRefresh();
}

function updateTargetManualDuration(name, val) {
    const target = targetPool.find(t => t.name === name) || standardStars.find(s => s.name === name);
    if (!target) return;
    
    const duration = val.trim() ? parseFloat(val) : null;
    target.manual_duration = duration;
    
    if (duration !== null) {
        if (target.lock_type === 'end' && target.manual_end_time) {
            const endDate = new Date(target.manual_end_time);
            if (!isNaN(endDate.getTime())) {
                const startDate = new Date(endDate.getTime() - duration * 60 * 1000);
                target.manual_start_time = startDate.toISOString();
            }
        } else if (target.manual_start_time) {
            const startDate = new Date(target.manual_start_time);
            if (!isNaN(startDate.getTime())) {
                const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
                target.manual_end_time = endDate.toISOString();
            }
        }
    }
    saveAndRefresh();
}

function toggleTargetLock(name) {
    const target = targetPool.find(t => t.name === name) || standardStars.find(s => s.name === name);
    if (!target) return;
    if (lockedTargets.has(name)) {
        lockedTargets.delete(name);
        target.manual_start_time = null;
        target.manual_end_time = null;
        target.lock_type = null;
    } else {
        const block = currentBlocksList.find(b => b.target_name === name);
        if (block) {
            lockedTargets.set(name, 'start');
            target.manual_start_time = block.start_time;
            target.manual_end_time = block.end_time;
            target.lock_type = 'start';
        }
    }
    saveAndRefresh();
}

function updateTargetCheckbox(name, field, checked) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    
    target[field] = !!checked;
    saveAndRefresh();
}

function clearAllOverrides() {
    targetPool.forEach(t => {
        t.manual_start_time = null;
        t.manual_end_time = null;
        t.manual_duration = null;
        t.lock_type = null;
        t.schedule_before = [];
    });
    standardStars.forEach(s => {
        s.manual_start_time = null;
        s.manual_end_time = null;
        s.manual_duration = null;
        s.lock_type = null;
        s.schedule_before = [];
    });
    lockedTargets.clear();
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

function parseHourMinute(timeStr, isStart = false) {
    if (!timeStr) return null;
    const clean = timeStr.trim().toLowerCase();
    
    let isPm = false;
    let isAm = false;
    if (clean.includes("pm")) {
        isPm = true;
    } else if (clean.includes("am")) {
        isAm = true;
    }
    
    const numericStr = clean.replace(/[a-z]/g, '').trim();
    if (!numericStr) return null;
    
    let hh = 0;
    let mm = 0;
    
    if (numericStr.includes(":")) {
        const parts = numericStr.split(":");
        hh = parseInt(parts[0], 10);
        mm = parseInt(parts[1], 10);
    } else {
        hh = parseInt(numericStr, 10);
        mm = 0;
    }
    
    if (isNaN(hh) || isNaN(mm)) return null;
    
    if (isPm) {
        if (hh < 12) hh += 12;
    } else if (isAm) {
        if (hh === 12) hh = 0;
    } else {
        if (isStart && hh > 0 && hh < 12) {
            hh += 12;
        }
    }
    
    return { hh, mm };
}

function parseTimeInputToISO(timeStr, dateStr, tz) {
    if (!timeStr) return null;
    const parsed = parseHourMinute(timeStr, false);
    if (!parsed) return null;
    const { hh, mm } = parsed;
    
    const observatory = { lat: 37.3414, lon: -121.6429, elevation: 1283 };
    const dateParts = dateStr.split('-');
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);
    const localNoon = new Date(year, month, day, 12, 0, 0);
    const offsetHours = -observatory.lon / 15.0;
    const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
    
    const st = (lastScheduleResult && lastScheduleResult.solar_times) ? {
        sunset: new Date(lastScheduleResult.solar_times.sunset),
        sunrise: new Date(lastScheduleResult.solar_times.sunrise)
    } : getSolarTimesFallback(utcNoon, observatory.lat, observatory.lon, observatory.elevation);
    
    const midpoint = new Date((st.sunset.getTime() + st.sunrise.getTime()) / 2);
    
    const refDate = st.sunset;
    const refYear = refDate.getUTCFullYear();
    const refMonth = refDate.getUTCMonth();
    const refDay = refDate.getUTCDate();
    
    let bestDate = null;
    let minDiff = Infinity;
    
    for (let dOffset = -2; dOffset <= 2; dOffset++) {
        let date;
        const candidateDay = refDay + dOffset;
        if (tz === 'UTC') {
            date = new Date(Date.UTC(refYear, refMonth, candidateDay, hh, mm));
        } else if (tz === 'browser') {
            date = new Date(refYear, refMonth, candidateDay, hh, mm);
        } else if (tz === 'obs') {
            const temp = new Date(Date.UTC(refYear, refMonth, candidateDay, hh, mm));
            let offset = -7;
            try {
                const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
                const formatted = formatter.format(temp);
                const match = formatted.match(/GMT([-+]\d+)/);
                offset = match ? parseInt(match[1], 10) : -7;
            } catch (e) {}
            date = new Date(Date.UTC(refYear, refMonth, candidateDay, hh - offset, mm));
        } else if (tz && tz.startsWith('UTC')) {
            const offsetStr = tz.replace('UTC', '');
            const offset = parseFloat(offsetStr) || 0;
            date = new Date(Date.UTC(refYear, refMonth, candidateDay, hh - offset, mm));
        } else {
            date = new Date(Date.UTC(refYear, refMonth, candidateDay, hh, mm));
        }
        
        const diff = Math.abs(date.getTime() - midpoint.getTime());
        if (diff < minDiff) {
            minDiff = diff;
            bestDate = date;
        }
    }
    
    return bestDate ? bestDate.toISOString() : null;
}

function formatLST(lstVal) {
    if (isNaN(lstVal)) return "";
    const hours = Math.floor(lstVal);
    const mins = Math.floor((lstVal - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} LST`;
}

function changeTimezone(val) {
    currentTimezone = val;
    localStorage.setItem("currentTimezone", currentTimezone);
    renderTargetsTable();
    if (lastScheduleResult) {
        updateScheduleUI(lastScheduleResult);
    }
}

function updateNightOverridePlaceholders() {
    if (!lastScheduleResult || !lastScheduleResult.solar_times) return;
    
    const tzOverride = document.getElementById("manual-night-tz")?.value || "UTC";
    const sunsetISO = lastScheduleResult.solar_times.sunset;
    const sunriseISO = lastScheduleResult.solar_times.sunrise;
    
    const sunsetFormatted = formatTimeForTimezone(sunsetISO, tzOverride);
    const sunriseFormatted = formatTimeForTimezone(sunriseISO, tzOverride);
    
    const startInput = document.getElementById("manual-night-start");
    const endInput = document.getElementById("manual-night-end");
    
    if (startInput) startInput.placeholder = sunsetFormatted;
    if (endInput) endInput.placeholder = sunriseFormatted;
}

// Drag & Drop and Standard Stars
async function loadStandardStars() {
    const storedOverrides = localStorage.getItem("standardsOverrides");
    let overrides = {};
    if (storedOverrides) {
        try {
            overrides = JSON.parse(storedOverrides);
        } catch (e) {}
    }

    try {
        const res = await fetch("/static/standards.json");
        if (res.ok) {
            const raw = await res.json();
            standardStars = raw.map(s => {
                const ovr = overrides[s.name] || {};
                return {
                    ...s,
                    manual_start_time: ovr.manual_start_time || null,
                    manual_end_time: ovr.manual_end_time || null,
                    manual_duration: ovr.manual_duration !== undefined ? ovr.manual_duration : null,
                    lock_type: ovr.lock_type || null,
                    schedule_before: ovr.schedule_before || [],
                    allow_twilight: true
                };
            });
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
        ].map(s => {
            const ovr = overrides[s.name] || {};
            return {
                ...s,
                manual_start_time: ovr.manual_start_time || null,
                manual_end_time: ovr.manual_end_time || null,
                manual_duration: ovr.manual_duration !== undefined ? ovr.manual_duration : null,
                lock_type: ovr.lock_type || null,
                schedule_before: ovr.schedule_before || [],
                allow_twilight: true
            };
        });
    }
    syncLockedTargets();
    renderStandardsTable();
}

function renderStandardsTable() {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const tbody = document.querySelector("#standards-table tbody");
    if (!tbody) return;
    
    if (standardStars.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center">No standard stars loaded</td></tr>`;
        window.scrollTo(scrollX, scrollY);
        return;
    }
    
    const obs = { lat: 37.3414, lon: -121.6429, elevation: 1283 };
    // Issue #13: Only check stars that are actually scheduled in the current plan
    const scheduledNames = new Set(currentBlocksList.map(b => b.target_name));

    // Issue #15: Sort standard stars by RA before rendering
    const sortedStars = [...standardStars].sort((a, b) => {
        const raA = parseCoordinate(a.ra, true);
        const raB = parseCoordinate(b.ra, true);
        return raA - raB;
    });

    tbody.innerHTML = sortedStars.map(s => {
        const isScheduled = scheduledNames.has(s.name);
        const isDisabled = disabledStandards.has(s.name);
        const raDecParsed = {
            ra: parseCoordinate(s.ra, true),
            dec: parseCoordinate(s.dec, false)
        };
        const isObs = isStandardStarObservable(raDecParsed, null, obs);
        
        let rowClass = "";
        let statusText = "Not Scheduled";
        let statusClass = "status-unobservable";
        let checkDisabledAttr = "";
        
        if (!isObs) {
            rowClass = "status-row-unobservable";
            statusText = "Unobservable";
            statusClass = "status-unobservable";
            checkDisabledAttr = "disabled";
        } else if (isDisabled) {
            rowClass = "status-row-disabled";
            statusText = "Disabled";
            statusClass = "status-unobservable";
        } else if (isScheduled) {
            rowClass = "status-row-scheduled";
            statusText = "Scheduled";
            statusClass = "status-scheduled";
        }
        
        const badgeColor = s.color === "blue" ? "badge-color-blue" : "badge-color-red";
        // Issue #13: checked = observable, not user-disabled, and not auto-disabled (meaning it was scheduled)
        const isAutoDisabled = autoDisabledStandards.has(s.name);
        const isChecked = autoStandardsMode ? (isObs && !isDisabled && !isAutoDisabled) : selectedStandards.has(s.name);
        
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
    window.scrollTo(scrollX, scrollY);
}

function toggleStandardUse(name, enabled) {
    if (autoStandardsMode) {
        // Transition from auto to manual selection mode
        autoStandardsMode = false;
        selectedStandards.clear();
        
        // Get the standard stars that are currently scheduled in the UI
        const scheduledNames = new Set(currentBlocksList.map(b => b.target_name));
        standardStars.forEach(s => {
            if (scheduledNames.has(s.name)) {
                selectedStandards.add(s.name);
            }
        });
    }
    
    if (enabled) {
        selectedStandards.add(name);
    } else {
        selectedStandards.delete(name);
    }
    
    // Update the visibility of the reset button
    const resetBtn = document.getElementById("reset-auto-standards-btn");
    if (resetBtn) resetBtn.style.display = "inline-block";
    
    saveAndRefresh();
}

function resetToAutoStandards() {
    autoStandardsMode = true;
    selectedStandards.clear();
    
    const resetBtn = document.getElementById("reset-auto-standards-btn");
    if (resetBtn) resetBtn.style.display = "none";
    
    saveAndRefresh();
}

function isStandardStarObservable(s, solar_times, observatory) {
    const dec = typeof s.dec === 'number' ? s.dec : parseCoordinate(s.dec, false);
    if (dec < -35.0 || dec > 72.0) return false;
    
    const dateInput = document.getElementById("obs-date").value;
    const dateParts = dateInput.split('-');
    const localNoon = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0);
    const offsetHours = -observatory.lon / 15.0;
    const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
    const st = solar_times || getSolarTimesFallback(utcNoon, observatory.lat, observatory.lon, observatory.elevation);
    
    // Checked standard stars can only be scheduled from sunset + 30m to sunrise - 30m
    const limitStart = st.sunset.getTime() + 30 * 60 * 1000;
    const limitEnd = st.sunrise.getTime() - 30 * 60 * 1000;
    
    // Standard star duration is typically 5 minutes (300 seconds)
    const durMs = 5 * 60 * 1000;
    
    // Check every 10 minutes from limitStart to limitEnd - durMs
    let t = limitStart;
    const tEnd = limitEnd - durMs;
    
    while (t <= tEnd) {
        let blockValid = true;
        // Check if visible for the entire 5 minutes starting at t
        for (let offsetMs = 0; offsetMs <= durMs; offsetMs += 60 * 1000) {
            const dt = new Date(t + offsetMs);
            if (!isShaneVisible(s, dt, observatory)) {
                blockValid = false;
                break;
            }
            const altAz = getAltAz(dt, observatory.lat, observatory.lon, s.ra, s.dec);
            const airmass = getAirmass(altAz.alt);
            if (airmass <= 0 || airmass > 2.5) {
                blockValid = false;
                break;
            }
        }
        if (blockValid) {
            return true;
        }
        t += 10 * 60 * 1000;
    }
    
    return false;
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
        if (!line || line.startsWith("#") || line.startsWith("!")) continue;
        
        let magnitude = NaN;
        let comment = "";
        let priority = 3.0; // default priority is 3.0
        let allow_twilight = false;
        let high_airmass = false;
        let sn_mode = "normal";
        
        let cleanLine = line;
        
        // Extract comment = ...
        const commentMatch = cleanLine.match(/comment\s*=\s*(.+)$/i);
        if (commentMatch) {
            comment = commentMatch[1].trim();
            cleanLine = cleanLine.replace(commentMatch[0], "");
        }
        
        // Extract mag/magnitude = ...
        const magMatch = cleanLine.match(/(?:mag|magnitude)\s*=\s*([0-9.-]+)/i);
        if (magMatch) {
            magnitude = parseFloat(magMatch[1]);
            cleanLine = cleanLine.replace(magMatch[0], "");
        }
        
        // Extract priority = ...
        const prioMatch = cleanLine.match(/priority\s*=\s*([0-9.-]+)/i);
        let priorityParsed = false;
        if (prioMatch) {
            priority = parseFloat(prioMatch[1]);
            priorityParsed = true;
            cleanLine = cleanLine.replace(prioMatch[0], "");
        }
        
        const parts = cleanLine.split(/[,\s]+/).map(p => p.trim()).filter(Boolean);
        if (parts.length < 3) continue;
        
        const name = parts[0];
        let raStr = "";
        let decStr = "";
        let nextIdx = 3;
        
        const isNum = (s) => !isNaN(parseFloat(s));
        
        if (parts.length >= 7 && isNum(parts[1]) && isNum(parts[2]) && isNum(parts[3]) && isNum(parts[4]) && isNum(parts[5]) && isNum(parts[6])) {
            raStr = parts[1] + ":" + parts[2] + ":" + parts[3];
            decStr = parts[4] + ":" + parts[5] + ":" + parts[6];
            nextIdx = 7;
            
            if (parts.length > nextIdx && (parts[nextIdx] === "2000" || parts[nextIdx] === "1950" || parts[nextIdx] === "B1950" || parts[nextIdx] === "J2000")) {
                nextIdx++;
            }
        } else {
            raStr = parts[1];
            decStr = parts[2];
            nextIdx = 3;
        }
        
        const ra = parseCoordinate(raStr, true);
        const dec = parseCoordinate(decStr, false);
        
        if (isNaN(magnitude) && parts.length > nextIdx) {
            const val = parseFloat(parts[nextIdx]);
            if (!isNaN(val)) {
                magnitude = val;
                nextIdx++;
            }
        }
        
        if (!priorityParsed && parts.length > nextIdx) {
            const val = parseFloat(parts[nextIdx]);
            if (!isNaN(val)) {
                priority = val;
                nextIdx++;
                priorityParsed = true;
            }
        }
        if (!priorityParsed) {
            priority = 3.0;
        }
        
        // Check for flags in remaining tokens or line
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes("twil") || lowerLine.includes("twilight")) allow_twilight = true;
        if (lowerLine.includes("airmass")) high_airmass = true;
        if (lowerLine.includes("high_sn")) sn_mode = "high_sn";
        else if (lowerLine.includes("class")) sn_mode = "classification";
        
        // If we consumed a flags token, skip nextIdx
        if (parts.length > nextIdx) {
            const tokenLower = parts[nextIdx].toLowerCase();
            if (tokenLower.includes("twil") || tokenLower.includes("airmass") || tokenLower.includes("high_sn") || tokenLower.includes("class") || tokenLower.includes("normal")) {
                nextIdx++;
            }
        }
        
        if (!comment && parts.length > nextIdx) {
            const commentStartIdx = line.indexOf(parts[nextIdx]);
            if (commentStartIdx !== -1) {
                comment = line.substring(commentStartIdx).trim();
            }
        }
        
        if (isNaN(ra) || isNaN(dec) || isNaN(magnitude)) continue;
        
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
        document.querySelectorAll(".real-time-only").forEach(el => el.style.display = "");
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

function logCommentFromInput() {
    const input = document.getElementById("rt-comment");
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    logToTerminal(`LOG COMMENT: ${val}`);
    input.value = "";
}

function logToTerminal(msg) {
    const term = document.getElementById("rt-log-terminal");
    if (!term) return;
    const timeStr = new Date().toLocaleTimeString();
    term.value += `[${timeStr}] ${msg}\n`;
    term.scrollTop = term.scrollHeight;
}

function clearRealTimeLog() {
    const term = document.getElementById("rt-log-terminal");
    if (term) term.value = "";
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
    
    const haLimitInput = document.getElementById("rt-ha-limit")?.value;
    const ha_limit = (haLimitInput !== undefined && haLimitInput !== "") ? parseFloat(haLimitInput) : null;
    
    const altLimitInput = document.getElementById("rt-alt-limit")?.value;
    const alt_limit = (altLimitInput !== undefined && altLimitInput !== "") ? parseFloat(altLimitInput) : null;
    
    const realtime_constraints = {
        extinction,
        mag_limit,
        ha_limit,
        alt_limit,
        start_from: new Date(nowMs).toISOString()
    };
    
    const standards_overrides = {};
    standardStars.forEach(s => {
        if (s.manual_start_time || s.manual_duration !== null || s.lock_type) {
            standards_overrides[s.name] = {
                manual_start_time: s.manual_start_time || null,
                manual_end_time: s.manual_end_time || null,
                manual_duration: s.manual_duration !== undefined ? s.manual_duration : null,
                schedule_before: s.schedule_before || []
            };
        }
    });

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
        auto_standards: autoStandardsMode,
        selected_standards: Array.from(selectedStandards),
        standards_overrides,
        realtime_constraints,
        previous_schedule: currentBlocksList.map(b => ({ target_name: b.target_name, start_time: b.start_time }))
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

// Issue #34: Debounce triggerScheduling to prevent flicker from rapid re-runs
let _scheduleDebounceTimer = null;
function triggerScheduling() {
    clearTimeout(_scheduleDebounceTimer);
    _scheduleDebounceTimer = setTimeout(_doSchedule, 150);
}

async function _doSchedule() {
    if (targetPool.length === 0) {
        // Issue #37: Clear alerts when pool is empty
        renderAlerts([], [], [], 0);
        currentBlocksList = [];
        renderTargetsTable();
        return;
    }
    
    const date = document.getElementById("obs-date").value;
    const disabledArray = Array.from(disabledStandards);
    
    const extinction = parseFloat(document.getElementById("rt-extinction")?.value) || 0.0;
    const magLimitInput = document.getElementById("rt-mag-limit")?.value;
    const mag_limit = (magLimitInput !== undefined && magLimitInput !== "") ? parseFloat(magLimitInput) : null;
    
    const haLimitInput = document.getElementById("rt-ha-limit")?.value;
    const ha_limit = (haLimitInput !== undefined && haLimitInput !== "") ? parseFloat(haLimitInput) : null;
    
    const altLimitInput = document.getElementById("rt-alt-limit")?.value;
    const alt_limit = (altLimitInput !== undefined && altLimitInput !== "") ? parseFloat(altLimitInput) : null;
    
    const startOverride = document.getElementById("manual-night-start")?.value.trim() || "";
    const endOverride = document.getElementById("manual-night-end")?.value.trim() || "";
    const tzOverride = document.getElementById("manual-night-tz")?.value || "UTC";

    const realtime_constraints = {
        extinction,
        mag_limit,
        ha_limit,
        alt_limit
    };

    if (startOverride || endOverride) {
        realtime_constraints.manual_limits_enabled = true;
        realtime_constraints.manual_limit_start = startOverride;
        realtime_constraints.manual_limit_end = endOverride;
        realtime_constraints.manual_limit_tz = tzOverride === 'obs' ? 'Local' : 'UTC';
    }
    
    const standards_overrides = {};
    standardStars.forEach(s => {
        if (s.manual_start_time || s.manual_duration !== null || s.lock_type) {
            standards_overrides[s.name] = {
                manual_start_time: s.manual_start_time || null,
                manual_end_time: s.manual_end_time || null,
                manual_duration: s.manual_duration !== undefined ? s.manual_duration : null,
                schedule_before: s.schedule_before || []
            };
        }
    });

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
        auto_standards: autoStandardsMode,
        selected_standards: Array.from(selectedStandards),
        standards_overrides,
        realtime_constraints,
        previous_schedule: currentBlocksList.map(b => ({ target_name: b.target_name, start_time: b.start_time }))
    };
    
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
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    alertsDismissed = false;

    lastScheduleResult = result;
    const { blocks, conflicts, unobservable, empty_blocks, moon_info, moon_plot, airmass_plots, solar_times } = result;
    
    document.getElementById("moon-phase-val").innerText = `${(moon_info.phase * 100).toFixed(0)}% illuminated`;
    document.getElementById("moon-ra-val").innerText = moon_info.ra.toFixed(1);
    document.getElementById("moon-dec-val").innerText = moon_info.dec.toFixed(1);
    
    const moonPic = document.getElementById("moon-phase-pic");
    const moonIllum = moon_info.phase;
    moonPic.style.boxShadow = `inset ${32 * (1 - moonIllum)}px 0px 0px rgba(15, 16, 27, 0.95), 0px 0px 15px #e2e8f0`;
    
    // Issue #35: Updated status pills with new statuses and colors
    targetPool.forEach(t => {
        const statusPill = document.getElementById(`status-${t.name}`);
        if (!statusPill) return;
        
        if (unobservable.includes(t.name)) {
            statusPill.className = "status-pill status-unobservable";
            statusPill.innerHTML = `<span class="target-status-dot" style="background:#000;"></span>Unobservable`;
        } else if (conflicts.includes(t.name)) {
            statusPill.className = "status-pill status-conflict";
            statusPill.innerHTML = `<span class="target-status-dot" style="background:#6b7280;"></span>Not Scheduled`;
        } else if (blocks.some(b => b.target_name === t.name)) {
            statusPill.className = "status-pill status-scheduled";
            statusPill.innerHTML = `<span class="target-status-dot" style="background:#eab308;"></span>Scheduled`;
        } else {
            statusPill.className = "status-pill status-not-scheduled";
            statusPill.innerHTML = `<span class="target-status-dot" style="background:#f97316;"></span>Not Scheduled`;
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
        schedBody.innerHTML = `<tr><td colspan="8" class="text-center" style="color: var(--text-muted);">No targets could be scheduled due to conflicts or visibility limits.</td></tr>`;
    } else {
        schedBody.innerHTML = blocks.map(b => {
            const startVal = formatTimeForTimezone(b.start_time, currentTimezone);
            const endVal = formatTimeForTimezone(b.end_time, currentTimezone);
            
            const target = targetPool.find(t => t.name === b.target_name) || standardStars.find(s => s.name === b.target_name);
            
            let timeCell = "";
            let durationCell = "";
            const isLocked = lockedTargets.has(b.target_name);
            let lockCell = "";
            
            if (target) {
                const startLocked = target.lock_type === 'start';
                const endLocked = target.lock_type === 'end';
                
                timeCell = `
                    <div style="display: flex; align-items: center; gap: 4px;" onclick="event.stopPropagation();">
                        <input type="text" value="${startVal}" 
                               onchange="updateTargetField('${b.target_name}', 'manual_start_time', this.value)" 
                               style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid ${startLocked ? '#f59e0b' : 'var(--border-color)'}; background: rgba(255, 255, 255, 0.05); color: #fff;">
                        <span>-</span>
                        <input type="text" value="${endVal}" 
                               onchange="updateTargetField('${b.target_name}', 'manual_end_time', this.value)" 
                               style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid ${endLocked ? '#f59e0b' : 'var(--border-color)'}; background: rgba(255, 255, 255, 0.05); color: #fff;">
                    </div>
                `;
                durationCell = `
                    <input type="number" min="1" step="1" value="${b.duration_minutes}" 
                           onchange="updateTargetField('${b.target_name}', 'manual_duration', this.value)" 
                           style="width: 55px; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: #fff;" 
                           onclick="event.stopPropagation();">
                `;
                lockCell = `<td style="text-align:center; width:30px;" onclick="event.stopPropagation();">
                    <button onclick="toggleTargetLock('${b.target_name}')" title="${isLocked ? 'Click to unlock' : 'Click to lock start time'}"
                        style="background:none; border:none; cursor:pointer; font-size:14px; opacity:${isLocked ? '1' : '0.35'}; color:${isLocked ? '#f59e0b' : 'inherit'};">${isLocked ? '🔒' : '🔓'}</button>
                </td>`;
            } else {
                timeCell = `<strong>${startVal} - ${endVal}</strong>`;
                durationCell = `${b.duration_minutes}`;
                lockCell = `<td></td>`;
            }
            
            return `
                <tr id="sched-row-${b.target_name}" data-target="${b.target_name}"
                    onmouseenter="highlightTarget('${b.target_name}')"
                    onmouseleave="unhighlightTarget('${b.target_name}')"
                    onclick="stickyHighlightTarget('${b.target_name}')"
                    style="cursor: pointer; ${isLocked ? 'background: rgba(245,158,11,0.05);' : ''}">
                    ${lockCell}
                    <td>${timeCell}</td>
                    <td><strong>${b.target_name}</strong></td>
                    <!-- Issue #33: priority as plain number -->
                    <td>${b.priority}</td>
                    <td>${durationCell}</td>
                    <td>${b.airmass_start.toFixed(2)} - ${b.airmass_end.toFixed(2)}</td>
                    <td><span style="font-weight:600; color:var(--accent-cyan);">${b.airmass_median.toFixed(2)}</span></td>
                    <td><span style="font-size: 0.85rem; color: var(--text-secondary);">${b.comment}</span></td>
                </tr>
            `;
        }).join('');
    }
    
    renderTimeline(blocks, solar_times, moon_plot);
    renderAlerts(conflicts, unobservable, empty_blocks, blocks.length);
    renderAirmassChart(airmass_plots, blocks, solar_times, moon_plot);
    drawPolarSkyMap(blocks, targetPool, solar_times);

    // Issue #13: After renderTimeline sets currentBlocksList, sync autoDisabledStandards
    // so checkboxes reflect which stars actually got scheduled.
    const _obs13 = { lat: 37.3414, lon: -121.6429, elevation: 1283 };
    const _scheduledStarNames = new Set(blocks.map(b => b.target_name));
    autoDisabledStandards.clear();
    standardStars.forEach(s => {
        const raDec = { ra: parseCoordinate(s.ra, true), dec: parseCoordinate(s.dec, false) };
        if (isStandardStarObservable(raDec, null, _obs13) && !disabledStandards.has(s.name)) {
            if (!_scheduledStarNames.has(s.name)) {
                autoDisabledStandards.add(s.name);
            }
        }
    });

    renderStandardsTable();
    // Issue #5: Re-render target table now that currentBlocksList is populated with scheduled blocks
    renderTargetsTable();
    // Issue #30: Update night overrides input placeholders
    updateNightOverridePlaceholders();

    window.scrollTo(scrollX, scrollY);
}


// ==============================================================================
// VISUAL TIMELINE BUILDER
// ==============================================================================



function handleTimelineReorder(draggedName, targetName) {
    if (draggedName === targetName) return;
    
    // Filter current blocks list to only include science targets
    const sciBlocks = currentBlocksList.filter(b => b.priority > 0);
    
    const draggedIdx = sciBlocks.findIndex(b => b.target_name === draggedName);
    if (draggedIdx === -1) return; // Standard stars cannot be dragged
    
    let targetIdx = sciBlocks.findIndex(b => b.target_name === targetName);
    
    // If targetName is a standard star, find the nearest science target in the timeline
    if (targetIdx === -1) {
        const fullTargetIdx = currentBlocksList.findIndex(b => b.target_name === targetName);
        if (fullTargetIdx === -1) return;
        
        let found = false;
        // Look to the right first
        for (let i = fullTargetIdx + 1; i < currentBlocksList.length; i++) {
            if (currentBlocksList[i].priority > 0) {
                targetName = currentBlocksList[i].target_name;
                targetIdx = sciBlocks.findIndex(b => b.target_name === targetName);
                found = true;
                break;
            }
        }
        // Look to the left if not found
        if (!found) {
            for (let i = fullTargetIdx - 1; i >= 0; i--) {
                if (currentBlocksList[i].priority > 0) {
                    targetName = currentBlocksList[i].target_name;
                    targetIdx = sciBlocks.findIndex(b => b.target_name === targetName);
                    found = true;
                    break;
                }
            }
        }
        if (!found) return; // No science targets scheduled to reorder against
    }

    if (targetName === draggedName) return;

    // 1. Clear all old constraints involving draggedName to start fresh
    const draggedTarget = targetPool.find(t => t.name === draggedName);
    if (!draggedTarget) return;
    draggedTarget.schedule_before = [];
    
    targetPool.forEach(t => {
        if (t.schedule_before) {
            t.schedule_before = t.schedule_before.filter(z => z !== draggedName);
        }
    });

    // 2. Get the list of science target names in the current schedule order
    const names = sciBlocks.map(b => b.target_name);
    
    // 3. Compute the new sequence by moving draggedName to be just before targetName
    names.splice(draggedIdx, 1);
    const newIdx = names.indexOf(targetName);
    names.splice(newIdx, 0, draggedName);
    
    // 4. Find the new index of draggedName
    const draggedNewIdx = names.indexOf(draggedName);
    
    // 5. For every target before the dragged target in the new sequence, add draggedName to its schedule_before
    for (let i = 0; i < draggedNewIdx; i++) {
        const xName = names[i];
        const xTarget = targetPool.find(t => t.name === xName) || standardStars.find(s => s.name === xName);
        if (xTarget) {
            if (!xTarget.schedule_before) xTarget.schedule_before = [];
            if (!xTarget.schedule_before.includes(draggedName)) {
                xTarget.schedule_before.push(draggedName);
            }
        }
    }
    
    // 6. For every target after the dragged target in the new sequence, add it to draggedTarget's schedule_before
    for (let i = draggedNewIdx + 1; i < names.length; i++) {
        const yName = names[i];
        if (!draggedTarget.schedule_before.includes(yName)) {
            draggedTarget.schedule_before.push(yName);
        }
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
    
    const sunsetMs = new Date(solar_times.sunset).getTime();
    const sunriseMs = new Date(solar_times.sunrise).getTime();
    const chartMin = Math.floor(sunsetMs / 3600000) * 3600000;
    const chartMax = Math.ceil(sunriseMs / 3600000) * 3600000;

    const nightStart = new Date(chartMin);
    const nightEnd = new Date(chartMax);
    const nightDurationMs = chartMax - chartMin;
    
    // 1. Build LST axis (top)
    const lstAxisEl = document.createElement("div");
    lstAxisEl.className = "timeline-lst-axis";
    lstAxisEl.style.position = "relative";
    lstAxisEl.style.height = "18px";
    lstAxisEl.style.width = "100%";
    lstAxisEl.style.marginBottom = "20px";
    
    const obsLon = -121.6429;
    for (let t = chartMin; t <= chartMax; t += 3600000) {
        const pct = ((t - chartMin) / nightDurationMs) * 100;
        const tickTime = new Date(t);
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
    
    if (eve18Ms > sunsetMs) {
        const leftPct = ((sunsetMs - nightStart.getTime()) / nightDurationMs) * 100;
        const widthPct = ((eve18Ms - sunsetMs) / nightDurationMs) * 100;
        const eveTwilightEl = document.createElement("div");
        eveTwilightEl.className = "timeline-twilight-region evening";
        eveTwilightEl.style.left = `${leftPct}%`;
        eveTwilightEl.style.width = `${widthPct}%`;
        blocksWrapper.appendChild(eveTwilightEl);
    }
    
    if (morn18Ms < sunriseMs) {
        const leftPct = ((morn18Ms - nightStart.getTime()) / nightDurationMs) * 100;
        const widthPct = ((sunriseMs - morn18Ms) / nightDurationMs) * 100;
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
        blockEl.title = `${b.target_name}\nUT: ${formatTimeForTimezone(b.start_time, 'UTC')} - ${formatTimeForTimezone(b.end_time, 'UTC')}\nLoc: ${formatTimeForTimezone(b.start_time, 'obs')} - ${formatTimeForTimezone(b.end_time, 'obs')}\nLST: ${bStartLST} - ${bEndLST}\nMedian Airmass: ${b.airmass_median.toFixed(2)}`;
        
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
            blockEl.addEventListener("dragover", (e) => {
                e.preventDefault();
            });
            blockEl.addEventListener("drop", (e) => {
                e.preventDefault();
                const draggedName = e.dataTransfer.getData("text/plain");
                if (draggedName && draggedName !== b.target_name) {
                    handleTimelineReorder(draggedName, b.target_name);
                }
            });
        }
        
        // Hover and Click Highlight Event Listeners
        blockEl.addEventListener("mouseenter", () => highlightTarget(b.target_name));
        blockEl.addEventListener("mouseleave", () => unhighlightTarget(b.target_name));
        blockEl.addEventListener("click", () => {
            stickyHighlightTarget(b.target_name);
        });
        
        blocksWrapper.appendChild(blockEl);
    });
    
    // Draw vertical hourly grid lines
    for (let t = chartMin; t <= chartMax; t += 3600000) {
        const pct = ((t - chartMin) / nightDurationMs) * 100;
        const lineEl = document.createElement("div");
        lineEl.style.position = "absolute";
        lineEl.style.left = `${pct}%`;
        lineEl.style.top = "0";
        lineEl.style.bottom = "0";
        lineEl.style.borderLeft = "1px dashed rgba(255, 255, 255, 0.05)";
        lineEl.style.zIndex = "1"; // Behind blocks but in wrapper
        lineEl.style.pointerEvents = "none";
        blocksWrapper.appendChild(lineEl);
    }
    
    // 4. Render Axis Ticks (bottom) showing UT and Local
    const axisEl = document.createElement("div");
    axisEl.className = "timeline-axis";
    axisEl.style.position = "relative";
    axisEl.style.height = "26px";
    axisEl.style.width = "100%";
    axisEl.style.marginTop = "4px";
    
    for (let t = chartMin; t <= chartMax; t += 3600000) {
        const pct = ((t - chartMin) / nightDurationMs) * 100;
        const tickTime = new Date(t);
        
        const primaryStr = formatTimeForTimezone(tickTime, currentTimezone);
        let secondaryStr = "";
        
        if (currentTimezone === 'UTC' || currentTimezone.startsWith('UTC')) {
            const locStr = formatTimeForTimezone(tickTime, 'obs');
            secondaryStr = `<div style="font-size:0.6rem; color:var(--text-muted);">${locStr} Loc</div>`;
        } else {
            const utStr = formatTimeForTimezone(tickTime, 'UTC');
            secondaryStr = `<div style="font-size:0.6rem; color:var(--text-muted);">${utStr} UT</div>`;
        }
        
        const tickEl = document.createElement("div");
        tickEl.className = "timeline-tick";
        tickEl.style.left = `${pct}%`;
        tickEl.style.position = "absolute";
        tickEl.style.transform = "translateX(-50%)";
        tickEl.style.fontSize = "0.7rem";
        tickEl.style.textAlign = "center";
        tickEl.innerHTML = `<div>${primaryStr}</div>${secondaryStr}`;
        
        axisEl.appendChild(tickEl);
    }
    
    container.appendChild(blocksWrapper);
    container.appendChild(axisEl);
}


// ==============================================================================
// ALERTS CONSOLE RENDERER
// ==============================================================================

function clearAlerts() {
    alertsDismissed = true;
    const consoleEl = document.getElementById("alerts-console");
    if (consoleEl) {
        consoleEl.style.display = "none";
    }
}

function renderAlerts(conflicts, unobservable, empty_blocks, scheduled_count) {
    const consoleEl = document.getElementById("alerts-console");
    consoleEl.innerHTML = "";
    
    if (alertsDismissed) {
        consoleEl.style.display = "none";
        return;
    }
    
    const items = [];
    
    conflicts.forEach(name => {
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
        const headerHtml = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
                <span style="font-weight: bold; color: #fff; font-size: 0.95rem;">Alerts & Conflicts</span>
                <button onclick="clearAlerts()" class="btn" style="padding: 2px 8px; font-size: 0.75rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 4px; cursor: pointer; color: #fca5a5;">Clear Alerts</button>
            </div>
        `;
        consoleEl.innerHTML = headerHtml + items.join('');
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
    const ctx = document.getElementById("airmassChart").getContext("2d");

    // Issue #22: Register custom positioner to keep tooltip above the thick observation lines
    if (!Chart.Tooltip.positioners.aboveLine) {
        Chart.Tooltip.positioners.aboveLine = function(items, eventPosition) {
            const pos = Chart.Tooltip.positioners.nearest.call(this, items, eventPosition);
            if (!pos) return false;
            const chartArea = this.chart.chartArea;
            return {
                x: Math.max(chartArea.left + 5, Math.min(pos.x, chartArea.right - 5)),
                y: Math.max(chartArea.top + 10, pos.y - 70),
                xAlign: 'center',
                yAlign: 'bottom'
            };
        };
    }
    
    if (airmassChart) {
        airmassChart.destroy();
    }
    
    originalXMin = null;
    originalXMax = null;
    
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
                y: (p.airmass <= 0) ? null : p.airmass
            };
        });
        datasets.push({
            label: 'Moon (Airmass)',
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
                y: (p.airmass <= 0) ? null : p.airmass,
                observable: !!p.observable
            };
        });
        
        // Dotted/dashed lines with lower opacity (0.25)
        datasets.push({
            label: `${tName} (Night Profile)`,
            data: fullNightPoints,
            borderColor: getRgba(color, 0.25),
            borderWidth: 1.5,
            fill: false,
            tension: 0.1,
            pointRadius: 0,
            segment: {
                borderDash: ctx => {
                    const chart = ctx.chart;
                    const datasetIndex = ctx.datasetIndex;
                    const idx = ctx.p0DataIndex;
                    if (chart && chart.data && chart.data.datasets && chart.data.datasets[datasetIndex]) {
                        const data = chart.data.datasets[datasetIndex].data;
                        const pt = data ? data[idx] : null;
                        if (pt && pt.observable) {
                            return [6, 4]; // Dashed line when observable
                        }
                    }
                    return [2, 2]; // Dotted line when unobservable
                }
            }
        });
        
        if (block) {
            const startMs = new Date(block.start_time).getTime();
            const endMs = new Date(block.end_time).getTime();
            
            const scheduledPoints = plotData.map(p => {
                const timeMs = new Date(p.time).getTime();
                const inRange = (timeMs >= startMs && timeMs <= endMs);
                return {
                    x: timeMs,
                    y: (inRange && p.airmass > 0) ? p.airmass : null
                };
            });
            
            // Issue #21: Observation window lines are twice as thick (width 8)
             datasets.push({
                label: tName,
                data: scheduledPoints,
                borderColor: color,
                borderWidth: 8,
                fill: false,
                tension: 0.1,
                pointRadius: 0,
                pointStyle: 'line',
                pointHoverRadius: 4
            });
        }
    });
    
    // Twilight Plugin to draw gradients & vertical lines in Chart.js
    const twilightPlugin = {
        id: 'twilightPlugin',
        beforeDraw: (chart) => {
            const chartCtx = chart.ctx;
            const xAxis = chart.scales.x;
            const yAxis = chart.scales.y;
            
            if (!xAxis || !yAxis || !solar_times) return;
            
            const sunsetMs = new Date(solar_times.sunset).getTime();
            const sunriseMs = new Date(solar_times.sunrise).getTime();
            const eve12Ms = new Date(solar_times.twilight_evening_12).getTime();
            const morn12Ms = new Date(solar_times.twilight_morning_12).getTime();
            const eve18Ms = new Date(solar_times.twilight_evening_18).getTime();
            const morn18Ms = new Date(solar_times.twilight_morning_18).getTime();
            
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
            chartCtx.restore();
        }
    };
    
    // Issue #4: Box Zoom Overlay Drawer Plugin — 2D rectangle (X and Y axes)
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
                
                const startX = Math.max(chartArea.left, Math.min(dragStart.x, chartArea.right));
                const endX = Math.max(chartArea.left, Math.min(dragEnd.x, chartArea.right));
                const startY = Math.max(chartArea.top, Math.min(dragStart.y, chartArea.bottom));
                const endY = Math.max(chartArea.top, Math.min(dragEnd.y, chartArea.bottom));
                
                chartCtx.fillRect(startX, startY, endX - startX, endY - startY);
                chartCtx.strokeRect(startX, startY, endX - startX, endY - startY);
                chartCtx.restore();
            }
        }
    };
    
    const sunsetMs = new Date(solar_times.sunset).getTime();
    const sunriseMs = new Date(solar_times.sunrise).getTime();
    const chartMin = Math.floor(sunsetMs / 3600000) * 3600000;
    const chartMax = Math.ceil(sunriseMs / 3600000) * 3600000;

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
                    bottom: 10
                }
            },
            interaction: {
                mode: 'nearest',
                intersect: false,
            },
            plugins: {
                legend: {
                    // Issue #20: Only show scheduled-observation series; use horizontal line icons
                    labels: {
                        color: '#94a3b8',
                        font: { family: 'Inter', size: 11 },
                        usePointStyle: true,
                        filter: function(item) {
                            // Exclude night-profile dotted series and Moon series
                            return !item.text.includes('(Night Profile)') && item.text !== 'Moon (Airmass)';
                        },
                        generateLabels: function(chart) {
                            const original = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                            return original
                                .filter(item => !item.text.includes('(Night Profile)') && item.text !== 'Moon (Airmass)')
                                .map(item => {
                                    // Issue #20: horizontal line icon instead of filled rectangle
                                    item.pointStyle = 'line';
                                    item.lineWidth = 3;
                                    return item;
                                });
                        }
                    }
                },
                tooltip: {
                    // Issue #22: Use the 'aboveLine' custom positioner (registered above) to keep
                    // the tooltip above the thick observation lines
                    position: 'aboveLine',
                    mode: 'nearest',
                    intersect: false,
                    usePointStyle: true,
                    filter: function(tooltipItem) {
                        return !tooltipItem.dataset.label.includes('(Night Profile)');
                    },
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
                    min: chartMin,
                    max: chartMax,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        callback: function(value, index, ticks) {
                            const date = new Date(value);
                            const utStr = formatTimeForTimezone(date, 'UTC');
                            const locStr = formatTimeForTimezone(date, 'obs');
                            // Return an array so each label renders on a separate line
                            return [utStr + ' UT', locStr + ' Loc'];
                        },
                        // Force ticks at whole UTC hours (3600000 ms)
                        stepSize: 3600000,
                        color: '#94a3b8',
                        font: { family: 'Inter' }
                    }
                },
                x2: {
                    type: 'linear',
                    position: 'top',
                    min: chartMin,
                    max: chartMax,
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
                    // Issue #6: Dynamic Y-axis max = max(1.7, highest scheduled airmass + 0.1)
                    max: (() => {
                        let maxAirmass = 1.7;
                        blocks.forEach(b => {
                            if (b.airmass_median && b.airmass_median > maxAirmass) maxAirmass = b.airmass_median;
                            if (b.airmass_start && b.airmass_start > maxAirmass) maxAirmass = b.airmass_start;
                            if (b.airmass_end && b.airmass_end > maxAirmass) maxAirmass = b.airmass_end;
                        });
                        return Math.max(1.7, maxAirmass + 0.1);
                    })(),
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
}

let originalXMin = null;
let originalXMax = null;
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
        // Issue #4: Track both X and Y for 2D box zoom
        const x = Math.max(airmassChart.chartArea.left, Math.min(e.clientX - rect.left, airmassChart.chartArea.right));
        const y = Math.max(airmassChart.chartArea.top, Math.min(e.clientY - rect.top, airmassChart.chartArea.bottom));
        dragEnd.x = x;
        dragEnd.y = y;
        
        airmassChart.draw();
    });
    
    canvas.addEventListener('mouseup', (e) => {
        if (!isDragging || !airmassChart) return;
        isDragging = false;
        
        const startX = dragStart.x;
        const endX = dragEnd.x;
        
        if (Math.abs(endX - startX) > 5) {
            const xAxis = airmassChart.scales.x;
            const val1 = xAxis.getValueForPixel(startX);
            const val2 = xAxis.getValueForPixel(endX);
            const minVal = Math.min(val1, val2);
            const maxVal = Math.max(val1, val2);
            
            airmassChart.options.scales.x.min = minVal;
            airmassChart.options.scales.x.max = maxVal;
            if (airmassChart.options.scales.x2) {
                airmassChart.options.scales.x2.min = minVal;
                airmassChart.options.scales.x2.max = maxVal;
            }
            
            const yAxis = airmassChart.scales.y;
            const valY1 = yAxis.getValueForPixel(dragStart.y);
            const valY2 = yAxis.getValueForPixel(dragEnd.y);
            const minY = Math.min(valY1, valY2);
            const maxY = Math.max(valY1, valY2);
            
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
        
        // Reset Y-axis scale to default
        airmassChart.options.scales.y.min = 1.0;
        let maxAirmass = 1.7;
        currentBlocksList.forEach(b => {
            if (b.airmass_median && b.airmass_median > maxAirmass) maxAirmass = b.airmass_median;
            if (b.airmass_start && b.airmass_start > maxAirmass) maxAirmass = b.airmass_start;
            if (b.airmass_end && b.airmass_end > maxAirmass) maxAirmass = b.airmass_end;
        });
        airmassChart.options.scales.y.max = Math.max(1.7, maxAirmass + 0.1);
        
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

function calculateExposure(target, moonPhase, moonSep) {
    let baseExp = 100.0 * Math.pow(2.512, target.magnitude - 15.0);
    const snMults = { classification: 0.5, normal: 1.0, high_sn: 2.0 };
    const snMult = snMults[target.sn_mode] || 1.0;
    const moonFactor = 1.0 + 5.0 * moonPhase * Math.exp(-moonSep / 30.0);
    const totalExp = baseExp * snMult * moonFactor;
    return Math.max(60.0, Math.min(7200.0, totalExp));
}

function runLocalJSSolver(payload) {
    const { date, observatory, targets } = payload;
    const dateParts = date.split('-');
    
    const localNoon = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0);
    const offsetHours = 8.109; // Lick offset W
    const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
    
    const solarTimes = getSolarTimesFallback(utcNoon, observatory.lat, observatory.lon, observatory.elevation);
    
    let sunset = solarTimes.sunset;
    let sunrise = solarTimes.sunrise;
    
    const rt = payload.realtime_constraints || {};
    if (rt.manual_limits_enabled) {
        const tzMode = rt.manual_limit_tz || 'UTC';
        
        let shh, smm;
        if (tzMode !== 'UTC') {
            try {
                const options = { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false };
                const partsSunset = new Intl.DateTimeFormat("en-US", options).formatToParts(sunset);
                shh = parseInt(partsSunset.find(p => p.type === 'hour').value, 10);
                smm = parseInt(partsSunset.find(p => p.type === 'minute').value, 10);
            } catch (e) {
                const localDate = new Date(sunset.getTime() - 7 * 60 * 60 * 1000);
                shh = localDate.getUTCHours();
                smm = localDate.getUTCMinutes();
            }
        } else {
            shh = sunset.getUTCHours();
            smm = sunset.getUTCMinutes();
        }
        if (rt.manual_limit_start) {
            const parsed = parseHourMinute(rt.manual_limit_start, true);
            if (parsed) {
                shh = parsed.hh;
                smm = parsed.mm;
            }
        }

        let ehh, emm;
        if (tzMode !== 'UTC') {
            try {
                const options = { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false };
                const partsSunrise = new Intl.DateTimeFormat("en-US", options).formatToParts(sunrise);
                ehh = parseInt(partsSunrise.find(p => p.type === 'hour').value, 10);
                emm = parseInt(partsSunrise.find(p => p.type === 'minute').value, 10);
            } catch (e) {
                const localDate = new Date(sunrise.getTime() - 7 * 60 * 60 * 1000);
                ehh = localDate.getUTCHours();
                emm = localDate.getUTCMinutes();
            }
        } else {
            ehh = sunrise.getUTCHours();
            emm = sunrise.getUTCMinutes();
        }
        if (rt.manual_limit_end) {
            const parsed = parseHourMinute(rt.manual_limit_end, false);
            if (parsed) {
                ehh = parsed.hh;
                emm = parsed.mm;
            }
        }

        if (tzMode === 'UTC') {
            sunset = new Date(Date.UTC(solarTimes.sunset.getUTCFullYear(), solarTimes.sunset.getUTCMonth(), solarTimes.sunset.getUTCDate(), shh, smm, 0, 0));
            sunrise = new Date(Date.UTC(solarTimes.sunrise.getUTCFullYear(), solarTimes.sunrise.getUTCMonth(), solarTimes.sunrise.getUTCDate(), ehh, emm, 0, 0));
            if (sunrise < sunset) {
                sunrise = new Date(sunrise.getTime() + 24 * 60 * 60 * 1000);
            }
        } else {
            function getOffset(date) {
                try {
                    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
                    const formatted = formatter.format(date);
                    const match = formatted.match(/GMT([-+]\d+)/);
                    return match ? parseInt(match[1], 10) : -7;
                } catch (e) {
                    return -7;
                }
            }
            const tempStart = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], shh, smm, 0, 0));
            const startOffset = getOffset(tempStart);
            sunset = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], shh - startOffset, smm, 0, 0));
            
            let endDay = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
            if (ehh < shh) {
                endDay = new Date(endDay.getTime() + 24 * 60 * 60 * 1000);
            }
            const tempEnd = new Date(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate(), ehh, emm, 0, 0));
            const endOffset = getOffset(tempEnd);
            sunrise = new Date(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate(), ehh - endOffset, emm, 0, 0));
        }
        
        if (solarTimes.twilight_evening_18 < sunset) {
            solarTimes.twilight_evening_18 = sunset;
        }
        if (solarTimes.twilight_morning_18 > sunrise) {
            solarTimes.twilight_morning_18 = sunrise;
        }
    }
    
    const totalDurationMs = sunrise.getTime() - sunset.getTime();
    // Issue #29: 1-minute chunks (was 5-minute)
    const numChunks = Math.floor(totalDurationMs / (60 * 1000));
    
    const chunkTimes = [];
    for (let i = 0; i < numChunks; i++) {
        chunkTimes.push(new Date(sunset.getTime() + i * 60 * 1000));
    }
    
    const midTime = new Date(sunset.getTime() + totalDurationMs / 2);
    const dMid = datetimeToD(midTime);
    const moon = getMoonPosition(dMid);
    
    function getAirmassForTarget(t, dt) {
        if (!t._airmassCache) t._airmassCache = {};
        const key = dt.getTime();
        if (t._airmassCache[key] !== undefined) {
            return t._airmassCache[key];
        }
        const altAz = getAltAz(dt, observatory.lat, observatory.lon, t.ra, t.dec);
        const val = getAirmass(altAz.alt);
        t._airmassCache[key] = val;
        return val;
    }
    
    function isShaneVisible(t, dt) {
        if (t.dec < -35.0 || t.dec > 72.0) return false;
        const lst = getLst(dt, observatory.lon);
        const ha = getHourAngle(lst, t.ra);
        // East -05:40 (-5.67h), West +03:45 (+3.75h)
        if (ha < -5.6667 || ha > 3.75) return false;
        return true;
    }
    
    function isChunkValid(t, cIdx, isManual = false, ignoreSchedulingLimits = false) {
        const dt = chunkTimes[cIdx];
        
        // Twilight check
        if (!isManual) {
            if (ignoreSchedulingLimits) {
                // Just check if it's within the night (sunset to sunrise)
                if (dt < sunset || dt > sunrise) {
                    return false;
                }
            } else {
                if (!t.allow_twilight) {
                    if (dt < solarTimes.twilight_evening_18 || dt > solarTimes.twilight_morning_18) {
                        return false;
                    }
                } else {
                    const rt = payload.realtime_constraints || {};
                    const isStandard = (t.priority === 0.0);
                    if (isStandard) {
                        const limitStart = rt.manual_limits_enabled ? sunset : new Date(sunset.getTime() + 30 * 60 * 1000);
                        const limitEnd = rt.manual_limits_enabled ? sunrise : new Date(sunrise.getTime() - 30 * 60 * 1000);
                        if (dt < limitStart || dt > limitEnd) {
                            return false;
                        }
                    } else {
                        const limitStart = new Date(solarTimes.twilight_evening_12);
                        const limitEnd = new Date(solarTimes.twilight_morning_12);
                        if (dt < limitStart || dt > limitEnd) {
                            return false;
                        }
                    }
                }
            }
            
            // Pointing check
            if (!isShaneVisible(t, dt)) return false;
        }
        
        // Airmass check
        const airmass = getAirmassForTarget(t, dt);
        if (isManual) {
            if (airmass <= 0) return false;
        } else {
            if (ignoreSchedulingLimits) {
                if (airmass <= 0 || airmass > 2.92) return false;
            } else {
                const limitAirmass = t.high_airmass ? 2.2 : 1.7;
                if (airmass <= 0 || airmass > limitAirmass) return false;
            }
        }
        
        if (!isManual && !ignoreSchedulingLimits) {
            // Real-time limits
            const rt = payload.realtime_constraints || {};
            if (rt.ha_limit !== undefined && rt.ha_limit !== null && rt.ha_limit !== "") {
                const lst = getLst(dt, observatory.lon);
                const ha = getHourAngle(lst, t.ra);
                if (Math.abs(ha) > parseFloat(rt.ha_limit)) return false;
            }
            if (rt.alt_limit !== undefined && rt.alt_limit !== null && rt.alt_limit !== "") {
                const altAz = getAltAz(dt, observatory.lat, observatory.lon, t.ra, t.dec);
                if (altAz.alt < parseFloat(rt.alt_limit)) return false;
            }
        }
        
        return true;
    }
    
    function getChunkIdxFromTimeStr(timeStr) {
        if (!timeStr) return null;
        timeStr = timeStr.trim();
        if (!timeStr) return null;
        
        if (timeStr.includes(":")) {
            const parts = timeStr.split(":");
            const hh = parseInt(parts[0], 10);
            const mm = parseInt(parts[1], 10);
            if (isNaN(hh) || isNaN(mm)) return null;
            
            for (let i = 0; i < chunkTimes.length; i++) {
                const ct = chunkTimes[i];
                // Issue #29: exact minute match (tolerance 0)
                if (ct.getUTCHours() === hh && ct.getUTCMinutes() === mm) {
                    return i;
                }
            }
            for (let i = 0; i < chunkTimes.length; i++) {
                const ct = chunkTimes[i];
                if (ct.getHours() === hh && ct.getMinutes() === mm) {
                    return i;
                }
            }
        }
        return null;
    }
    
    // 3. Load standard stars database early
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
    standardsData.forEach(s => {
        s.allow_twilight = true;
    });
    
    if (payload.disabled_standards) {
        const disabledSet = new Set(payload.disabled_standards);
        standardsData = standardsData.filter(s => !disabledSet.has(s.name));
    }

    if (payload.standards_overrides) {
        standardsData.forEach(s => {
            if (payload.standards_overrides[s.name]) {
                const ovr = payload.standards_overrides[s.name];
                if (ovr.manual_start_time) {
                    s.manual_start_time = ovr.manual_start_time;
                }
                if (ovr.manual_duration !== null && ovr.manual_duration !== undefined) {
                    s.manual_duration = ovr.manual_duration;
                }
            }
        });
    }

    const prelimReservedChunks = new Set();
    const manualStandardBlocks = [];

    standardsData.forEach(s => {
        if (s.manual_start_time) {
            const manualChunk = getChunkIdxFromTimeStr(s.manual_start_time);
            if (manualChunk !== null) {
                let durChunks = 5;
                if (s.manual_duration !== null && s.manual_duration !== undefined) {
                    durChunks = Math.max(1, Math.ceil(s.manual_duration));
                }
                let blockValid = true;
                for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                    if (c >= numChunks || prelimReservedChunks.has(c) || !isChunkValid(s, c, true)) {
                        blockValid = false;
                        break;
                    }
                }
                if (blockValid) {
                    for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                        prelimReservedChunks.add(c);
                    }
                    const air = getAirmassForTarget(s, chunkTimes[manualChunk]);
                    manualStandardBlocks.push({
                        target_name: s.name,
                        ra: s.ra,
                        dec: s.dec,
                        start_time: chunkTimes[manualChunk].toISOString(),
                        end_time: (manualChunk + durChunks < numChunks) ? chunkTimes[manualChunk + durChunks].toISOString() : sunrise.toISOString(),
                        duration_minutes: durChunks,
                        airmass_start: air,
                        airmass_end: air,
                        airmass_median: air,
                        priority: 0.0,
                        comment: `Calib: ${s.color.charAt(0).toUpperCase() + s.color.slice(1)} / ${s.quality.charAt(0).toUpperCase() + s.quality.slice(1)}, Airmass ${air.toFixed(2)}`
                    });
                }
            }
        }
    });

    // Filter out pre-scheduled standards so they aren't processed in standard selection loops
    let activeStandardsData = standardsData.filter(s => !s.manual_start_time);

    // Sort and calculate exposures
    const targetExposures = {};
    targets.forEach(t => {
        const sep = getSeparation(t.ra, t.dec, moon.ra, moon.dec);
        targetExposures[t.name] = calculateExposure(t, moon.phase, sep);
    });
    
    // 1. Run preliminary solve to see what gets scheduled and if we need high-airmass calibrations
    const prelimSolve = solveInternal(targets, new Set(prelimReservedChunks));
    const scheduledScience = prelimSolve.blocks;
    
    let needHighAirmass = false;
    for (let i = 0; i < scheduledScience.length; i++) {
        if (scheduledScience[i].airmass_median > 1.5) {
            needHighAirmass = true;
            break;
        }
    }
    
    // Issue #29: Standard star slots at 30 & 35 min after sunset (1-min chunks)
    const hasManual = !!(payload.realtime_constraints && payload.realtime_constraints.manual_limits_enabled);
    let eveSlot1 = hasManual ? 0 : 30;
    let eveSlot2 = hasManual ? 5 : 35;
    const brightThreshold = 15.5; // Lick Shane threshold
    
    const scienceStartBlock = scheduledScience.find(b => new Date(b.start_time).getTime() === chunkTimes[0].getTime());
    if (scienceStartBlock) {
        const sciTarget = targets.find(t => t.name === scienceStartBlock.target_name);
        if (sciTarget && sciTarget.magnitude < brightThreshold) {
            eveSlot1 = Math.max(hasManual ? 0 : 30, Math.ceil(scienceStartBlock.duration_minutes));
            eveSlot2 = eveSlot1 + 5;
        }
    }
    
    // Morning standards: 35 & 40 min before sunrise
    let mornSlot2 = hasManual ? numChunks - 5 : numChunks - 35;
    let mornSlot1 = mornSlot2 - 5;
    const scienceEndBlock = scheduledScience.find(b => new Date(b.end_time).getTime() === chunkTimes[numChunks - 1].getTime());
    if (scienceEndBlock) {
        const sciTarget = targets.find(t => t.name === scienceEndBlock.target_name);
        if (sciTarget && sciTarget.magnitude < brightThreshold) {
            mornSlot2 = Math.min(hasManual ? numChunks - 5 : numChunks - 35, numChunks - 5 - Math.ceil(scienceEndBlock.duration_minutes));
            mornSlot1 = mornSlot2 - 5;
        }
    }
    
    // 3. Setup standard stars
    const blueStandards = activeStandardsData.filter(s => s.color === 'blue');
    const redStandards = activeStandardsData.filter(s => s.color === 'red');
    
    const reservedChunks = new Set(prelimReservedChunks);
    const standardBlocks = [...manualStandardBlocks];
    
    function addStandardBlock(starObj, chunkIdx) {
        if (!starObj) return;
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
        let durChunks = 5;
        if (starObj.manual_duration !== null && starObj.manual_duration !== undefined) {
            durChunks = Math.max(1, Math.ceil(starObj.manual_duration));
        }
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
            duration_minutes: durChunks,
            airmass_start: air,
            airmass_end: air,
            airmass_median: air,
            priority: 0.0,
            comment: targetObj.comment
        });
    }

    if (payload.auto_standards !== false) {
        // Auto Selection Mode (schedule independently for each of the 4 slots if observable)
        let s_eb = null;
        let s_er = null;
        let s_mb = null;
        let s_mr = null;

        // Evening Blue (Slot 1)
        let best_eb_score = -1.0;
        blueStandards.forEach(s => {
            if (Array.from({length: 5}, (_, i) => eveSlot1 + i).some(c => reservedChunks.has(c))) return;
            if (!isShaneVisible(s, chunkTimes[eveSlot1])) return;
            const air = getAirmassForTarget(s, chunkTimes[eveSlot1]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 100.0 : 10.0;
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
        if (s_eb) {
            addStandardBlock(s_eb, eveSlot1);
        }

        // Evening Red (Slot 2)
        let best_er_score = -1.0;
        redStandards.forEach(s => {
            if (Array.from({length: 5}, (_, i) => eveSlot2 + i).some(c => reservedChunks.has(c))) return;
            if (!isShaneVisible(s, chunkTimes[eveSlot2])) return;
            const air = getAirmassForTarget(s, chunkTimes[eveSlot2]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 100.0 : 10.0;
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
        if (s_er) {
            addStandardBlock(s_er, eveSlot2);
        }

        // Morning Blue (Slot 1)
        let best_mb_score = -1.0;
        blueStandards.forEach(s => {
            if (Array.from({length: 5}, (_, i) => mornSlot1 + i).some(c => reservedChunks.has(c))) return;
            if (!isShaneVisible(s, chunkTimes[mornSlot1])) return;
            const air = getAirmassForTarget(s, chunkTimes[mornSlot1]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 100.0 : 10.0;
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
        if (s_mb) {
            addStandardBlock(s_mb, mornSlot1);
        }

        // Morning Red (Slot 2)
        let best_mr_score = -1.0;
        redStandards.forEach(s => {
            if (Array.from({length: 5}, (_, i) => mornSlot2 + i).some(c => reservedChunks.has(c))) return;
            if (!isShaneVisible(s, chunkTimes[mornSlot2])) return;
            const air = getAirmassForTarget(s, chunkTimes[mornSlot2]);
            if (air > 0 && air <= 2.2) {
                let score = s.quality === 'good' ? 100.0 : 10.0;
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
        if (s_mr) {
            addStandardBlock(s_mr, mornSlot2);
        }
    } else {
        // Manual Selection Mode
        const selectedSet = new Set(payload.selected_standards || []);
        const manualStandards = activeStandardsData.filter(s => selectedSet.has(s.name));
        
        // Sort by RA
        manualStandards.sort((a, b) => a.ra - b.ra);
        
        // Find twilight chunks
        const twilChunks = [];
        const eveTwilStart = hasManual ? sunset : new Date(sunset.getTime() + 30 * 60 * 1000);
        const eveTwilEnd = new Date(sunset.getTime() + 90 * 60 * 1000);
        const mornTwilStart = new Date(sunrise.getTime() - 90 * 60 * 1000);
        const mornTwilEnd = hasManual ? sunrise : new Date(sunrise.getTime() - 30 * 60 * 1000);
        
        for (let c = 0; c < numChunks; c++) {
            const ct = chunkTimes[c];
            if ((ct >= eveTwilStart && ct <= eveTwilEnd) || (ct >= mornTwilStart && ct <= mornTwilEnd)) {
                twilChunks.push(c);
            }
        }
        
        manualStandards.forEach(s => {
            let durChunks = 5;
            if (s.manual_duration !== null && s.manual_duration !== undefined) {
                durChunks = Math.max(1, Math.ceil(s.manual_duration));
            }
            
            function findBestChunk(allowedChunks, maxAirmass) {
                let bc = null;
                let ba = Infinity;
                
                for (let i = 0; i < allowedChunks.length; i++) {
                    const cIdx = allowedChunks[i];
                    if (cIdx + durChunks > numChunks) continue;
                    
                    let overlap = false;
                    for (let c = cIdx; c < cIdx + durChunks; c++) {
                        if (reservedChunks.has(c)) {
                            overlap = true;
                            break;
                        }
                    }
                    if (overlap) continue;
                    
                    let blockOk = true;
                    for (let offset = 0; offset < durChunks; offset++) {
                        if (!isShaneVisible(s, chunkTimes[cIdx + offset])) {
                            blockOk = false;
                            break;
                        }
                    }
                    if (!blockOk) continue;
                    
                    const air = getAirmassForTarget(s, chunkTimes[cIdx]);
                    if (air > 0 && air <= maxAirmass) {
                        if (air < ba) {
                            ba = air;
                            bc = cIdx;
                        }
                    }
                }
                return { bc, ba };
            }
            
            let res = findBestChunk(twilChunks, 2.2);
            if (res.bc === null) res = findBestChunk(twilChunks, 2.5);
            
            const minChunk = hasManual ? 0 : 30;
            const allChunks = Array.from({length: numChunks}, (_, i) => i).filter(c => c >= minChunk);
            if (res.bc === null) res = findBestChunk(allChunks, 2.2);
            if (res.bc === null) res = findBestChunk(allChunks, 2.5);
            if (res.bc === null) res = findBestChunk(allChunks, 10.0);
            
            if (res.bc !== null) {
                addStandardBlock(s, res.bc);
            }
        });
    }
    
    // 4. Run final solve with reserved standard blocks
    const finalSolve = solveInternal(targets, reservedChunks);
    const scheduledBlocks = [...finalSolve.blocks, ...standardBlocks];
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
            // Issue #29: gap threshold is 1 minute
            if (bStart > new Date(curr.getTime() + 1 * 60 * 1000)) {
                empty_blocks.push({
                    start_time: curr.toISOString(),
                    end_time: b.start_time,
                    duration_minutes: Math.round((bStart.getTime() - curr.getTime()) / (60 * 1000))
                });
            }
            curr = bEnd > curr ? bEnd : curr;
        });
        
        if (new Date(curr.getTime() + 1 * 60 * 1000) < endActive) {
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
        const curve = [];
        for (let i = 0; i < numChunks; i++) {
            curve.push({
                time: chunkTimes[i].toISOString(),
                airmass: getAirmassForTarget({ra: block.ra, dec: block.dec, name: block.target_name}, chunkTimes[i])
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
        targetsList.forEach(t => {
            if (t.manual_duration !== null && t.manual_duration !== undefined) {
                targetExps[t.name] = t.manual_duration * 60.0;
            } else {
                const sep = getSeparation(t.ra, t.dec, moon.ra, moon.dec);
                targetExps[t.name] = calculateExposure(t, moon.phase, sep);
            }
        });
        
        const manualStartChunks = {};
        targetsList.forEach(t => {
            manualStartChunks[t.name] = getChunkIdxFromTimeStr(t.manual_start_time);
        });
        
        const durations = {};
        targetsList.forEach(t => {
            durations[t.name] = Math.max(1, Math.ceil(targetExps[t.name] / 60));
        });
        
        const unobservable = [];
        const observable = [];
        const initialConflicts = [];
        
        targetsList.forEach(t => {
            // 1. Check physical observability (ignoring reserved)
            let hasPhysicalChunk = false;
            const manualChunk = manualStartChunks[t.name];
            if (manualChunk !== null) {
                const durChunks = durations[t.name];
                let blockValid = true;
                for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                    if (c >= numChunks || !isChunkValid(t, c, true, true)) {
                        blockValid = false;
                        break;
                    }
                }
                if (blockValid) {
                    hasPhysicalChunk = true;
                }
            } else {
                for (let c = 0; c < numChunks; c++) {
                    if (isChunkValid(t, c, false, true)) {
                        hasPhysicalChunk = true;
                        break;
                    }
                }
            }
            
            if (!hasPhysicalChunk) {
                unobservable.push(t.name);
                return;
            }
            
            // 2. Check scheduling availability (considering reserved)
            let hasAvailChunk = false;
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
                    hasAvailChunk = true;
                }
            } else {
                for (let c = 0; c < numChunks; c++) {
                    if (!reserved.has(c) && isChunkValid(t, c, false)) {
                        hasAvailChunk = true;
                        break;
                    }
                }
            }
            
            if (!hasAvailChunk) {
                initialConflicts.push(t.name);
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
        const conflicts = [...initialConflicts];
        const manuallyScheduled = new Set();
        
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
                    manuallyScheduled.add(t.name);
                } else {
                    conflicts.push(t.name);
                }
            }
        });
        
        let previouslyScheduled = new Set(Object.keys(currentSchedule));
        
        sortedPrios.forEach(prio => {
            const prioTargets = obsTargetsByPrio[prio] || [];
            if (prioTargets.length === 0) return;
            
            // S_active: previously scheduled science targets that are not manual
            const S_active = observable.filter(tg => previouslyScheduled.has(tg.name) && !manuallyScheduled.has(tg.name));
            // new_active: targets of current priority that are not manual
            const new_active = prioTargets.filter(tg => !manuallyScheduled.has(tg.name));
            
            const targetsToSchedule = [...S_active, ...new_active];
            if (targetsToSchedule.length === 0) return;
            
            const S_active_names = new Set(S_active.map(t => t.name));
            const new_active_names = new Set(new_active.map(t => t.name));
            
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
                        if (reserved.has(c) || !isChunkValid(t, c, false)) {
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
                        
                        // Calculate twilight proximity penalty for non-standard targets
                        let twilightDist = 0.0;
                        if (t.priority !== 0.0) {
                            const tEve18 = solarTimes.twilight_evening_18;
                            const tMorn18 = solarTimes.twilight_morning_18;
                            const dists = [];
                            for (let c = s; c < s + durChunks; c++) {
                                const ct = chunkTimes[c];
                                if (ct < tEve18) {
                                    dists.push((tEve18.getTime() - ct.getTime()) / (60 * 1000));
                                } else if (ct > tMorn18) {
                                    dists.push((ct.getTime() - tMorn18.getTime()) / (60 * 1000));
                                } else {
                                    dists.push(0.0);
                                }
                            }
                            dists.sort((a,b)=>a-b);
                            const mIdx = Math.floor(dists.length / 2);
                            twilightDist = dists.length % 2 !== 0 ? dists[mIdx] : (dists[mIdx-1] + dists[mIdx]) / 2.0;
                        }
                        
                        costs[s] = median + 1000.0 * twilightDist;
                    }
                }
                
                validSlots[t.name] = slots;
                airmassCosts[t.name] = costs;
            });
            
            const hasConstraint = {};
            targetsToSchedule.forEach(tg => {
                let hc = false;
                if (tg.schedule_before && tg.schedule_before.length > 0) {
                    hc = true;
                } else {
                    for (let i = 0; i < targetsToSchedule.length; i++) {
                        const other = targetsToSchedule[i];
                        if (other.schedule_before && other.schedule_before.includes(tg.name)) {
                            hc = true;
                            break;
                        }
                    }
                }
                hasConstraint[tg.name] = hc;
            });

            const solverTargets = [...targetsToSchedule].sort((a,b) => {
                const hcA = hasConstraint[a.name] ? 0 : 1;
                const hcB = hasConstraint[b.name] ? 0 : 1;
                if (hcA !== hcB) return hcA - hcB;
                if (a.priority !== b.priority) return a.priority - b.priority;
                return durations[b.name] - durations[a.name];
            });
            
            let bestSchedule = null;
            let bestCost = Infinity;
            let searchIterations = 0;
            const maxSearchIterations = 100000;
            
            function overlap(s1, d1, s2, d2) {
                return !(s1 + d1 <= s2 || s2 + d2 <= s1);
            }
            
            function search(idx, sched, cost) {
                searchIterations++;
                if (searchIterations > maxSearchIterations) {
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
                let sortedSlots;
                const sPrev = currentSchedule[name];
                if (sPrev !== undefined && slots.includes(sPrev)) {
                    const otherSlots = slots.filter(s => s !== sPrev).sort((a,b) => airmassCosts[name][a] - airmassCosts[name][b]);
                    sortedSlots = [sPrev, ...otherSlots];
                } else {
                    sortedSlots = [...slots].sort((a,b) => airmassCosts[name][a] - airmassCosts[name][b]);
                }
                
                for (let i = 0; i < sortedSlots.length; i++) {
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
                        
                        const pObj = targetsList.find(tg => tg.name === pName);
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
                
                // If target is new, we can skip it (with a large penalty)
                if (new_active_names.has(name)) {
                    search(idx + 1, sched, cost + 100000.0);
                }
            }
            
            const initialSchedule = {};
            manuallyScheduled.forEach(name => {
                if (currentSchedule[name] !== undefined) {
                    initialSchedule[name] = currentSchedule[name];
                }
            });
            
            search(0, initialSchedule, 0);
            
            if (bestSchedule !== null) {
                currentSchedule = bestSchedule;
                previouslyScheduled = new Set(Object.keys(currentSchedule));
                new_active.forEach(t => {
                    if (currentSchedule[t.name] === undefined) {
                        conflicts.push(t.name);
                    }
                });
            } else {
                new_active.forEach(t => {
                    conflicts.push(t.name);
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
                end_time: chunkTimes[startIdx + durChunks].toISOString(),
                duration_minutes: durChunks,
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
    
    // Draw restricted pointing regions as grey shading
    const isRealTime = document.getElementById("mode-realtime-btn")?.classList.contains("active");
    let minAlt = 20;
    let maxAlt = 90;
    let minAz = 0;
    let maxAz = 360;
    
    if (isRealTime) {
        minAlt = parseFloat(document.getElementById("rt-alt-limit")?.value) || 20;
        maxAlt = parseFloat(document.getElementById("rt-alt-max")?.value) || 90;
        minAz = parseFloat(document.getElementById("rt-az-min")?.value) || 0;
        maxAz = parseFloat(document.getElementById("rt-az-max")?.value) || 360;
    }
    
    // 1. Altitude < minAlt grey ring
    if (minAlt > 0) {
        const rInner = rMax * ((90 - minAlt) / 90);
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.beginPath();
        ctx.arc(cx, cy, rMax, 0, 2 * Math.PI);
        ctx.arc(cx, cy, rInner, 0, 2 * Math.PI, true);
        ctx.fill();
    }
    
    // 2. Altitude > maxAlt grey circle
    if (maxAlt < 90) {
        const rOuter = rMax * ((90 - maxAlt) / 90);
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.beginPath();
        ctx.arc(cx, cy, rOuter, 0, 2 * Math.PI);
        ctx.fill();
    }
    
    // 3. Azimuth outside [minAz, maxAz] grey sector
    if (minAz > 0 || maxAz < 360) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        const startAngle = (maxAz - 90) * Math.PI / 180;
        const endAngle = (minAz - 90) * Math.PI / 180;
        ctx.arc(cx, cy, rMax, startAngle, endAngle);
        ctx.closePath();
        ctx.fill();
    }

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
