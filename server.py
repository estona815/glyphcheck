#!/usr/bin/env python3
"""Local-only HTTP bridge to the open-source Tesseract OCR runtime.

Input image bytes travel through stdin. No uploaded images or recognized text
are written to disk or request logs. This server does not access a cloud API.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import threading
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024
INFERENCE_LOCK = threading.Lock()
STATIC = {
    "/": (ROOT / "web/index.html", "text/html; charset=utf-8"),
    "/styles.css": (ROOT / "web/styles.css", "text/css; charset=utf-8"),
    "/app.js": (ROOT / "web/app.js", "text/javascript; charset=utf-8"),
    "/demo.png": (ROOT / "demo/synthetic-printed.png", "image/png"),
}


def validate_result(value):
    """Reject malformed runtime output before the browser trusts coordinates."""
    if not isinstance(value, dict) or value.get("schema") != "glyphcheck.ocr/v1":
        raise ValueError("OCR returned an unexpected result format.")
    for dimension in ("width", "height"):
        if type(value.get(dimension)) is not int or not 0 < value[dimension] <= 16000:
            raise ValueError("OCR returned invalid image dimensions.")
    if value["width"] * value["height"] > 16_000_000:
        raise ValueError("Image exceeds the 16 megapixel limit.")
    if value.get("engine") not in ("Apple Vision", "Tesseract.js"):
        raise ValueError("OCR engine does not match this local build.")
    lines = value.get("lines")
    if not isinstance(lines, list) or len(lines) > 2000:
        raise ValueError("OCR returned too many lines.")
    ids = set()
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("text"), str):
            raise ValueError("OCR returned an invalid text line.")
        if not isinstance(line.get("id"), str) or line["id"] in ids:
            raise ValueError("OCR returned invalid line identifiers.")
        ids.add(line["id"])
        if len(line["text"]) > 16384:
            raise ValueError("OCR text line is too long.")
        score = line.get("confidence")
        if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("OCR returned an invalid confidence value.")
        box = line.get("bbox")
        if not isinstance(box, dict):
            raise ValueError("OCR returned an invalid visual guide.")
        for key in ("x", "y", "width", "height"):
            number = box.get(key)
            if not isinstance(number, (int, float)) or not math.isfinite(number) or not 0 <= number <= 1:
                raise ValueError("OCR visual guide falls outside the image.")
        if box["x"] + box["width"] > 1.001 or box["y"] + box["height"] > 1.001:
            raise ValueError("OCR visual guide falls outside the image.")
        alternatives = line.get("alternatives", [])
        if not isinstance(alternatives, list) or len(alternatives) > 3:
            raise ValueError("OCR returned invalid alternative candidates.")
        for alternate in alternatives:
            if not isinstance(alternate, dict) or not isinstance(alternate.get("text"), str):
                raise ValueError("OCR returned an invalid alternative candidate.")
            confidence = alternate.get("confidence")
            if not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
                raise ValueError("OCR returned an invalid alternative confidence.")
    return value


class Handler(BaseHTTPRequestHandler):
    server_version = "GlyphCheck/0.1"

    def log_message(self, format_string, *args):
        # Private filenames, OCR text and image bytes must not become logs.
        pass

    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def json_response(self, status, value):
        self.respond(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))

    def error(self, status, code, message):
        self.json_response(status, {"schema": "glyphcheck.error/v1", "code": code, "message": message})

    def allowed_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in ("127.0.0.1:" + str(port), "localhost:" + str(port))

    def do_GET(self):
        if not self.allowed_host():
            return self.error(403, "host", "Use this computer's localhost URL.")
        path = urlsplit(self.path).path
        if path == "/health":
            command = self.server.ocr_command
            return self.json_response(200, {"schema": "glyphcheck.health/v1", "local_only": True, "engine": self.server.ocr_engine, "executable_present": Path(command[0]).is_file(), "adapter_present": Path(command[1]).is_file() if self.server.ocr_engine == "tesseract" else Path(command[0]).is_file(), "note": "File presence only; actual recognition is verified by the real demo and tests."})
        asset = STATIC.get(path)
        if asset is None:
            return self.error(404, "route", "That local route does not exist.")
        filename, mime = asset
        if not filename.is_file() or filename.is_symlink():
            return self.error(503, "asset", "The local app is still being prepared.")
        return self.respond(200, filename.read_bytes(), mime)

    def do_POST(self):
        if not self.allowed_host():
            return self.error(403, "host", "Use this computer's localhost URL.")
        expected_origin = "http://" + self.headers["Host"]
        if self.headers.get("Origin") != expected_origin:
            return self.error(403, "origin", "Only this local app may run OCR.")
        if urlsplit(self.path).path != "/api/recognize":
            return self.error(404, "route", "That local route does not exist.")
        if self.headers.get("Transfer-Encoding"):
            return self.error(400, "length", "Send one image with a bounded content length.")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.error(411, "length", "The image length is required.")
        if not 0 < length <= MAX_IMAGE_BYTES:
            return self.error(413, "size", "Choose a PNG/JPEG image of 10 MiB or less.")
        mime = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if mime not in ("image/png", "image/jpeg"):
            return self.error(415, "type", "This version accepts PNG and JPEG images.")
        self.connection.settimeout(15)
        try:
            body = self.rfile.read(length)
        except OSError:
            return self.error(408, "timeout", "The local image transfer timed out.")
        if len(body) != length:
            return self.error(400, "truncated", "The image transfer was incomplete.")
        is_png = body.startswith(b"\x89PNG\r\n\x1a\n")
        is_jpeg = body.startswith(b"\xff\xd8\xff")
        if (mime == "image/png" and not is_png) or (mime == "image/jpeg" and not is_jpeg):
            return self.error(415, "signature", "The image bytes do not match PNG/JPEG.")
        command = self.server.ocr_command
        if not Path(command[0]).is_file() or Path(command[0]).is_symlink():
            return self.error(503, "runtime", "Prepare the local OCR runtime first.")
        if not INFERENCE_LOCK.acquire(blocking=False):
            return self.error(429, "busy", "Another image is being recognized. Try after it finishes.")
        try:
            result = subprocess.run(command, input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, cwd=str(ROOT), env=self.server.ocr_environment)
            if len(result.stdout) > MAX_RESULT_BYTES:
                return self.error(502, "result", "OCR produced an oversized result.")
            try:
                value = json.loads(result.stdout)
            except (ValueError, UnicodeDecodeError):
                return self.error(502, "result", "OCR returned an unreadable result.")
            if result.returncode != 0:
                if isinstance(value, dict) and value.get("schema") == "glyphcheck.error/v1" and isinstance(value.get("message"), str):
                    return self.error(422, "recognition", value["message"][:600])
                return self.error(422, "recognition", "The local OCR engine could not read this image.")
            return self.json_response(200, validate_result(value))
        except subprocess.TimeoutExpired:
            return self.error(504, "timeout", "OCR timed out. Try a smaller image.")
        except (OSError, ValueError):
            return self.error(502, "runtime", "The local OCR result could not be validated.")
        finally:
            INFERENCE_LOCK.release()


def main():
    parser = argparse.ArgumentParser(description="Run GlyphCheck on this computer; no cloud API.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--engine", choices=("tesseract", "vision"), default="tesseract")
    parser.add_argument("--node", help="Node executable; defaults to node on PATH")
    parser.add_argument("--module-dir", help="Optional existing node_modules directory")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be 1024–65535")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.ocr_engine = args.engine
    # Give the known runtime only the language/module paths and ordinary OS
    # process values it needs; do not copy authentication variables into it.
    server.ocr_environment = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL") if key in os.environ}
    if args.engine == "tesseract":
        node_path = args.node or shutil.which("node")
        if not node_path or not Path(node_path).is_file():
            parser.error("Node.js 22+ is required for the open-source OCR runtime")
        server.ocr_command = [node_path, str(ROOT / "src/tesseract_ocr.cjs"), "--stdin"]
        if args.module_dir:
            server.ocr_environment["GLYPHCHECK_NODE_MODULES"] = str(Path(args.module_dir).resolve())
    else:
        server.ocr_command = [str(ROOT / "_runtime/vision-ocr"), "--stdin"]
    print("GlyphCheck local tool: http://127.0.0.1:" + str(args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
