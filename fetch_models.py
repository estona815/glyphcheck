#!/usr/bin/env python3
"""Fetch only the pinned, free Apache-2.0 English/Korean OCR data.

Existing files must match the whole-file hashes. Never overwrite another copy.
This is an explicit setup step; recognition itself makes no network requests.
"""
import hashlib
import os
from pathlib import Path
import urllib.request

COMMIT = "87416418657359cb625c412a48b6e1d6d41c29bd"
MODELS = {
    "eng.traineddata": (4113088, "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"),
    "kor.traineddata": (1677415, "6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2"),
    "LICENSE": (11358, "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"),
}


def main():
    directory = Path(__file__).resolve().parent / "_runtime/tessdata"
    directory.mkdir(parents=True, exist_ok=True)
    for name, (length, expected_hash) in MODELS.items():
        path = directory / name
        if path.is_symlink():
            raise ValueError("Refusing a model symlink: " + name)
        if path.exists():
            data = path.read_bytes()
            if len(data) != length or hashlib.sha256(data).hexdigest() != expected_hash:
                raise ValueError("Existing model differs; refusing overwrite: " + name)
            print("Verified existing model:", name)
            continue
        url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/" + COMMIT + "/" + name
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(length + 1)
        if len(data) != length or hashlib.sha256(data).hexdigest() != expected_hash:
            raise ValueError("Model download failed integrity check: " + name)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        print("Fetched verified free model:", name)


if __name__ == "__main__":
    main()
