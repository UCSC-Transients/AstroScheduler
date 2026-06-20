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
├── app.py                # Web server application (FastAPI & HTTP server fallback)
├── scheduler.py          # Core Python observation scheduling constraint solver
├── static/
│   ├── app.js            # Frontend application logic and JS solver fallback
│   ├── style.css         # Glassmorphism dark-mode responsive layout styling
│   └── standards.json    # Standard calibration stars database
├── templates/
│   └── index.html        # Main dashboard user interface
├── tests/
│   └── test_scheduler.py # Backend solver unit tests
├── requirements.txt      # Python dependencies list
└── .github/
    └── workflows/        # GitHub Actions continuous integration workflow
```

## Getting Started

### 1. Prerequisites

- Python 3.10+
- Modern Web Browser (Chrome, Firefox, Safari)

### 2. Installation

Clone the repository and install the required dependencies:

```bash
git clone https://github.com/UCSC-Transients/AstroScheduler.git
cd AstroScheduler
pip install -r requirements.txt
```

### 3. Running the Server

Start the web application server:

```bash
python app.py
```

The application will start on `http://127.0.0.1:8000`. If FastAPI/Uvicorn is not present, it automatically falls back to serving via Python's built-in `http.server`.

### 4. Running Tests

Run the automated Python backend unit tests:

```bash
python -m unittest tests/test_scheduler.py
```

---

*Developed for Lick Observatory and the UCSC Transients Group.*
