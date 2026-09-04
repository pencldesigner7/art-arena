(function () {
  'use strict';
  // Art Arena v53 — THEME SCENES. One canvas (#home-bg), one live scene at a
  // time, chosen by the active premium theme. All strictly 2D, subtle and
  // cheap: ≤ 40 particles, DPR capped at 2, ~30fps, paused when the tab is
  // hidden, and a single static frame when the user prefers reduced motion.
  // setPalette(theme, custom) swaps colors live; dispose() tears it down.

  var REDUCED = false;
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function hex(c) {
    if (!c) return [255, 60, 172];
    var s = String(c).replace('#', '');
    if (s.length === 3) s = s.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(c, a) { var r = hex(c); return 'rgba(' + r[0] + ',' + r[1] + ',' + r[2] + ',' + a + ')'; }

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function ThemeScene(host, opts) {
    opts = opts || {};
    this.host = host;
    this.theme = opts.theme || 'flame';
    this.custom = opts.custom || null;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.dead = false;
    this.last = 0;
    this.acc = 0;
    this.burst = 0;            // glitch burst timer
    this.glitchPulseAt = performance.now() + rnd(6000, 12000);
    var self = this;
    this._onResize = function () { self.resize(); self.staticFrame(); };
    window.addEventListener('resize', this._onResize);
    this._onVis = function () { if (document.hidden) { self.pause = true; } else { self.pause = false; self.last = 0; } };
    document.addEventListener('visibilitychange', this._onVis);
    this.resize();
    this.seed();
    if (REDUCED) { this.staticFrame(); }
    else { this.raf = requestAnimationFrame(this.tick.bind(this)); }
  }

  ThemeScene.prototype.c1 = function () {
    var t = ThemeScene.PALETTE[this.theme];
    return (this.custom && this.custom.c1) || (t && t.c1) || '#FF3CAC';
  };
  ThemeScene.prototype.c2 = function () {
    var t = ThemeScene.PALETTE[this.theme];
    return (this.custom && this.custom.c2) || (t && t.c2) || '#7B2CFF';
  };
  ThemeScene.prototype.dir = function () {
    return (this.custom && typeof this.custom.dir === 'number') ? this.custom.dir : 135;
  };

  ThemeScene.prototype.resize = function () {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = this.host.clientWidth || window.innerWidth;
    var h = this.host.clientHeight || window.innerHeight;
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  ThemeScene.prototype.seed = function () {
    var i, w = this.w, h = this.h;
    this.p = [];
    if (this.theme === 'flame') {
      for (i = 0; i < 34; i++) this.p.push({ x: rnd(0, w), y: rnd(h * 0.25, h), r: rnd(1.2, 4.2), v: rnd(14, 46), sway: rnd(6, 26), ph: rnd(0, 6.28), a: rnd(0.25, 0.7) });
    } else if (this.theme === 'cloud') {
      for (i = 0; i < 7; i++) this.p.push({ x: rnd(-0.3, 1.1) * w, y: rnd(0.06, 0.62) * h, s: rnd(0.5, 1.5), v: rnd(5, 16), a: rnd(0.5, 0.9) });
    } else if (this.theme === 'glitch') {
      for (i = 0; i < 26; i++) this.p.push({ x: rnd(0, w), y: rnd(0, h), v: rnd(8, 30), w: rnd(20, 90), h: rnd(1, 3), a: rnd(0.05, 0.22) });
    } else if (this.theme === 'graffiti') {
      for (i = 0; i < 22; i++) this.p.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(0.6, 2.6), vx: rnd(-6, 6), vy: rnd(-6, 6), a: rnd(0.12, 0.3), hue: Math.random() < 0.5 ? 0 : 1 });
      this.splats = [];
      for (i = 0; i < 4; i++) this.splats.push({ x: Math.random() < 0.5 ? rnd(0, w * 0.12) : rnd(w * 0.88, w), y: rnd(h * 0.15, h * 0.9), r: rnd(10, 26), a: rnd(0.10, 0.2), hue: i % 2 });
    } else if (this.theme === 'stitch') {
      this.stitchX = -80;
    } else if (this.theme === 'glowing') {
      for (i = 0; i < 9; i++) this.p.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(30, 90), v: rnd(4, 12), ang: rnd(0, 6.28), ph: rnd(0, 6.28), c: i % 2 });
    } else if (this.theme === 'magazine') {
      for (i = 0; i < 12; i++) this.p.push({ x: rnd(0, w), y: rnd(-h, h), w: rnd(18, 70), hgt: rnd(12, 44), rot: rnd(0, 6.28), vr: rnd(-0.14, 0.14), vy: rnd(6, 18), a: rnd(0.05, 0.14), tone: i % 3 });
    }
  };

  ThemeScene.prototype.setPalette = function (theme, custom) {
    var changed = theme !== this.theme;
    this.theme = theme; this.custom = custom || null;
    if (changed) { this.seed(); }
    if (REDUCED) this.staticFrame();
  };

  ThemeScene.prototype.tick = function (ts) {
    if (this.dead) return;
    if (this.pause) { this.raf = requestAnimationFrame(this.tick.bind(this)); return; }
    if (!this.last) this.last = ts;
    var dt = Math.min(0.05, (ts - this.last) / 1000);
    this.last = ts;
    this.acc += dt;
    if (this.acc >= 1 / 30) { this.step(this.acc); this.draw(); this.acc = 0; }
    this.raf = requestAnimationFrame(this.tick.bind(this));
  };

  // ---- per-theme simulation + painting ----------------------------------
  ThemeScene.prototype.step = function (dt) {
    var i, p, w = this.w, h = this.h;
    if (this.theme === 'flame') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.y -= p.v * dt; p.ph += dt * 3; if (p.y < -8) { p.y = h + 8; p.x = rnd(0, w); } }
    } else if (this.theme === 'cloud') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.x += p.v * dt; if (p.x - 220 * p.s > w) { p.x = -220 * p.s; p.y = rnd(0.06, 0.62) * h; } }
    } else if (this.theme === 'glitch') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.y += p.v * dt; if (p.y > h) { p.y = -4; p.x = rnd(0, w); } }
      this.burst = Math.max(0, this.burst - dt);
      if (performance.now() > this.glitchPulseAt) {
        this.burst = 0.35;
        this.glitchPulseAt = performance.now() + rnd(9000, 17000);
        this.pagePulse();
      }
    } else if (this.theme === 'graffiti') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.x += p.vx * dt; p.y += p.vy * dt; if (p.x < 0 || p.x > w) p.vx *= -1; if (p.y < 0 || p.y > h) p.vy *= -1; }
    } else if (this.theme === 'stitch') {
      this.stitchX += 26 * dt; if (this.stitchX > w + 120) this.stitchX = -120;
    } else if (this.theme === 'glowing') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.ph += dt * 0.8; p.ang += dt * 0.12; p.x += Math.cos(p.ang) * p.v * dt; p.y += Math.sin(p.ang) * p.v * dt; if (p.x < -p.r) p.x = w + p.r; if (p.x > w + p.r) p.x = -p.r; if (p.y < -p.r) p.y = h + p.r; if (p.y > h + p.r) p.y = -p.r; }
    } else if (this.theme === 'magazine') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.y += p.vy * dt; p.rot += p.vr * dt; if (p.y - 60 > h) { p.y = -60; p.x = rnd(0, w); } }
    }
  };

  ThemeScene.prototype.draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h, i, p, c1 = this.c1(), c2 = this.c2();
    ctx.clearRect(0, 0, w, h);
    if (this.theme === 'flame') {
      var g = ctx.createLinearGradient(0, h, 0, h * 0.55);
      g.addColorStop(0, rgba(c1, 0.16)); g.addColorStop(1, rgba(c1, 0));
      ctx.fillStyle = g; ctx.fillRect(0, h * 0.5, w, h * 0.5);
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        var x = p.x + Math.sin(p.ph) * p.sway * 0.25;
        var gg = ctx.createRadialGradient(x, p.y, 0, x, p.y, p.r * 3);
        gg.addColorStop(0, rgba(i % 3 === 0 ? c2 : c1, p.a)); gg.addColorStop(1, rgba(c1, 0));
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, p.y, p.r * 3, 0, 6.283); ctx.fill();
      }
    } else if (this.theme === 'cloud') {
      var sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#8ec9f5'); sky.addColorStop(0.65, '#c9e6fb'); sky.addColorStop(1, '#eef7ff');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        ctx.save(); ctx.globalAlpha = p.a * 0.85; ctx.fillStyle = '#ffffff';
        var s = p.s;
        [[0, 0, 46], [38, 6, 34], [-40, 8, 30], [12, -16, 34], [-14, -12, 26]].forEach(function (o) {
          ctx.beginPath(); ctx.ellipse(p.x + o[0] * s, p.y + o[1] * s, o[2] * s, o[2] * s * 0.62, 0, 0, 6.283); ctx.fill();
        });
        ctx.restore();
      }
    } else if (this.theme === 'glitch') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        ctx.fillStyle = rgba(i % 2 ? c1 : c2, p.a); ctx.fillRect(p.x, p.y, p.w, p.h);
      }
      if (this.burst > 0) {
        var by = rnd(0, h), bh = rnd(4, 14);
        ctx.fillStyle = rgba(c1, 0.16); ctx.fillRect(0, by, w, bh);
        ctx.fillStyle = rgba(c2, 0.13); ctx.fillRect(rnd(-30, 0), by + bh, w, bh * 0.7);
      }
    } else if (this.theme === 'graffiti') {
      var self = this;
      (this.splats || []).forEach(function (s) {
        ctx.fillStyle = rgba(s.hue ? self.c2() : self.c1(), s.a);
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
        ctx.fillRect(s.x - s.r * 0.12, s.y, s.r * 0.24, s.r * 2.4); // the drip
      });
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        ctx.fillStyle = rgba(p.hue ? c2 : c1, p.a);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
    } else if (this.theme === 'stitch') {
      var gap = 26;
      ctx.strokeStyle = rgba(this.c1(), 0.10); ctx.lineWidth = 1.4; ctx.setLineDash([7, 6]);
      for (var y = gap; y < h; y += gap * 1.6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.setLineDash([]);
      // the running stitch crossing the fabric
      var sx = this.stitchX;
      ctx.strokeStyle = rgba(this.c2(), 0.35); ctx.lineWidth = 2.2; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(sx - 120, h * 0.62);
      ctx.bezierCurveTo(sx - 40, h * 0.5, sx + 40, h * 0.74, sx + 120, h * 0.6);
      ctx.stroke(); ctx.setLineDash([]);
    } else if (this.theme === 'glowing') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        var pulse = 0.5 + 0.5 * Math.sin(p.ph);
        var rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        rg.addColorStop(0, rgba(p.c ? c2 : c1, 0.10 + 0.08 * pulse)); rg.addColorStop(1, rgba(p.c ? c2 : c1, 0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
    } else if (this.theme === 'magazine') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.tone === 0 ? 'rgba(255,255,255,' + p.a + ')' : p.tone === 1 ? 'rgba(20,20,25,' + p.a + ')' : rgba(this.c1(), p.a);
        ctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
        ctx.restore();
      }
    }
  };

  // Occasional page-level glitch pulse (glitch theme only). Suppressed while
  // a battle countdown/overlay is up or the room battle is live — never
  // interferes with gameplay, timers or the drawing deadline.
  ThemeScene.prototype.pagePulse = function () {
    if (this.theme !== 'glitch' || REDUCED) return;
    try {
      if (typeof window.__pthGlitchAllowed === 'function' && !window.__pthGlitchAllowed()) return;
      document.body.classList.add('pth-glitch-pulse');
      var self = this;
      setTimeout(function () { document.body.classList.remove('pth-glitch-pulse'); }, 200);
    } catch (e) {}
  };

  ThemeScene.prototype.staticFrame = function () { this.step(0.016); this.draw(); };

  ThemeScene.prototype.dispose = function () {
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  ThemeScene.PALETTE = {
    flame: { c1: '#FF5A00', c2: '#FFC300' },
    glitch: { c1: '#00F0FF', c2: '#FF2BD1' },
    glowing: { c1: '#8A7CFF', c2: '#39C4FF' },
    graffiti: { c1: '#FF3CAC', c2: '#7B2CFF' },
    stitch: { c1: '#E8D8C4', c2: '#FF6A5A' },
    cloud: { c1: '#4A9FE8', c2: '#8EC9F5' },
    magazine: { c1: '#FF5A5A', c2: '#222228' }
  };

  window.ThemeScene = ThemeScene;
})();
