# UCSC AstroScheduler

UCSC AstroScheduler is a modern, real-time observation scheduling and planning dashboard designed specifically for the **Lick Shane 3m Telescope**. It combines a high-performance Python constraint solver backend with a rich, glassmorphic web dashboard frontend, providing observers with interactive sky visualizations, real-time target status tracking, and automated calibration star sequencing.

## Features

- **Dynamic Sky Map (Alt/Az Polar Plot)**: Live circular canvas rendering showing current target tracks across the sky (Zenith to Horizon) mapped with corresponding priority colors.
- **Double-Axis Airmass Chart**: Interactive airmass curves showing targets throughout the night, with a secondary top axis for **Local Sidereal Time (LST)** and dual **UT/Local** labels at the bottom.
- **Target Ingestion & Management**: Easily drag-and-drop or select target coordinate text files, with support for sexagesimal formats (`HH:MM:SS`, `DD:MM:SS`) and magnitude/priority float fields.
- **Standard Stars Calibration**: Automatically selects and schedules optimal blue and red standard stars (constrained to at least 30 minutes after sunset / before sunrise) to match the science target requirements.
- **Real-Time Observing Mode**: Reschedule blocks on the fly "starting from now" with active pointing checks, HA limits (East: -05:40, West: +03:45), and live electronic log comments.
- **Client-Side Solver Fallback**: Full client-side JavaScript implementation of the solver ensures the dashboard remains 100% functional even when the Python server is offline.

## Repository Layout

```
├── astroscheduler/       # The installable package
│   ├── core.py           # Observation scheduling constraint solver (no web dependencies)
│   ├── server.py         # Web server application (FastAPI & HTTP server fallback)
│   ├── static/
│   │   ├── app.js        # Frontend application logic and JS solver fallback
│   │   ├── style.css     # Glassmorphism dark-mode responsive layout styling
│   │   └── standards.json # Standard calibration stars database
│   └── templates/
│       └── index.html    # Main dashboard user interface
├── app.py                # `python app.py` entry point (runs astroscheduler.server)
├── scheduler.py          # Compatibility alias for astroscheduler.core
├── tests/
│   └── test_scheduler.py # Backend solver unit tests
├── pyproject.toml        # Package metadata and dependencies
├── requirements.txt      # Development install (package + server + test tools)
└── .github/
    └── workflows/        # GitHub Actions continuous integration workflow
```

## Getting Started

### 1. Prerequisites

- Python 3.8+ for the solver library; the web app and browser tests are tested on 3.10 and 3.11
- Modern Web Browser (Chrome, Firefox, Safari)

### 2. Installation

Clone the repository and install the required dependencies:

```bash
git clone https://github.com/UCSC-Transients/AstroScheduler.git
cd AstroScheduler
pip install -r requirements.txt
```

`requirements.txt` installs the package in editable mode with the `server` and `test` extras.

To use only the solver as a library (for example from another web app), install the package
without extras. It needs only astropy, astroplan, numpy and pytz:

```bash
pip install "astroscheduler @ git+https://github.com/UCSC-Transients/AstroScheduler@<tag>"
```

Add the `server` extra (`astroscheduler[server]`) for the standalone web app.

### 3. Running the Server

Start the web application server:

```bash
python app.py
```

The application will start on `http://127.0.0.1:8055` (set `PORT` to change it). If FastAPI/Uvicorn is not present, it automatically falls back to serving via Python's built-in `http.server`.

### 4. Running Tests

Run the automated Python backend unit tests:

```bash
PYTHONPATH=. pytest tests/test_scheduler.py tests/test_kast_exposures.py
```

`PYTHONPATH=. pytest` runs everything, including the Playwright browser tests
(`python -m playwright install chromium` first).

---

*Developed for Lick Observatory and the UCSC Transients Group.*
