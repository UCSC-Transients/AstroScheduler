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

// Initial Setup on Page Load
document.addEventListener("DOMContentLoaded", () => {
    // Set default date to 2026-06-18 (user's target date)
    document.getElementById("obs-date").value = "2026-06-18";
    
    // Add Event Listeners
    document.getElementById("target-form").addEventListener("submit", handleAddTarget);
    document.getElementById("run-schedule-btn").addEventListener("click", triggerScheduling);
    document.getElementById("load-sample-btn").addEventListener("click", loadSampleTargets);
    document.getElementById("clear-targets-btn").addEventListener("click", clearAllTargets);
    
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
    ];
    saveAndRefresh();
}

function saveAndRefresh() {
    localStorage.setItem("targetPool", JSON.stringify(targetPool));
    renderTargetsTable();
    triggerScheduling();
}


// ==============================================================================
// UI RENDERING HELPERS
// ==============================================================================

function renderTargetsTable() {
    const tbody = document.querySelector("#targets-table tbody");
    if (targetPool.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="text-center">No targets in pool</td></tr>`;
        return;
    }
    
    tbody.innerHTML = targetPool.map(t => {
        return `
            <tr id="target-row-${t.name}" data-target="${t.name}" 
                onmouseenter="highlightTarget('${t.name}')" 
                onmouseleave="unhighlightTarget('${t.name}')" 
                onclick="stickyHighlightTarget('${t.name}')"
                style="cursor: pointer;">
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
                    <input type="text" placeholder="HH:MM" value="${t.manual_start_time || ''}" 
                           onchange="updateTargetField('${t.name}', 'manual_start_time', this.value)" 
                           onclick="event.stopPropagation();" style="width: 75px; font-family: monospace; text-align: center;">
                </td>
                <td>
                    <input type="number" placeholder="min" min="0" value="${t.manual_duration !== null && t.manual_duration !== undefined ? t.manual_duration : ''}" 
                           onchange="updateTargetField('${t.name}', 'manual_duration', this.value)" 
                           onclick="event.stopPropagation();" style="width: 65px; text-align: center;">
                </td>
                <td><span class="status-pill status-unobservable" id="status-${t.name}"><span class="target-status-dot status-dot-standby"></span>Pending</span></td>
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
        t.manual_duration = null;
        t.schedule_before = [];
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
    
    const dateParts = dateStr.split('-');
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);
    
    let date;
    if (tz === 'UTC') {
        date = new Date(Date.UTC(year, month, day, hh, mm));
    } else if (tz === 'browser') {
        date = new Date(year, month, day, hh, mm);
    } else if (tz === 'obs') {
        const temp = new Date(Date.UTC(year, month, day, hh, mm));
        try {
            const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
            const formatted = formatter.format(temp);
            const match = formatted.match(/GMT([-+]\d+)/);
            const offsetHours = match ? parseInt(match[1], 10) : -7;
            date = new Date(Date.UTC(year, month, day, hh - offsetHours, mm));
        } catch (e) {
            date = new Date(Date.UTC(year, month, day, hh + 7, mm));
        }
    } else if (tz && tz.startsWith('UTC')) {
        const offsetStr = tz.replace('UTC', '');
        const offset = parseFloat(offsetStr) || 0;
        date = new Date(Date.UTC(year, month, day, hh - offset, mm));
    } else {
        date = new Date(Date.UTC(year, month, day, hh, mm));
    }
    return date.toISOString();
}

function formatLST(lstVal) {
    if (isNaN(lstVal)) return "";
    const hours = Math.floor(lstVal);
    const mins = Math.floor((lstVal - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} LST`;
}

function changeTimezone(val) {
    currentTimezone = val;
    if (lastScheduleResult) {
        updateScheduleUI(lastScheduleResult);
    }
}

function updateTargetManualStart(name, val) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    
    if (!val.trim()) {
        target.manual_start_time = null;
    } else {
        const dateStr = document.getElementById("obs-date").value;
        const iso = parseTimeInputToISO(val, dateStr, currentTimezone);
        if (iso) {
            target.manual_start_time = iso;
        } else {
            target.manual_start_time = val.trim();
        }
    }
    saveAndRefresh();
}

function updateTargetManualDuration(name, val) {
    const target = targetPool.find(t => t.name === name);
    if (!target) return;
    target.manual_duration = val.trim() ? parseFloat(val) : null;
    saveAndRefresh();
}

// Drag & Drop and Standard Stars
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
    const scheduledNames = currentBlocksList.map(b => b.target_name);
    
    tbody.innerHTML = standardStars.map(s => {
        const isScheduled = scheduledNames.includes(s.name);
        const isDisabled = disabledStandards.has(s.name);
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
        
        return `
            <tr class="${rowClass}">
                <td>
                    <input type="checkbox" ${isDisabled || !isObs ? "" : "checked"} ${checkDisabledAttr} 
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

function toggleStandardUse(name, enabled) {
    if (enabled) {
        disabledStandards.delete(name);
    } else {
        disabledStandards.add(name);
    }
    renderStandardsTable();
    triggerScheduling();
}

function isStandardStarObservable(s, solar_times, observatory) {
    const dec = typeof s.dec === 'number' ? s.dec : parseCoordinate(s.dec, false);
    if (dec < -35.0 || dec > 72.0) return false;
    
    const dateInput = document.getElementById("obs-date").value;
    const dateParts = dateInput.split('-');
    const localNoon = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0);
    const offsetHours = 8.109;
    const utcNoon = new Date(localNoon.getTime() + offsetHours * 60 * 60 * 1000);
    const st = solar_times || getSolarTimesFallback(utcNoon, observatory.lat, observatory.lon, observatory.elevation);
    
    const eveTime = new Date(st.sunset.getTime() + 30 * 60 * 1000);
    const mornTime = new Date(st.sunrise.getTime() - 30 * 60 * 1000);
    
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
        document.querySelectorAll(".real-time-only").forEach(el => el.style.display = "block");
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
        alt_limit
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
        realtime_constraints
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
    lastScheduleResult = result;
    const { blocks, conflicts, unobservable, empty_blocks, moon_info, moon_plot, airmass_plots, solar_times } = result;
    
    document.getElementById("moon-phase-val").innerText = `${(moon_info.phase * 100).toFixed(0)}% illuminated`;
    document.getElementById("moon-ra-val").innerText = moon_info.ra.toFixed(1);
    document.getElementById("moon-dec-val").innerText = moon_info.dec.toFixed(1);
    
    const moonPic = document.getElementById("moon-phase-pic");
    const moonIllum = moon_info.phase;
    moonPic.style.boxShadow = `inset ${32 * (1 - moonIllum)}px 0px 0px rgba(15, 16, 27, 0.95), 0px 0px 15px #e2e8f0`;
    
    targetPool.forEach(t => {
        const statusPill = document.getElementById(`status-${t.name}`);
        if (!statusPill) return;
        
        if (unobservable.includes(t.name)) {
            statusPill.className = "status-pill status-unobservable";
            statusPill.innerHTML = `<span class="target-status-dot status-dot-standby"></span>Unobservable`;
        } else if (conflicts.includes(t.name)) {
            statusPill.className = "status-pill status-conflict";
            statusPill.innerHTML = `<span class="target-status-dot status-dot-standby"></span>Conflict`;
        } else if (blocks.some(b => b.target_name === t.name)) {
            statusPill.className = "status-pill status-scheduled";
            statusPill.innerHTML = `<span class="target-status-dot status-dot-scheduled"></span>Scheduled`;
        } else {
            statusPill.className = "status-pill status-unobservable";
            statusPill.innerHTML = `<span class="target-status-dot status-dot-standby"></span>Standby`;
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
            const startVal = formatTimeForTimezone(b.start_time, currentTimezone);
            const endVal = formatTimeForTimezone(b.end_time, currentTimezone);
            
            const target = targetPool.find(t => t.name === b.target_name);
            
            let timeCell = "";
            let durationCell = "";
            
            if (target) {
                // Science target: editable start time and duration/exposure time
                timeCell = `
                    <div style="display: flex; align-items: center; gap: 4px;" onclick="event.stopPropagation();">
                        <input type="text" value="${startVal}" 
                               onchange="updateTargetManualStart('${b.target_name}', this.value)" 
                               style="width: 55px; font-family: monospace; text-align: center; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: #fff;">
                        <span>- ${endVal}</span>
                    </div>
                `;
                durationCell = `
                    <input type="number" min="5" step="5" value="${b.duration_minutes}" 
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
                </tr>
            `;
        }).join('');
    }
    
    renderTimeline(blocks, solar_times, moon_plot);
    renderAlerts(conflicts, unobservable, empty_blocks, blocks.length);
    renderAirmassChart(airmass_plots, blocks, solar_times, moon_plot);
    drawPolarSkyMap(blocks, targetPool, solar_times);
    renderStandardsTable();
}


// ==============================================================================
// VISUAL TIMELINE BUILDER
// ==============================================================================

function handleTimelineReorder(draggedName, targetName) {
    const draggedTarget = targetPool.find(t => t.name === draggedName);
    if (!draggedTarget) return;
    
    if (!draggedTarget.schedule_before) {
        draggedTarget.schedule_before = [];
    }
    
    const targetIdx = currentBlocksList.findIndex(b => b.target_name === targetName);
    if (targetIdx !== -1) {
        for (let i = targetIdx; i < currentBlocksList.length; i++) {
            const nameToBefore = currentBlocksList[i].target_name;
            if (nameToBefore !== draggedName && !draggedTarget.schedule_before.includes(nameToBefore)) {
                draggedTarget.schedule_before.push(nameToBefore);
            }
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
    
    const nightStart = new Date(new Date(solar_times.sunset).getTime() + 30 * 60 * 1000);
    const nightEnd = new Date(new Date(solar_times.sunrise).getTime() - 30 * 60 * 1000);
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
    
    // 4. Render Axis Ticks (bottom) showing UT and Local
    const axisEl = document.createElement("div");
    axisEl.className = "timeline-axis";
    axisEl.style.position = "relative";
    axisEl.style.height = "26px";
    axisEl.style.width = "100%";
    axisEl.style.marginTop = "4px";
    
    for (let i = 0; i <= 5; i++) {
        const pct = (i / 5) * 100;
        const tickTime = new Date(nightStart.getTime() + (i / 5) * nightDurationMs);
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
    const ctx = document.getElementById("airmassChart").getContext("2d");
    
    if (airmassChart) {
        airmassChart.destroy();
    }
    
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
                y: (p.airmass > 2.5 || p.airmass <= 0) ? null : p.airmass
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
                y: (p.airmass > 2.5 || p.airmass <= 0) ? null : p.airmass
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
                    y: (inRange && p.airmass <= 2.5 && p.airmass > 0) ? p.airmass : null
                };
            });
            
            datasets.push({
                label: `${tName} (Obs Window)`,
                data: scheduledPoints,
                borderColor: color,
                borderWidth: 4,
                fill: false,
                tension: 0.1,
                pointRadius: 0,
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
                
                const top = chartArea.top;
                const height = chartArea.bottom - chartArea.top;
                const startX = dragStart.x;
                const endX = dragEnd.x;
                
                chartCtx.fillRect(startX, top, endX - startX, height);
                chartCtx.strokeRect(startX, top, endX - startX, height);
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
                    bottom: 10
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
                        filter: function(item, chart) {
                            return !item.text.includes("(Night Profile)");
                        }
                    }
                },
                tooltip: {
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
                    max: 2.5,
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
        const x = Math.max(airmassChart.chartArea.left, Math.min(e.clientX - rect.left, airmassChart.chartArea.right));
        dragEnd.x = x;
        
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
    
    const sunset = solarTimes.sunset;
    const sunrise = solarTimes.sunrise;
    const totalDurationMs = sunrise.getTime() - sunset.getTime();
    const numChunks = Math.floor(totalDurationMs / (300 * 1000));
    
    const chunkTimes = [];
    for (let i = 0; i < numChunks; i++) {
        chunkTimes.push(new Date(sunset.getTime() + i * 5 * 60 * 1000));
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
    
    function isChunkValid(t, cIdx) {
        const dt = chunkTimes[cIdx];
        
        // Twilight check
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
        
        // Pointing check
        if (!isShaneVisible(t, dt)) return false;
        
        // Airmass check
        const airmass = getAirmassForTarget(t, dt);
        const limitAirmass = t.high_airmass ? 2.2 : 1.7;
        if (airmass <= 0 || airmass > limitAirmass) return false;
        
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
                if (ct.getUTCHours() === hh && Math.abs(ct.getUTCMinutes() - mm) < 5) {
                    return i;
                }
            }
            for (let i = 0; i < chunkTimes.length; i++) {
                const ct = chunkTimes[i];
                if (ct.getHours() === hh && Math.abs(ct.getMinutes() - mm) < 5) {
                    return i;
                }
            }
        }
        return null;
    }
    
    // Sort and calculate exposures
    const targetExposures = {};
    targets.forEach(t => {
        const sep = getSeparation(t.ra, t.dec, moon.ra, moon.dec);
        targetExposures[t.name] = calculateExposure(t, moon.phase, sep);
    });
    
    // 1. Run preliminary solve to see what gets scheduled and if we need high-airmass calibrations
    const prelimSolve = solveInternal(targets, new Set());
    const scheduledScience = prelimSolve.blocks;
    
    let needHighAirmass = false;
    for (let i = 0; i < scheduledScience.length; i++) {
        if (scheduledScience[i].airmass_median > 1.5) {
            needHighAirmass = true;
            break;
        }
    }
    
    // 2. Determine standard stars twilight slots (restricted to at least 30 minutes after sunset / chunk 6)
    let eveSlot1 = 6;
    let eveSlot2 = 7;
    const brightThreshold = 15.5; // Lick Shane threshold
    
    const scienceStartBlock = scheduledScience.find(b => new Date(b.start_time).getTime() === chunkTimes[0].getTime());
    if (scienceStartBlock) {
        const sciTarget = targets.find(t => t.name === scienceStartBlock.target_name);
        if (sciTarget && sciTarget.magnitude < brightThreshold) {
            eveSlot1 = Math.max(6, Math.ceil(scienceStartBlock.duration_minutes / 5));
            eveSlot2 = eveSlot1 + 1;
        }
    }
    
    let mornSlot2 = numChunks - 7;
    let mornSlot1 = mornSlot2 - 1;
    const scienceEndBlock = scheduledScience.find(b => new Date(b.end_time).getTime() === chunkTimes[numChunks - 1].getTime());
    if (scienceEndBlock) {
        const sciTarget = targets.find(t => t.name === scienceEndBlock.target_name);
        if (sciTarget && sciTarget.magnitude < brightThreshold) {
            mornSlot2 = Math.min(numChunks - 7, numChunks - 1 - Math.ceil(scienceEndBlock.duration_minutes / 5));
            mornSlot1 = mornSlot2 - 1;
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
    
    if (payload.disabled_standards) {
        const disabledSet = new Set(payload.disabled_standards);
        standardsData = standardsData.filter(s => !disabledSet.has(s.name));
    }
    
    const blueStandards = standardsData.filter(s => s.color === 'blue');
    const redStandards = standardsData.filter(s => s.color === 'red');
    
    let bestSelection = null;
    let bestScore = -1.0;
    
    blueStandards.forEach(s_eb => {
        if (!isShaneVisible(s_eb, chunkTimes[eveSlot1])) return;
        const airmass_eb = getAirmassForTarget(s_eb, chunkTimes[eveSlot1]);
        if (airmass_eb > 2.2 || airmass_eb <= 0) return;
        
        redStandards.forEach(s_er => {
            if (!isShaneVisible(s_er, chunkTimes[eveSlot2])) return;
            const airmass_er = getAirmassForTarget(s_er, chunkTimes[eveSlot2]);
            if (airmass_er > 2.2 || airmass_er <= 0) return;
            
            const mornOptions = [[null, null, 0.0, 999.0, 999.0]];
            blueStandards.forEach(s_mb => {
                if (!isShaneVisible(s_mb, chunkTimes[mornSlot1])) return;
                const airmass_mb = getAirmassForTarget(s_mb, chunkTimes[mornSlot1]);
                if (airmass_mb > 2.2 || airmass_mb <= 0) return;
                
                redStandards.forEach(s_mr => {
                    if (!isShaneVisible(s_mr, chunkTimes[mornSlot2])) return;
                    const airmass_mr = getAirmassForTarget(s_mr, chunkTimes[mornSlot2]);
                    if (airmass_mr > 2.2 || airmass_mr <= 0) return;
                    
                    let scoreAdd = 50.0;
                    if (s_mb.quality === 'good') scoreAdd += 10.0;
                    if (s_mr.quality === 'good') scoreAdd += 10.0;
                    mornOptions.push([s_mb, s_mr, scoreAdd, airmass_mb, airmass_mr]);
                });
            });
            
            mornOptions.forEach(([s_mb, s_mr, mornScore, airmass_mb, airmass_mr]) => {
                let score = 100.0 + mornScore;
                if (s_eb.quality === 'good') score += 10.0;
                if (s_er.quality === 'good') score += 10.0;
                
                if (needHighAirmass) {
                    if (s_mb !== null) {
                        const bLow = (airmass_eb < 1.3 || airmass_mb < 1.3);
                        const bHigh = (1.5 <= airmass_eb && airmass_eb <= 2.2) || (1.5 <= airmass_mb && airmass_mb <= 2.2);
                        score += (bLow && bHigh) ? 40.0 : 10.0;
                    } else {
                        if (airmass_eb < 1.3) score += 10.0;
                    }
                    
                    if (s_mr !== null) {
                        const rLow = (airmass_er < 1.3 || airmass_mr < 1.3);
                        const rHigh = (1.5 <= airmass_er && airmass_er <= 2.2) || (1.5 <= airmass_mr && airmass_mr <= 2.2);
                        score += (rLow && rHigh) ? 40.0 : 10.0;
                    } else {
                        if (airmass_er < 1.3) score += 10.0;
                    }
                } else {
                    if (airmass_eb < 1.3) score += 10.0;
                    if (airmass_er < 1.3) score += 10.0;
                    if (s_mb !== null && airmass_mb < 1.3) score += 10.0;
                    if (s_mr !== null && airmass_mr < 1.3) score += 10.0;
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestSelection = [s_eb, s_er, s_mb, s_mr, eveSlot1, eveSlot2, mornSlot1, mornSlot2];
                }
            });
        });
    });
    
    const reservedChunks = new Set();
    const standardBlocks = [];
    
    if (bestSelection !== null) {
        const [s_eb, s_er, s_mb, s_mr, es1, es2, ms1, ms2] = bestSelection;
        
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
            const durChunks = 1; // 5 min block
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
                duration_minutes: durChunks * 5,
                airmass_start: air,
                airmass_end: air,
                airmass_median: air,
                priority: 0.0,
                comment: targetObj.comment
            });
        }
        
        addStandardBlock(s_eb, es1);
        addStandardBlock(s_er, es2);
        if (s_mb !== null) addStandardBlock(s_mb, ms1);
        if (s_mr !== null) addStandardBlock(s_mr, ms2);
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
            durations[t.name] = Math.ceil(targetExps[t.name] / 300);
        });
        
        const unobservable = [];
        const observable = [];
        
        targetsList.forEach(t => {
            let hasAnyValid = false;
            const manualChunk = manualStartChunks[t.name];
            if (manualChunk !== null) {
                if (!reserved.has(manualChunk) && isChunkValid(t, manualChunk)) {
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
        
        sortedPrios.forEach(prio => {
            const prioTargets = obsTargetsByPrio[prio] || [];
            if (prioTargets.length === 0) return;
            
            const targetsToSchedule = [];
            sortedPrios.forEach(p => {
                if (p <= prio) {
                    targetsToSchedule.push(...(obsTargetsByPrio[p] || []));
                }
            });
            
                        const validSlots = {};
            const airmassCosts = {};
            
            targetsToSchedule.forEach(t => {
                const durChunks = durations[t.name];
                
                const manualChunk = manualStartChunks[t.name];
                if (manualChunk !== null) {
                    let blockValid = true;
                    const airmasses = [];
                    for (let c = manualChunk; c < manualChunk + durChunks; c++) {
                        if (c >= numChunks || reserved.has(c) || !isChunkValid(t, c)) {
                            blockValid = false;
                            break;
                        }
                        airmasses.push(getAirmassForTarget(t, chunkTimes[c]));
                    }
                    if (blockValid) {
                        validSlots[t.name] = [manualChunk];
                        airmasses.sort((a,b)=>a-b);
                        const mid = Math.floor(airmasses.length / 2);
                        const median = airmasses.length % 2 !== 0 ? airmasses[mid] : (airmasses[mid-1] + airmasses[mid]) / 2.0;
                        airmassCosts[t.name] = {};
                        airmassCosts[t.name][manualChunk] = median;
                    } else {
                        validSlots[t.name] = [];
                        airmassCosts[t.name] = {};
                    }
                } else {
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
                }
            });
            
            const solverTargets = [...targetsToSchedule].sort((a,b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return durations[b.name] - durations[a.name];
            });
            
            let bestSchedule = null;
            let bestCost = Infinity;
            let searchIterations = 0;
            const maxSearchIterations = 2000;
            
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
                const sortedSlots = [...slots].sort((a,b) => airmassCosts[name][a] - airmassCosts[name][b]);
                
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
                currentSchedule = bestSchedule;
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
                end_time: chunkTimes[startIdx + durChunks].toISOString(),
                duration_minutes: durChunks * 5,
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
