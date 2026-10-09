# GlyphCheck · 줄대조

A local tool for proofreading OCR against the original printed-text image.
Open a Korean/English PNG or JPEG, run actual OCR, compare each recognized line
with its approximate source region, correct the text, mark it reviewed and
export TXT plus a JSON record that retains the original OCR and your edits.

## The problem

An OCR result can look plausible while losing punctuation, spaces or letters.
Copying the result into another editor separates it from the original image.
GlyphCheck keeps the image, recognition and explicit review state together so
a person can inspect and correct the result before using it.

## AI and workflow

The open-source runtime uses **Tesseract.js 7.0.0**, its Tesseract LSTM OCR engine
and the pretrained English/Korean `tessdata_fast` models. It runs on the local
CPU. The project does not train those models or generate confidence scores.
Line scores come from the real engine and are normalized from 0–100 to 0–1.
They prioritize review; they do not certify that text is correct.

1. Open your own PNG/JPEG or run the explicitly synthetic demonstration.
2. Inspect the recognized lines in the OCR engine's returned order.
3. Select a line to show a padded, approximate region on the original image.
4. Edit the text and mark that line reviewed. Editing clears its reviewed flag.
5. Export every line in that engine order as TXT, and an audit JSON containing
   original/edited text, confidence, source hash and reviewed status.

The tool does not autonomously correct spelling or certify factual accuracy.
Tesseract does not return alternate text candidates through this adapter, so
no alternatives are invented. The synthetic image is test material, not a
real user's document or evidence of a field study.

## Run locally

Requirements: Python 3.9+, Node.js **22+** and a current supported operating
system with the normal `sharp` platform package. These are free local tools;
there is no API key, card, cloud account or metered inference service.

```sh
npm install
python3 fetch_models.py
python3 server.py
```

Open `http://127.0.0.1:8765`. The setup step downloads only the pinned free
Apache-2.0 English/Korean model files and verifies their complete SHA-256 hashes.
Existing matching files are reused; mismatches cause an error, not an overwrite.
After setup, OCR needs no network connection. The HTTP service binds only to
`127.0.0.1`, checks its localhost host/origin and serves a fixed list of UI files.
Uploaded image bytes pass in memory to the OCR process, are not written to disk,
and are not logged. The original file is never modified. Exported files are
saved by your browser at your request. No external fonts, scripts, analytics
or fallback AI APIs are loaded.

If Node or installed modules are outside the default PATH, pass the executable
and module directory explicitly:

```sh
python3 server.py --node /path/to/node --module-dir /path/to/node_modules
```

## Limits

- PNG/JPEG, at most **10 MiB** and **16 megapixels**; a single image per request.
- Korean/English printed text is the intended use. Handwriting, complex
  columns, small or blurred print and other languages can fail or be reordered.
- Confidence and bounding boxes are approximate guides. Always inspect the
  original yourself, including high-confidence lines.
- Rotated EXIF images are accepted only if the selected runtime explicitly
  normalizes them; otherwise the error asks you to export an upright image.
- A process handles one recognition request at a time. OCR has a bounded
  timeout; failures are visible, with no fabricated fallback result.
- This is a proofreading prototype, not a medical, legal, eligibility or
  identity decision system. It makes no accuracy or award guarantee.

## Validation

```sh
python3 tests/test_http.py --node /path/to/node --module-dir /path/to/node_modules
```

The integration suite exercises real OCR on the fresh synthetic sample and
blank image, explicit image errors, local-origin/host protection, private-route
denial and bounded coordinate/confidence output. Browser checks cover source
guides, edits, review filters and real TXT/JSON downloads. Detailed observed
results are kept with this submission's review artifacts; no user survey,
interview or broad accuracy benchmark is claimed.

## Credits, creation and license

Participant: **권준**, working solo. The application code, interface and test
fixtures were newly written during this hackathon's current submission window.
Codex AI assisted the design, implementation, documentation and tests. No AI
agent is listed as a human teammate, and no previous personal application code
or contest work is reused.

The interface, Python bridge and other application source are MIT licensed;
the freshly written `src/tesseract_ocr.cjs` adapter is Apache-2.0, as its SPDX
header states. Tesseract.js, Tesseract.js-core,
`sharp` and the official `tessdata_fast` data are external Apache-2.0 components;
their models and recognition implementation are not this project's invention.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[the pinned model source lock](docs/opensource-model-source-lock.json).

An early local feasibility test used the installed Apple Vision runtime.
That experimental helper and Apple SDK/model assets are not part of the
open-source competition runtime or redistributed submission package.
