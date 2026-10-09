#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Local-only stdin adapter. This file also bootstraps the official worker so
// engine diagnostics cannot expose recognized text through stdout/stderr.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isMainThread } = require('node:worker_threads');

const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const LANGUAGES = ['kor', 'eng'];
const MODEL_LOCK = [
  { language: 'kor', filename: 'kor.traineddata', bytes: 1677415,
    sha256: '6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2' },
  { language: 'eng', filename: 'eng.traineddata', bytes: 4113088,
    sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' },
];

class InputError extends Error {
  constructor(code, message, status = 2) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function moduleEntry(name) {
  try {
    return require.resolve(name);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const modules = process.env.GLYPHCHECK_NODE_MODULES;
    if (!modules || !path.isAbsolute(modules)) {
      throw new InputError('RUNTIME_UNAVAILABLE', 'Install the local OCR dependencies or configure their local module directory.', 3);
    }
    try { return require.resolve(path.join(modules, name)); }
    catch (_) { throw new InputError('RUNTIME_UNAVAILABLE', 'The configured local OCR dependency directory is unavailable.', 3); }
  }
}

function disableNetworkFetch() {
  globalThis.fetch = async () => { throw new Error('Network access is disabled in this local OCR adapter.'); };
}

function silenceConsole() {
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
}

function emit(value) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
    throw new InputError('RESULT_SIZE', 'OCR produced an oversized result.', 4);
  }
  process.stdout.write(encoded + '\n');
}

function fail(error) {
  const known = error instanceof InputError;
  emit({ schema: 'glyphcheck.error/v1',
    code: known ? error.code : 'OCR_FAILED',
    message: known ? error.message : 'The local OCR runtime could not process this image.' });
  process.exit(known ? error.status : 4);
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      throw new InputError('INPUT_SIZE', 'The image must be nonempty and at most 10 MiB.');
    }
    chunks.push(chunk);
  }
  if (!total) throw new InputError('INPUT_SIZE', 'The image must be nonempty and at most 10 MiB.');
  return Buffer.concat(chunks, total);
}

function rejectAnimatedPng(image) {
  let offset = 8;
  while (offset + 12 <= image.length) {
    const size = image.readUInt32BE(offset);
    if (size > image.length - offset - 12) throw new InputError('INVALID_IMAGE', 'Use a valid, single-image PNG or JPEG.');
    const type = image.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw new InputError('INVALID_IMAGE', 'Animated PNG images are not supported. Choose one still image.');
    offset += size + 12;
    if (type === 'IEND') break;
  }
}

async function verifiedModels() {
  const directory = path.join(ROOT, '_runtime', 'tessdata');
  const directoryInfo = await fs.promises.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new InputError('MODEL_UNAVAILABLE', 'The locked local OCR models are unavailable.', 3);
  }
  for (const model of MODEL_LOCK) {
    const handle = await fs.promises.open(path.join(directory, model.filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== model.bytes) throw new Error('Model size mismatch');
      const bytes = await handle.readFile();
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error('Model hash mismatch');
    } finally {
      await handle.close();
    }
  }
  return directory;
}

function flattenLines(blocks, width, height) {
  if (!Array.isArray(blocks)) throw new InputError('INVALID_RESULT', 'The local OCR runtime returned invalid line data.', 4);
  const lines = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        if (typeof line.text !== 'string' || !line.text.trim()) continue;
        if (line.text.length > 16384 || lines.length >= 2000) throw new InputError('RESULT_SIZE', 'OCR produced too much text.', 4);
        const box = line.bbox;
        const coordinates = box && [box.x0, box.y0, box.x1, box.y1];
        if (!coordinates || !coordinates.every(Number.isFinite) || box.x1 < box.x0 || box.y1 < box.y0 ||
            !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 100) {
          throw new InputError('INVALID_RESULT', 'The local OCR runtime returned invalid visual guides.', 4);
        }
        const x0 = Math.max(0, Math.min(width, box.x0));
        const y0 = Math.max(0, Math.min(height, box.y0));
        const x1 = Math.max(x0, Math.min(width, box.x1));
        const y1 = Math.max(y0, Math.min(height, box.y1));
        lines.push({ id: `line-${String(lines.length + 1).padStart(4, '0')}`,
          text: line.text.replace(/[\r\n]+$/, ''), confidence: line.confidence / 100,
          bbox: { x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height },
          alternatives: [] });
      }
    }
  }
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--stdin')) {
    throw new InputError('USAGE', 'Use tesseract_ocr.cjs --stdin and pipe PNG/JPEG bytes.');
  }
  const started = performance.now();
  const image = await readStdin();
  const isPng = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255;
  if (!isPng && !isJpeg) throw new InputError('INVALID_IMAGE', 'Use a valid, single-image PNG or JPEG.');
  if (isPng) rejectAnimatedPng(image);
  let sharp;
  let metadata;
  try {
    sharp = require(moduleEntry('sharp'));
    metadata = await sharp(image, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('INVALID_IMAGE', 'Use a valid PNG/JPEG of at most 16 million pixels.');
  }
  const { width, height } = metadata;
  if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages || 1) !== 1 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > 16000 || height > 16000 || width * height > MAX_PIXELS) {
    throw new InputError('IMAGE_DIMENSIONS', 'Use a single PNG/JPEG of at most 16 million pixels.');
  }
  if ((metadata.orientation || 1) !== 1) {
    throw new InputError('UNSUPPORTED_ORIENTATION', 'This version accepts upright images only (EXIF orientation 1). Export or rotate the image upright first.');
  }
  let langPath;
  try { langPath = await verifiedModels(); }
  catch (_) { throw new InputError('MODEL_UNAVAILABLE', 'The locked local OCR models are unavailable or do not match their hashes.', 3); }
  const tesseractEntry = moduleEntry('tesseract.js');
  const { createWorker } = require(tesseractEntry);
  const packageInfo = JSON.parse(await fs.promises.readFile(path.join(path.dirname(tesseractEntry), '..', 'package.json'), 'utf8'));
  if (packageInfo.name !== 'tesseract.js' || typeof packageInfo.version !== 'string') {
    throw new InputError('RUNTIME_UNAVAILABLE', 'The local OCR package metadata is invalid.', 3);
  }
  let worker;
  try {
    worker = await createWorker(['kor', 'eng'], 1, {
      langPath, gzip: false, cacheMethod: 'none', workerPath: __filename,
      logger: () => {},
      errorHandler: () => fail(new InputError('OCR_FAILED', 'The local OCR worker could not initialize or process this image.', 4)),
      logging: false,
    });
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    const lines = flattenLines(data.blocks, width, height);
    return { schema: 'glyphcheck.ocr/v1', engine: 'Tesseract.js', revision: 1,
      revision_kind: 'ocr-engine-mode', engine_mode: 'LSTM_ONLY', engine_version: packageInfo.version,
      tesseract_version: String(data.version || ''), width, height,
      languages: LANGUAGES, lines, elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      input_sha256: crypto.createHash('sha256').update(image).digest('hex'),
      models: MODEL_LOCK.map(model => ({ ...model })),
      model_upstream: 'tesseract-ocr/tessdata_fast',
      model_commit: '87416418657359cb625c412a48b6e1d6d41c29bd',
      models_trained_by_this_project: false };
  } finally {
    if (worker) await worker.terminate();
  }
}

silenceConsole();
disableNetworkFetch();
process.stderr.write = () => true;
if (!isMainThread) {
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  const entry = moduleEntry('tesseract.js');
  require(path.join(path.dirname(entry), 'worker-script', 'node', 'index.js'));
} else {
  process.on('uncaughtException', () => fail(new InputError('OCR_FAILED', 'The local OCR worker could not initialize or process this image.', 4)));
  process.on('unhandledRejection', () => fail(new InputError('OCR_FAILED', 'The local OCR worker could not initialize or process this image.', 4)));
  const deadline = setTimeout(() => fail(new InputError('TIMEOUT', 'The local OCR run timed out. Try a smaller image.', 4)), 35000);
  deadline.unref();
  main().then(value => { clearTimeout(deadline); emit(value); }).catch(error => { clearTimeout(deadline); fail(error); });
}
