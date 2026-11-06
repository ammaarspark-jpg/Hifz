// Hifz Revision — Recite (listening) mode.
// Uses globals from the main script: state, ui, Q, JUZ, PAGES, render, esc, arNum, surahName, ayahText,
// surahOptions, juzRange, pageRange, pageOf, juzOf, markAyah, gradeEntry, isStrong, TYPES, toast, saveSettings, key.
"use strict";
let W = null; // engine word index
const RS = {
  model: "idle", // idle | loading | warming | ready | error
  progress: 0, loadedMB: 0, totalMB: 0, backend: "", err: "", note: "",
  worker: null, phase: "setup", // setup | live | finishing | review
  sess: null, heardLog: [], jumpMsg: "", queue: [], busy: false, segId: 0,
  lastMs: 0, review: null, paused: false, startedAt: 0, wakeLock: null, micErr: ""
};
const REC = { ctx: null, stream: null, node: null, src: null, rate: 16000, frames: [], pre: [], speaking: false,
  silenceMs: 0, segMs: 0, voicedMs: 0, noise: 0.004, above: 0 };

function engineReady() { if (!W) W = HifzEngine.buildIndex(Q); return W; }

// ---------- Model ----------
function ensureWorker() {
  if (RS.worker) return RS.worker;
  const w = new Worker("asr-worker.js", { type: "module" });
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "progress") {
      RS.model = "loading"; RS.loadedMB = m.loaded / 1048576; RS.totalMB = m.total / 1048576;
      RS.progress = m.total ? m.loaded / m.total : 0; throttleRender();
    } else if (m.type === "warming") { RS.model = "warming"; reciteRender(); }
    else if (m.type === "note") { RS.note = m.msg; }
    else if (m.type === "ready") {
      RS.model = "ready"; RS.backend = m.device === "webgpu" ? "Fast mode (phone GPU)" : "Standard mode";
      state.settings.modelCached = true; saveSettings(); reciteRender();
    } else if (m.type === "error") { RS.model = "error"; RS.err = m.msg; reciteRender(); }
    else if (m.type === "result") onResult(m);
  };
  w.onerror = (e) => { RS.model = "error"; RS.err = (e && e.message) || "The listening engine failed to start."; reciteRender(); };
  RS.worker = w; return w;
}
function loadModel() {
  if (RS.model === "loading" || RS.model === "warming" || RS.model === "ready") return;
  RS.model = "loading"; RS.err = ""; RS.progress = 0;
  ensureWorker().postMessage({ type: "load", pref: state.settings.modelPref || "fast" });
  reciteRender();
}
let _rt = 0;
function throttleRender() { const n = Date.now(); if (n - _rt > 250) { _rt = n; reciteRender(); } }

// ---------- Microphone + pause detection ----------
async function startMic() {
  REC.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  try { REC.ctx = new AudioContext({ sampleRate: 16000 }); } catch (e) { REC.ctx = new AudioContext(); }
  REC.rate = REC.ctx.sampleRate;
  const code = "class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('hifz-cap',C)";
  await REC.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
  REC.src = REC.ctx.createMediaStreamSource(REC.stream);
  REC.node = new AudioWorkletNode(REC.ctx, "hifz-cap");
  REC.node.port.onmessage = (e) => onFrame(e.data);
  const g = REC.ctx.createGain(); g.gain.value = 0;
  REC.src.connect(REC.node); REC.node.connect(g); g.connect(REC.ctx.destination);
  REC.frames = []; REC.pre = []; REC.speaking = false; REC.silenceMs = 0; REC.segMs = 0; REC.voicedMs = 0; REC.above = 0;
}
function stopMic() {
  try { REC.src && REC.src.disconnect(); REC.node && REC.node.disconnect(); } catch (e) {}
  try { REC.stream && REC.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { REC.ctx && REC.ctx.close(); } catch (e) {}
  REC.ctx = REC.stream = REC.node = REC.src = null;
}
function onFrame(f) {
  if (RS.paused || RS.phase !== "live") return;
  const ms = f.length / REC.rate * 1000;
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length);
  const thr = Math.max(0.01, REC.noise * 3);
  if (!REC.speaking) {
    REC.noise = Math.max(0.002, REC.noise * 0.98 + rms * 0.02);
    REC.pre.push(f); let preMs = REC.pre.length * ms; while (preMs > 300) { REC.pre.shift(); preMs -= ms; }
    if (rms > thr) { REC.above += ms; if (REC.above > 40) { REC.speaking = true; REC.frames = REC.pre.slice(); REC.pre = []; REC.segMs = REC.frames.length * ms; REC.silenceMs = 0; REC.voicedMs = REC.above; } }
    else REC.above = 0;
    return;
  }
  REC.frames.push(f); REC.segMs += ms;
  if (rms < thr * 0.7) REC.silenceMs += ms; else { REC.silenceMs = 0; REC.voicedMs += ms; }
  const endByPause = REC.silenceMs > 650 && REC.segMs > 1000;
  const endByLength = (REC.segMs > 20000 && REC.silenceMs > 150) || REC.segMs > 27000;
  if (endByPause || endByLength) cutSegment();
}
function cutSegment() {
  const frames = REC.frames; const voiced = REC.voicedMs;
  REC.frames = []; REC.speaking = false; REC.segMs = 0; REC.silenceMs = 0; REC.voicedMs = 0; REC.above = 0;
  if (voiced < 350 || !frames.length) return;
  let len = 0; for (const f of frames) len += f.length;
  let buf = new Float32Array(len); let o = 0; for (const f of frames) { buf.set(f, o); o += f.length; }
  if (REC.rate !== 16000) buf = resample(buf, REC.rate, 16000);
  RS.queue.push({ id: ++RS.segId, audio: buf });
  pump(); reciteRenderStatus();
}
function resample(x, from, to) {
  const r = from / to, n = Math.floor(x.length / r), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * r, i0 = Math.floor(p), t = p - i0; y[i] = (x[i0] || 0) * (1 - t) + (x[i0 + 1] || 0) * t; }
  return y;
}
function pump() {
  if (RS.busy || !RS.queue.length || RS.model !== "ready") return;
  const seg = RS.queue.shift(); RS.busy = true;
  RS.worker.postMessage({ type: "run", id: seg.id, audio: seg.audio }, [seg.audio.buffer]);
}
function onResult(m) {
  RS.busy = false; RS.lastMs = m.ms || 0;
  const text = (m.text || "").trim();
  if (text && RS.sess) {
    const r = HifzEngine.feed(RS.sess, text);
    RS.heardLog.unshift(text); RS.heardLog = RS.heardLog.slice(0, 3);
    if (r.jump) { const to = W.s[r.jump.to] + ":" + W.a[r.jump.to], at = W.s[r.jump.at] + ":" + W.a[r.jump.at];
      RS.jumpMsg = `That sounded like ${surahName(W.s[r.jump.to])} ${to} — you should be at ${at}.`;
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]); }
    else if (r.changed.length) RS.jumpMsg = "";
    if (r.changed.some(e => RS.sess.status[e] === "wrong" || RS.sess.status[e] === "skip") && navigator.vibrate) navigator.vibrate(60);
  }
  pump();
  if (RS.phase === "finishing" && !RS.busy && !RS.queue.length) return toReview();
  if (RS.phase === "live" || RS.phase === "finishing") reciteRenderLive();
}

// ---------- Session control ----------
function recStart() {
  const r = ui.rec; let st;
  if (r.mode === "page") st = pageRange(r.page).st;
  else if (r.mode === "juz") st = juzRange(r.juz).st;
  else st = [r.s, Math.max(1, Math.min(r.a, Q[r.s - 1][2].length))];
  engineReady();
  RS.sess = HifzEngine.createSession(W, W.ayahStart[st[0] + ":" + st[1]]);
  RS.heardLog = []; RS.jumpMsg = ""; RS.queue = []; RS.micErr = ""; RS.paused = false;
  startMic().then(() => {
    RS.phase = "live"; RS.startedAt = Date.now();
    try { navigator.wakeLock && navigator.wakeLock.request("screen").then(l => RS.wakeLock = l).catch(() => {}); } catch (e) {}
    reciteRender(); window.scrollTo(0, 0);
  }).catch((e) => {
    RS.micErr = (e && e.name === "NotAllowedError") ? "Microphone permission was refused. Allow it for this site in Chrome's settings and try again." : "Couldn't open the microphone: " + ((e && e.message) || e);
    reciteRender();
  });
}
function recFinish() {
  if (REC.speaking) cutSegment();
  stopMic();
  try { RS.wakeLock && RS.wakeLock.release(); } catch (e) {}
  RS.phase = "finishing";
  if (!RS.busy && !RS.queue.length) toReview(); else reciteRender();
}
function toReview() {
  const sum = HifzEngine.summarise(RS.sess);
  const issues = sum.filter(r => r.type);
  const clean = sum.filter(r => !r.type && r.ok >= Math.ceil(r.total * 0.8));
  const cleanWeak = clean.filter(r => { const e = state.weak[key(r.s, r.a)]; return e && !isStrong(e); });
  RS.review = { issues: issues.map(r => Object.assign(r, { take: !!r.confident })), clean, cleanWeak, takeClean: true };
  RS.phase = "review"; reciteRender(); window.scrollTo(0, 0);
}
function applyReview() {
  const R = RS.review; let n = 0;
  for (const r of R.issues) if (r.take) { markAyah(r.s, r.a, r.type, r.type === "mixed" ? r.jumpTo : ""); n++; }
  let c = 0;
  if (R.takeClean) for (const r of R.cleanWeak) { if (!R.issues.find(x => x.take && x.key === r.key)) { gradeEntry(key(r.s, r.a), 2); c++; } }
  RS.phase = "setup"; RS.sess = null; RS.review = null;
  toast(n || c ? `${n ? n + " flagged" : ""}${n && c ? " · " : ""}${c ? c + " weak āyāt reviewed" : ""}` : "Nothing to add");
  ui.tab = "today"; render(); window.scrollTo(0, 0);
}

// ---------- Rendering ----------
function reciteRender() { if (ui.tab === "recite" && !ui.session) render(); }
function reciteRenderStatus() { const el = document.getElementById("rStatus"); if (el) el.innerHTML = statusHtml(); }
function heardHtml() { return RS.heardLog[0] ? 'Heard: <span class="ar" style="font-size:16px">' + esc(RS.heardLog[0]) + "</span>" : "Start reciting whenever you're ready. Pause briefly between āyāt."; }
function jumpHtml() { return RS.jumpMsg ? `<div class="jump">${esc(RS.jumpMsg)}</div>` : ""; }
function reciteRenderLive() {
  const el = document.getElementById("rLive"); if (el) { el.innerHTML = liveHtml(); scrollCurrent(); }
  const h = document.getElementById("rHeard"); if (h) h.innerHTML = heardHtml();
  const j = document.getElementById("rJump"); if (j) j.innerHTML = jumpHtml();
  reciteRenderStatus();
}
function statusHtml() {
  if (RS.phase === "finishing") return `<span class="dot busy"></span> Finishing — checking the last part…`;
  if (RS.paused) return `<span class="dot"></span> Paused`;
  const q = RS.queue.length + (RS.busy ? 1 : 0);
  return `<span class="dot ${REC.speaking ? "on" : ""}"></span> ${REC.speaking ? "Hearing you…" : "Listening"}${q ? ` · checking ${q} part${q > 1 ? "s" : ""}` : ""}`;
}
function wordSpan(e, hide) {
  const st = RS.sess.status[e]; const t = esc(W.text[e]);
  if (st === "ok") return `<span class="rw ok">${t}</span>`;
  if (st === "wrong") return `<span class="rw bad" title="Heard: ${esc(RS.sess.heard[e] || "")}">${t}</span>`;
  if (st === "skip") return `<span class="rw skip">${t}</span>`;
  if (st === "hint") return `<span class="rw hint">${t}</span>`;
  const cur = e === RS.sess.ptr ? " cur" : "";
  return hide ? `<span class="rw hidden${cur}">${t}</span>` : `<span class="rw todo${cur}">${t}</span>`;
}
function liveHtml() {
  const S = RS.sess, hide = ui.rec.hide;
  const ptr = Math.min(S.ptr, W.n - 1);
  const startK = W.s[S.start] + ":" + W.a[S.start];
  // show from max(start ayah, 8 āyāt before current) to the āyah after current
  let ay = []; let e = W.ayahStart[startK];
  const curK = W.s[ptr] + ":" + W.a[ptr];
  while (e < W.n) { const k = W.s[e] + ":" + W.a[e]; ay.push(k); if (k === curK) break; e = W.ayahEnd[k]; }
  const nextE = W.ayahEnd[curK]; if (nextE < W.n) ay.push(W.s[nextE] + ":" + W.a[nextE]);
  ay = ay.slice(-9);
  let html = ""; let lastS = 0;
  for (const k of ay) {
    const [s, a] = k.split(":").map(Number);
    if (s !== lastS && a === 1) html += `<div class="rsurah">${esc(surahName(s))} · <span class="ar" style="font-size:19px">${esc(Q[s - 1][0])}</span></div>`;
    lastS = s;
    let ws = ""; for (let i = W.ayahStart[k]; i < W.ayahEnd[k]; i++) ws += wordSpan(i, hide) + " ";
    html += `<div class="ar rayah ${k === curK ? "now" : ""}" ${k === curK ? 'id="rCur"' : ""}>${ws}<span class="num">﴿${arNum(a)}﴾</span></div>`;
  }
  return html;
}
function scrollCurrent() { const c = document.getElementById("rCur"); if (c) c.scrollIntoView({ block: "center", behavior: "smooth" }); }
function startPicker() {
  const r = ui.rec;
  const chip = (m, l) => `<button class="chip ${r.mode === m ? "on" : ""}" data-act="r-mode" data-m="${m}">${l}</button>`;
  let h = `<div class="chips" style="margin-bottom:12px">${chip("page", "Page")}${chip("juz", "Juz")}${chip("surah", "Surah")}</div><div class="controls">`;
  if (r.mode === "page") h += `<label class="f full">Start page — 15-line Madani (1–604)<input type="number" inputmode="numeric" min="1" max="604" value="${r.page}" data-act="r-page"></label>`;
  else if (r.mode === "juz") h += `<label class="f full">Start of juz<select data-act="r-juz">${Array.from({ length: 30 }, (_, i) => `<option value="${i + 1}" ${r.juz === i + 1 ? "selected" : ""}>Juz ${i + 1}</option>`).join("")}</select></label>`;
  else h += `<label class="f full">Surah<select data-act="r-surah">${surahOptions(r.s)}</select></label><label class="f full">From āyah<input type="number" inputmode="numeric" min="1" value="${r.a}" data-act="r-ayah"></label>`;
  h += `<label class="toggle full" style="margin-top:4px"><input type="checkbox" data-act="r-hide" ${r.hide ? "checked" : ""}> Hide the text — words appear as you recite them</label></div>`;
  return h;
}
function modelCard() {
  const pref = state.settings.modelPref || "fast";
  if (RS.model === "ready") return `<div class="card row between"><div><b>Listening engine ready</b><div class="small muted">${esc(RS.backend)}${RS.note ? " · " + esc(RS.note) : ""}</div></div><span class="pill strong">Ready</span></div>`;
  if (RS.model === "loading") {
    const pct = Math.round(RS.progress * 100);
    return `<div class="card"><b>${state.settings.modelCached ? "Loading the listening engine…" : "Downloading the listening engine…"}</b>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="small muted">${RS.totalMB ? `${RS.loadedMB.toFixed(0)} of ${RS.totalMB.toFixed(0)} MB` : "Starting…"} · keep this screen open</div></div>`;
  }
  if (RS.model === "warming") return `<div class="card"><b>Getting ready…</b><div class="small muted">Preparing the engine on your phone. First time takes a little longer.</div></div>`;
  const err = RS.model === "error" ? `<div class="small danger" style="margin-top:8px">Couldn't load: ${esc(RS.err)}</div>` : "";
  return `<div class="card"><b>Listening engine</b>
    <div class="small muted" style="margin:4px 0 10px;line-height:1.5">A Quran recitation model runs on your phone, so your voice never leaves it. It downloads once — use Wi-Fi.</div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${pref === "fast" ? "on" : ""}" data-act="r-pref" data-v="fast">Fast · ~200 MB</button>
      <button class="chip ${pref === "small" ? "on" : ""}" data-act="r-pref" data-v="small">Smaller · ~100 MB</button></div>
    <div class="small muted" style="margin-bottom:10px">Fast uses your phone's graphics chip (recent Android + Chrome). Smaller works everywhere but checks each part more slowly.</div>
    <button class="btn block" data-act="r-load">${state.settings.modelCached ? "Load listening engine" : "Download listening engine"}</button>${err}</div>`;
}
function renderRecite() {
  engineReady();
  if (!ui.rec) ui.rec = { mode: "page", page: 1, juz: 1, s: 1, a: 1, hide: true };
  if (state.settings.modelCached && RS.model === "idle") setTimeout(loadModel, 0);
  if (RS.phase === "live" || RS.phase === "finishing") {
    const el = Math.floor((Date.now() - RS.startedAt) / 1000);
    view.innerHTML = `<div class="rbar"><div id="rStatus" class="small">${statusHtml()}</div><div class="small muted">${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")}</div></div>
      <div id="rJump">${jumpHtml()}</div>
      <div id="rLive" class="rlive">${liveHtml()}</div>
      <div id="rHeard" class="small muted heard">${heardHtml()}</div>
      <div class="rctl">
        <button class="btn ghost" data-act="r-hint" ${RS.phase !== "live" ? "disabled" : ""}>Hint</button>
        <button class="btn plain" data-act="r-pause" ${RS.phase !== "live" ? "disabled" : ""}>${RS.paused ? "Resume" : "Pause"}</button>
        <button class="btn" data-act="r-finish" ${RS.phase !== "live" ? "disabled" : ""}>Finish</button>
      </div>`;
    setTimeout(scrollCurrent, 50);
    return;
  }
  if (RS.phase === "review") return renderReview();
  view.innerHTML = `<h2>Recite from memory</h2>${modelCard()}
    <h2>Where are you starting?</h2><div class="card">${startPicker()}</div>
    ${RS.micErr ? `<p class="small danger">${esc(RS.micErr)}</p>` : ""}
    <div style="margin-top:12px"><button class="btn block" data-act="r-start" ${RS.model === "ready" ? "" : "disabled"}>Start listening</button></div>
    <p class="muted small" style="margin-top:14px;line-height:1.55">Recite normally and pause briefly between āyāt. Words turn <span class="rw ok">green</span> when heard correctly, <span class="rw bad">red</span> when different, and <span class="rw skip">amber</span> if skipped. If you jump to a similar āyah, the phone buzzes. Nothing is flagged until you review it at the end, because the engine can mishear, especially with background noise or a very fast pace.</p>`;
}
function renderReview() {
  const R = RS.review;
  const typeSel = (r, i) => `<select data-act="r-rtype" data-i="${i}" style="padding:5px 8px;font-size:13px">${Object.entries(TYPES).map(([t, v]) => `<option value="${t}" ${r.type === t ? "selected" : ""}>${v.label}</option>`).join("")}</select>`;
  const desc = (r) => { const p = []; if (r.jumpTo) p.push("went to " + r.jumpTo); if (r.skip) p.push(r.skip + " word" + (r.skip > 1 ? "s" : "") + " skipped"); if (r.wrong) p.push(r.wrong + " word" + (r.wrong > 1 ? "s" : "") + " different"); if (r.hint) p.push("used a hint"); return p.join(" · "); };
  const ayahHtml = (r) => { let h = ""; for (let i = W.ayahStart[r.key]; i < W.ayahEnd[r.key]; i++) { const st = RS.sess.status[i]; const cls = st === "wrong" ? "bad" : st === "skip" ? "skip" : st === "hint" ? "hint" : ""; h += `<span class="rw ${cls}">${esc(W.text[i])}</span> `; } return h; };
  view.innerHTML = `<h2>Review your recitation</h2>
  <div class="card"><b>${R.issues.length ? R.issues.length + " āyah" + (R.issues.length > 1 ? "āt" : "") + " with possible slips" : "No slips heard — mā shā’ Allāh"}</b>
  <div class="small muted" style="margin-top:4px">${R.clean.length} āyāt recited cleanly. Untick anything the app misheard.</div></div>
  ${R.issues.map((r, i) => `<div class="ayah ${r.take ? "m-" + r.type : ""}" style="margin-top:8px">
    <div class="row between" style="margin-top:4px"><label class="toggle"><input type="checkbox" data-act="r-take" data-i="${i}" ${r.take ? "checked" : ""}><b>${esc(surahName(r.s))} ${r.key}</b></label>${typeSel(r, i)}</div>
    <div class="small muted" style="margin:2px 0 0 26px">${desc(r)}${!r.confident ? " · may be the app mishearing" : ""}</div>
    <div class="ar" style="font-size:22px">${ayahHtml(r)}</div></div>`).join("")}
  ${R.cleanWeak.length ? `<label class="toggle card" style="margin-top:10px"><input type="checkbox" data-act="r-takeclean" ${R.takeClean ? "checked" : ""}> Count ${R.cleanWeak.length} weak āyah${R.cleanWeak.length > 1 ? "āt" : ""} you recited cleanly as a solid review</label>` : ""}
  <div class="row" style="gap:8px;margin-top:14px"><button class="btn plain block" data-act="r-discard">Discard</button><button class="btn block" data-act="r-apply">Save to weak list</button></div>`;
}

// ---------- Events ----------
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act^='r-']"); if (!el) return;
  const a = el.dataset.act;
  if (a === "r-load") loadModel();
  else if (a === "r-pref") { state.settings.modelPref = el.dataset.v; saveSettings(); reciteRender(); }
  else if (a === "r-mode") { ui.rec.mode = el.dataset.m; reciteRender(); }
  else if (a === "r-start") recStart();
  else if (a === "r-finish") recFinish();
  else if (a === "r-pause") { RS.paused = !RS.paused; if (RS.paused && REC.speaking) cutSegment(); reciteRender(); }
  else if (a === "r-hint") { const e = HifzEngine.hint(RS.sess); if (e >= 0) reciteRenderLive(); }
  else if (a === "r-apply") applyReview();
  else if (a === "r-discard") { RS.phase = "setup"; RS.sess = null; RS.review = null; reciteRender(); }
});
document.addEventListener("change", (ev) => {
  const el = ev.target; const a = el.dataset && el.dataset.act; if (!a || !a.startsWith("r-")) return;
  const r = ui.rec;
  if (a === "r-page") r.page = Math.max(1, Math.min(604, +el.value || 1));
  else if (a === "r-juz") r.juz = +el.value;
  else if (a === "r-surah") { r.s = +el.value; r.a = 1; reciteRender(); }
  else if (a === "r-ayah") r.a = Math.max(1, +el.value || 1);
  else if (a === "r-hide") r.hide = el.checked;
  else if (a === "r-take") { RS.review.issues[+el.dataset.i].take = el.checked; renderReview(); }
  else if (a === "r-rtype") RS.review.issues[+el.dataset.i].type = el.value;
  else if (a === "r-takeclean") RS.review.takeClean = el.checked;
});
setInterval(() => { if (RS.phase === "live" && ui.tab === "recite") { const b = document.querySelector(".rbar .muted"); if (b) { const el = Math.floor((Date.now() - RS.startedAt) / 1000); b.textContent = Math.floor(el / 60) + ":" + String(el % 60).padStart(2, "0"); } reciteRenderStatus(); } }, 1000);
window.addEventListener("beforeunload", (e) => { if (RS.phase === "live") { e.preventDefault(); e.returnValue = ""; } });
