import http.server
import os


class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        if self.server.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/")
        elif self.server.mode == "foreign":
            self.send_response(204)
        elif self.server.mode == "key" and self.headers.get("Authorization") != "Bearer " + "a" * 32:
            self.send_response(403)
        else:
            self.send_response(204)
            self.send_header("x-delegatus-diagnostics", "1")
        self.end_headers()

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
server.mode = os.environ["PROBE_MODE"]
print(server.server_port, flush=True)
server.serve_forever()
