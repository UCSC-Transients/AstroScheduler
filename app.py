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
from scheduler import Observatory, ShaneTelescope, Target, Scheduler

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

def run_schedule_logic(data: dict) -> dict:
    """Core request processing for scheduling API."""
    date_str = data.get('date')
    obs_data = data.get('observatory', {})
    targets_data = data.get('targets', [])
    
    if not date_str:
        raise ValueError("Missing 'date' parameter")
        
    date_local = datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
    
    obs_name = obs_data.get('name', 'Lick Observatory')
    obs_lat = float(obs_data.get('lat', 37.3414))
    obs_lon = float(obs_data.get('lon', -121.6429))
    obs_elev = float(obs_data.get('elevation', 1283))
    
    # ShaneTelescope is our default
    observatory = Observatory(obs_name, obs_lat, obs_lon, obs_elev)
    telescope = ShaneTelescope()
    
    disabled_standards = set(data.get('disabled_standards', []))
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
        # Apply real-time extinction offset to magnitude
        magnitude += extinction
        
        # Filter by magnitude limit if specified
        if mag_limit is not None and magnitude > mag_limit:
            continue
            
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
            schedule_before=t_data.get('schedule_before')
        ))
        
    scheduler = Scheduler(observatory, telescope, date_local)
    return scheduler.solve(targets, disabled_standards=disabled_standards, realtime_constraints=rt_constraints)


# ==============================================================================
# FASTAPI SERVER DEFINITION
# ==============================================================================

if HAS_FASTAPI:
    app = FastAPI(title="UCSC AstroScheduler")
    
    @app.post("/api/schedule")
    async def api_schedule(request: Request):
        try:
            data = await request.json()
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
    port = 8000
    # Ensure static and templates folders exist
    os.makedirs("static", exist_ok=True)
    os.makedirs("templates", exist_ok=True)
    
    if HAS_FASTAPI:
        print("FastAPI and Uvicorn detected. Launching primary server...")
        uvicorn.run("app:app", host="127.0.0.1", port=port, reload=True)
    else:
        print("FastAPI or Uvicorn not available. Launching built-in fallback server...")
        run_fallback_server(port)
