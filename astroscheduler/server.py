"""
Web server application for the Astronomical Observation Scheduler.
Provides API endpoints for scheduling and serves static assets.
Supports FastAPI/Uvicorn as primary, and python http.server as fallback.
"""

import os
import json
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from . import api, frontend, yse_pz
from .core import use_offline_iers_globally

# The standalone app owns its process, so it may set astropy's IERS options globally.
use_offline_iers_globally()

# Front-end files ship inside the package, so the server works from any working directory.
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(PACKAGE_DIR, "static")
TEMPLATES_DIR = os.path.join(PACKAGE_DIR, "templates")

try:
    from fastapi import FastAPI, Request, HTTPException
    from fastapi.responses import HTMLResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles
    import uvicorn
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False


# ==============================================================================
# SCHEDULING DISPATCHER HANDLER
# ==============================================================================

# The solver API lives in astroscheduler.api; these names are kept for existing callers.
OBSERVATORIES = api.OBSERVATORIES
run_schedule_logic = api.solve_dict


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
            
    @app.post("/api/yse_pz/{action}")
    async def api_yse_pz(action: str, request: Request):
        # The body carries the user's YSE_PZ token: never log it.
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        status, body = yse_pz.handle(action, payload)
        return JSONResponse(content=body, status_code=status)

    @app.get("/")
    async def get_index():
        return HTMLResponse(frontend.render_page("/static"))

    # Serve static assets
    if os.path.exists(STATIC_DIR):
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


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
            page = frontend.render_page("/static").encode("utf-8")
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(page)
            return
        if not path.startswith("/static/"):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            return

        # Clean path to prevent arbitrary directory traversal
        clean_path = path.lstrip('/')
        if '..' in clean_path or clean_path.startswith('/'):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Bad Request")
            return
            
        clean_path = os.path.join(PACKAGE_DIR, clean_path)
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
            
    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode('utf-8'))

    def do_POST(self):
        if self.path.startswith("/api/yse_pz/"):
            # The body carries the user's YSE_PZ token: never log it.
            try:
                length = int(self.headers.get('Content-Length') or 0)
                payload = json.loads(self.rfile.read(length).decode('utf-8') or "{}")
            except (ValueError, UnicodeDecodeError):
                payload = {}
            self._send_json(*yse_pz.handle(self.path[len("/api/yse_pz/"):], payload))
            return
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

def main():
    port = int(os.environ.get("PORT", 8055))

    if HAS_FASTAPI:
        print("FastAPI and Uvicorn detected. Launching primary server...")
        # Reload spawns a child process and delays first response; disable on CI/tests.
        reload = (
            os.environ.get("GITHUB_ACTIONS") != "true"
            and os.environ.get("UVICORN_RELOAD", "1").lower() not in ("0", "false", "no")
        )
        uvicorn.run("astroscheduler.server:app", host="127.0.0.1", port=port, reload=reload)
    else:
        print("FastAPI or Uvicorn not available. Launching built-in fallback server...")
        run_fallback_server(port)


if __name__ == "__main__":
    main()
