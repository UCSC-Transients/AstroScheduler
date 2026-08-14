"""
Web server application for the Astronomical Observation Scheduler.
Provides API endpoints for scheduling and serves static assets.
Supports FastAPI/Uvicorn as primary, and python http.server as fallback.
"""

import os
import json
import datetime
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from scheduler import Observatory, ShaneTelescope, Keck1Telescope, Keck2Telescope, Target, Scheduler

try:
    from fastapi import FastAPI, Request, HTTPException
    from fastapi.responses import JSONResponse, FileResponse
    from fastapi.staticfiles import StaticFiles
    import uvicorn
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False


# ==============================================================================
# SCHEDULING DISPATCHER HANDLER
# ==============================================================================

OBSERVATORIES = {
    'lick': {
        'name': 'Lick Observatory',
        'lat': 37.3414,
        'lon': -121.6429,
        'elevation': 1283,
        'timezone': 'America/Los_Angeles',
        'telescope_class': ShaneTelescope
    },
    'keck1': {
        'name': 'Keck I',
        'lat': 19.8267,
        'lon': -155.4733,
        'elevation': 4123,
        'timezone': 'Pacific/Honolulu',
        'telescope_class': Keck1Telescope
    },
    'keck2': {
        'name': 'Keck II',
        'lat': 19.8267,
        'lon': -155.4733,
        'elevation': 4123,
        'timezone': 'Pacific/Honolulu',
        'telescope_class': Keck2Telescope
    }
}


def run_schedule_logic(data: dict) -> dict:
    """Core request processing for scheduling API."""
    date_str = data.get('date')
    obs_data = data.get('observatory', {})
    targets_data = data.get('targets', [])
    
    if not date_str:
        raise ValueError("Missing 'date' parameter")
        
    date_local = datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
    
    obs_id = obs_data.get('id', 'lick')
    obs_info = OBSERVATORIES.get(obs_id, OBSERVATORIES['lick'])
    
    obs_name = obs_data.get('name', obs_info['name'])
    obs_lat = float(obs_data.get('lat', obs_info['lat']))
    obs_lon = float(obs_data.get('lon', obs_info['lon']))
    obs_elev = float(obs_data.get('elevation', obs_info['elevation']))
    obs_tz = obs_data.get('timezone', obs_info['timezone'])
    telescope = obs_info['telescope_class']()
        
    observatory = Observatory(obs_name, obs_lat, obs_lon, obs_elev, timezone=obs_tz)
    
    instrument = data.get('instrument', 'kast')
    
    disabled_standards = set(data.get('disabled_standards', []))
    selected_standards = data.get('selected_standards', [])
    auto_standards = bool(data.get('auto_standards', True))
    standards_overrides = data.get('standards_overrides')
    rt_constraints = data.get('realtime_constraints', {})
    extinction = float(rt_constraints.get('extinction', 0.0))
    
    mag_limit = rt_constraints.get('mag_limit')
    if mag_limit is not None and mag_limit != "":
        try:
            mag_limit = float(mag_limit)
        except ValueError:
            mag_limit = None
    else:
        mag_limit = None
        
    targets = []
    for t_data in targets_data:
        manual_dur = t_data.get('manual_duration')
        if manual_dur is not None and manual_dur != "":
            try:
                manual_dur = float(manual_dur)
            except ValueError:
                manual_dur = None
        else:
            manual_dur = None
            
        magnitude = float(t_data.get('magnitude'))
        
        # Filter by magnitude limit if specified (compare raw magnitude + extinction for limit)
        if mag_limit is not None and (magnitude + extinction) > mag_limit:
            continue
            
        status = t_data.get('status')
        if status in ["Skipped", "Failed", "Punted", "Observed"]:
            continue

        red_exptime = t_data.get('red_exptime')
        if red_exptime is not None and red_exptime != "":
            try:
                red_exptime = float(red_exptime)
            except ValueError:
                red_exptime = None
        else:
            red_exptime = None

        red_num = t_data.get('red_num')
        if red_num is not None and red_num != "":
            try:
                red_num = int(red_num)
            except ValueError:
                red_num = None
        else:
            red_num = None

        blue_exptime = t_data.get('blue_exptime')
        if blue_exptime is not None and blue_exptime != "":
            try:
                blue_exptime = float(blue_exptime)
            except ValueError:
                blue_exptime = None
        else:
            blue_exptime = None

        blue_num = t_data.get('blue_num')
        if blue_num is not None and blue_num != "":
            try:
                blue_num = int(blue_num)
            except ValueError:
                blue_num = None
        else:
            blue_num = None

        targets.append(Target(
            name=t_data.get('name'),
            ra=t_data.get('ra'),
            dec=t_data.get('dec'),
            magnitude=magnitude,
            priority=float(t_data.get('priority', 1.0)),
            allow_twilight=bool(t_data.get('allow_twilight', False)),
            high_airmass=bool(t_data.get('high_airmass', False)),
            sn_mode=t_data.get('sn_mode', 'normal'),
            comment=t_data.get('comment', ''),
            manual_start_time=t_data.get('manual_start_time'),
            manual_duration=manual_dur,
            schedule_before=t_data.get('schedule_before'),
            status=status,
            red_exptime=red_exptime,
            red_num=red_num,
            blue_exptime=blue_exptime,
            blue_num=blue_num
        ))
        
    scheduler = Scheduler(observatory, telescope, date_local)

    night_start_override = data.get('night_start_override')
    night_end_override = data.get('night_end_override')
    if night_start_override:
        try:
            dt = datetime.datetime.fromisoformat(night_start_override.replace("Z", "+00:00"))
            scheduler.start_night = dt
            scheduler.solar_times['sunset'] = dt
            if scheduler.solar_times['twilight_evening_18'] < dt:
                scheduler.solar_times['twilight_evening_18'] = dt
            if scheduler.solar_times['twilight_evening_12'] < dt:
                scheduler.solar_times['twilight_evening_12'] = dt
        except Exception:
            pass
    if night_end_override:
        try:
            dt = datetime.datetime.fromisoformat(night_end_override.replace("Z", "+00:00"))
            scheduler.end_night = dt
            scheduler.solar_times['sunrise'] = dt
            if scheduler.solar_times['twilight_morning_18'] > dt:
                scheduler.solar_times['twilight_morning_18'] = dt
            if scheduler.solar_times['twilight_morning_12'] > dt:
                scheduler.solar_times['twilight_morning_12'] = dt
        except Exception:
            pass

    if night_start_override or night_end_override:
        # Floor to whole minute for clean block.start_time values
        scheduler.start_night = scheduler.start_night.replace(second=0, microsecond=0)
        scheduler.end_night = scheduler.end_night.replace(second=0, microsecond=0)
        total_seconds = (scheduler.end_night - scheduler.start_night).total_seconds()
        if total_seconds > 0:
            scheduler.num_chunks = int(total_seconds // 60)
            scheduler.chunk_times = [
                scheduler.start_night + datetime.timedelta(minutes=i)
                for i in range(scheduler.num_chunks)
            ]

    return scheduler.solve(
        targets,
        instrument=instrument,
        disabled_standards=disabled_standards,
        selected_standards=selected_standards,
        auto_standards=auto_standards,
        realtime_constraints=rt_constraints,
        standards_overrides=standards_overrides,
        previous_schedule=data.get('previous_schedule')
    )


# ==============================================================================
# FASTAPI SERVER DEFINITION
# ==============================================================================

if HAS_FASTAPI:
    app = FastAPI(title="UCSC AstroScheduler")
    
    @app.post("/api/schedule")
    async def api_schedule(request: Request):
        try:
            data = await request.json()
            print("API REQUEST RECEIVED:", {k: v for k, v in data.items() if k != 'targets'}, flush=True)
            result = run_schedule_logic(data)
            return JSONResponse(content=result)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
            
    @app.get("/")
    async def get_index():
        return FileResponse("templates/index.html")
        
    # Serve static assets
    if os.path.exists("static"):
        app.mount("/static", StaticFiles(directory="static"), name="static")
        
    # Serve templates directly if needed
    if os.path.exists("templates"):
        app.mount("/templates", StaticFiles(directory="templates"), name="templates")


# ==============================================================================
# PURE PYTHON HTTP SERVER FALLBACK
# ==============================================================================

class FallbackHTTPServerHandler(BaseHTTPRequestHandler):
    """Pure Python web server fallback."""
    
    def log_message(self, format, *args):
        # Silence default request logging in console unless needed
        pass
        
    def do_GET(self):
        path = self.path
        if path == "/":
            path = "/templates/index.html"
            
        # Clean path to prevent arbitrary directory traversal
        clean_path = path.lstrip('/')
        if '..' in clean_path or clean_path.startswith('/'):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Bad Request")
            return
            
        if not os.path.exists(clean_path) or os.path.isdir(clean_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            return
            
        self.send_response(200)
        mime_type, _ = mimetypes.guess_type(clean_path)
        if mime_type:
            self.send_header('Content-Type', mime_type)
        self.end_headers()
        
        with open(clean_path, 'rb') as f:
            self.wfile.write(f.read())
            
    def do_POST(self):
        if self.path == "/api/schedule":
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                
                result = run_schedule_logic(data)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'detail': str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")


def run_fallback_server(port: int = 8000):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, FallbackHTTPServerHandler)
    print(f"Fallback HTTP server started on http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()


# ==============================================================================
# MAIN ENTRYPOINT
# ==============================================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8055))
    # Ensure static and templates folders exist
    os.makedirs("static", exist_ok=True)
    os.makedirs("templates", exist_ok=True)
    
    if HAS_FASTAPI:
        print("FastAPI and Uvicorn detected. Launching primary server...")
        # Reload spawns a child process and delays first response; disable on CI/tests.
        reload = (
            os.environ.get("GITHUB_ACTIONS") != "true"
            and os.environ.get("UVICORN_RELOAD", "1").lower() not in ("0", "false", "no")
        )
        uvicorn.run("app:app", host="127.0.0.1", port=port, reload=reload)
    else:
        print("FastAPI or Uvicorn not available. Launching built-in fallback server...")
        run_fallback_server(port)
