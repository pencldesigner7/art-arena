/* ============================================================================
 * ART ARENA v43 — matchmaking "searching" layer (window.MmScanWrap)
 * ============================================================================
 * The planet scanner. v42 shipped this WRONG twice, per the user's report:
 * dots spawned across the WHOLE matchmaking card (not on the planet) and
 * they ACCUMULATED into a field of up to 16. The intended (and now actual)
 * behaviour:
 *   searching  — ONE small light-blue glowing dot at a time, ON THE PLANET
 *                (inside the globe layer's circle). It drifts gently; the
 *                moment the NEXT dot appears somewhere else on the planet,
 *                the previous one fades away — a scanning beacon hopping
 *                across the globe (~1 s apart, never a burst, never a
 *                field of dots, never on the surrounding card);
 *   connected  — the moment a player is found, the current dot STOPS on
 *                the planet and smoothly shifts from light blue to light
 *                green (the connection is established) and holds with a
 *                very gentle breathing glow;
 *   off        — everything fades out (failed / cancelled / view left).
 * Canvas-based, dependency-free, DPR-aware, full dispose (no leaks).
 * The layer is inert without a 2D context (jsdom/headless safety).
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SEARCH = { r: 137, g: 201, b: 255 }; // light blue  (#89C9FF)
  const LINKED = { r: 127, g: 224, b: 168 }; // light green (#7FE0A8 — the app's "found" accent)

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function MmScan(canvas, host, opts) {
    this.canvas = canvas;
    this.host = host || (canvas ? canvas.parentElement : null);
    // maxDots/linkedDots kept for call-compat; v43 is a single beacon, so
    // they no longer drive population.
    this.opts = Object.assign({ maxDots: 1, linkedDots: 1 }, opts || {});
    this.ctx = null;
    if (canvas && typeof canvas.getContext === 'function') {
      try { this.ctx = canvas.getContext('2d'); } catch (_) { this.ctx = null; }
    }
    this.dots = [];
    this.mode = 'off';
    this.running = false;
    this.raf = 0;
    this.lastT = 0;
    this.lastSpawn = 0;   // when the current beacon was born
    this.nextGap = 0;     // ms until the next beacon replaces it
    this.nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    this.w = 0; this.h = 0;
    this.ro = null;
    if (!this.ctx || !this.host) return; // no 2D context (jsdom/headless) → inert
    const self = this;
    this._resize = () => self.resize();
    this.resize();
    if (typeof ResizeObserver === 'function') {
      try { this.ro = new ResizeObserver(this._resize); this.ro.observe(this.host); } catch (_) { this.ro = null; }
    }
    this._loop = (t) => self.frame(t);
  }

  MmScan.prototype.resize = function () {
    if (!this.ctx || !this.host) return;
    const w = this.host.clientWidth || 0;
    const h = this.host.clientHeight || 0;
    const dpr = (typeof devicePixelRatio === 'undefined') ? 1 : (devicePixelRatio || 1);
    if (w === 0 || h === 0) {
      this.w = 0; this.h = 0;
      this.canvas.width = 0; this.canvas.height = 0;
      return;
    }
    if (this.w > 0 && this.h > 0) {
      const sx = w / this.w, sy = h / this.h;
      for (const d of this.dots) { d.x *= sx; d.y *= sy; } // keep composition on resize
    }
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  MmScan.prototype.setMode = function (mode) {
    if (mode !== 'search' && mode !== 'connected' && mode !== 'off') return;
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'connected') {
      // The beacon freezes where it is ON THE PLANET and turns light green.
      for (const d of this.dots) {
        if (!d.linked) {
          d.linked = true;
          d.linkT0 = this.nowT;
          d.from = { r: d.color.r, g: d.color.g, b: d.color.b };
          d.targetA = rand(0.6, 0.8);
        }
        d.vx = 0; d.vy = 0; // the active dot stops moving
      }
    }
    if (mode === 'off') {
      for (const d of this.dots) d.dying = true;
    }
    this.start();
  };

  // A point ON THE PLANET: rejection-sampled inside the host's inscribed
  // circle (the globe layer is the square box around the round planet), with
  // a small inset so the beacon never clips the horizon.
  MmScan.prototype.pointOnPlanet = function () {
    const cx = this.w / 2, cy = this.h / 2;
    const rad = Math.min(this.w, this.h) / 2;
    const inset = rad * 0.16; // keep clear of the very rim
    const maxR = rad - inset;
    let x = 0, y = 0;
    for (let i = 0; i < 24; i++) {
      x = rand(0, this.w); y = rand(0, this.h);
      if (Math.hypot(x - cx, y - cy) <= maxR) return { x, y };
    }
    // fall back to a deterministic ring point (tiny/odd boxes)
    const a = rand(0, Math.PI * 2), rr = maxR * 0.7;
    return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
  };

  MmScan.prototype.spawn = function (t) {
    if (this.w < 20 || this.h < 20) return;
    // ONE beacon at a time: the new dot retires the previous one.
    for (const d of this.dots) if (!d.linked) d.dying = true;
    const linked = this.mode === 'connected';
    const p = this.pointOnPlanet();
    this.dots.push({
      x: p.x,
      y: p.y,
      r: rand(1.8, 3.1),
      a: 0,
      targetA: linked ? rand(0.6, 0.8) : rand(0.55, 0.85),
      color: linked
        ? { r: LINKED.r, g: LINKED.g, b: LINKED.b }
        : { r: SEARCH.r, g: SEARCH.g, b: SEARCH.b },
      from: null,
      linked: linked, // connected-mode dot fades in already green
      linkT0: t,
      born: t,
      life: rand(2.2, 3.4),  // natural end (the next spawn usually beats it)
      dying: false,
      vx: linked ? 0 : Math.cos(rand(0, Math.PI * 2)) * rand(3, 8),
      vy: linked ? 0 : Math.sin(rand(0, Math.PI * 2)) * rand(3, 8),
      wAmp: rand(1.5, 4),
      wPer: rand(2.5, 5),
      phase: rand(0, Math.PI * 2),
    });
  };

  MmScan.prototype.start = function () {
    if (this.running || !this.ctx) return;
    this.running = true;
    this.lastT = this.nowT;
    this.raf = requestAnimationFrame(this._loop);
  };

  MmScan.prototype.stop = function () {
    this.running = false;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  };

  MmScan.prototype.frame = function (t) {
    if (!this.running) return;
    this.nowT = t;
    const dt = Math.min(50, Math.max(0, t - this.lastT)) / 1000 || 0.016;
    this.lastT = t;

    // Population: a single beacon hopping across the planet. A new dot is
    // born only when the previous one has been alone for its full stint
    // (and instantly retires it), so exactly ONE light-blue dot is ever
    // clearly visible while searching.
    const alive = this.dots.filter((d) => !d.dying && !d.linked).length;
    if (this.mode === 'search' && this.w > 0 &&
        alive === 0 && t - this.lastSpawn > this.nextGap) {
      this.spawn(t);
      this.lastSpawn = t;
      this.nextGap = rand(850, 1400);
    }
    // Edge: 'connected' arriving between beacons (nothing alive to freeze).
    if (this.mode === 'connected' && this.dots.length === 0 && this.w > 0 && t - this.lastSpawn > 300) {
      this.spawn(t); // fades in already green, holds
      this.lastSpawn = t;
    }

    const keep = [];
    for (const d of this.dots) {
      if (!d.linked) {
        // SEARCH beacon: gentle drift + wobble, kept INSIDE the planet.
        if (this.mode === 'search' && !d.dying) {
          const wob = Math.cos(t / 1000 / d.wPer * Math.PI * 2 + d.phase) * d.wAmp * 0.4;
          d.x += (d.vx + wob) * dt;
          d.y += (d.vy - wob * 0.6) * dt;
          const cx = this.w / 2, cy = this.h / 2;
          const rad = Math.min(this.w, this.h) / 2 - rad_inset(this);
          const dx = d.x - cx, dy = d.y - cy;
          const dist = Math.hypot(dx, dy);
          if (dist > rad && dist > 0) { // steer back toward the centre
            d.x = cx + (dx / dist) * rad;
            d.y = cy + (dy / dist) * rad;
          }
        }
        if (this.mode === 'off') d.dying = true;
        const age = (t - d.born) / 1000;
        if (d.dying) d.a = Math.max(0, d.a - dt / 0.35 * (d.targetA + 0.2)); // quick handoff fade
        else if (age < 0.5) d.a = d.targetA * (age / 0.5);
        else if (age > d.life) d.a = Math.max(0, d.a - dt / 1.0 * (d.targetA + 0.2));
        else d.a = d.targetA;
      } else {
        // CONNECTED beacon: stationary on the planet, light blue → light
        // green, soft breathing glow.
        const k = clamp01((t - d.linkT0) / 1000);
        const f = d.from || d.color;
        d.color.r = lerp(f.r, LINKED.r, k);
        d.color.g = lerp(f.g, LINKED.g, k);
        d.color.b = lerp(f.b, LINKED.b, k);
        if (this.mode === 'off') d.a = Math.max(0, d.a - dt / 0.45 * (d.targetA + 0.2));
        else d.a = lerp(d.a, d.targetA, Math.min(1, dt * 2.5)) + Math.sin(t / 1000 * 2.1 + d.phase) * 0.05 * k;
      }
      // The 100 ms birth grace keeps a dot through its first frames
      // (alpha is still ~0 while the fade-in has just begun).
      if (d.a > 0.004 || t - d.born < 100) keep.push(d);
    }
    this.dots = keep;

    // Render: soft glow + dot (alpha clamped — it never paints > 1).
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const d of this.dots) {
      const alpha = Math.min(1, Math.max(0, d.a));
      const c = 'rgba(' + Math.round(d.color.r) + ',' + Math.round(d.color.g) + ',' + Math.round(d.color.b) + ',';
      ctx.shadowColor = c + alpha.toFixed(3) + ')';
      ctx.shadowBlur = d.r * 5;
      ctx.fillStyle = c + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    if (this.mode === 'off' && this.dots.length === 0) this.stop();
    else this.raf = requestAnimationFrame(this._loop);
  };

  function rad_inset(self) {
    return (Math.min(self.w, self.h) / 2) * 0.16; // same inset as pointOnPlanet
  }

  MmScan.prototype.dispose = function () {
    this.stop();
    if (this.ro) { try { this.ro.disconnect(); } catch (_) {} this.ro = null; }
    this.dots = [];
    this.mode = 'off';
    if (this.ctx && this.w > 0) { try { this.ctx.clearRect(0, 0, this.w, this.h); } catch (_) {} }
  };

  MmScan.create = function (canvas, host, opts) { return new MmScan(canvas, host, opts); };

  global.MmScanWrap = {
    create: MmScan.create,
    _test: { SEARCH, LINKED }, // shared constants for the port test
  };
})(typeof window !== 'undefined' ? window : globalThis);
