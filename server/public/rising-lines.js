// Rising Lines — vanilla port of the Originkit "custom-style" React component
// the user supplied (v48; replaces the Line Ripple homepage background).
//
// DARK preset (verbatim from the supplied code):
//   particles 130, color #EB00FF, riseSpeed 10, opacity 30, scale 6,
//   horizon ON (#C918F8 @ 85%), direction up.
// Physics are ported 1:1 — seeded Mulberry32 PRNG (0xC0FFEE), Irwin–Hall
// center-biased x sampling, spark trail heights (12% tall outliers), area-
// scaled counts (130 @ the 800×400 reference frame), position-based
// respawn, travel-progress triangular fade, dt clamped to [0.001, 0.05],
// DPR capped at 2. The only adaptation: the frame background is the app's
// page color instead of pure black (same look, no seam against the page).
//
// light background shows through. v50 (user request): the light streaks are
// now PINK — the Art Arena brand pink family (#FF3CAC stems, #FF49B8 horizon)
// at dark-parity opacity (brighter than the old violet, which read grey on
// white) — with deep-pink cores so bright cores don't wash out.
//
// setTheme('dark'|'light') swaps the palette LIVE — same canvas, same
// particles, no rebuild, no refresh.
(function () {
  'use strict';

  function parseColor(input) {
    if (!input) return [255, 255, 255];
    var s = String(input).trim();
    if (s.charAt(0) === '#') {
      var hex = s.slice(1);
      if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
      var num = parseInt(hex, 16);
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    }
    var m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var parts = m[1].split(',').map(function (p) { return parseFloat(p.trim()); });
      return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    }
    return [255, 255, 255];
  }

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  // The two palettes. `bg`: null → clear to transparent (light page shows
  // through); a color → the frame paints it opaque (dark, like the original).
  var PALETTES = {
    dark: {
      bg: '#09070d',            // the app's dark page color (original used #000)
      color: '#EB00FF',         // supplied preset
      horizonColor: '#C918F8',  // supplied default
      opacity: 0.30,            // supplied preset (30)
      horizonOpacity: 0.85,     // supplied default (85)
      core: [255, 255, 255]     // crisp white cores (supplied behavior)
    },
    light: {
      bg: null,                 // transparent — the light page is the backdrop
      color: '#FF3CAC',         // v50: Art Arena brand pink (was violet #A63CD8)
      horizonColor: '#FF49B8',  // v50: warm pink horizon glow
      opacity: 0.30,            // v50: dark-parity — brighter than the old 0.26
      horizonOpacity: 0.62,
      core: [214, 13, 130]      // v50: deep-pink cores (#D60D82)
    }
  };

  var PRESET = { particles: 130, riseSpeed: 10, scale: 6 };

  function RisingLines(host, opts) {
    opts = opts || {};
    this._host = host;
    this._theme = opts.theme || 'dark';
    this._particles = PRESET.particles;
    this._riseSpeed = PRESET.riseSpeed / 100;
    this._scale = PRESET.scale / 2;
    this._raf = null;
    this._ro = null;
    this._io = null;
    this._visible = true;
    this._lastT = 0;

    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    host.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    // seeded PRNG — Mulberry32, seed 0xC0FFEE (layout stable across reloads)
    var seed = 0xc0ffee >>> 0;
    this._rng = function () {
      seed = (seed + 0x6d2b79f5) >>> 0;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    var rng = this._rng;
    this._sampleCenterX = function (w) { return ((rng() + rng() + rng()) / 3) * w; };

    this._w = 1; this._h = 1;
    this._resize();
    this._initParticles();
    var self = this;
    this._ro = new ResizeObserver(function () { self._resize(); self._initParticles(); });
    this._ro.observe(host);
    this._io = new IntersectionObserver(function (entries) { self._visible = entries[0].isIntersecting; }, { threshold: 0.05 });
    this._io.observe(host);
    this._loop = this._loop.bind(this);
    this._lastT = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  RisingLines.prototype._resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(this._host.clientWidth || this._host.offsetWidth || 800));
    var h = Math.max(1, Math.floor(this._host.clientHeight || this._host.offsetHeight || 400));
    this._w = w; this._h = h;
    this._canvas.width = Math.floor(w * dpr);
    this._canvas.height = Math.floor(h * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  RisingLines.prototype._initParticles = function () {
    var w = this._w, h = this._h;
    var worldScale = Math.max(0.1, this._scale) / 3.5;
    var horizonY = h - 1;
    var rng = this._rng, sampleCenterX = this._sampleCenterX;
    var self = this;

    var sampleSparkHeight = function () {
      var tall;
      if (rng() < 0.12) tall = 70 + rng() * 30;
      else tall = 20 + Math.pow(rng(), 0.7) * 35;
      return Math.max(1, Math.floor(tall * worldScale));
    };

    var area = w * h, refArea = 800 * 400;
    var target = Math.max(0, Math.floor((this._particles * area) / refArea));
    var count = Math.min(target, 4000);
    this._pX = new Float32Array(count); this._pY = new Float32Array(count);
    this._pVY = new Float32Array(count); this._pH = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      this._pX[i] = sampleCenterX(w);
      this._pY[i] = horizonY - rng() * horizonY * 0.95;
      this._pVY[i] = 10 + rng() * 40;
      this._pH[i] = sampleSparkHeight();
    }
    var blobCount = Math.min(Math.max(0, Math.floor(target * 0.3)), 1200);
    this._bX = new Float32Array(blobCount); this._bY = new Float32Array(blobCount);
    this._bVY = new Float32Array(blobCount); this._bR = new Float32Array(blobCount);
    for (var j = 0; j < blobCount; j++) {
      this._bX[j] = sampleCenterX(w);
      this._bY[j] = horizonY - rng() * horizonY * 0.95;
      this._bVY[j] = 8 + rng() * 28;
      this._bR[j] = (1.5 + Math.pow(rng(), 1.8) * 3.5) * worldScale;
    }
    this._sampleSparkHeight = sampleSparkHeight;
  };

  RisingLines.prototype._loop = function (t) {
    var self = this;
    var dt = Math.max(0.001, Math.min(0.05, (t - this._lastT) / 1000));
    this._lastT = t;
    if (this._visible) this._draw(dt);
    this._raf = requestAnimationFrame(this._loop);
  };

  RisingLines.prototype._draw = function (dt) {
    var ctx = this._ctx, w = this._w, h = this._h;
    var pal = PALETTES[this._theme] || PALETTES.dark;
    var cParticle = parseColor(pal.color);
    var cHorizon = parseColor(pal.horizonColor);
    var horizonY = h - 1;
    var worldScale = Math.max(0.1, this._scale) / 3.5;

    // (1) frame background — dark paints the page color; light clears to
    // transparent so the light page shows through (same motion either way).
    ctx.globalCompositeOperation = 'source-over';
    if (pal.bg) { ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h); }
    else ctx.clearRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';

    // (2) horizon blob
    var ry = 40 * worldScale;
    ctx.save();
    ctx.translate(w / 2, horizonY);
    ctx.scale((w * 0.5) / ry, 1);
    var hg = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
    hg.addColorStop(0, rgba(cHorizon, pal.horizonOpacity));
    hg.addColorStop(0.35, rgba(cHorizon, pal.horizonOpacity * 0.65));
    hg.addColorStop(0.7, rgba(cHorizon, pal.horizonOpacity * 0.2));
    hg.addColorStop(1, rgba(cHorizon, 0));
    ctx.fillStyle = hg;
    ctx.fillRect(-ry - 2, -ry - 2, (ry + 2) * 2, (ry + 2) * 2);
    ctx.restore();

    var riseSpeedMul = Math.max(0, this._riseSpeed) * 10;
    var denom = Math.max(1, horizonY);
    var rng = this._rng, sampleCenterX = this._sampleCenterX;

    // (3) glow blobs
    for (var b = 0; b < this._bX.length; b++) {
      this._bY[b] -= this._bVY[b] * (1 + riseSpeedMul) * dt;
      if (this._bY[b] < -this._bR[b] * 2) {
        this._bX[b] = sampleCenterX(w);
        this._bY[b] = horizonY - rng() * 10;
        this._bVY[b] = 8 + rng() * 28;
        this._bR[b] = (1.5 + Math.pow(rng(), 1.8) * 3.5) * worldScale;
      }
      var tb = Math.max(0, Math.min(1, (horizonY - this._bY[b]) / denom));
      var fb = tb < 0.2 ? tb / 0.2 : Math.max(0, 1 - (tb - 0.2) / 0.8);
      var ab = fb * pal.opacity;
      if (ab < 0.01) continue;
      var cx = this._bX[b], cy = this._bY[b], r = this._bR[b];
      var ac = Math.min(1, ab);
      var bg2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      bg2.addColorStop(0, rgba(cParticle, ac));
      bg2.addColorStop(0.4, rgba(cParticle, ac * 0.45));
      bg2.addColorStop(1, rgba(cParticle, 0));
      ctx.fillStyle = bg2;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      if (r > 2.5) {
        ctx.fillStyle = rgba(pal.core, ac);
        ctx.fillRect(Math.floor(cx), Math.floor(cy), 1, 1);
      }
    }

    // (4) pixel-line trail sparks
    for (var p = 0; p < this._pX.length; p++) {
      this._pY[p] -= this._pVY[p] * (1 + riseSpeedMul) * dt;
      if (this._pY[p] < -this._pH[p]) {
        this._pX[p] = sampleCenterX(w);
        this._pY[p] = horizonY - rng() * 10;
        this._pVY[p] = 10 + rng() * 40;
        this._pH[p] = this._sampleSparkHeight();
      }
      var tp = Math.max(0, Math.min(1, (horizonY - this._pY[p]) / denom));
      var fp = tp < 0.2 ? tp / 0.2 : Math.max(0, 1 - (tp - 0.2) / 0.8);
      var ap = fp * pal.opacity;
      if (ap < 0.01) continue;
      var px = Math.floor(this._pX[p]), py = Math.floor(this._pY[p]);
      var aq = Math.min(1, ap);
      var sg = ctx.createLinearGradient(0, py, 0, py + this._pH[p]);
      sg.addColorStop(0, rgba(cParticle, 0));
      sg.addColorStop(0.7, rgba(cParticle, aq));
      sg.addColorStop(1, rgba(cParticle, aq));
      ctx.fillStyle = sg;
      ctx.fillRect(px, py, 1, this._pH[p]);
    }
  };

  // LIVE theme swap — recolors in place; particles/timing untouched.
  RisingLines.prototype.setTheme = function (theme) {
    if (PALETTES[theme]) this._theme = theme;
  };
  RisingLines.prototype.getTheme = function () { return this._theme; };

  RisingLines.prototype.dispose = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._ro) this._ro.disconnect();
    if (this._io) this._io.disconnect();
    if (this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
  };

  RisingLines.PALETTES = PALETTES;
  RisingLines.PRESET = PRESET;
  window.RisingLines = RisingLines;
})();
