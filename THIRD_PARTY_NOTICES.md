# External components

Own interface/Python application code: MIT, [LICENSE](LICENSE).
Own newly written `src/tesseract_ocr.cjs` adapter: Apache-2.0,
[LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt), per that file's SPDX header.

| Component | Version/source | License | Use |
|---|---|---|---|
| Tesseract.js | 7.0.0, https://github.com/naptha/tesseract.js | Apache-2.0 | Local WebAssembly OCR wrapper |
| Tesseract.js-core | 7.0.0, https://github.com/naptha/tesseract.js-core | Apache-2.0 | Existing Tesseract OCR/LSTM engine |
| sharp | 0.35.4, https://github.com/lovell/sharp | Apache-2.0 | Local image metadata/decoding; includes its documented platform dependencies |
| tessdata_fast | commit `87416418657359cb625c412a48b6e1d6d41c29bd`, https://github.com/tesseract-ocr/tessdata_fast | Apache-2.0 | Existing pretrained English/Korean LSTM recognition data |

Models are fetched from their official pinned source by an explicit setup
step, with full-byte hashes. Their upstream Apache-2.0 LICENSE is retained next
to them. The package manager retains the dependency packages' own license and
notice files. SDK binaries, private credentials, previous applications and
personal images are not distributed in this project's source package.

The synthetic demonstration image was newly drawn from fictional text with
system fonts for testing. It contains no real participant or contact data.
The source package does not redistribute system font files.
