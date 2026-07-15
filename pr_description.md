# Pull Request: Pointing Limits and Alt/Az Plot Shading Fixes

This Pull Request addresses the Hour Angle and pointing limits propagation issue, correctly shading restricted regions on the Alt/Az sky map.

## Resolved Issues and Features

- [x] **Gather real-time constraint parameters**: Updated frontend payload construction to extract and send all 10 real-time constraints from the UI inputs (including dec, alt, az, and asymmetric HA limits) to the backend solver.
- [x] **Local JS solver constraint validation**: Corrected the client-side solver to check asymmetric Hour Angle, Declination, Altitude, and Azimuth constraints.
- [x] **Grid-based shading on Alt/Az plot**: Re-implemented the sky map shading logic to evaluate Dec, HA, Alt, and Az constraints on a 2px grid, rendering accurate grey shaded restricted zones.
- [x] **Test validation**: Verified that all 40 python and browser integration tests pass successfully.

Resolves #68

