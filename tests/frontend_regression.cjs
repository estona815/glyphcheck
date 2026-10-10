/* Synthetic frontend logic regressions. No browser, network, OCR model, user image, or database. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const sourcePath = path.join(__dirname, "..", "web", "app.js");
const htmlPath = path.join(__dirname, "..", "web", "index.html");
const source = fs.readFileSync(sourcePath, "utf8");
const sourceSha = crypto.createHash("sha256").update(source).digest("hex");
const expectedPosition = process.argv.indexOf("--expected-sha");
if (expectedPosition >= 0) assert.equal(sourceSha, process.argv[expectedPosition + 1], "Frozen app.js SHA");
const html = fs.readFileSync(htmlPath, "utf8");

function syntheticReply() {
  return {
    schema: "glyphcheck.ocr/v1", width: 640, height: 240,
    engine: "SYNTHETIC TEST ENGINE", engine_version: "test-only",
    revision: 1, revision_kind: "synthetic", languages: ["eng"],
    elapsed_ms: 12,
    lines: [{ id: "synthetic-line-1", text: "SYNTHETIC ORIGINAL", confidence: 0.6,
      bbox: { x: 0.1, y: 0.2, width: 0.7, height: 0.2 },
      alternatives: [{ text: "SYNTHETIC ALTERNATIVE", confidence: 0.4 }] }]
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeHarness() {
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = new Map();
      this.className = ""; this.textContent = ""; this.value = ""; this.checked = false;
      this.disabled = false; this.hidden = false;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          const present = force === undefined ? !names.has(name) : Boolean(force);
          if (present) names.add(name); else names.delete(name);
          this.className = [...names].join(" "); return present;
        },
        remove: name => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(" "); }
      };
    }
    append(...nodes) {
      for (const n of nodes) { n.parentNode = this; this.children.push(n); }
    }
    replaceChildren(...nodes) {
      for (const child of this.children) child.parentNode = null;
      this.children = []; this.append(...nodes);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatch(type) {
      for (const fn of this.listeners.get(type) || []) fn({ target: this, type });
    }
    click() { this.dispatch("click"); }
    focus() { document.activeElement = this; }
    scrollIntoView() { this.guideScrollRequested = true; }
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter(x => x !== this);
        this.parentNode = null;
      }
    }
    descendants() { return this.children.flatMap(x => [x, ...x.descendants()]); }
    matchesToken(token) {
      return token.startsWith(".") ? this.classList.contains(token.slice(1))
        : this.tagName.toLowerCase() === token.toLowerCase();
    }
    matches(selector) {
      const tokens = selector.trim().split(/\s+/);
      if (!this.matchesToken(tokens.pop())) return false;
      let parent = this.parentNode;
      while (tokens.length) {
        const token = tokens.pop();
        while (parent && !parent.matchesToken(token)) parent = parent.parentNode;
        if (!parent) return false;
        parent = parent.parentNode;
      }
      return true;
    }
    querySelectorAll(selector) {
      const parts = selector.split(",");
      return this.descendants().filter(n => parts.some(s => n.matches(s)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  document = {
    body: new Element("body"), activeElement: null,
    createElement: tag => new Element(tag),
    getElementById: id => document.body.descendants().find(x => x.id === id) || null
  };
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.id = match[3];
    element.hidden = /\bhidden\b/.test(match[2]);
    const value = match[2].match(/\bvalue="([^"]*)"/);
    if (value) element.value = value[1];
    document.body.append(element);
  }
  const harness = {
    document, decodeMode: "success", fetchCalls: [], revoked: [], created: [],
    timers: new Map(), cleared: [], nextTimer: 1, nextUrl: 1,
    fetchHandler: async () => ({ ok: true, status: 200, json: async () => syntheticReply() })
  };
  class SyntheticImage {
    set src(value) {
      this.imageUrl = value;
      queueMicrotask(() => {
        if (harness.decodeMode === "failure") this.onerror();
        else { this.naturalWidth = 640; this.naturalHeight = 240; this.onload(); }
      });
    }
  }
  const sandbox = {
    document, Image: SyntheticImage, Blob, AbortController, queueMicrotask,
    URL: {
      createObjectURL: blob => {
        const value = "blob:synthetic/" + harness.nextUrl++;
        harness.created.push({ value, bytes: blob.size }); return value;
      },
      revokeObjectURL: value => harness.revoked.push(value)
    },
    fetch: async (url, options) => {
      assert.ok(["/api/recognize", "/demo.png"].includes(url), "Synthetic harness permits only local OCR/demo routes");
      harness.fetchCalls.push({ url, options });
      return harness.fetchHandler(url, options);
    },
    setTimeout: (fn, delay) => {
      const id = harness.nextTimer++; harness.timers.set(id, { fn, delay }); return id;
    },
    clearTimeout: id => { harness.cleared.push(id); harness.timers.delete(id); }
  };
  vm.createContext(sandbox);
  vm.runInContext(source + "\n;globalThis.testApi = {state,el,recognize,runTask,setBusy,renderLines,exportRecord};",
    sandbox, { filename: "actual-app.js", timeout: 1000 });
  harness.api = sandbox.testApi;
  harness.blob = () => new Blob(["SYNTHETIC IMAGE EVENT STUB"], { type: "image/png" });
  harness.fire = id => {
    const timer = harness.timers.get(id);
    assert.ok(timer, "Requested active timer exists"); timer.fn();
  };
  return harness;
}
async function tick() { await new Promise(setImmediate); }
function portable(value) { return JSON.parse(JSON.stringify(value)); }
function recordWithoutTime(h) {
  const record = portable(h.api.exportRecord()); delete record.exported_at; return record;
}
async function seededHarness() {
  const h = makeHarness();
  await h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-old.png", "synthetic_demo"));
  const editor = h.document.getElementById("edit-line-1");
  editor.value = "SYNTHETIC USER CORRECTION"; editor.dispatch("input");
  const review = h.api.el["line-list"].querySelector(".review-check input");
  review.checked = true; review.dispatch("change");
  assert.equal(h.api.state.lines[0].editedText, "SYNTHETIC USER CORRECTION");
  assert.equal(h.api.state.lines[0].reviewed, true);
  return h;
}
function preservedSnapshot(h) {
  return {
    record: recordWithoutTime(h), source: h.api.state.source, lines: h.api.state.lines,
    recognition: h.api.state.recognition, sourceUrl: h.api.state.sourceUrl,
    img: h.api.el["source-image"].src, label: h.api.el["source-name"].textContent,
    guideHidden: h.api.el["region-guide"].hidden,
    guideStyle: { ...h.api.el["region-guide"].style }, selectedId: h.api.state.selectedId
  };
}
function assertPreserved(h, before) {
  assert.deepEqual(recordWithoutTime(h), before.record, "User correction and provenance retained");
  assert.equal(h.api.state.source, before.source);
  assert.equal(h.api.state.lines, before.lines);
  assert.equal(h.api.state.recognition, before.recognition);
  assert.equal(h.api.state.sourceUrl, before.sourceUrl);
  assert.equal(h.api.el["source-image"].src, before.img);
  assert.equal(h.api.el["source-name"].textContent, before.label);
  assert.equal(h.api.el["region-guide"].hidden, before.guideHidden);
  assert.deepEqual({ ...h.api.el["region-guide"].style }, before.guideStyle);
  assert.equal(h.api.state.selectedId, before.selectedId);
  assert.ok(!h.revoked.includes(before.sourceUrl), "Previous image handle not revoked");
  assert.equal(h.api.state.busy, false);
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("decode failure preserves prior corrected/reviewed lines and image without POST", async () => {
  const h = await seededHarness(); const before = preservedSnapshot(h);
  const calls = h.fetchCalls.length; h.decodeMode = "failure";
  await h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-corrupt.png", "synthetic_demo"));
  assertPreserved(h, before); assert.equal(h.fetchCalls.length, calls);
  assert.equal(h.api.el.error.hidden, false);
  assert.match(h.api.el.status.textContent, /이전 교정 작업을 유지/);
});
test("model HTTP failure preserves prior correction and reports actual synthetic error", async () => {
  const h = await seededHarness(); const before = preservedSnapshot(h);
  h.fetchHandler = async () => ({ ok: false, status: 422,
    text: async () => JSON.stringify({ error: "SYNTHETIC MODEL FAILURE" }) });
  await h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-next.png", "synthetic_demo"));
  assertPreserved(h, before);
  assert.equal(h.api.el.error.textContent, "SYNTHETIC MODEL FAILURE");
  assert.ok(h.revoked.includes(h.created.at(-1).value), "Only failed new preview released");
});
test("invalid recognition payload preserves prior correction before commit", async () => {
  const h = await seededHarness(); const before = preservedSnapshot(h);
  h.fetchHandler = async () => ({ ok: true, status: 200,
    json: async () => ({ ...syntheticReply(), width: 999 }) });
  await h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-mismatch.png", "synthetic_demo"));
  assertPreserved(h, before);
  assert.match(h.api.el.error.textContent, /좌표 크기가 다릅니다/);
});
test("busy filters/threshold and re-rendered line controls remain disabled; events guarded", async () => {
  const h = await seededHarness(); h.api.setBusy(true);
  for (const id of ["needs-review-only", "low-confidence-only", "threshold"]) {
    assert.equal(h.api.el[id].disabled, true, id + " disabled");
  }
  const oldRow = h.api.el["line-list"].children[0];
  for (const id of ["needs-review-only", "low-confidence-only"]) h.api.el[id].dispatch("change");
  const oldThresholdLabel = h.api.el["threshold-value"].textContent;
  h.api.el.threshold.dispatch("input");
  assert.equal(h.api.el["threshold-value"].textContent, oldThresholdLabel);
  assert.equal(h.api.el["line-list"].children[0], oldRow, "Busy filter event cannot replace editor");
  h.api.renderLines();
  const controls = h.api.el["line-list"].querySelectorAll("button,input,textarea,select");
  assert.ok(controls.length >= 4);
  assert.ok(controls.every(x => x.disabled), "Newly rendered controls also disabled");
  const editor = h.document.getElementById("edit-line-1");
  editor.value = "SYNTHETIC BUSY MUTATION"; editor.dispatch("input");
  const review = h.api.el["line-list"].querySelector(".review-check input");
  review.checked = false; review.dispatch("change");
  const alternative = h.document.getElementById("candidate-line-1");
  alternative.value = "1"; alternative.dispatch("change");
  assert.equal(h.api.state.lines[0].editedText, "SYNTHETIC USER CORRECTION");
  assert.equal(h.api.state.lines[0].reviewed, true);
  assert.equal(h.api.state.lines[0].selectedCandidate, 0);
  h.api.setBusy(false);
  assert.ok(controls.every(x => !x.disabled));
});
test("editing a reviewed line resets review without inventing corrected confidence", async () => {
  const h = await seededHarness();
  const originalConfidence = h.api.state.lines[0].originalConfidence;
  const editor = h.document.getElementById("edit-line-1");
  editor.value = "SYNTHETIC SECOND CORRECTION"; editor.dispatch("input");
  const record = portable(h.api.exportRecord());
  assert.equal(record.lines[0].reviewed, false);
  assert.equal(record.lines[0].corrected_text, "SYNTHETIC SECOND CORRECTION");
  assert.equal(record.lines[0].original_confidence, originalConfidence);
  assert.ok(!("corrected_confidence" in record.lines[0]));
});
test("response body remains covered by timeout until JSON validation/commit completes", async () => {
  const h = await seededHarness(); const body = deferred(); let signal;
  h.fetchHandler = async (_, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => body.promise };
  };
  const pending = h.api.recognize(h.blob(), "synthetic-delayed.png", "synthetic_demo");
  await tick();
  assert.equal(h.timers.size, 1, "Timer not cleared just because headers arrived");
  assert.equal(signal.aborted, false);
  assert.equal([...h.timers.values()][0].delay, 120000);
  body.resolve(syntheticReply()); await pending;
  assert.equal(h.timers.size, 0, "Timer cleared after complete body");
  assert.equal(h.api.state.source.name, "synthetic-delayed.png");
  assert.match(h.api.el["engine-meta"].textContent, /SYNTHETIC TEST ENGINE test-only/);
  assert.ok(!h.api.el["engine-meta"].textContent.includes("revision"));
});
test("hanging JSON body receives actual AbortSignal and retains prior correction", async () => {
  const h = await seededHarness(); const before = preservedSnapshot(h); let signal;
  h.fetchHandler = async (_, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("SYNTHETIC BODY ABORT"); error.name = "AbortError"; reject(error);
      }, { once: true });
    }) };
  };
  const pending = h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-hanging.png", "synthetic_demo"));
  await tick();
  assert.equal(h.timers.size, 1);
  h.fire([...h.timers.keys()][0]);
  assert.equal(signal.aborted, true, "Actual AbortController signaled");
  await pending;
  assertPreserved(h, before);
  assert.equal(h.timers.size, 0);
  assert.match(h.api.el.error.textContent, /120초/);
});
test("hanging non-2xx error body also remains under timeout", async () => {
  const h = await seededHarness(); const before = preservedSnapshot(h); let signal;
  h.fetchHandler = async (_, options) => {
    signal = options.signal;
    return { ok: false, status: 422, text: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("SYNTHETIC ERROR BODY ABORT"); error.name = "AbortError"; reject(error);
      }, { once: true });
    }) };
  };
  const pending = h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-error-body.png", "synthetic_demo"));
  await tick(); assert.equal(h.timers.size, 1);
  h.fire([...h.timers.keys()][0]); await pending;
  assertPreserved(h, before); assert.equal(h.timers.size, 0); assert.equal(signal.aborted, true);
});

test("successful empty OCR replaces old guide with no-text state and disables exports", async () => {
  const h = await seededHarness();
  assert.equal(h.api.el["region-guide"].hidden, false);
  const previousUrl = h.api.state.sourceUrl;
  h.fetchHandler = async () => ({ ok: true, status: 200,
    json: async () => ({ ...syntheticReply(), lines: [] }) });
  await h.api.runTask(() => h.api.recognize(h.blob(), "synthetic-empty.png", "synthetic_demo"));
  assert.equal(h.api.state.lines.length, 0);
  assert.equal(h.api.state.selectedId, null);
  assert.equal(h.api.el["region-guide"].hidden, true);
  assert.equal(h.api.el["no-text"].hidden, false);
  assert.equal(h.api.el["export-text"].disabled, true);
  assert.equal(h.api.el["export-record"].disabled, true);
  assert.equal(h.api.state.source.name, "synthetic-empty.png");
  assert.ok(h.revoked.includes(previousUrl), "Old preview released only after successful commit");
  assert.equal(h.api.state.busy, false);
});

for (const stalledPhase of ["headers", "image-body", "error-body"]) {
  test("stalled demo " + stalledPhase + " is aborted without losing previous corrections", async () => {
    const h = await seededHarness(); const before = preservedSnapshot(h); let signal;
    const stalled = () => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("SYNTHETIC DEMO ABORT"); error.name = "AbortError"; reject(error);
      }, { once: true });
    });
    h.fetchHandler = async (url, options) => {
      assert.equal(url, "/demo.png"); signal = options.signal;
      if (stalledPhase === "headers") return stalled();
      if (stalledPhase === "image-body") return { ok: true, status: 200, blob: stalled };
      return { ok: false, status: 503, text: stalled };
    };
    h.api.el["run-demo"].click(); await tick();
    assert.equal(h.api.state.busy, true);
    assert.equal(h.timers.size, 1, "Demo fetch and body must remain under a deadline");
    assert.equal([...h.timers.values()][0].delay, 120000);
    assert.ok(signal, "Demo request carries its own AbortSignal");
    h.fire([...h.timers.keys()][0]); await tick();
    assert.equal(signal.aborted, true);
    assertPreserved(h, before); assert.equal(h.timers.size, 0);
    assert.equal(h.api.el["run-demo"].disabled, false);
    assert.equal(h.api.el["open-image"].disabled, false);
    assert.match(h.api.el.error.textContent, /120초/);
    assert.equal(h.fetchCalls.filter(x => x.url === "/api/recognize").length, 1,
      "Stalled demo never starts a new OCR request");
  });
}
test("successful demo clears download timer before independent OCR request", async () => {
  const h = await seededHarness(); let demoSignal, ocrSignal;
  h.fetchHandler = async (url, options) => {
    if (url === "/demo.png") {
      demoSignal = options.signal;
      return { ok: true, status: 200, blob: async () => h.blob() };
    }
    ocrSignal = options.signal;
    assert.equal(h.timers.size, 1, "Only OCR timer remains after complete demo download");
    return { ok: true, status: 200, json: async () => syntheticReply() };
  };
  h.api.el["run-demo"].click(); await tick();
  assert.ok(demoSignal); assert.ok(ocrSignal); assert.notEqual(demoSignal, ocrSignal);
  assert.equal(demoSignal.aborted, false); assert.equal(ocrSignal.aborted, false);
  assert.equal(h.timers.size, 0); assert.equal(h.api.state.busy, false);
  assert.equal(h.api.state.source.name, "demo.png");
});

(async () => {
  console.log("SYNTHETIC LOGIC ONLY: Node VM + minimal DOM; no browser/network/model/user data/database.");
  console.log("app.js SHA256 " + sourceSha);
  let passed = 0;
  for (const entry of tests) {
    try { await entry.fn(); passed++; console.log("PASS " + entry.name); }
    catch (error) {
      console.error("FAIL " + entry.name);
      console.error(error.stack); process.exitCode = 1;
    }
  }
  console.log("RESULT " + passed + "/" + tests.length + " synthetic logic cases");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"), sourceSha,
    "Production source unchanged during test run");
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
