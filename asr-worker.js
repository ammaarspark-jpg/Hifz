// Runs the Quran speech model on the phone (no audio leaves the device).
// Model: tarteel-ai/whisper-base-ar-quran (Apache-2.0), ONNX export packaged for the browser.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true; // model is cached after the first download

const MODEL = "iqbalaesthetic/Basira";
let asr = null;
let busy = false;

async function pickBackend(pref) {
  if (pref !== "small" && self.navigator && navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) return { device: "webgpu", dtype: ad.features.has("shader-f16") ? "fp16" : "q4" };
    } catch (e) { /* fall through */ }
  }
  return { device: "wasm", dtype: "q8" };
}

async function load(pref) {
  const files = {};
  const progress = (p) => {
    if (p.status === "progress" && p.file) {
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      let l = 0, t = 0;
      for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
      postMessage({ type: "progress", loaded: l, total: t });
    }
  };
  let be = await pickBackend(pref);
  try {
    asr = await pipeline("automatic-speech-recognition", MODEL, { device: be.device, dtype: be.dtype, progress_callback: progress });
  } catch (e) {
    if (be.device !== "webgpu") throw e;
    postMessage({ type: "note", msg: "Fast mode isn't supported on this phone — switching to standard mode." });
    be = { device: "wasm", dtype: "q8" };
    asr = await pipeline("automatic-speech-recognition", MODEL, { device: be.device, dtype: be.dtype, progress_callback: progress });
  }
  postMessage({ type: "warming" });
  const t0 = performance.now();
  await asr(new Float32Array(16000 * 2), { language: "arabic", task: "transcribe" });
  postMessage({ type: "ready", device: be.device, dtype: be.dtype, warmMs: Math.round(performance.now() - t0) });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "load") {
    try { await load(m.pref); }
    catch (e) { postMessage({ type: "error", msg: String((e && e.message) || e) }); }
  } else if (m.type === "run") {
    if (!asr) { postMessage({ type: "result", id: m.id, text: "", error: "not loaded" }); return; }
    busy = true;
    const t0 = performance.now();
    try {
      const out = await asr(m.audio, { language: "arabic", task: "transcribe" });
      postMessage({ type: "result", id: m.id, text: (out && out.text) || "", ms: Math.round(performance.now() - t0), secs: m.audio.length / 16000 });
    } catch (e) {
      postMessage({ type: "result", id: m.id, text: "", error: String((e && e.message) || e) });
    }
    busy = false;
  }
};
