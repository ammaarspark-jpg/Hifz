// Hifz Revision — recitation matching engine.
// Turns what the speech model heard into per-word results against the expected Quran text.
// Works on a letter "skeleton" (no diacritics, unified alif/ya/ta-marbuta, alif removed)
// so differences between Uthmani spelling and ordinary spelling don't count as mistakes.
(function (root) {
  "use strict";
  const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿـ]/g;
  function skeleton(w) {
    return w
      .replace(MARKS, "")
      .replace(/[ٱأإآا]/g, "")      // alif and its forms: the main Uthmani/imla'i difference
      .replace(/[ىئ]/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ة/g, "ه")
      .replace(/ء/g, "")
      .replace(/[^ء-ي]/g, "");
  }
  function displayWords(t) { return t.replace(/[۞۩]/g, "").split(/\s+/).filter(Boolean); }

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  function similar(a, b) {
    if (!a || !b) return a === b && a !== undefined;
    if (a === b) return true;
    const L = Math.max(a.length, b.length);
    if (L <= 2) return false;
    const d = lev(a, b);
    return L <= 4 ? d <= 1 : d / L <= 0.25;
  }

  // ---- Global word list ----
  // Q = [[name, translit, [verseText...]], ...]
  function buildIndex(Q) {
    const W = { s: [], a: [], text: [], sk: [], ayahStart: {}, ayahEnd: {} };
    for (let si = 0; si < Q.length; si++) {
      const vs = Q[si][2];
      for (let ai = 0; ai < vs.length; ai++) {
        const k = (si + 1) + ":" + (ai + 1);
        W.ayahStart[k] = W.s.length;
        for (const w of displayWords(vs[ai])) {
          W.s.push(si + 1); W.a.push(ai + 1); W.text.push(w); W.sk.push(skeleton(w));
        }
        W.ayahEnd[k] = W.s.length; // exclusive
      }
    }
    W.n = W.s.length;
    W.tri = null;
    return W;
  }
  function triIndex(W) {
    if (W.tri) return W.tri;
    const m = new Map();
    for (let i = 0; i + 2 < W.n; i++) {
      const key = W.sk[i] + " " + W.sk[i + 1] + " " + W.sk[i + 2];
      let arr = m.get(key); if (!arr) { arr = []; m.set(key, arr); }
      if (arr.length < 50) arr.push(i);
    }
    W.tri = m; return m;
  }
  // Where in the whole Quran does this heard text best fit? Returns {pos, end, votes} or null.
  function locate(W, hypSk) {
    const tri = triIndex(W);
    const votes = new Map();
    for (let i = 0; i + 2 < hypSk.length; i++) {
      const hits = tri.get(hypSk[i] + " " + hypSk[i + 1] + " " + hypSk[i + 2]);
      if (!hits) continue;
      for (const p of hits) {
        const start = p - i; // implied start of the hypothesis
        const b = Math.round(start / 4); // tolerate small drift
        const v = votes.get(b) || { n: 0, start, last: p + 3 };
        v.n++; v.last = Math.max(v.last, p + 3); votes.set(b, v);
      }
    }
    let best = null;
    for (const v of votes.values()) if (!best || v.n > best.n) best = v;
    if (!best || best.n < 2) return null;
    return { pos: Math.max(0, best.start), end: Math.min(W.n, best.last), votes: best.n };
  }

  // ---- Session ----
  // A session tracks a pointer into the global word list and per-word status:
  // 'ok' | 'wrong' | 'skip' | 'hint'. Heard words that didn't fit are kept as 'extra'.
  function createSession(W, startIdx) {
    return { W, start: startIdx, ptr: startIdx, status: {}, heard: {}, jumps: [], log: [] };
  }

  const BACK = 10, AHEAD = 90;
  // Align heard skeleton words H against expected window; returns ops.
  function alignWindow(W, ptr, H) {
    const lo = Math.max(0, ptr - BACK), hi = Math.min(W.n, ptr + AHEAD);
    const E = W.sk.slice(lo, hi);
    const back = ptr - lo;
    const n = H.length, m = E.length;
    const INF = 1e9;
    const C = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
    const B = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)); // backpointer op
    // free start anywhere in the "back" zone (re-reciting) or exactly at ptr; skipping ahead costs
    for (let j = 0; j <= m; j++) { C[0][j] = j <= back ? 0 : (j - back); B[0][j] = j <= back ? 9 : 2; }
    const isRepeat = (h, j) => { for (let k = Math.max(0, j - 8); k < j; k++) if (similar(h, E[k])) return true; return false; };
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        let best = INF, op = 0;
        // insertion: heard word not in text (repeat of recent words is cheap)
        const ins = C[i - 1][j] + (i < n && isRepeat(H[i - 1], j) ? 0.3 : 1); // restarting a few words back is common; a trailing repeat is not
        if (ins < best) { best = ins; op = 1; }
        if (j > 0) {
          // deletion: expected word not heard (skipped)
          const del = C[i][j - 1] + (j <= back ? 0 : 1);
          if (del < best) { best = del; op = 2; }
          // match / substitution
          const sub = C[i - 1][j - 1] + (similar(H[i - 1], E[j - 1]) ? 0 : 1);
          if (sub < best) { best = sub; op = 3; }
          // two heard words = one written word (e.g. يا أيها / يٰأيها)
          if (i > 1 && similar(H[i - 2] + H[i - 1], E[j - 1])) {
            const v = C[i - 2][j - 1]; if (v < best) { best = v; op = 4; }
          }
          // one heard word = two written words
          if (j > 1 && similar(H[i - 1], E[j - 2] + E[j - 1])) {
            const v = C[i - 1][j - 2]; if (v < best) { best = v; op = 5; }
          }
        }
        C[i][j] = best; B[i][j] = op;
      }
    }
    // free end: pick the end with lowest cost; on ties prefer further along
    let jBest = 0, cBest = INF;
    for (let j = 0; j <= m; j++) if (C[n][j] <= cBest) { cBest = C[n][j]; jBest = j; }
    // backtrack
    const ops = []; let i = n, j = jBest;
    while (i > 0 || j > 0) {
      const op = i === 0 ? B[0][j] : B[i][j];
      if (op === 9) break;
      if (op === 1) { ops.push({ t: "extra", h: i - 1 }); i--; }
      else if (op === 2) { ops.push({ t: "skip", e: lo + j - 1 }); j--; }
      else if (op === 3) { ops.push({ t: similar(H[i - 1], E[j - 1]) ? "ok" : "wrong", e: lo + j - 1, h: i - 1 }); i--; j--; }
      else if (op === 4) { ops.push({ t: "ok", e: lo + j - 1, h: i - 2 }); i -= 2; j--; }
      else if (op === 5) { ops.push({ t: "ok", e: lo + j - 2, h: i - 1 }); ops.push({ t: "ok", e: lo + j - 1, h: i - 1 }); i--; j -= 2; }
      else break;
    }
    ops.reverse();
    const matched = ops.filter(o => o.t === "ok").length;
    return { ops, cost: cBest, end: lo + jBest, matched };
  }

  // Feed one recognised segment. Returns a summary of what changed.
  function feed(sess, heardText) {
    const W = sess.W;
    const raw = heardText.split(/\s+/).filter(Boolean);
    const H = raw.map(skeleton).filter(Boolean);
    const res = { heard: heardText, changed: [], jump: null, ignored: false };
    if (!H.length) { res.ignored = true; return res; }
    const al = alignWindow(W, sess.ptr, H);
    const ratio = al.matched / H.length;
    if (H.length >= 3 && ratio < 0.4) {
      // Doesn't fit where we expected — find where it does fit.
      const loc = locate(W, H);
      if (loc) {
        const sameSurahAhead = loc.pos > sess.ptr && W.s[loc.pos] === W.s[sess.ptr] && loc.pos - sess.ptr < 400;
        if (sameSurahAhead) {
          // Skipped ahead: everything between pointer and the new place was skipped.
          for (let e = sess.ptr; e < loc.pos; e++) if (!sess.status[e]) { sess.status[e] = "skip"; res.changed.push(e); }
          for (let e = loc.pos; e < loc.end; e++) { if (!sess.status[e] || sess.status[e] === "skip") sess.status[e] = "ok"; res.changed.push(e); }
          sess.ptr = loc.end;
        } else if (Math.abs(loc.pos - sess.ptr) > 3) {
          // Went somewhere else entirely — most likely a similar āyah (mutashābih).
          const j = { at: sess.ptr, to: loc.pos };
          sess.jumps.push(j); res.jump = j;
        }
      } else res.ignored = true;
      sess.log.push(res);
      return res;
    }
    for (const o of al.ops) {
      if (o.e === undefined || o.e < sess.ptr) continue; // re-recited earlier words: leave earlier results
      const prev = sess.status[o.e];
      if (o.t === "ok") { if (prev !== "hint") sess.status[o.e] = "ok"; }
      else if (o.t === "wrong") { if (!prev || prev === "skip") { sess.status[o.e] = "wrong"; sess.heard[o.e] = raw[o.h] || ""; } }
      else if (o.t === "skip") { if (!prev) sess.status[o.e] = "skip"; }
      res.changed.push(o.e);
    }
    // Trailing words the model didn't reach yet are not "skipped": trim skips at the very end.
    let end = al.end;
    while (end > sess.ptr && sess.status[end - 1] === "skip") { delete sess.status[end - 1]; end--; }
    sess.ptr = Math.max(sess.ptr, end);
    sess.log.push(res);
    return res;
  }

  function hint(sess) {
    const e = sess.ptr;
    if (e >= sess.W.n) return -1;
    sess.status[e] = "hint";
    return e;
  }

  // Ayah-level summary for review.
  function summarise(sess) {
    const W = sess.W; const byAyah = new Map();
    const touch = (k) => { let r = byAyah.get(k); if (!r) { r = { key: k, s: +k.split(":")[0], a: +k.split(":")[1], ok: 0, wrong: 0, skip: 0, hint: 0, jumpTo: "" }; byAyah.set(k, r); } return r; };
    for (let e = sess.start; e < sess.ptr; e++) {
      const st = sess.status[e]; if (!st) continue;
      touch(W.s[e] + ":" + W.a[e])[st]++;
    }
    for (const j of sess.jumps) {
      const r = touch(W.s[j.at] + ":" + W.a[j.at]);
      r.jumpTo = W.s[j.to] + ":" + W.a[j.to];
    }
    const out = [];
    for (const r of byAyah.values()) {
      const total = W.ayahEnd[r.key] - W.ayahStart[r.key];
      r.total = total;
      const issues = r.wrong + r.skip + r.hint + (r.jumpTo ? 1 : 0);
      if (!issues) { r.type = ""; out.push(r); continue; }
      if (r.jumpTo) r.type = "mixed";
      else if (r.skip >= Math.max(3, total / 2) || r.wrong + r.skip >= 4) r.type = "forgot";
      else r.type = "hesitated";
      // a single misheard word is often the app, not you
      r.confident = r.jumpTo || r.skip >= 2 || r.wrong + r.skip + r.hint >= 2 || r.hint > 0;
      out.push(r);
    }
    out.sort((x, y) => x.s - y.s || x.a - y.a);
    return out;
  }

  root.HifzEngine = { skeleton, displayWords, similar, buildIndex, createSession, feed, hint, summarise, locate };
})(typeof window !== "undefined" ? window : globalThis);
