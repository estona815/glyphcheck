/* New GlyphCheck frontend. No prior app code, external assets, model output fixtures, or API keys. */
"use strict";

const el = Object.fromEntries([
  "workspace", "image-input", "open-image", "run-demo", "status", "error",
  "image-meta", "image-empty", "image-wrap", "source-image", "region-guide",
  "source-name", "review-count", "needs-review-only", "low-confidence-only",
  "threshold", "threshold-value", "lines-empty", "no-text", "filter-empty",
  "line-list", "engine-meta", "export-text", "export-record", "export-summary"
].map(id => [id, document.getElementById(id)]));

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const state = {
  busy: false, source: null, sourceUrl: null, recognition: null,
  lines: [], selectedId: null
};

function message(text) { el.status.textContent = text; }
function showError(text) {
  el.error.textContent = text;
  el.error.hidden = false;
}
function setBusy(busy) {
  state.busy = busy;
  el.workspace.setAttribute("aria-busy", String(busy));
  el["open-image"].disabled = busy;
  el["run-demo"].disabled = busy;
  el["image-input"].disabled = busy;
  for (const id of ["needs-review-only", "low-confidence-only", "threshold"]) {
    el[id].disabled = busy;
  }
  for (const control of el["line-list"].querySelectorAll("button,input,textarea,select")) {
    control.disabled = busy;
  }
  updateSummary();
}
function resetRecognition() {
  state.recognition = null;
  state.lines = [];
  state.selectedId = null;
  el["line-list"].replaceChildren();
  el["region-guide"].hidden = true;
  el["lines-empty"].hidden = false;
  el["no-text"].hidden = true;
  el["filter-empty"].hidden = true;
  el["engine-meta"].textContent = "";
  updateSummary();
}
function confidenceText(value) { return (value * 100).toFixed(1) + "%"; }
function candidateFor(line) { return line.candidates[line.selectedCandidate]; }
function isLow(line) { return candidateFor(line).confidence < Number(el.threshold.value) / 100; }
function passesFilter(line) {
  return (!el["needs-review-only"].checked || !line.reviewed)
    && (!el["low-confidence-only"].checked || isLow(line));
}
function updateSummary() {
  const reviewed = state.lines.filter(line => line.reviewed).length;
  const total = state.lines.length;
  el["review-count"].textContent = total ? reviewed + " / " + total + "줄 검토 완료" : "0줄";
  el["export-summary"].textContent = total
    ? "전체 " + total + "줄 · 검토 완료 " + reviewed + "줄 · 미검토 " + (total - reviewed) + "줄"
    : "이미지를 인식한 뒤 교정 결과를 저장할 수 있습니다.";
  el["export-text"].disabled = state.busy || total === 0;
  el["export-record"].disabled = state.busy || total === 0;
}
function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function showGuide(line, button) {
  if (state.busy && button) return;
  state.selectedId = line.id;
  for (const row of el["line-list"].children) {
    const selected = row.dataset.lineId === line.id;
    row.classList.toggle("selected", selected);
    row.querySelector(".region-button").setAttribute("aria-pressed", String(selected));
  }
  const b = line.bbox;
  const padX = 0.012;
  const padY = 0.010;
  const left = Math.max(0, b.x - padX);
  const top = Math.max(0, b.y - padY);
  const right = Math.min(1, b.x + b.width + padX);
  const bottom = Math.min(1, b.y + b.height + padY);
  Object.assign(el["region-guide"].style, {
    left: left * 100 + "%", top: top * 100 + "%",
    width: (right - left) * 100 + "%", height: (bottom - top) * 100 + "%"
  });
  el["region-guide"].hidden = false;
  el["region-guide"].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  if (button) message("줄 " + line.order + "의 근사 영역을 표시했습니다. 원본 픽셀과 교정문을 직접 대조하세요.");
}
function renderLines() {
  el["line-list"].replaceChildren();
  const visible = state.lines.filter(passesFilter);
  el["lines-empty"].hidden = Boolean(state.recognition);
  el["no-text"].hidden = !(state.recognition && state.lines.length === 0);
  el["filter-empty"].hidden = !(state.lines.length > 0 && visible.length === 0);

  for (const line of visible) {
    const row = node("li", "line-row");
    row.dataset.lineId = line.id;
    row.value = line.order;
    row.classList.toggle("reviewed", line.reviewed);
    row.classList.toggle("selected", state.selectedId === line.id);
    const heading = node("div", "line-heading");
    const label = node("div", "");
    label.append(node("span", "line-number", "줄 " + line.order));
    const confidence = node("span", "candidate-confidence", "OCR 후보 확신도 " + confidenceText(candidateFor(line).confidence));
    confidence.classList.toggle("low", isLow(line));
    label.append(confidence);
    const regionButton = node("button", "region-button", "원본에서 보기");
    regionButton.type = "button";
    regionButton.setAttribute("aria-label", "줄 " + line.order + " 원본의 근사 영역 보기");
    regionButton.setAttribute("aria-controls", "image-viewport");
    regionButton.setAttribute("aria-pressed", String(state.selectedId === line.id));
    regionButton.addEventListener("click", () => showGuide(line, regionButton));
    heading.append(label, regionButton);

    const editorId = "edit-line-" + line.order;
    const editLabel = node("label", "edit-label", "줄 " + line.order + " 교정문");
    editLabel.htmlFor = editorId;
    const editor = node("textarea", "line-editor");
    editor.id = editorId;
    editor.value = line.editedText;
    editor.rows = 2;
    editor.spellcheck = false;
    const bottom = node("div", "line-bottom");
    const reviewLabel = node("label", "review-check");
    const review = node("input", "");
    review.type = "checkbox";
    review.checked = line.reviewed;
    review.setAttribute("aria-label", "줄 " + line.order + " 검토 완료");
    reviewLabel.append(review, node("span", "", "검토 완료"));
    const changed = node("span", "edited-note", line.editedText !== line.originalText ? "교정됨" : "인식 원문 유지");
    bottom.append(reviewLabel, changed);
    editor.addEventListener("input", () => {
      if (state.busy) return;
      line.editedText = editor.value;
      line.reviewed = false;
      review.checked = false;
      row.classList.remove("reviewed");
      changed.textContent = line.editedText !== line.originalText ? "교정됨" : "인식 원문 유지";
      updateSummary();
    });
    review.addEventListener("change", () => {
      if (state.busy) return;
      line.reviewed = review.checked;
      if (el["needs-review-only"].checked) {
        renderLines();
        const next = el["line-list"].querySelector(".review-check input");
        (next || el["needs-review-only"]).focus();
      } else {
        row.classList.toggle("reviewed", line.reviewed);
        updateSummary();
      }
    });
    row.append(heading, editLabel, editor);

    if (line.candidates.length > 1) {
      const alternate = node("div", "alternate-control");
      const alternateLabel = node("label", "", "OCR 엔진이 실제 반환한 후보");
      const select = node("select", "");
      select.id = "candidate-line-" + line.order;
      alternateLabel.htmlFor = select.id;
      line.candidates.forEach((candidate, index) => {
        const option = node("option", "", candidate.text + " — " + confidenceText(candidate.confidence));
        option.value = String(index);
        option.selected = index === line.selectedCandidate;
        select.append(option);
      });
      select.addEventListener("change", () => {
        if (state.busy) return;
        line.selectedCandidate = Number(select.value);
        line.editedText = candidateFor(line).text;
        line.reviewed = false;
        renderLines();
        const current = document.getElementById("candidate-line-" + line.order);
        if (current) current.focus();
        else el["low-confidence-only"].focus();
        message("줄 " + line.order + "을 실제 대체 후보로 바꿨습니다. 다시 원본과 대조하세요.");
      });
      alternate.append(alternateLabel, select);
      row.append(alternate);
    }
    row.append(bottom);
    el["line-list"].append(row);
  }
  for (const control of el["line-list"].querySelectorAll("button,input,textarea,select")) {
    control.disabled = state.busy;
  }
  updateSummary();
}
function validateRecognition(data, dimensions) {
  if (!data || data.schema !== "glyphcheck.ocr/v1" || (typeof data.engine !== "string" || !data.engine.trim())
      || !Number.isInteger(data.width) || data.width < 1
      || !Number.isInteger(data.height) || data.height < 1
      || !Number.isInteger(data.revision) || data.revision < 1
      || !Array.isArray(data.languages) || !data.languages.every(x => typeof x === "string")
      || !Number.isFinite(data.elapsed_ms) || data.elapsed_ms < 0 || !Array.isArray(data.lines)) {
    throw new Error("로컬 OCR 응답 형식이 올바르지 않습니다.");
  }
  if (data.width !== dimensions.width || data.height !== dimensions.height) {
    throw new Error("이미지 표시 크기와 OCR 좌표 크기가 다릅니다. 잘못된 영역 안내를 피하기 위해 결과를 표시하지 않습니다.");
  }
  const ids = new Set();
  for (const line of data.lines) {
    const b = line && line.bbox;
    if (!line || typeof line.id !== "string" || !line.id || ids.has(line.id)
        || typeof line.text !== "string" || !line.text.trim()
        || !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1
        || !b || !["x", "y", "width", "height"].every(k => Number.isFinite(b[k]))
        || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0
        || b.x + b.width > 1.00001 || b.y + b.height > 1.00001
        || !Array.isArray(line.alternatives)) {
      throw new Error("줄의 텍스트·확신도·근사 좌표가 유효하지 않습니다.");
    }
    ids.add(line.id);
    for (const candidate of line.alternatives) {
      if (!candidate || typeof candidate.text !== "string" || !candidate.text.trim()
          || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
        throw new Error("대체 후보 응답이 유효하지 않습니다.");
      }
    }
  }
  return data;
}
async function digest(blob) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
  const bytes = await blob.arrayBuffer();
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
async function decodeImage(blob) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("PNG 또는 JPEG 이미지를 열 수 없습니다. 파일의 실제 형식을 확인하세요."));
      image.src = url;
    });
    return { url, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
async function responseError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    if (typeof data.error === "string") return data.error;
    if (typeof data.message === "string") return data.message;
  } catch (_) { /* Non-JSON local server errors still receive a readable status. */ }
  return "로컬 서버가 HTTP " + response.status + " 오류를 반환했습니다.";
}
async function recognize(blob, name, sourceKind) {
  if (!["image/png", "image/jpeg"].includes(blob.type)) {
    throw new Error("PNG 또는 JPEG만 지원합니다. 이미지 형식과 Content-Type을 확인하세요.");
  }
  if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) {
    throw new Error("이미지는 0바이트보다 크고 10 MiB 이하여야 합니다.");
  }
  const decoded = await decodeImage(blob);
  let committed = false;
  message("로컬 OCR로 이미지를 인식하고 있습니다…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const nextSource = {
      kind: sourceKind, name, content_type: blob.type, bytes: blob.size,
      sha256: await digest(blob)
    };
    const response = await fetch("/api/recognize", {
      method: "POST", headers: { "Content-Type": blob.type }, body: blob,
      mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(await responseError(response));
    const data = validateRecognition(await response.json(), decoded);
    const nextLines = data.lines.map((line, index) => {
      const candidates = [{ text: line.text, confidence: line.confidence }];
      for (const candidate of line.alternatives) {
        if (!candidates.some(x => x.text === candidate.text && x.confidence === candidate.confidence)) {
          candidates.push({ text: candidate.text, confidence: candidate.confidence });
        }
      }
      return {
        id: line.id, order: index + 1, originalText: line.text,
        originalConfidence: line.confidence, bbox: { ...line.bbox }, candidates,
        selectedCandidate: 0, editedText: line.text, reviewed: false
      };
    });
    // Commit only a completely decoded, recognized and validated image.
    // A failed new file must not erase the previous user's corrections.
    const previousUrl = state.sourceUrl;
    state.source = nextSource;
    state.sourceUrl = decoded.url;
    state.recognition = data;
    state.lines = nextLines;
    state.selectedId = null;
    el["region-guide"].hidden = true;
    el["source-image"].src = decoded.url;
    el["image-wrap"].hidden = false;
    el["image-empty"].hidden = true;
    el["image-meta"].textContent = decoded.width + " × " + decoded.height + " px";
    el["source-name"].textContent = sourceKind === "synthetic_demo" ? "합성 예제 · 실제 로컬 OCR 인식" : name;
    committed = true;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const engineLabel = typeof data.engine_version === "string" && data.engine_version.trim()
      ? data.engine + " " + data.engine_version : data.engine;
    el["engine-meta"].textContent = engineLabel
      + " · " + data.languages.join(", ") + " · 이번 OCR 처리 " + Math.round(data.elapsed_ms) + " ms";
    renderLines();
    if (state.lines.length) {
      showGuide(state.lines[0]);
      message(state.lines.length + "줄을 인식했습니다. 확신도와 원본을 대조한 뒤 검토 완료를 표시하세요.");
    } else {
      message("OCR 처리는 완료됐지만 인식된 글자가 없습니다.");
    }
  } finally {
    clearTimeout(timer);
    if (!committed) URL.revokeObjectURL(decoded.url);
  }
}
async function runTask(task) {
  if (state.busy) return;
  el.error.hidden = true;
  setBusy(true);
  try { await task(); }
  catch (error) {
    const text = error.name === "AbortError"
      ? "120초 안에 처리가 끝나지 않아 요청을 중단했습니다. 로컬 서버 상태를 확인하세요."
      : (error instanceof TypeError ? "로컬 OCR 서비스에 연결할 수 없습니다. 이 페이지와 로컬 서버가 실행 중인지 확인하세요." : error.message);
    showError(text || "이미지를 처리할 수 없습니다.");
    message(state.recognition ? "새 이미지를 인식하지 못해 이전 교정 작업을 유지했습니다." : "인식을 완료하지 못했습니다. 원본을 확인하고 다시 시도하세요.");
  } finally { setBusy(false); }
}
function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = node("a", "");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const pending = state.lines.filter(line => !line.reviewed).length;
  message(pending
    ? "미검토 " + pending + "줄을 포함한 " + filename + " 저장을 요청했습니다. JSON의 reviewed 값을 확인하세요."
    : filename + " 저장을 요청했습니다. 모든 줄에 사용자 검토 완료 표시가 있습니다.");
}
function exportRecord() {
  return {
    schema: "glyphcheck.review/v1",
    exported_at: new Date().toISOString(),
    source: { ...state.source },
    recognition: {
      engine: state.recognition.engine, revision: state.recognition.revision,
      engine_version: state.recognition.engine_version || null,
      revision_kind: state.recognition.revision_kind || null,
      languages: [...state.recognition.languages],
      width: state.recognition.width, height: state.recognition.height,
      elapsed_ms: state.recognition.elapsed_ms,
      confidence_scope: "OCR text candidate line; not words or edited text; not an accuracy guarantee",
      bounding_boxes: "Approximate visual guides in normalized top-left image coordinates"
    },
    view_settings: {
      confidence_threshold: Number(el.threshold.value) / 100,
      unreviewed_only: el["needs-review-only"].checked,
      low_confidence_only: el["low-confidence-only"].checked,
      filters_affect_export: false,
      order_scope: "OCR engine returned order; original semantic reading order is not certified"
    },
    reviewed_lines: state.lines.filter(line => line.reviewed).length,
    total_lines: state.lines.length,
    lines: state.lines.map(line => ({
      id: line.id, order: line.order, original_text: line.originalText,
      original_confidence: line.originalConfidence, bbox: { ...line.bbox },
      candidates: line.candidates.map(x => ({ ...x })),
      selected_candidate: line.selectedCandidate,
      corrected_text: line.editedText, reviewed: line.reviewed,
      changed: line.editedText !== line.originalText
    }))
  };
}
el["open-image"].addEventListener("click", () => el["image-input"].click());
el["image-input"].addEventListener("change", () => {
  const file = el["image-input"].files[0];
  if (file) runTask(() => recognize(file, file.name, "user_local_image"));
  el["image-input"].value = "";
});
el["run-demo"].addEventListener("click", () => runTask(async () => {
  message("합성 예제를 로컬 서버에서 불러오고 있습니다…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let blob;
  try {
    const response = await fetch("/demo.png", {
      mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(await responseError(response));
    blob = await response.blob();
  } finally {
    clearTimeout(timer);
  }
  await recognize(blob, "demo.png", "synthetic_demo");
}));
for (const id of ["needs-review-only", "low-confidence-only"]) {
  el[id].addEventListener("change", () => { if (!state.busy) renderLines(); });
}
el.threshold.addEventListener("input", () => {
  if (state.busy) return;
  el["threshold-value"].textContent = el.threshold.value + "% 미만";
  renderLines();
});
el["export-text"].addEventListener("click", () => {
  if (!state.lines.length || state.busy) return;
  download(state.lines.map(line => line.editedText).join("\n") + "\n",
    "text/plain;charset=utf-8", "glyphcheck-corrected.txt");
});
el["export-record"].addEventListener("click", () => {
  if (!state.lines.length || state.busy) return;
  download(JSON.stringify(exportRecord(), null, 2) + "\n",
    "application/json;charset=utf-8", "glyphcheck-review.json");
});
