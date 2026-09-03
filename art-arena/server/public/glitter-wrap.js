/* ============================================================================
 *  ART ARENA™ — v37 port · v39 ZERO-TRAIL FIX (login background)
 * ============================================================================
 *  The user's GlitterWrap — an animated starfield warp tunnel with
 *  glittering sparkle flashes — ported 1:1 from the Originkit React/TS
 *  component they provided (no build step: plain IIFE on window).
 *
 *  Fidelity notes (kept exactly as in the original):
 *    - parseColor: #hex (3/6) + rgba()/rgba() parsing, white fallback
 *    - control mapping: stepZ = speed*0.0008, focalDepth/100,
 *      starSize*0.15, turbulence*0.2, glitterIntensity*0.1, brightness/100
 *      (density used raw)
 *    - forward stars spawn far (z=1) and fly OUT toward the viewer;
 *      reverse is the exact time-reverse (spawn at z=focalDepth, travel in)
 *    - per-star speed multiplier (vmul 0.6–1.4) breaks respawn cohorts
 *    - glitter: flash ~40–110 ms, next one 1–5 s out scaled by intensity
 *    - v39: ZERO trails — every frame begins with a full clearRect +
 *      source-over; stars are drawn ONLY at their current position as
 *      tiny dots (no previous-frame pixels, no destination-out fade,
 *      no previous-position line, no motion blur). The outward motion
 *      comes entirely from the z-update / projection, never from
 *      drawing a line between frames.
 *    - v39: subtle independent twinkle — each star's alpha breathes on
 *      its own slow seed-based sine
 *    - colour strings built once per frame (3), per-star alpha via
 *      globalAlpha → zero string allocation in the hot loop
 *    - DPR capped at 2; resize no-ops unless size/DPR actually changed
 *    - deltaSec capped at 100 ms so a backgrounded tab doesn't snap the
 *      turbulence phase or fire every glitter flash at once on resume
 *    - pool grows/shrinks to the live particle count without rebuilding
 *
 *  Dropped from the original (React/Framer plumbing that has no meaning
 *  here): the RenderTarget static-export path (always the live loop),
 *  propsRef (the class reads this.props live each frame instead — same
 *  behaviour: config changes apply without tearing the animation down).
 *
 *  Usage:
 *    const g = new GlitterWrap(hostElement, props?);   // starts immediately
 *    g.dispose();                                       // stops + disconnects
 * ============================================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // parseColor — hoisted pure utility (identical to the original)
  // ---------------------------------------------------------------------------
  function parseColor(input) {
    if (!input) return [255, 255, 255, 1];
    const s = String(input).trim();
    if (s.startsWith('#')) {
      let hex = s.slice(1);
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      const num = parseInt(hex, 16);
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 1];
    }
    const m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
      return [
        parts[0] || 0,
        parts[1] || 0,
        parts[2] || 0,
        parts[3] == null ? 1 : parts[3],
      ];
    }
    return [255, 255, 255, 1];
  }

  // ---------------------------------------------------------------------------
  class GlitterWrap {
    constructor(container, props) {
      if (!container || typeof container.appendChild !== 'function') {
        throw new Error('GlitterWrap needs a container element');
      }
      // Same merge order as the original export:
      //   {...COMPONENT_DEFAULTS, ...PRESET, ...props}
      this.props = Object.assign({}, GlitterWrap.DEFAULTS, GlitterWrap.PRESET, props || {});

      this.container = container;
      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.appendChild(canvas);
      this.canvas = canvas;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      this.ctx = ctx;

      this.stars = [];
      this.raf = null;
      this._disposed = false;
      this._size = { w: 0, h: 0, dpr: 1 };
      this._lastT = null;
      this._elapsed = 0;
      // Cached parsed colours — only recomputed when the string changes
      // (avoids 3 parses + regex calls per frame).
      this._cc = { color1: '', color2: '', color3: '', parsed1: [255, 255, 255, 1], parsed2: [177, 158, 239, 1], parsed3: [205, 217, 255, 1] };

      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => this.resize(entries[0])) : null;
      this.ro = ro;

      this._syncCount();
      this.resize(undefined);
      if (ro) ro.observe(container);

      const loop = (t) => {
        if (this._disposed) return;
        if (this._lastT == null) this._lastT = t;
        const deltaSec = (t - this._lastT) / 1000;
        this._lastT = t;
        this._drawFrame(deltaSec);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    // ------------------------------------------------------------------ cfg --
    // Map the integer UI controls to internal working ranges in one place.
    _cfg() {
      const p = this.props;
      return {
        reverse: !!p.reverse,
        density: p.density,            // 1–100, used raw
        stepZ: p.speed * 0.0008,       // speed 1–10
        focalDepth: p.focalDepth / 100, // 1–30 -> 0.01–0.30
        starScale: p.starSize * 0.15,   // 0–20 -> 0–3.0
        turbulence: p.turbulence * 0.2, // 0–10 -> 0–2
        glitter: p.glitterIntensity * 0.1, // 0–10 -> 0–1
        brightness: Math.min(1, p.brightness / 100), // 0–100%
      };
    }

    _getCachedColors() {
      const p = this.props;
      const c = this._cc;
      if (p.color1 !== c.color1) { c.color1 = p.color1; c.parsed1 = parseColor(p.color1); }
      if (p.color2 !== c.color2) { c.color2 = p.color2; c.parsed2 = parseColor(p.color2); }
      if (p.color3 !== c.color3) { c.color3 = p.color3; c.parsed3 = parseColor(p.color3); }
      return c;
    }

    // ----------------------------------------------------------------- stars -
    _resetStar(s, initial) {
      const c = this._cfg();
      const angle = Math.random() * Math.PI * 2;
      const radius = (0.2 + Math.random() * 0.8) * (c.density / 15);
      s.x = Math.cos(angle) * radius;
      s.y = Math.sin(angle) * radius;
      if (c.reverse) {
        s.z = initial ? c.focalDepth + Math.random() * (1 - c.focalDepth) : c.focalDepth;
      } else {
        s.z = initial ? Math.random() : 1.0;
      }
      s.seed = Math.random() * 1000;
      s.vmul = 0.6 + Math.random() * 0.8;
      s.colorIdx = Math.floor(Math.random() * 3);
      s.flashUntil = 0;
      s.nextFlash =
        this._elapsed +
        1 +
        Math.random() * 4 * (1 / Math.max(0.0001, c.glitter));
    }

    _syncCount() {
      const count = Math.max(1, Math.floor(this.props.particleCount));
      if (this.stars.length === count) return;
      if (this.stars.length > count) {
        this.stars.length = count;
      } else {
        while (this.stars.length < count) {
          const s = { x: 0, y: 0, z: 0, seed: 0, vmul: 1, colorIdx: 0, flashUntil: 0, nextFlash: 0 };
          this._resetStar(s, true);
          this.stars.push(s);
        }
      }
    }

    // ---------------------------------------------------------------- resize -
    resize(entry) {
      if (this._disposed) return;
      const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
      const cr = entry && entry.contentRect;
      const rectW = (cr && cr.width) || this.container.clientWidth || (this.container.getBoundingClientRect && this.container.getBoundingClientRect().width);
      const rectH = (cr && cr.height) || this.container.clientHeight || (this.container.getBoundingClientRect && this.container.getBoundingClientRect().height);
      const w = Math.max(1, Math.floor(rectW) || 600);
      const h = Math.max(1, Math.floor(rectH) || 400);

      // Bail when nothing changed. ResizeObserver fires spuriously; each real
      // reset sets canvas.width (the canvas is cleared every frame anyway —
      // there is no trail buffer to preserve).
      const prev = this._size;
      if (prev.w === w && prev.h === h && prev.dpr === dpr) return;

      this._size = { w, h, dpr };
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, w, h);
    }

    // ------------------------------------------------------------------ draw -
    _drawFrame(deltaSec) {
      const { reverse, stepZ, focalDepth, starScale, turbulence, glitter, brightness } = this._cfg();

      this._syncCount();
      const cc = this._getCachedColors();
      const palette = [cc.parsed1, cc.parsed2, cc.parsed3];
      const rgbStrs = [
        'rgb(' + palette[0][0] + ', ' + palette[0][1] + ', ' + palette[0][2] + ')',
        'rgb(' + palette[1][0] + ', ' + palette[1][1] + ', ' + palette[1][2] + ')',
        'rgb(' + palette[2][0] + ', ' + palette[2][1] + ', ' + palette[2][2] + ')',
      ];

      const { w, h } = this._size;
      const cx = w / 2;
      const cy = h / 2;
      const projScale = Math.min(w, h) * 0.9;

      const dt = Math.max(0.001, Math.min(0.1, deltaSec)) * 60; // frames at 60 fps

      // v39: ZERO trails — the frame ALWAYS starts from a completely clean
      // canvas. Nothing from the previous frame survives: no fade, no
      // destination-out erase, no preserved pixels, no motion blur.
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.globalCompositeOperation = 'source-over';

      for (let i = 0; i < this.stars.length; i++) {
        const s = this.stars[i];

        const vz = stepZ * s.vmul * dt;
        if (reverse) {
          s.z += vz;
          if (s.z >= 1.0) { this._resetStar(s); continue; }
        } else {
          s.z -= vz;
          if (s.z <= focalDepth) { this._resetStar(s); continue; }
        }

        // Turbulence: gentle sinusoidal wobble that grows as the star
        // approaches.
        let tx = s.x;
        let ty = s.y;
        if (turbulence > 0) {
          const t = this._elapsed * 1.2 + s.seed;
          const amp = turbulence * (1 - s.z) * 0.25;
          tx += Math.sin(t + s.seed) * amp;
          ty += Math.cos(t * 1.13 + s.seed * 0.7) * amp;
        }

        const persp = focalDepth / Math.max(s.z, 0.0001);
        const sx = cx + tx * persp * projScale;
        const sy = cy + ty * persp * projScale;

        // Off-screen respawn — forward only. A reverse star is born at
        // z=focalDepth (persp=1) past the edge and travels ONTO the screen.
        if (!reverse && (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20)) {
          this._resetStar(s);
          continue;
        }

        // Glitter flash logic.
        let flashMult = 1;
        if (glitter > 0) {
          if (this._elapsed >= s.nextFlash && s.flashUntil < this._elapsed) {
            s.flashUntil = this._elapsed + 0.04 + Math.random() * 0.07;
            s.nextFlash = this._elapsed + 1 + Math.random() * 4 * (1 / Math.max(0.0001, glitter));
          }
          if (this._elapsed <= s.flashUntil) flashMult = 1 + 2.5 * glitter;
        }

        const sizePersp = Math.min(2.5, (focalDepth / Math.max(s.z, 0.0001)) * 0.6);
        const baseR = Math.max(0.25, starScale * (0.4 + sizePersp));
        const maxR = 1 + starScale * 2.5;
        const r = Math.min(baseR * flashMult, maxR);

        const lifeT = reverse ? s.z : 1 - s.z;
        const fadeIn = reverse
          ? Math.min(1, (s.z - focalDepth) / (1 - focalDepth) / 0.12)
          : 1;
        // v39: subtle independent twinkle — each star's brightness breathes
        // on its own slow seed-based sine (per-star phase, no shared beat).
        const twinkle = 0.82 + 0.18 * Math.sin(this._elapsed * (1.3 + (s.seed % 1) * 1.8) + s.seed * 2.39);
        const a =
          Math.min(1, reverse ? 0.85 - lifeT * 0.6 : lifeT * 0.9 + 0.05) *
          fadeIn *
          brightness *
          twinkle *
          (flashMult > 1 ? 1 : 0.85);

        const colStr = rgbStrs[s.colorIdx];

        // v39: the star is drawn ONLY at its current position — a tiny dot,
        // never a line from where it was.
        this.ctx.globalAlpha = a;
        this.ctx.fillStyle = colStr;
        this.ctx.fillRect(sx - r, sy - r, r * 2, r * 2);

        if (flashMult > 1) {
          const rf = Math.min(r * 1.4, maxR * 1.4);
          this.ctx.globalAlpha = a * 0.5;
          this.ctx.fillRect(sx - rf, sy - rf, rf * 2, rf * 2);
        }
      }

      this.ctx.globalAlpha = 1;
      this._elapsed += Math.min(0.1, Math.max(0, deltaSec));
    }

    // ---------------------------------------------------------------- dispose -
    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      if (this.raf != null) { try { cancelAnimationFrame(this.raf); } catch (_) {} this.raf = null; }
      if (this.ro) { try { this.ro.disconnect(); } catch (_) {} this.ro = null; }
      if (this.canvas && this.canvas.parentNode) {
        try { this.canvas.parentNode.removeChild(this.canvas); } catch (_) {}
      }
      this.stars.length = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // The user's preset — baked in exactly as provided (values not present here
  // fall back to the component defaults, same merge order as the original).
  // ---------------------------------------------------------------------------
  GlitterWrap.PRESET = {
    particleCount: 970,
    color1: '#A300FF',
    color2: '#4507FF',
    color3: '#FF00DB',
    speed: 1,
    density: 89,
    focalDepth: 6,
    turbulence: 2,
    glitterIntensity: 2,
  };
  GlitterWrap.DEFAULTS = {
    particleCount: 500,
    color1: '#ffffff',
    color2: '#FF0000',
    color3: '#FFE500',
    speed: 5,
    density: 100,
    starSize: 20,
    focalDepth: 13,
    turbulence: 0,
    brightness: 100,
    glitterIntensity: 3,
    trailAmount: 100, // v39: unused (trails removed) — kept so the preset object stays identical to the original component's props
    reverse: false,
  };

  window.GlitterWrap = GlitterWrap;
  window.GlitterWrapPreset = Object.assign({}, GlitterWrap.DEFAULTS, GlitterWrap.PRESET);
})();
