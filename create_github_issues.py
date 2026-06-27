#!/usr/bin/env python3
import subprocess
import sys

issues = [
    {"title": "UI: Remove excess left-side padding on dashboard layout", "body": "There is currently a lot of padding/margin on the left side of the page on wide viewports that should be removed to make better use of the screen space."},
    {"title": "UI: Stack UT and Local times vertically on timeline and airmass plot axes", "body": "For the timeline and airmass plots, the UT time should be directly below the plot. The Local time should be directly below the UT time (stacked vertically), not below and slightly to the side."},
    {"title": "Chart: Implement 2D rectangular zoom (Time + Airmass) on airmass plot", "body": "The zoom feature for the airmass plot currently only zooms in time (horizontal). Update the drag handler to allow drawing a rectangle to zoom in both time (X-axis) and airmass (Y-axis) simultaneously."},
    {"title": "UI: Implement status circle indicators in target list", "body": "Implement circle indicators to the left of each target in the target list: green if the target is currently scheduled, and red if it is not scheduled."},
    {"title": "Chart: Apply dynamic maximum airmass limit to airmass plot", "body": "The maximum airmass limit on the y-axis of the airmass plot should be dynamic: the maximum of 1.7 or the highest airmass of any scheduled observation during the night + 0.1."},
    {"title": "Solver: Enforce locked manual start times for target schedule editing", "body": "When a manual start time is entered for an observing block, it should be treated as fixed and scheduled exactly at that time, with the solver scheduling all other blocks around it."},
    {"title": "UI: Prevent observing time column wrapping in schedule table", "body": "The observing time column in the schedule table should always be on exactly one line. Prevent wrapping by adding styling (e.g. white-space: nowrap) and expanding the column if necessary."},
    {"title": "UI: Adjust target name column auto-width in target list", "body": "The target name column in the target list should only expand as large as necessary for the names in the list, capping it (with text-overflow ellipsis) only when a target name is extremely large."},
    {"title": "UI: Reduce column widths for Airmass Range and Median Airmass", "body": "Make the Airmass Range and Median Airmass columns in the schedule table much smaller/narrower to allocate more room for comments."},
    {"title": "UI: Implement sorting for target list columns", "body": "Allow the user to sort the target list by target name, RA, Dec, magnitude, priority, and S/N mode by clicking on the headers."},
    {"title": "UI: Set default target list sorting to Priority then Name", "body": "When first loading the target list, it should be sorted by priority (high to low) and target name (A-Z) by default."},
    {"title": "UI: Standard star checkbox should only be checked if scheduled", "body": "The standard star list checkboxes currently check all available stars. Change it so they are only checked if they are actually used (scheduled) on the night's plan. Unused but observable stars should be unchecked but available."},
    {"title": "Solver: Schedule selected standard stars independently if complete pairs are missing", "body": "If two standard stars for a single twilight are not selected or available, schedule whichever selected/observable standard stars are available rather than failing to schedule any standard stars at all."},
    {"title": "UI: Sort standard stars list by RA", "body": "The standard stars listed in the standard star table should be sorted by Right Ascension (RA)."},
    {"title": "UI: Clicking standard star checkbox should trigger reschedule", "body": "Clicking a checkbox to enable/disable a standard star should immediately trigger a reschedule and update the UI."},
    {"title": "UI: Rename Alt/Az map header to 'Sky Alt/Az Map'", "body": "Change the title of the Alt/Az map from 'Sky Alt/Az Map (Polar)' to 'Sky Alt/Az Map'."},
    {"title": "UI: Rename airmass plot header to 'Airmass'", "body": "Change the title of the airmass plot card from 'Night Airmass Profile (Zenith at Top)' to 'Airmass'."},
    {"title": "UI: Implement collapsible sections/cards", "body": "Make all cards on the dashboard collapsible by implementing the collapse/minimization handler when clicking the minus/plus button on card headers."},
    {"title": "Chart: Format airmass plot legend to display target names as horizontal lines", "body": "Modify the airmass plot legend so that it only lists target names (excluding helper series) and uses horizontal lines instead of colored rectangles as legend icons."},
    {"title": "Chart: Make airmass plot observation lines twice as thick", "body": "Increase the border thickness of active scheduled observation lines on the airmass plot to make them twice as thick (width 8) as they currently are."},
    {"title": "Chart: Position airmass plot tooltips to prevent overlap with lines", "body": "Configure the airmass plot tooltips to hover above the data points with padding so that the tooltip box does not overlap the thick observation lines."},
    {"title": "UI: Remove priority label from timeline block text", "body": "Timeline block bubbles should only display the target name, not its priority (e.g. remove '(P1)' suffix)."},
    {"title": "UI: Display hover tooltip with target name for narrow timeline blocks", "body": "When timeline block bubbles are too narrow to show the target name fully, display a native tooltip with the target name when hovering over them."},
    {"title": "UI: Add Observing Run start/end manual override inputs", "body": "Add controls in the Observing Run configuration to manually override the start and end of the night (either in UT or local time, defaulting to UT) for half-nights or shorter runs."},
    {"title": "UI: Rename Observatory Config card to 'Observing Run'", "body": "Change the header name of 'Observatory & Date Config' to 'Observing Run'."},
    {"title": "UI: Clean up layout alignment and unnecessary text", "body": "Remove any leftover debugging/warning texts at the top, align table cells, and clean up padding to polish the visual design of the dashboard."},
    {"title": "Solver: Separate physical unobservability from reserved-chunk conflicts", "body": "Targets that are physically visible but blocked by standard star twilight/night reservations were marked as 'Unschedulable' (red and disabled in UI) instead of 'Not Scheduled' (orange/conflict)."},
    {"title": "Solver: Optimize Branch and Bound search by precomputing suffix min costs", "body": "Precompute static target minimum costs (suffix_min_costs) to perform O(1) bounds checks instead of loops, resulting in a 1000x speedup per search node."},
    {"title": "Solver: Increase max search iterations to 300,000", "body": "Increase max_search_iterations to allow the solver to search deeply and satisfy constraints without aborting and dropping targets."},
    {"title": "UI: Restrict standard star checkbox observability limits", "body": "Checkboxes for standard stars in the UI should only allow checking stars that are visible in the twilight-bounded interval (sunset + 30m to sunrise - 30m) to match the backend constraints."},
    {"title": "UI: Set Mode nearest and Intersect false on Airmass Chart tooltip", "body": "Airmass plot tooltip displays too many labels, making the hovered target unreadable. Set mode nearest to only show the hovered series."},
    {"title": "UI: Shift target locks on Observing Date changes", "body": "When the date is changed in the observing date picker, shift all target start/end locks by the date delta to keep them on the current night's schedule."}
]

for idx, issue in enumerate(issues, 1):
    print(f"Creating issue {idx}/{len(issues)}: {issue['title']}...")
    cmd = ["/opt/local/bin/gh", "issue", "create", "--title", issue["title"], "--body", issue["body"]]
    try:
        subprocess.run(cmd, check=True)
    except Exception as e:
        print(f"Failed to create issue: {e}")
        sys.exit(1)

print("All issues created successfully!")
