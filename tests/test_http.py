"""Exercise the real local HTTP bridge with synthetic images only."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("glyphcheck_server", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class LocalBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = SERVER.ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        cls.server.ocr_engine = "tesseract"
        cls.server.ocr_command = [OPTIONS.node, str(ROOT / "src/tesseract_ocr.cjs"), "--stdin"]
        cls.server.ocr_environment = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL") if key in os.environ}
        if OPTIONS.module_dir:
            cls.server.ocr_environment["GLYPHCHECK_NODE_MODULES"] = OPTIONS.module_dir
        cls.origin = "http://127.0.0.1:" + str(cls.server.server_port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def request(self, path, body=None, headers=None):
        request = urllib.request.Request(self.origin + path, data=body, headers=headers or {})
        try:
            response = urllib.request.urlopen(request, timeout=55)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def recognize(self, data):
        status, headers, body = self.request("/api/recognize", data, {"Origin": self.origin, "Content-Type": "image/png"})
        return status, headers, json.loads(body)

    def test_actual_synthetic_image_runs_open_source_ocr(self):
        status, _, value = self.recognize((ROOT / "demo/synthetic-printed.png").read_bytes())
        self.assertEqual(status, 200)
        self.assertEqual(value["engine"], "Tesseract.js")
        self.assertEqual((value["width"], value["height"]), (1400, 900))
        self.assertGreaterEqual(len(value["lines"]), 3)
        self.assertTrue(any(any("가" <= character <= "힣" for character in line["text"]) for line in value["lines"]))
        self.assertTrue(any(any("A" <= character <= "Z" for character in line["text"]) for line in value["lines"]))
        self.assertEqual(SERVER.validate_result(value), value)

    def test_blank_image_returns_no_text_without_inventing_candidates(self):
        status, _, value = self.recognize((ROOT / "demo/blank.png").read_bytes())
        self.assertEqual(status, 200)
        self.assertEqual(value["lines"], [])

    def test_disguised_image_is_rejected(self):
        status, _, value = self.recognize(b"This is text, not an image")
        self.assertEqual(status, 415)
        self.assertEqual(value["code"], "signature")

    def test_corrupt_png_is_an_explicit_runtime_error(self):
        status, _, value = self.recognize(b"\x89PNG\r\n\x1a\ncorrupt synthetic test")
        self.assertEqual(status, 422)
        self.assertEqual(value["schema"], "glyphcheck.error/v1")

    def test_cross_origin_cannot_start_ocr(self):
        status, _, body = self.request("/api/recognize", b"tiny", {"Origin": "https://unrelated.example", "Content-Type": "image/png"})
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["code"], "origin")

    def test_rebound_host_cannot_read_local_files(self):
        status, _, body = self.request("/health", headers={"Host": "unrelated.example"})
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["code"], "host")

    def test_private_source_and_runtime_are_not_static_routes(self):
        for route in ("/server.py", "/src/tesseract_ocr.cjs", "/_runtime/tessdata/eng.traineddata", "/../README.md"):
            with self.subTest(route=route):
                status, _, _ = self.request(route)
                self.assertEqual(status, 404)

    def test_result_coordinates_and_scores_must_be_finite(self):
        value = {"schema": "glyphcheck.ocr/v1", "width": 100, "height": 100, "engine": "Tesseract.js", "lines": [{"id": "line-1", "text": "Synthetic", "confidence": float("nan"), "bbox": {"x": 0, "y": 0, "width": 1, "height": 1}, "alternatives": []}]}
        with self.assertRaises(ValueError):
            SERVER.validate_result(value)
        value["lines"][0]["confidence"] = 0.5
        value["lines"][0]["bbox"]["x"] = 0.5
        with self.assertRaises(ValueError):
            SERVER.validate_result(value)

    def test_local_only_browser_policy(self):
        status, headers, _ = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--module-dir")
    OPTIONS, remaining = parser.parse_known_args()
    unittest.main(argv=[__file__] + remaining, verbosity=2)
