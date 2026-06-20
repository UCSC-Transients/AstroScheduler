# Pull Request: AstroScheduler Dashboard Refinements and Feature Enhancements

This Pull Request addresses the layout, visualization, and scheduling logic issues requested for the UCSC Shane Telescope Dashboard.

## Resolved Issues

- [x] #1 UI: Remove excess left-side padding on dashboard layout
- [x] #2 UI: Stack UT and Local times vertically on timeline and airmass plot axes
- [x] #3 Chart: Implement 2D rectangular zoom (Time + Airmass) on airmass plot
- [x] #4 UI: Implement status circle indicators in target list
- [x] #5 Chart: Apply dynamic maximum airmass limit to airmass plot
- [x] #6 Solver: Enforce locked manual start times for target schedule editing
- [x] #7 UI: Prevent observing time column wrapping in schedule table
- [x] #8 UI: Adjust target name column auto-width in target list
- [x] #9 UI: Reduce column widths for Airmass Range and Median Airmass
- [x] #10 UI: Implement sorting for target list columns
- [x] #11 UI: Set default target list sorting to Priority then Name
- [x] #12 UI: Standard star checkbox should only be checked if scheduled
- [x] #13 Solver: Schedule selected standard stars independently if complete pairs are missing
- [x] #14 UI: Sort standard stars list by RA
- [x] #15 UI: Clicking standard star checkbox should trigger reschedule
- [x] #16 UI: Rename Alt/Az map header to 'Sky Alt/Az Map'
- [x] #17 UI: Rename airmass plot header to 'Airmass'
- [x] #18 UI: Implement collapsible sections/cards
- [x] #19 Chart: Format airmass plot legend to display target names as horizontal lines
- [x] #20 Chart: Make airmass plot observation lines twice as thick
- [x] #21 Chart: Position airmass plot tooltips to prevent overlap with lines
- [x] #22 UI: Remove priority label from timeline block text
- [x] #23 UI: Display hover tooltip with target name for narrow timeline blocks
- [x] #24 UI: Add Observing Run start/end manual override inputs
- [x] #25 UI: Rename Observatory Config card to 'Observing Run'
- [x] #26 UI: Clean up layout alignment and unnecessary text

## Verification
- Running backend tests.
- Visual inspection of the dashboard layout, charts, and interactive functionalities.
