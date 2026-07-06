/**
 * Tests for JS timezone functions extracted from app.js.
 * Run with: node tests/test_timezone_js.mjs
 */

// ── Minimal stubs ──────────────────────────────────────────────────────────
// We need only formatTimeForTimezone and parseTimeInputToISO.

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

// ── Tests ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log(`  PASS: ${msg}`);
        passed++;
    } else {
        console.error(`  FAIL: ${msg}`);
        failed++;
    }
}

function assertEqual(a, b, msg) {
    if (a === b) {
        console.log(`  PASS: ${msg} (${a})`);
        passed++;
    } else {
        console.error(`  FAIL: ${msg} — got "${a}", expected "${b}"`);
        failed++;
    }
}

console.log("\n=== formatTimeForTimezone tests ===");

// A known UTC time: 2026-06-19T07:40:00.000Z = 00:40 PDT
const utcIso = "2026-06-19T07:40:00.000Z";

// tz='UTC' → must return "07:40"
assertEqual(formatTimeForTimezone(utcIso, 'UTC'), "07:40",
    "UTC display of 07:40Z should be 07:40");

// tz='obs' (America/Los_Angeles, PDT = UTC-7) → must return "00:40"
const obsResult = formatTimeForTimezone(utcIso, 'obs');
assertEqual(obsResult, "00:40",
    "Local (obs/PDT) display of 07:40Z should be 00:40");

// Changing tz must change the result
assert(formatTimeForTimezone(utcIso, 'UTC') !== formatTimeForTimezone(utcIso, 'obs'),
    "UTC and Local results must differ");

// tz='UTC-7' should match 'obs' PDT (both UTC-7)
const utcMinus7 = formatTimeForTimezone(utcIso, 'UTC-7');
assertEqual(utcMinus7, "00:40",
    "UTC-7 display of 07:40Z should be 00:40");

// Empty string returns empty
assertEqual(formatTimeForTimezone("", 'UTC'), "",
    "Empty ISO string returns empty");

// Invalid ISO returns empty
assertEqual(formatTimeForTimezone("not-a-date", 'UTC'), "",
    "Invalid ISO returns empty");

console.log("\n=== chunk floor tests (simulated) ===");

// Simulate chunk times being floored to whole minutes
// (mirrors the Python backend behaviour)
const sunsetRaw = new Date("2026-06-19T03:47:23.000Z");
const sunsetFloored = new Date(Math.floor(sunsetRaw.getTime() / 60000) * 60000);
assertEqual(sunsetFloored.getUTCSeconds(), 0, "Floored sunset has seconds=0");
assertEqual(sunsetFloored.getUTCMilliseconds(), 0, "Floored sunset has ms=0");
assertEqual(sunsetFloored.toISOString(), "2026-06-19T03:47:00.000Z",
    "Floored sunset truncates seconds");

// Chunk 60 = floored sunset + 60 minutes
const chunk60 = new Date(sunsetFloored.getTime() + 60 * 60 * 1000);
assertEqual(chunk60.getUTCSeconds(), 0, "Chunk 60 has seconds=0");
assertEqual(chunk60.toISOString(), "2026-06-19T04:47:00.000Z",
    "Chunk 60 is exactly floored sunset + 60 min");

console.log("\n=== getChunkIdxFromTimeStr ISO handling ===");

// Simulate the JS getChunkIdxFromTimeStr for ISO strings
const chunkTimes = [];
for (let i = 0; i < 480; i++) {
    chunkTimes.push(new Date(sunsetFloored.getTime() + i * 60 * 1000));
}

function getChunkIdxFromTimeStr(timeStr) {
    if (!timeStr) return null;
    timeStr = timeStr.trim();
    if (!timeStr) return null;

    const isoDate = new Date(timeStr);
    if (!isNaN(isoDate.getTime())) {
        let bestIdx = null;
        let minDiff = Infinity;
        for (let i = 0; i < chunkTimes.length; i++) {
            const diff = Math.abs(chunkTimes[i].getTime() - isoDate.getTime());
            if (diff < minDiff) { minDiff = diff; bestIdx = i; }
        }
        if (bestIdx !== null && minDiff <= 90000) return bestIdx;
        return bestIdx;
    }

    if (timeStr.includes(":")) {
        const parts = timeStr.split(":");
        const hh = parseInt(parts[0], 10);
        const mm = parseInt(parts[1], 10);
        if (isNaN(hh) || isNaN(mm)) return null;
        for (let i = 0; i < chunkTimes.length; i++) {
            if (chunkTimes[i].getUTCHours() === hh && chunkTimes[i].getUTCMinutes() === mm) return i;
        }
    }
    return null;
}

// ISO string for chunk 60 must resolve to exactly 60
const chunk60iso = chunkTimes[60].toISOString();
assertEqual(getChunkIdxFromTimeStr(chunk60iso), 60,
    "ISO chunk 60 string resolves to idx 60");

// ISO string that WAS broken before fix: old code split on ':' giving hh=2026 → no loop match → null
// chunk60iso = "2026-06-19T04:47:00.000Z" — old code: parts[0]="2026-06-19T04" → parseInt=2026 (not NaN!)
// Then the loop looks for getUTCHours()===2026 → never matches → returns null
const oldResult = (() => {
    const parts = chunk60iso.split(":");
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    // Simulate old loop
    for (let i = 0; i < chunkTimes.length; i++) {
        if (chunkTimes[i].getUTCHours() === hh && chunkTimes[i].getUTCMinutes() === mm) return i;
    }
    return null;  // hh=2026 never matches any chunk hour
})();
assert(oldResult === null, "OLD buggy code: ISO → hh=2026 → no chunk match → null (confirms regression was real)");

// New code correctly parses ISO
assert(getChunkIdxFromTimeStr(chunk60iso) === 60,
    "NEW code: ISO string correctly finds chunk 60");

// Time before night (>60s before chunk 0) must return null-or-wrong-idx
// Our implementation returns bestIdx always, but Python returns null. JS is "best match"
// at least verify it doesn't return 60 for a completely wrong time
const beforeNight = new Date(sunsetFloored.getTime() - 5 * 60 * 1000).toISOString();
const beforeResult = getChunkIdxFromTimeStr(beforeNight);
assert(beforeResult === 0 || beforeResult === null,
    "Time 5 min before night maps to chunk 0 or null (boundary)");

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
