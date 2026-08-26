# -*- coding: utf-8 -*-
"""Serveur de dev sans cache (les .js édités doivent être rechargés à chaque fois)."""
import http.server, functools, os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("127.0.0.1", 8757), NoCacheHandler).serve_forever()
