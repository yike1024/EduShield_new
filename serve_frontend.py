#!/usr/bin/env python3
"""EduShield 前端代理服务器
- 静态文件服务 (dist/)
- /aisoc-brain/api/* → aisoc-brain (port 6657) /api/*
- /aisoc-pentest/api/* → reasonix API 网关 (port 8787) → 裸 reasonix (8791)
- /aisoc-logaudit/api/* → logaudit (port 8788)
- /api/* → aisoc-brain (port 6657)
"""
import http.server
import urllib.request
import http.client
import os
import sys

PORT = 3000
DIST_DIR = os.path.join(os.path.dirname(__file__), "desktop", "frontend", "dist")

# 路由映射: 前缀 → (目标地址, 是否去除前缀)
# 去除前缀时，目标地址需包含替换后的路径前缀
ROUTES = [
    ("/aisoc-brain/api",    "http://127.0.0.1:6657/api",  True),
    ("/aisoc-pentest/api",  "http://127.0.0.1:8787/api",  True),
    ("/aisoc-logaudit/api", "http://127.0.0.1:8788/api", True),
    ("/api",                "http://127.0.0.1:6657",      False),
]


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 300  # SSE 长连接超时

    def _match_route(self):
        for prefix, target, strip in ROUTES:
            if self.path.startswith(prefix + "/") or self.path == prefix:
                remaining = self.path[len(prefix):] if strip else self.path
                return target + remaining
        return None

    def do_GET(self):
        target = self._match_route()
        if target:
            self._proxy(target)
        else:
            self._serve_static()

    def do_POST(self):
        target = self._match_route()
        if target:
            self._proxy(target, method="POST")
        else:
            self._serve_static()

    def _proxy(self, target_url, method="GET"):
        try:
            from urllib.parse import urlparse
            parsed = urlparse(target_url)
            host = parsed.hostname
            port = parsed.port or 80
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query

            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else None

            conn = http.client.HTTPConnection(host, port, timeout=60)
            headers = {}
            for key, val in self.headers.items():
                if key.lower() not in ("host", "connection"):
                    headers[key] = val
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            content_type = resp.getheader("Content-Type", "")

            # SSE: 流式转发，逐块 flush
            if "text/event-stream" in content_type:
                self.send_response(resp.status)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    chunk = resp.read1(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                conn.close()
                return

            # 普通请求
            data = resp.read()
            conn.close()
            self.send_response(resp.status)
            for key, val in resp.getheaders():
                if key.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(key, val)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(f"Proxy error: {e}".encode())

    def _serve_static(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "":
            path = "/index.html"
        file_path = os.path.join(DIST_DIR, path.lstrip("/"))
        if os.path.isfile(file_path):
            with open(file_path, "rb") as f:
                data = f.read()
            self.send_response(200)
            ext = os.path.splitext(file_path)[1]
            content_types = {
                ".html": "text/html", ".js": "application/javascript",
                ".css": "text/css", ".json": "application/json",
                ".svg": "image/svg+xml", ".png": "image/png",
                ".ico": "image/x-icon", ".woff2": "font/woff2",
            }
            self.send_header("Content-Type", content_types.get(ext, "application/octet-stream"))
            self.send_header("Content-Length", len(data))
            self.end_headers()
            self.wfile.write(data)
        else:
            index_path = os.path.join(DIST_DIR, "index.html")
            if os.path.isfile(index_path):
                with open(index_path, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", len(data))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404)
                self.end_headers()

    def log_message(self, format, *args):
        if "/api/" in str(args[0]) if args else False:
            print(f"[PROXY] {args[0]}")


if __name__ == "__main__":
    print(f"EduShield Frontend Server")
    print(f"  Static: {DIST_DIR}")
    print(f"  Routes:")
    for prefix, target, strip in ROUTES:
        print(f"    {prefix}/* -> {target} {'(strip prefix)' if strip else ''}")
    print(f"  Listening: http://0.0.0.0:{PORT}")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), ProxyHandler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
