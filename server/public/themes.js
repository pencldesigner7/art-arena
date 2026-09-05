(function () {
  'use strict';
  // Art Arena v55 — THEME SCENES. One canvas, one live scene at a time, chosen
  // by the active premium theme. All strictly 2D and cheap: baked offscreen
  // sprites drawn per frame, ≤ 40 live particles, DPR capped at 2, ~30fps,
  // paused when the tab is hidden, a static frame under reduced motion — and
  // since v55, MOTION CAN BE FROZEN app-wide (Settings → Animations OFF):
  // setMotion(false) stops the clock but keeps the scene fully visible.
  //
  // setPalette(theme, custom) swaps colors live (sprites re-bake only when the
  // palette actually changes); dispose() tears everything down.
  //
  // v54 glitch event system (kept): the scene owns the pulse clock and tells
  // the app via window events — aa-glitch-pulse / aa-glitch-burst /
  // aa-glitch-fullscreen (~1-in-10 true-random roll). Guards live in the app
  // (window.__pthGlitchAllowed) so gameplay, countdowns and battles are NEVER
  // interrupted. __pthSceneStats / __pthForceEvent are honest test hooks.

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
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function mk(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h));
    return c;
  }
  // v55: global motion preference (Settings → Animations). Read at construction
  // and toggled live via setMotion(); the attribute is the single truth.
  function motionOn() {
    try { return document.documentElement.getAttribute('data-anim') !== 'off'; } catch (e) { return true; }
  }
  // v55: draw a REALISTIC paint drip — a run that tapers under gravity and
  // ends in a bulbous head wider than the run (not "a line and a dot").
  function drawDrip(ctx, x, y, len, w0, color, alpha) {
    var segs = 4, i, yy, ww;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (i = 0; i < segs; i++) {
      yy = y + (len * i) / segs;
      ww = w0 * (1 - 0.45 * (i / (segs - 1)));        // taper toward the head
      ctx.fillRect(x - ww / 2, yy, ww, len / segs + 0.6);
    }
    // the accumulated head: a droplet BULB wider than the run
    var hy = y + len, hr = w0 * 0.85;
    ctx.beginPath();
    ctx.ellipse(x, hy - hr * 0.15, hr * 0.72, hr, 0, 0, 6.283);
    ctx.fill();
    // wet highlight on the head
    ctx.globalAlpha = alpha * 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(x - hr * 0.22, hy - hr * 0.45, hr * 0.2, hr * 0.3, -0.5, 0, 6.283);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------

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
    // v56: the cloud theme renders through the user-supplied CloudSky shader
    // (WebGL) — the 2D canvas stands down (hidden) and this scene only
    // supervises the lifecycle (motion freeze, dispose).
    this.cloudSky = null;
    if (this.theme === 'cloud' && window.CloudSkyScene) {
      try {
        this.cloudSky = new window.CloudSkyScene(host);
        this.cloudSky.setMotion(motionOn() && !REDUCED);
        this.canvas.style.display = 'none';
      } catch (e) { this.cloudSky = null; }
    }
    this.dead = false;
    this.last = 0;
    this.acc = 0;
    this.t = 0;                       // scene age (s) — drives reveals
    this.burst = 0;                   // glitch burst timer
    this.pulseAt = 0;                 // next glitch pulse (scene time)
    this.stats = { pulses: 0, fullscreen: 0, bursts: 0, drips: 0, placed: 0 };
    this.motion = motionOn();         // v55: Animations toggle (freeze ≠ hide)
    var self = this;
    this._onResize = function () { self.resize(); self.bake(); self.staticFrame(); };
    window.addEventListener('resize', this._onResize);
    this._onVis = function () { if (document.hidden) { self.pause = true; } else { self.pause = false; self.last = 0; } };
    document.addEventListener('visibilitychange', this._onVis);
    this.resize();
    this.seed();
    if (REDUCED || !this.motion) { this.staticFrame(); }
    else { this.raf = requestAnimationFrame(this.tick.bind(this)); }
    try { window.__pthScene = this; } catch (e) {}
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

  // ---- baked sprites (per theme, per palette) ------------------------------
  ThemeScene.prototype.bake = function () {
    var key = this.theme + '|' + this.c1() + '|' + this.c2();
    if (this._bakeKey === key) return;
    this._bakeKey = key;
    this.spr = {};
    if (this.theme === 'cloud') { if (!this.cloudSky) this.bakeClouds(); }
    else if (this.theme === 'graffiti') this.bakeWall();
    else if (this.theme === 'magazine') this.bakePaper();
    else if (this.theme === 'stitch') this.bakeWeave();
    else if (this.theme === 'glowing') this.bakeGlow();
    else if (this.theme === 'pixel') this.bakePixel();
  };

  // CLOUD (v55: refined, atmospheric — not cartoon). One cohesive silhouette
  // per cloud (single-path union, no seams), but now: elongated organic masses
  // with fewer, bolder arcs; flatter irregular undersides; shading in the
  // cloud LOGO's blue-grays; atmospheric depth (far = hazy, near = crisp with
  // a defined under-shadow). Thin stratus streaks fill the far field.
  ThemeScene.prototype.bakeClouds = function () {
    var LOGO = { hi: '#fbfcfe', body: '#e8edf5', shade: '#c3cddd', deep: '#9fb0c6' };
    function cloudSprite(sw, sh) {
      var c = mk(sw, sh + 20), x = c.getContext('2d');
      var base = sh * 0.74;
      var path = new Path2D();
      var cx = 12, span = sw - 26;
      // bold asymmetric arcs — 3 max (fewer, stronger shapes)
      var r0 = rnd(base * 0.5, base * 0.62);
      path.moveTo(cx, base);
      path.arc(cx + r0, base - r0 * 0.1, r0, Math.PI, Math.PI * 1.6);
      var r1 = rnd(base * 0.58, base * 0.75);
      path.arc(cx + span * rnd(0.38, 0.5), base - r1 * 0.8, r1, Math.PI * 1.02, Math.PI * 1.7);
      var r2 = rnd(base * 0.4, base * 0.55);
      path.arc(sw - 18 - r2, base - r2 * 0.55, r2, Math.PI * 1.05, Math.PI * 1.95);
      // irregular underside (never a straight cartoon base)
      var ux = sw - 14;
      while (ux > cx + 6) { var step = rnd(16, 42); path.lineTo(Math.max(cx + 4, ux - step * 0.5), base + rnd(-2.5, 2.5)); ux -= step; }
      path.lineTo(cx, base);
      path.closePath();
      var g = x.createLinearGradient(0, 0, 0, base);
      g.addColorStop(0, LOGO.hi); g.addColorStop(0.55, LOGO.body); g.addColorStop(1, LOGO.shade);
      x.fillStyle = g; x.fill(path);
      // defined under-shadow (edgier than a soft puff)
      x.save(); x.clip(path);
      var sg = x.createLinearGradient(0, base - base * 0.34, 0, base);
      sg.addColorStop(0, 'rgba(159,176,198,0)'); sg.addColorStop(1, 'rgba(159,176,198,.5)');
      x.fillStyle = sg; x.fillRect(0, base - base * 0.34, sw, base * 0.34 + 2);
      x.restore();
      return c;
    }
    function streakSprite(sw) {
      var c = mk(sw, 22), x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, sw, 0);
      g.addColorStop(0, 'rgba(232,237,245,0)'); g.addColorStop(0.5, 'rgba(232,237,245,.85)'); g.addColorStop(1, 'rgba(232,237,245,0)');
      x.fillStyle = g;
      x.beginPath(); x.ellipse(sw / 2, 11, sw / 2, rnd(5, 8), 0, 0, 6.283); x.fill();
      return c;
    }
    this.spr.clouds = [];
    for (var i = 0; i < 9; i++) {
      var depth = i < 2 ? 0 : (i < 7 ? 1 : 2);        // 0 far · 1 mid · 2 near
      var sw = depth === 0 ? rnd(240, 340) : depth === 1 ? rnd(300, 430) : rnd(430, 620);
      this.spr.clouds.push({
        img: cloudSprite(sw, sw * rnd(0.26, 0.36)),
        depth: depth,
        x: rnd(-0.3, 1.1) * this.w,
        y: depth === 0 ? rnd(0.03, 0.2) * this.h : rnd(0.07, 0.52) * this.h,
        v: (depth === 0 ? rnd(2.5, 5) : depth === 1 ? rnd(6, 11) : rnd(12, 19)) / (depth === 2 ? 1.6 : 1),
        bob: depth === 2 ? rnd(0, 2.5) : 0,
        ph: rnd(0, 6.28),
        a: depth === 0 ? rnd(0.22, 0.34) : depth === 1 ? rnd(0.5, 0.7) : rnd(0.78, 0.92),
        haze: depth === 0
      });
    }
    this.spr.streaks = [];
    for (var s2 = 0; s2 < 4; s2++) this.spr.streaks.push({ img: streakSprite(rnd(180, 380)), x: rnd(-0.2, 1) * this.w, y: rnd(0.05, 0.3) * this.h, v: rnd(3, 6), a: rnd(0.3, 0.5) });
  };

  // GRAFFITI (v55) — the user's EXACT monochrome wall image is the background
  // (themes/graffiti-bg.png, cover-fit baked at resize). On top: realistic
  // white/black paint drips (tapered runs + bulbous heads) and occasional
  // monochrome spray puffs. Pure black & white — the app chrome follows.
  ThemeScene.prototype.bakeWall = function () {
    var self = this;
    this.spr.wall = null; // v55: the generated wall is gone — exact image below
    if (!this.bgImg) {
      try {
        var img = new Image();
        img.onload = function () {
          self.bgImg = img;
          self._bakeKey = null;       // force a cover-fit rebake next frame
          self.bake();
          self.staticFrame();
        };
        img.src = '/themes/graffiti-bg.png';
      } catch (e) {}
    }
    // cover-fit the exact image once per size bake
    var W = this.w, H = this.h;
    if (this.bgImg) {
      var sc = Math.max(W / this.bgImg.width, H / this.bgImg.height);
      var bw = Math.round(this.bgImg.width * sc), bh = Math.round(this.bgImg.height * sc);
      var c = mk(bw, bh), x = c.getContext('2d');
      x.drawImage(this.bgImg, 0, 0, bw, bh);
      this.spr.wallCanvas = { c: c, x: Math.round((W - bw) / 2), y: Math.round((H - bh) / 2) };
    } else { this.spr.wallCanvas = null; }
    // v56 integration scrims — the wall melts into the page instead of
    // reading as a pasted photo: dark feathered edges + a center vignette
    // that keeps UI text high-contrast over the art.
    var sg1 = mk(64, 220), sx1 = sg1.getContext('2d');
    var tg = sx1.createLinearGradient(0, 0, 0, 220);
    tg.addColorStop(0, 'rgba(16,16,16,.66)'); tg.addColorStop(1, 'rgba(16,16,16,0)');
    sx1.fillStyle = tg; sx1.fillRect(0, 0, 64, 220);
    this.spr.scrimTop = sg1;
    var sg2 = mk(64, 220), sx2 = sg2.getContext('2d');
    var bg2 = sx2.createLinearGradient(0, 0, 0, 220);
    bg2.addColorStop(0, 'rgba(16,16,16,0)'); bg2.addColorStop(1, 'rgba(16,16,16,.62)');
    sx2.fillStyle = bg2; sx2.fillRect(0, 0, 64, 220);
    this.spr.scrimBottom = sg2;
    var sg3 = mk(512, 512), sx3 = sg3.getContext('2d');
    var rg3 = sx3.createRadialGradient(256, 256, 130, 256, 256, 330);
    rg3.addColorStop(0, 'rgba(16,16,16,0)'); rg3.addColorStop(1, 'rgba(16,16,16,.5)');
    sx3.fillStyle = rg3; sx3.fillRect(0, 0, 512, 512);
    this.spr.scrimVig = sg3;
    // monochrome spray puffs
    this.sprays = [];
    this.nextSpray = 1.6;
    // realistic drips: anchors spread over the upper half; they run, bulge, dry
    this.drips = [];
    var n = 7, i;
    for (i = 0; i < n; i++) {
      this.drips.push({
        x: rnd(0.04, 0.96) * (this.w || 800),
        y: rnd(0.06, 0.42) * (this.h || 600),
        len: 0, max: rnd(60, 210),
        v: rnd(9, 26),
        w: rnd(2.6, 5.2),
        c: Math.random() < 0.72 ? '#F2F2F2' : '#0c0c0c',
        started: rnd(0, 9),
      });
    }
  };

  // MAGAZINE — a real collage: torn-edge paper clippings with print fragments
  // (big glyphs, halftone patches, headline bars), taped corners, layered with
  // soft shadows. Sheets drift a breath; new clippings get PLACED occasionally.
  ThemeScene.prototype.bakePaper = function () {
    var c1 = this.c1();
    function tornSheet(sw, sh, tone, ink) {
      var c = mk(sw + 24, sh + 24), x = c.getContext('2d');
      x.translate(12, 12);
      var path = new Path2D();
      var jag = 3.2;
      function edge(from, to, jit) {
        var steps = Math.max(3, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 22));
        for (var i = 1; i <= steps; i++) {
          var u = i / steps;
          var jx = i === steps ? 0 : rnd(-jit, jit), jy = i === steps ? 0 : rnd(-jit, jit);
          path.lineTo(from[0] + (to[0] - from[0]) * u + jx, from[1] + (to[1] - from[1]) * u + jy);
        }
      }
      path.moveTo(0, 0);
      edge([0, 0], [sw, 0], jag); edge([sw, 0], [sw, sh], jag);
      edge([sw, sh], [0, sh], jag); edge([0, sh], [0, 0], jag);
      path.closePath();
      x.shadowColor = 'rgba(30,26,20,.35)'; x.shadowBlur = 10; x.shadowOffsetY = 3;
      x.fillStyle = tone; x.fill(path);
      x.shadowColor = 'transparent';
      // print content, clipped to the torn sheet
      x.save(); x.clip(path);
      var kind = Math.floor(rnd(0, 3));
      if (kind === 0) {          // giant typographic fragment
        x.fillStyle = ink;
        x.font = '900 ' + Math.round(sh * 1.05) + 'px Georgia, serif';
        x.fillText(pick(['A', 'R', 'T', 'N', 'M', 'W', '&', '?']), rnd(-6, sw * 0.24), sh * 0.92);
      } else if (kind === 1) {   // halftone dot patch
        x.fillStyle = ink;
        for (var hy = 8; hy < sh - 4; hy += 11) {
          for (var hx = 8; hx < sw - 4; hx += 11) {
            var r2 = 2.4 * (0.4 + 0.6 * Math.abs(Math.sin(hx * 0.05 + hy * 0.08)));
            x.beginPath(); x.arc(hx, hy, r2, 0, 6.283); x.fill();
          }
        }
      } else {                   // headline bars + column rules
        x.fillStyle = ink;
        x.fillRect(8, 10, sw * rnd(0.5, 0.8), Math.max(8, sh * 0.14));
        x.fillStyle = rgba(c1, 0.85);
        x.fillRect(8, 10 + Math.max(12, sh * 0.18), sw * rnd(0.25, 0.45), Math.max(5, sh * 0.08));
        x.fillStyle = rgba(ink, 0.55);
        for (var ly = 10 + sh * 0.36; ly < sh - 8; ly += 7) x.fillRect(8, ly, sw - 16 * rnd(1, 2.4), 2);
      }
      x.restore();
      // tape strip on one corner
      if (Math.random() < 0.6) {
        x.save(); x.translate(rnd(0, sw - 46), Math.random() < 0.5 ? -4 : sh - 6); x.rotate(rnd(-0.4, 0.4));
        x.fillStyle = 'rgba(233,222,166,.75)'; x.fillRect(0, 0, 46, 13);
        x.fillStyle = 'rgba(255,255,255,.25)'; x.fillRect(0, 0, 46, 4);
        x.restore();
      }
      return c;
    }
    var tones = ['#faf7ef', '#f2ecdf', '#eadfe4', '#e8eef2', '#f6efe2'];
    var inks = ['#23211d', '#2c3350', '#5c2320'];
    this.spr.sheets = [];
    for (var i = 0; i < 13; i++) {
      var big = i < 4;
      this.spr.sheets.push({
        img: tornSheet(big ? rnd(120, 210) : rnd(60, 130), big ? rnd(90, 160) : rnd(50, 110), pick(tones), pick(inks)),
        x: rnd(-20, this.w - 60), y: rnd(-20, this.h - 60),
        rot: rnd(-0.34, 0.34), vr: rnd(-0.05, 0.05), vx: rnd(-3, 3), vy: rnd(-2.5, 2.5),
        a: big ? rnd(0.5, 0.72) : rnd(0.3, 0.5), settle: 1
      });
    }
    // v55 (user request): MORE things in the collage — typography fragments
    // (single serif glyphs), thin paper strips, and halftone patches.
    function glyphSprite(ch) {
      var c = mk(64, 64), x = c.getContext('2d');
      x.font = '900 58px Georgia, serif';
      x.fillStyle = pick(inks.concat(['#8a2f74', '#1f5c46']));
      x.fillText(ch, rnd(2, 14), 54 + rnd(-4, 4));
      return c;
    }
    function stripSprite() {
      var c = mk(20, 130), x = c.getContext('2d');
      x.fillStyle = pick(tones); x.fillRect(0, 0, 20, 130);
      x.fillStyle = 'rgba(35,33,29,.5)';
      for (var ly = 10; ly < 120; ly += 12) x.fillRect(4, ly, rnd(8, 14), 2);
      return c;
    }
    function halftoneSprite() {
      var c = mk(84, 84), x = c.getContext('2d');
      x.fillStyle = pick(['#e3d6e8', '#d6e4e8', '#e8e0d6']);
      x.fillRect(0, 0, 84, 84);
      x.fillStyle = 'rgba(35,33,29,.55)';
      for (var hy = 8; hy < 78; hy += 12) for (var hx = 8; hx < 78; hx += 12) {
        x.beginPath(); x.arc(hx, hy, 2 + 2.4 * Math.abs(Math.sin(hx * 0.09 + hy * 0.07)), 0, 6.283); x.fill();
      }
      return c;
    }
    var glyphs = 'ARNMW&?!✦'.split('');
    this.spr.frags = [];
    for (var f = 0; f < 12; f++) this.spr.frags.push({ img: glyphSprite(pick(glyphs)), x: rnd(0, this.w), y: rnd(0, this.h), rot: rnd(-0.5, 0.5), vr: rnd(-0.08, 0.08), vx: rnd(-4, 4), vy: rnd(-3, 3), a: rnd(0.25, 0.5) });
    this.spr.strips = [];
    for (var t2 = 0; t2 < 7; t2++) this.spr.strips.push({ img: stripSprite(), x: rnd(0, this.w), y: rnd(0, this.h), rot: rnd(-0.24, 0.24), vr: rnd(-0.04, 0.04), vx: rnd(-3, 3), vy: rnd(-2, 2), a: rnd(0.3, 0.55) });
    this.spr.dots = [];
    for (var d2 = 0; d2 < 5; d2++) this.spr.dots.push({ img: halftoneSprite(), x: rnd(0, this.w), y: rnd(0, this.h), rot: rnd(-0.3, 0.3), vr: rnd(-0.05, 0.05), vx: rnd(-3, 3), vy: rnd(-2, 2), a: rnd(0.22, 0.4) });
    this.nextPlace = 2.5;
  };

  // STITCH (v56) — a fashion atelier: an invisible hand sketches ONE outfit
  // at a time inside the embroidery hoop — gown → jacket → sneakers — with
  // running-stitch strokes and a floating needle tip. The sketch completes,
  // holds, then unpicks itself and the next design begins. Textile world:
  // dark linen, weave texture, drifting thread curls. Nothing static.
  ThemeScene.prototype.bakeWeave = function () {
    var w = mk(64, 64), x = w.getContext('2d');
    x.strokeStyle = 'rgba(255,255,255,.028)'; x.lineWidth = 1;
    for (var i = 0; i <= 64; i += 8) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke();
      x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke();
    }
    x.strokeStyle = 'rgba(0,0,0,.05)';
    for (var j = 4; j < 64; j += 8) {
      x.beginPath(); x.moveTo(j, 0); x.lineTo(j, 64); x.stroke();
    }
    this.spr.weave = w;
    // the atelier hoop — big, centered, the page of the sketchbook
    var r = Math.min(this.w, this.h) * 0.34, hc = mk(r * 2 + 26, r * 2 + 26), hx = hc.getContext('2d');
    hx.translate(hc.width / 2, hc.height / 2);
    hx.fillStyle = 'rgba(232,216,196,.07)';
    hx.beginPath(); hx.arc(0, 0, r - 7, 0, 6.283); hx.fill();
    hx.strokeStyle = 'rgba(196,148,96,.55)'; hx.lineWidth = 7;
    hx.beginPath(); hx.arc(0, 0, r, 0, 6.283); hx.stroke();
    hx.strokeStyle = 'rgba(148,104,62,.45)'; hx.lineWidth = 3;
    hx.beginPath(); hx.arc(0, 0, r + 6, 0, 6.283); hx.stroke();
    hx.beginPath(); hx.arc(0, 0, r - 6, 0, 6.283); hx.stroke();
    // hoop clamp at the top
    hx.strokeStyle = 'rgba(148,104,62,.6)'; hx.lineWidth = 5;
    hx.beginPath(); hx.moveTo(0, -r - 11); hx.lineTo(0, -r + 9); hx.stroke();
    this.spr.hoop = hc;
    // drifting thread curls (ambient textile life)
    this.spr.threads = [];
    for (var t = 0; t < 4; t++) {
      var tc = mk(90, 26), tx = tc.getContext('2d');
      tx.strokeStyle = 'rgba(196,148,96,.34)'; tx.lineWidth = 2.2; tx.lineCap = 'round';
      tx.beginPath(); tx.moveTo(6, 16);
      tx.bezierCurveTo(26, 2, 40, 26, 58, 12);
      tx.bezierCurveTo(70, 2, 80, 20, 88, 10);
      tx.stroke();
      this.spr.threads.push({ img: tc, x: rnd(0, this.w), y: rnd(this.h * 0.06, this.h * 0.94), vx: rnd(2.5, 7) * (Math.random() < 0.5 ? -1 : 1), ph: rnd(0, 6.28) });
    }
    // the sketchbook: three designs, one live at a time
    this.sketch = { idx: 0, u: 0, phase: 'draw', hold: 0 };
    this.designs = this.makeDesigns();
    this._designPx = null; // baked to pixel space per resize
  };

  // garment designs as normalized stroke lists (0..1 design space, y down).
  // Silhouettes wear the theme's c2 thread; construction lines the c1 linen;
  // laces/accents take gold + sage. Drawn as running-stitch dashed lines.
  ThemeScene.prototype.makeDesigns = function () {
    var self = this;
    var C = function (k) { return function () { return self['_' + k] || k; }; };
    function st(pts, cKey, lw, dash) { return { pts: pts, c: cKey, lw: lw || 2.6, dash: dash || [11, 8] }; }
    function dot(x, y, r) { return { dot: 1, x: x, y: y, r: r || 2.6 }; }
    return [
      { name: 'gown', strokes: [
        st([[.42,.14],[.36,.15],[.33,.22],[.34,.30],[.36,.34]], 'c2', 2.8),
        st([[.58,.14],[.64,.15],[.67,.22],[.66,.30],[.64,.34]], 'c2', 2.8),
        st([[.42,.14],[.46,.19],[.50,.20],[.54,.19],[.58,.14]], 'c2'),
        st([[.42,.14],[.44,.09],[.47,.075]], 'c1'),
        st([[.58,.14],[.56,.09],[.53,.075]], 'c1'),
        st([[.36,.34],[.28,.52],[.20,.72],[.14,.92]], 'c2', 2.8),
        st([[.64,.34],[.74,.52],[.84,.72],[.90,.94]], 'c2', 2.8),
        st([[.14,.92],[.30,.97],[.52,.985],[.72,.97],[.90,.94]], 'c2', 2.8),
        st([[.36,.34],[.50,.37],[.64,.34]], 'c1'),
        st([[.44,.42],[.42,.62],[.40,.86]], 'gold'),
        st([[.50,.42],[.50,.68],[.49,.90]], 'gold'),
        st([[.56,.42],[.58,.62],[.61,.88]], 'gold')
      ] },
      { name: 'jacket', strokes: [
        st([[.50,.10],[.42,.12],[.38,.20]], 'c2', 2.8),
        st([[.38,.20],[.44,.30],[.43,.38]], 'c2', 2.8),
        st([[.50,.10],[.58,.12],[.62,.20]], 'c2', 2.8),
        st([[.62,.20],[.56,.30],[.57,.38]], 'c2', 2.8),
        st([[.38,.13],[.26,.16]], 'c2'),
        st([[.62,.13],[.74,.16]], 'c2'),
        st([[.26,.16],[.22,.34],[.20,.52]], 'c2'),
        st([[.20,.52],[.25,.53]], 'c1'),
        st([[.74,.16],[.78,.34],[.80,.52]], 'c2'),
        st([[.80,.52],[.75,.53]], 'c1'),
        st([[.40,.20],[.37,.50],[.36,.74]], 'c2'),
        st([[.60,.20],[.63,.50],[.64,.74]], 'c2'),
        st([[.36,.74],[.50,.77],[.64,.74]], 'c2'),
        st([[.50,.16],[.50,.74]], 'c1'),
        st([[.41,.52],[.46,.53]], 'sage'),
        st([[.41,.52],[.41,.57],[.46,.58],[.46,.53]], 'sage'),
        dot(.50,.28), dot(.50,.42), dot(.50,.56), dot(.50,.68)
      ] },
      { name: 'sneakers', strokes: [
        st([[.12,.74],[.16,.82],[.30,.86],[.55,.87],[.72,.85],[.84,.80],[.88,.72],[.84,.70],[.70,.75],[.50,.77],[.30,.76],[.16,.71],[.12,.74]], 'c2', 2.8),
        st([[.14,.72],[.30,.77],[.50,.78],[.70,.76],[.86,.70]], 'c1'),
        st([[.88,.72],[.90,.62],[.86,.52],[.78,.47]], 'c2'),
        st([[.78,.47],[.62,.44],[.50,.46]], 'c2'),
        st([[.50,.46],[.44,.40],[.42,.32]], 'c2'),
        st([[.42,.32],[.32,.30],[.24,.34],[.20,.44]], 'c2'),
        st([[.20,.44],[.17,.58],[.14,.68]], 'c2'),
        st([[.22,.34],[.19,.28]], 'c1'),
        st([[.46,.42],[.52,.46]], 'gold'), st([[.52,.42],[.46,.46]], 'gold'),
        st([[.44,.37],[.50,.41]], 'gold'), st([[.50,.37],[.44,.41]], 'gold'),
        st([[.43,.33],[.48,.36]], 'gold'), st([[.48,.33],[.43,.36]], 'gold'),
        st([[.26,.58],[.40,.60],[.54,.57],[.62,.52]], 'sage')
      ] }
    ];
  };

  // pixel-space design (recomputed on resize) + cumulative lengths for the
  // progressive reveal. The design box lives inside the hoop.
  ThemeScene.prototype.designPx = function () {
    if (this._designPx && this._designPx.w === this.w && this._designPx.h === this.h) return this._designPx;
    var cx = this.w * 0.5, cy = this.h * 0.52, r = Math.min(this.w, this.h) * 0.34 - 26;
    var dw = r * 1.55, dh = r * 1.9; // fashion-plate proportions
    var out = { w: this.w, h: this.h, cx: cx, cy: cy, dw: dw, dh: dh, items: [] };
    (this.designs || []).forEach(function (g) {
      var strokes = [], total = 0;
      g.strokes.forEach(function (s0) {
        if (s0.dot) { strokes.push({ dot: 1, x: cx - dw / 2 + s0.x * dw, y: cy - dh / 2 + s0.y * dh, r: s0.r, c: s0.c || 'c2', at: total }); return; }
        var pts = s0.pts.map(function (p) { return [cx - dw / 2 + p[0] * dw, cy - dh / 2 + p[1] * dh]; });
        var len = 0;
        for (var k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        total += len;
        strokes.push({ pts: pts, len: len, at: total - len, c: s0.c, lw: s0.lw, dash: s0.dash });
      });
      out.items.push({ name: g.name, strokes: strokes, total: total });
    });
    this._designPx = out;
    return out;
  };

  // PIXEL (v57) — a pop-art PIXEL world in the pixel logo's own palette
  // (magenta / cyan / gold / violet on deep navy), built from the supplied
  // comic reference: a radial halftone dot field, a sunburst of chunky rays,
  // bold comic star-bursts, drifting blocky clouds and twinkles. Every
  // element is a deliberate pixel shape: rendered at 1/S resolution on a
  // small working canvas and upscaled with smoothing OFF (crisp blocks —
  // never blurry). A soft centre vignette keeps the UI readable on top.
  ThemeScene.PIXEL = {
    navy: '#0B1A3A', navy2: '#16245C', violet: '#5A1F9E', magenta: '#FF2ED1', pink: '#FF7AE0',
    cyan: '#3EE8FF', cyan2: '#C6FBFF', gold: '#FFD23F', gold2: '#FFF1A6', orange: '#FF7A2F',
    lime: '#8CFF5A', white: '#FFFFFF', ink: '#070B1C'
  };
  ThemeScene.prototype.bakePixel = function () {
    var P = ThemeScene.PIXEL, S = 5;
    this.pxScale = S;
    var pw = Math.max(8, Math.ceil(this.w / S)), ph = Math.max(8, Math.ceil(this.h / S));
    this.spr.px = mk(pw, ph);                 // working frame (dynamic)
    var cx = pw / 2, cy = ph * 0.42;          // burst origin (upper-centre, behind the logo)
    var i, x, y;
    // 1) static backdrop: navy → violet vertical bands with 2x2 checker dithered seams
    var bg = mk(pw, ph), bx = bg.getContext('2d');
    var bands = ['#060C24', P.navy, '#1A1E6E', '#3A1C8C', P.violet, '#8A1E9C', '#C22AB8'];
    for (i = 0; i < bands.length; i++) {
      var yT = Math.floor(ph * i / bands.length), yB = Math.floor(ph * (i + 1) / bands.length);
      bx.fillStyle = bands[i]; bx.fillRect(0, yT, pw, yB - yT);
      // 4-row checker dither between bands — classic 16-bit sky gradient
      if (i > 0) { bx.fillStyle = bands[i - 1]; for (y = 0; y < 4; y++) for (x = 0; x < pw; x++) { var keep = y < 2 ? (((x + y) & 1) === 0) : (((x + y) % 4) === 0); if (keep) bx.fillRect(x, yT + y, 1, 1); } }
    }
    // a bold horizon glow line + ground strip at the bottom (depth: sky over floor)
    var gy = Math.floor(ph * 0.86);
    bx.fillStyle = P.gold; bx.fillRect(0, gy, pw, 1);
    bx.fillStyle = P.orange; bx.fillRect(0, gy + 1, pw, 1);
    bx.fillStyle = '#12082E'; bx.fillRect(0, gy + 2, pw, ph - gy - 2);
    // perspective grid on the floor (synthwave pixel floor — magenta lines)
    bx.fillStyle = P.magenta; bx.globalAlpha = 0.55;
    for (y = gy + 3; y < ph; y += 3 + Math.floor((y - gy) / 6)) bx.fillRect(0, y, pw, 1);
    for (i = -6; i <= 6; i++) { for (y = gy + 2; y < ph; y++) { var fx = Math.round(cx + i * (y - gy) * 1.6); if (fx >= 0 && fx < pw) bx.fillRect(fx, y, 1, 1); } }
    bx.globalAlpha = 1;
    // 2) radial HALFTONE dot field (the comic signature): sparse 1px dots
    //    near the burst origin, 2px dots at the rim — grid 6px, offset rows
    //    so it reads as a dot screen, never as a mesh. Cyan near, pink far.
    var maxR = Math.sqrt(cx * cx + Math.max(cy, ph - cy) * Math.max(cy, ph - cy));
    var row = 0;
    for (y = 3; y < ph; y += 6, row++) for (x = (row & 1) ? 6 : 3; x < pw; x += 6) {
      var dd = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxR;
      if (dd < 0.18) continue;
      if (y > gy) continue;
      var sz = dd < 0.45 ? 1 : (dd < 0.75 ? 2 : 3);
      bx.globalAlpha = 0.6 + 0.4 * dd;
      bx.fillStyle = dd < 0.4 ? P.gold2 : (dd < 0.7 ? P.cyan : P.magenta);
      bx.fillRect(x, y, sz, sz);
    }
    bx.globalAlpha = 1;
    this.spr.pxBg = bg;
    this.pxCenter = { x: cx, y: cy };
    // 3) SUNBURST rays — baked once as a rotatable sprite: 12 chunky wedges,
    //    gold / magenta / cyan in turn, bright and clean over the navy field
    var rr = Math.ceil(maxR) + 4, rays = mk(rr * 2, rr * 2), rx = rays.getContext('2d');
    var N = 12, rayCols = [P.gold, P.magenta, P.cyan, P.orange];
    var wedge = function (a0, a1, r0, r1) { rx.beginPath(); rx.moveTo(rr + Math.cos(a0) * r0, rr + Math.sin(a0) * r0); rx.lineTo(rr + Math.cos(a0) * r1, rr + Math.sin(a0) * r1); rx.lineTo(rr + Math.cos(a1) * r1, rr + Math.sin(a1) * r1); rx.lineTo(rr + Math.cos(a1) * r0, rr + Math.sin(a1) * r0); rx.closePath(); rx.fill(); };
    for (i = 0; i < N; i++) {
      var a0 = (i / N) * 6.2832, a1 = a0 + (0.46 / N) * 6.2832, aw = (a1 - a0) * 0.12;
      rx.globalAlpha = 0.9; rx.fillStyle = P.ink; wedge(a0 - aw, a1 + aw, 0, rr);          // ink outline → crisp wedge edges
      rx.globalAlpha = 0.85; rx.fillStyle = rayCols[i % 4]; wedge(a0, a1, 0, rr);
      rx.globalAlpha = 0.5; rx.fillStyle = P.white; wedge(a0 + (a1 - a0) * 0.3, a0 + (a1 - a0) * 0.5, 0, rr); // highlight stripe
    }
    // a bright core disc — the burst origin reads as a sun behind the logo
    rx.globalAlpha = 1; rx.fillStyle = P.gold2; rx.beginPath(); rx.arc(rr, rr, 9, 0, 6.2832); rx.fill();
    rx.fillStyle = P.white; rx.beginPath(); rx.arc(rr, rr, 5, 0, 6.2832); rx.fill();
    rx.globalAlpha = 1;
    this.spr.pxRays = rays; this.pxRayAng = 0; this.pxRayR = rr;
    // 4) comic STAR-BURSTS (the white spiky shapes) — pixel sprites in 3 sizes,
    //    white fill, ink outline, a cyan/magenta inner spark
    var starSprite = function (R, fill, inner) {
      var c = mk(R * 2 + 4, R * 2 + 4), g = c.getContext('2d'), k, spikes = 8;
      var poly = function (rad0, rad1) {
        g.beginPath();
        for (k = 0; k < spikes * 2; k++) { var an = (k / (spikes * 2)) * 6.2832 - 1.5708, rd = (k % 2) ? rad1 : rad0; g.lineTo(R + 2 + Math.cos(an) * rd, R + 2 + Math.sin(an) * rd); }
        g.closePath();
      };
      g.fillStyle = P.ink; poly(R + 1.6, R * 0.5 + 1.6); g.fill();
      g.fillStyle = fill; poly(R, R * 0.5); g.fill();
      g.fillStyle = inner; poly(R * 0.42, R * 0.18); g.fill();
      return c;
    };
    this.spr.pxStarBig = starSprite(13, P.white, P.cyan);
    this.spr.pxStarMid = starSprite(8, P.gold2, P.orange);
    this.spr.pxStarSm = starSprite(4, P.lime, P.white);
    this.spr.pxStarPink = starSprite(8, P.pink, P.magenta);
    // fixed comic composition: big bursts pinned to the corners/edges, mids
    // spread around, smalls scattered — like the reference frame
    this.pxBursts = [
      { s: 'big', x: pw * 0.06, y: ph * 0.16, ph: rnd(0, 6.28) }, { s: 'big', x: pw * 0.94, y: ph * 0.72, ph: rnd(0, 6.28) },
      { s: 'big', x: pw * 0.90, y: ph * 0.10, ph: rnd(0, 6.28) }, { s: 'big', x: pw * 0.10, y: ph * 0.80, ph: rnd(0, 6.28) },
      { s: 'mid', x: pw * 0.30, y: ph * 0.90, ph: rnd(0, 6.28) }, { s: 'mid', x: pw * 0.72, y: ph * 0.88, ph: rnd(0, 6.28) },
      { s: 'mid', x: pw * 0.22, y: ph * 0.06, ph: rnd(0, 6.28) }, { s: 'mid', x: pw * 0.66, y: ph * 0.04, ph: rnd(0, 6.28) }
    ];
    this.pxBursts.push({ s: 'pink', x: pw * 0.14, y: ph * 0.48, ph: rnd(0, 6.28) }, { s: 'pink', x: pw * 0.86, y: ph * 0.40, ph: rnd(0, 6.28) });
    for (i = 0; i < 14; i++) this.pxBursts.push({ s: 'sm', x: rnd(2, pw - 2), y: rnd(2, ph * 0.84), ph: rnd(0, 6.28) });
    // 5) drifting chunky clouds — slab + two bumps, cyan tint with an ink under-edge
    this.pxClouds = [];
    for (i = 0; i < 5; i++) {
      var depth = i < 2 ? 0 : (i < 4 ? 1 : 2);
      var wpx = depth === 0 ? rnd(10, 15) : depth === 1 ? rnd(16, 24) : rnd(26, 36);
      this.pxClouds.push({ x: rnd(-30, pw + 10), y: rnd(2, ph * 0.3), w: wpx | 0, h: Math.max(2, Math.round(wpx * rnd(0.3, 0.42))),
        v: depth === 0 ? 1.0 : depth === 1 ? 2.0 : 3.4, a: depth === 0 ? 0.7 : depth === 1 ? 0.85 : 1,
        b1: rnd(0.15, 0.4), b2: rnd(0.6, 0.85), bw: rnd(0.18, 0.3) });
    }
    // 6) twinkles — single pixels in gold / cyan / white (slow sine gate)
    this.pxStars = [];
    for (i = 0; i < 40; i++) this.pxStars.push({ x: rnd(0, pw) | 0, y: rnd(0, ph) | 0, ph: rnd(0, 6.28), sp: rnd(0.6, 1.4), c: i % 3 === 0 ? P.gold2 : i % 3 === 1 ? P.cyan2 : P.white });
    // 7) centre READABILITY vignette (screen-space, drawn after the upscale):
    //    a soft dark column where the cards live — the art stays vivid at the edges
    var v = mk(256, 256), vx = v.getContext('2d');
    var rg = vx.createRadialGradient(128, 128, 30, 128, 128, 150);
    rg.addColorStop(0, 'rgba(7,11,28,.55)'); rg.addColorStop(0.55, 'rgba(7,11,28,.22)'); rg.addColorStop(1, 'rgba(7,11,28,0)');
    vx.fillStyle = rg; vx.fillRect(0, 0, 256, 256);
    this.spr.pxVignette = v;
  };

  // GLOWING — layered light fields + drifting sparks + edge vignette. The
  // BACKGROUND stays soft and dim: the hierarchy lives in the UI, where only
  // important elements glow (see the CSS tokens).
  ThemeScene.prototype.bakeGlow = function () {
    var c1 = this.c1(), c2 = this.c2();
    // vignette overlay (dark edges → the center reads brighter than the rim)
    var v = mk(512, 512), vx = v.getContext('2d');
    var rg = vx.createRadialGradient(256, 256, 120, 256, 256, 340);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(2,2,12,.5)');
    vx.fillStyle = rg; vx.fillRect(0, 0, 512, 512);
    this.spr.vignette = v;
    this.p = [];
    for (var i = 0; i < 6; i++) {
      this.p.push({ x: rnd(0, this.w), y: rnd(0, this.h), r: rnd(110, 260), v: rnd(3, 9), ang: rnd(0, 6.28), ph: rnd(0, 6.28), c: i % 2 });
    }
    this.sparks = [];
    for (var s = 0; s < 16; s++) {
      this.sparks.push({ x: rnd(0, this.w), y: rnd(0, this.h), r: rnd(0.8, 2.1), v: rnd(2, 7), ph: rnd(0, 6.28), c: Math.random() < 0.5 ? c1 : c2 });
    }
  };

  // ---------------------------------------------------------------------------

  ThemeScene.prototype.seed = function () {
    var i, w = this.w, h = this.h;
    this.p = [];
    this.t = 0;
    this.pulseAt = rnd(2.5, 5.5);
    if (this.theme === 'flame') {
      for (i = 0; i < 34; i++) this.p.push({ x: rnd(0, w), y: rnd(h * 0.25, h), r: rnd(1.2, 4.2), v: rnd(14, 46), sway: rnd(6, 26), ph: rnd(0, 6.28), a: rnd(0.25, 0.7) });
    } else if (this.theme === 'glitch') {
      for (i = 0; i < 26; i++) this.p.push({ x: rnd(0, w), y: rnd(0, h), v: rnd(8, 30), w: rnd(20, 90), h: rnd(1, 3), a: rnd(0.05, 0.22) });
    }
    this.bake();
  };

  ThemeScene.prototype.setPalette = function (theme, custom) {
    var themeChanged = theme !== this.theme;
    var palChanged = JSON.stringify(custom || null) !== JSON.stringify(this.custom || null);
    this.theme = theme; this.custom = custom || null;
    if (themeChanged) { this.seed(); }
    else if (palChanged) { this._bakeKey = null; this.bake(); }
    if (REDUCED || !this.motion) this.staticFrame();
  };

  // v55: Animations OFF freezes the clock but NEVER hides the scene — the
  // theme's full visual identity stays on screen as a static frame.
  ThemeScene.prototype.setMotion = function (on) {
    this.motion = !!on;
    if (this.cloudSky) { try { this.cloudSky.setMotion(on); } catch (e) {} } // v56
    if (!this.motion) {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      this.staticFrame();
    } else if (!this.raf && !this.dead && !REDUCED) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.tick.bind(this));
    }
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

  // ---- per-theme simulation ------------------------------------------------
  ThemeScene.prototype.step = function (dt) {
    this.t += dt;
    var i, p, w = this.w, h = this.h;
    if (this.theme === 'flame') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.y -= p.v * dt; p.ph += dt * 3; if (p.y < -8) { p.y = h + 8; p.x = rnd(0, w); } }
    } else if (this.theme === 'cloud') {
      if (this.cloudSky) return; // v56: CloudSky owns its clock
      var cs = this.spr.clouds || [];
      for (i = 0; i < cs.length; i++) {
        p = cs[i]; p.x += p.v * dt; p.ph += dt * 0.5;
        if (p.x - p.img.width > w) { p.x = -p.img.width + 10; p.y = (p.depth === 0 ? rnd(0.03, 0.2) : rnd(0.07, 0.52)) * h; }
      }
      var st = this.spr.streaks || [];
      for (i = 0; i < st.length; i++) {
        p = st[i]; p.x += p.v * dt;
        if (p.x - p.img.width > w) { p.x = -p.img.width; p.y = rnd(0.05, 0.3) * h; }
      }
    } else if (this.theme === 'glitch') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.y += p.v * dt; if (p.y > h) { p.y = -4; p.x = rnd(0, w); } }
      this.burst = Math.max(0, this.burst - dt);
      // v54: pulses come a little more often (3.5–7.5s) — still long calm
      // stretches between; each pulse may burst buttons, and ~1 in 10 (true
      // random roll, never a counter) escalates to the fullscreen takeover.
      if (this.t >= this.pulseAt) {
        this.pulseAt = this.t + rnd(3.5, 7.5);
        this.doPulse();
      }
    } else if (this.theme === 'graffiti') {
      // drips run down under gravity, bulge at the head, then dry (stop)
      for (i = 0; i < (this.drips || []).length; i++) {
        var d = this.drips[i];
        if (d.started > 0) { d.started -= dt; continue; }
        if (d.len < d.max) { d.len += d.v * dt * (1 - 0.4 * (d.len / d.max)); if (d.len >= d.max) this.stats.drips++; }
      }
      // a fresh monochrome spray pass every few seconds — energy, wall stays put
      this.nextSpray -= dt;
      if (this.nextSpray <= 0) {
        this.nextSpray = rnd(2.2, 5);
        var col = Math.random() < 0.6 ? '#F2F2F2' : '#9a9a9a';
        this.sprays.push({ x: rnd(w * 0.05, w * 0.95), y: rnd(h * 0.08, h * 0.92), r: rnd(26, 64), a: 0, rise: true, c: col });
        if (this.sprays.length > 5) this.sprays.shift();
      }
      for (i = 0; i < this.sprays.length; i++) {
        var s = this.sprays[i];
        s.a += (s.rise ? 2.4 : -1.6) * dt;
        if (s.a >= 0.5) s.rise = false;
        if (s.a <= 0) s.a = 0;
      }
    } else if (this.theme === 'magazine') {
      var sh = this.spr.sheets || [];
      for (i = 0; i < sh.length; i++) {
        p = sh[i];
        if (p.settle < 1) p.settle = Math.min(1, p.settle + dt * 1.4);
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt * 0.2;
        if (p.x < -p.img.width) p.x = w; if (p.x > w + 10) p.x = -p.img.width;
        if (p.y < -p.img.height) p.y = h; if (p.y > h + 10) p.y = -p.img.height;
      }
      // v55: the small collage fragments breathe too
      var dr2 = function (arr) { for (var k = 0; k < arr.length; k++) { var e = arr[k]; e.x += e.vx * dt; e.y += e.vy * dt; e.rot += e.vr * dt * 0.2; if (e.x < -e.img.width) e.x = w; if (e.x > w + 8) e.x = -e.img.width; if (e.y < -e.img.height) e.y = h; if (e.y > h + 8) e.y = -e.img.height; } };
      dr2(this.spr.frags || []); dr2(this.spr.strips || []); dr2(this.spr.dots || []);
      // occasionally a NEW clipping gets placed onto the collage
      this.nextPlace -= dt;
      if (this.nextPlace <= 0 && sh.length) {
        this.nextPlace = rnd(5, 9);
        var old = sh[Math.floor(rnd(0, sh.length))];
        old.settle = 0; old.x = rnd(-10, w - 80); old.y = rnd(-10, h - 80); old.rot = rnd(-0.34, 0.34);
        this.stats.placed++;
      }
    } else if (this.theme === 'stitch') {
      // the invisible hand: draw → hold → unpick → next design (one at a time)
      var sk = this.sketch;
      if (sk) {
        if (sk.phase === 'draw') {
          sk.u += dt * 0.22;                          // ~4.5s per garment
          if (sk.u >= 1) { sk.u = 1; sk.phase = 'hold'; sk.hold = 1.9; }
        } else if (sk.phase === 'hold') {
          sk.hold -= dt;
          if (sk.hold <= 0) sk.phase = 'unpick';
        } else {
          sk.u -= dt * 0.5;                           // stitches unpick quickly
          if (sk.u <= 0) { sk.u = 0; sk.phase = 'draw'; sk.idx = (sk.idx + 1) % 3; }
        }
      }
      var th = this.spr.threads || [];
      for (i = 0; i < th.length; i++) { th[i].x += th[i].vx * dt; th[i].ph += dt * 0.6; if (th[i].x > this.w + 20) th[i].x = -100; if (th[i].x < -100) th[i].x = this.w + 20; }
    } else if (this.theme === 'pixel') {
      var pcx = this.pxClouds || [];
      for (i = 0; i < pcx.length; i++) { pcx[i].x += pcx[i].v * dt; if (pcx[i].x - 45 > this.spr.px.width) pcx[i].x = -45; }
      var pst = this.pxStars || [];
      for (i = 0; i < pst.length; i++) pst[i].ph += pst[i].sp * dt;
      var pbs = this.pxBursts || [];
      for (i = 0; i < pbs.length; i++) pbs[i].ph += dt * 1.1;
      this.pxRayAng = (this.pxRayAng || 0) + dt * 0.06;  // v57: the sunburst turns, slowly
    } else if (this.theme === 'glowing') {
      for (i = 0; i < this.p.length; i++) { p = this.p[i]; p.ph += dt * 0.8; p.ang += dt * 0.12; p.x += Math.cos(p.ang) * p.v * dt; p.y += Math.sin(p.ang) * p.v * dt; if (p.x < -p.r) p.x = w + p.r; if (p.x > w + p.r) p.x = -p.r; if (p.y < -p.r) p.y = h + p.r; if (p.y > h + p.r) p.y = -p.r; }
      for (i = 0; i < this.sparks.length; i++) { var k = this.sparks[i]; k.ph += dt * 1.7; k.y -= k.v * dt; if (k.y < -6) { k.y = h + 6; k.x = rnd(0, w); } }
    }
  };

  // glitch pulse: page pulse + button burst; fullscreen on a true ~1-in-10 roll
  ThemeScene.prototype.doPulse = function () {
    this.stats.pulses++;
    this.burst = 0.4;
    var allowed = true;
    try { if (typeof window.__pthGlitchAllowed === 'function') allowed = window.__pthGlitchAllowed(); } catch (e) {}
    if (!allowed || REDUCED) return;
    try {
      document.body.classList.add('pth-glitch-pulse');
      var self = this;
      setTimeout(function () { document.body.classList.remove('pth-glitch-pulse'); }, 200);
      window.dispatchEvent(new CustomEvent('aa-glitch-pulse'));
      // gradient buttons glitch along (short burst, still readable/clickable)
      if (Math.random() < 0.85) {
        this.stats.bursts++;
        window.dispatchEvent(new CustomEvent('aa-glitch-burst', { detail: {} }));
      }
      // the rare one: fullscreen takeover, ~3s, pointer-transparent
      if (Math.random() < 0.10) {
        this.stats.fullscreen++;
        window.dispatchEvent(new CustomEvent('aa-glitch-fullscreen', { detail: { duration: 3000 } }));
      }
    } catch (e) {}
  };
  // deterministic hooks for the e2e battery (never used by the app itself)
  ThemeScene.prototype.forceEvent = function (kind) {
    if (kind === 'fullscreen') { this.stats.fullscreen++; try { window.dispatchEvent(new CustomEvent('aa-glitch-fullscreen', { detail: { duration: 3000, forced: true } })); } catch (e) {} }
    else if (kind === 'burst') { this.stats.bursts++; try { window.dispatchEvent(new CustomEvent('aa-glitch-burst', { detail: { forced: true } })); } catch (e) {} }
    else this.doPulse();
  };

  // ---- painting ------------------------------------------------------------
  ThemeScene.prototype.draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h, i, p, c1 = this.c1(), c2 = this.c2();
    if (this.cloudSky) return; // v56: the CloudSky shader paints the frame
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
      // v55: deeper, moodier sky (edgier than pale baby blue)
      var sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#6fb3e8'); sky.addColorStop(0.6, '#a8d4f2'); sky.addColorStop(1, '#e8f4fc');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      var st = this.spr.streaks || [];
      for (i = 0; i < st.length; i++) { p = st[i]; ctx.globalAlpha = p.a; ctx.drawImage(p.img, Math.round(p.x), Math.round(p.y)); }
      var cs = (this.spr.clouds || []).slice().sort(function (a, b) { return a.depth - b.depth; });
      for (i = 0; i < cs.length; i++) {
        p = cs[i];
        ctx.globalAlpha = p.a;
        if (p.haze) { ctx.globalAlpha = 1; ctx.drawImage(p.img, Math.round(p.x), Math.round(p.y + Math.sin(p.ph) * p.bob)); ctx.globalAlpha = 1; }
        else ctx.drawImage(p.img, Math.round(p.x), Math.round(p.y + Math.sin(p.ph) * p.bob));
      }
      ctx.globalAlpha = 1;
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
      // the user's EXACT wall image, cover-fit — v56: the page base always
      // paints first so the photo's edges feather into the UI, and the wall
      // breathes almost imperceptibly (a living surface, not a pasted PNG).
      ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, w, h);
      var wc = this.spr.wallCanvas;
      if (wc) {
        var br = 1 + 0.014 * Math.sin(this.t * 0.35);
        var bw2 = wc.c.width * br, bh2 = wc.c.height * br;
        ctx.drawImage(wc.c, wc.x - (bw2 - wc.c.width) / 2, wc.y - (bh2 - wc.c.height) / 2, bw2, bh2);
      }
      if (this.spr.scrimTop) ctx.drawImage(this.spr.scrimTop, 0, 0, w, h * 0.22);
      if (this.spr.scrimBottom) ctx.drawImage(this.spr.scrimBottom, 0, h - h * 0.22, w, h * 0.22);
      if (this.spr.scrimVig) ctx.drawImage(this.spr.scrimVig, 0, 0, w, h);
      // fresh monochrome spray passes (breathe in, fade)
      for (i = 0; i < (this.sprays || []).length; i++) {
        var sp = this.sprays[i];
        var sg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, sp.r);
        sg.addColorStop(0, rgba(sp.c, 0.16 * sp.a * 2)); sg.addColorStop(0.7, rgba(sp.c, 0.07 * sp.a * 2)); sg.addColorStop(1, rgba(sp.c, 0));
        ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sp.x, sp.y, sp.r, 0, 6.283); ctx.fill();
      }
      // realistic drips: tapered runs ending in bulbous heads
      for (i = 0; i < (this.drips || []).length; i++) {
        var dr = this.drips[i];
        if (dr.started > 0 || dr.len <= 1) continue;
        drawDrip(ctx, dr.x, dr.y, dr.len, dr.w, dr.c, 0.85);
      }
    } else if (this.theme === 'stitch') {
      // atelier base: dark linen with the weave texture
      var linen = ctx.createLinearGradient(0, 0, 0, h);
      linen.addColorStop(0, '#2c2531'); linen.addColorStop(1, '#241e29');
      ctx.fillStyle = linen; ctx.fillRect(0, 0, w, h);
      var weave = this.spr.weave;
      if (weave) for (var yy = 0; yy < h; yy += weave.height) for (var xx = 0; xx < w; xx += weave.width) ctx.drawImage(weave, xx, yy);
      // drifting thread curls
      var ths = this.spr.threads || [];
      for (i = 0; i < ths.length; i++) ctx.drawImage(ths[i].img, Math.round(ths[i].x), Math.round(ths[i].y + Math.sin(ths[i].ph) * 5));
      // the hoop (design box lives inside it)
      var hoop = this.spr.hoop;
      if (hoop) ctx.drawImage(hoop, Math.round(w * 0.5 - hoop.width / 2), Math.round(h * 0.52 - hoop.height / 2));
      // the living sketch: one garment, progressively stitched
      var self = this, sk = this.sketch, D = this.designPx();
      if (sk && D) {
        var garment = D.items[sk.idx % D.items.length];
        var target = garment.total * sk.u;
        var colFor = function (k) { return k === 'c1' ? self.c1() : k === 'c2' ? self.c2() : k === 'gold' ? '#E8B84B' : k === 'sage' ? '#7FBF9E' : k; };
        var fade = sk.phase === 'unpick' ? 0.5 : (sk.phase === 'hold' ? 0.62 + 0.06 * Math.sin(this.t * 2.2) : 0.58);
        var tip = null, tipDir = [1, 0];
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (var s2 = 0; s2 < garment.strokes.length; s2++) {
          var st2 = garment.strokes[s2];
          if (st2.dot) {
            if (st2.at <= target) {
              ctx.fillStyle = rgba(colFor(st2.c), 0.75);
              ctx.beginPath(); ctx.arc(st2.x, st2.y, st2.r, 0, 6.283); ctx.fill();
            }
            continue;
          }
          if (st2.at >= target) { if (!tip && st2.pts.length) { tip = st2.pts[0]; tipDir = st2.pts.length > 1 ? [st2.pts[1][0] - st2.pts[0][0], st2.pts[1][1] - st2.pts[0][1]] : tipDir; } continue; }
          var reach = target - st2.at;              // how far into this stroke
          ctx.strokeStyle = rgba(colFor(st2.c), fade);
          ctx.lineWidth = st2.lw; ctx.setLineDash(st2.dash);
          ctx.beginPath(); ctx.moveTo(st2.pts[0][0], st2.pts[0][1]);
          var acc = 0, endPt = st2.pts[st2.pts.length - 1], done = true;
          for (var k2 = 1; k2 < st2.pts.length; k2++) {
            var a2 = st2.pts[k2 - 1], b2 = st2.pts[k2];
            var segLen = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
            if (acc + segLen <= reach) { ctx.lineTo(b2[0], b2[1]); acc += segLen; }
            else {
              var f2 = Math.max(0, (reach - acc) / (segLen || 1));
              var px2 = a2[0] + (b2[0] - a2[0]) * f2, py2 = a2[1] + (b2[1] - a2[1]) * f2;
              ctx.lineTo(px2, py2);
              endPt = [px2, py2]; tipDir = [b2[0] - a2[0], b2[1] - a2[1]]; done = false;
              break;
            }
          }
          ctx.stroke(); ctx.setLineDash([]);
          if (!done) tip = endPt; else if (s2 === garment.strokes.length - 1 || garment.strokes[s2 + 1].at >= target) tip = endPt;
        }
        // the only visible part of the "hand": a floating needle at the tip.
        // Parked (hidden) while the finished design is held for admiration.
        if (sk.phase !== 'hold' && tip) {
          var dl = Math.hypot(tipDir[0], tipDir[1]) || 1;
          var dx2 = tipDir[0] / dl, dy2 = tipDir[1] / dl;
          ctx.strokeStyle = 'rgba(226,230,238,.85)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(tip[0] + dx2 * 3, tip[1] + dy2 * 3);
          ctx.lineTo(tip[0] - dx2 * 15, tip[1] - dy2 * 15); ctx.stroke();
          ctx.strokeStyle = rgba(self.c2(), 0.6); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(tip[0] - dx2 * 15, tip[1] - dy2 * 15);
          ctx.quadraticCurveTo(tip[0] - dx2 * 26, tip[1] - dy2 * 8 + 7, tip[0] - dx2 * 20, tip[1] + 14); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,.95)';
          ctx.beginPath(); ctx.arc(tip[0] + dx2 * 2, tip[1] + dy2 * 2, 1.8, 0, 6.283); ctx.fill();
        }
      }
    } else if (this.theme === 'pixel') {
      var px = this.spr.px, S = this.pxScale || 5, PX = ThemeScene.PIXEL;
      if (px) {
        var g2 = px.getContext('2d');
        var pw = px.width, ph = px.height;
        g2.imageSmoothingEnabled = false;
        g2.drawImage(this.spr.pxBg, 0, 0);
        // sunburst rays: rotation quantized to 1/48 turn so the wedges step
        // like frames of a sprite (pixel motion, not a smooth spin)
        if (this.spr.pxRays) {
          var qa = Math.round((this.pxRayAng || 0) / (6.2832 / 48)) * (6.2832 / 48);
          g2.save(); g2.translate(this.pxCenter.x, this.pxCenter.y); g2.rotate(qa);
          g2.drawImage(this.spr.pxRays, -this.pxRayR, -this.pxRayR);
          g2.restore();
        }
        // drifting chunky clouds
        for (i = 0; i < (this.pxClouds || []).length; i++) {
          var pc3 = this.pxClouds[i];
          var cx2 = pc3.x | 0, cy2 = pc3.y | 0;
          g2.globalAlpha = pc3.a;
          var b1x = cx2 + Math.round(pc3.b1 * pc3.w), b1w = Math.round(pc3.bw * pc3.w), b2x = cx2 + Math.round(pc3.b2 * pc3.w), b2w = Math.round(pc3.bw * pc3.w * 0.8);
          // ink outline (1px around) → the cloud reads as a drawn sprite
          g2.fillStyle = PX.ink;
          g2.fillRect(cx2 - 1, cy2 - 1, pc3.w + 2, pc3.h + 2); g2.fillRect(b1x - 1, cy2 - 3, b1w + 2, 3); g2.fillRect(b2x - 1, cy2 - 2, b2w + 2, 2);
          g2.fillStyle = PX.white;
          g2.fillRect(cx2, cy2, pc3.w, pc3.h); g2.fillRect(b1x, cy2 - 2, b1w, 2); g2.fillRect(b2x, cy2 - 1, b2w, 1);
          g2.fillStyle = PX.cyan; // cyan shade on the underside
          g2.fillRect(cx2, cy2 + pc3.h - 1, pc3.w, 1); g2.fillRect(cx2 + 1, cy2 + pc3.h - 2, Math.max(1, pc3.w - 2), 1);
          g2.globalAlpha = 1;
        }
        // comic star-bursts (a slow 1px "breathe" — sprite swap, never a blur)
        for (i = 0; i < (this.pxBursts || []).length; i++) {
          var bb = this.pxBursts[i];
          var spr = bb.s === 'big' ? this.spr.pxStarBig : bb.s === 'mid' ? this.spr.pxStarMid : bb.s === 'pink' ? this.spr.pxStarPink : this.spr.pxStarSm;
          if (!spr) continue;
          var grow = Math.sin(bb.ph) > 0.6 ? 1 : 0;
          g2.drawImage(spr, (bb.x - spr.width / 2 - grow) | 0, (bb.y - spr.height / 2 - grow) | 0, spr.width + grow * 2, spr.height + grow * 2);
        }
        // twinkles
        for (i = 0; i < (this.pxStars || []).length; i++) {
          var st3 = this.pxStars[i];
          var on = Math.sin(st3.ph);
          if (on > 0.25) { g2.fillStyle = st3.c; g2.globalAlpha = Math.min(1, on); g2.fillRect(st3.x, st3.y, 1, 1); if (on > 0.85) { g2.fillRect(st3.x - 1, st3.y, 3, 1); g2.fillRect(st3.x, st3.y - 1, 1, 3); } g2.globalAlpha = 1; }
        }
        // upscale with NEAREST — chunky pixels, no smoothing
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(px, 0, 0, pw, ph, 0, 0, pw * S, ph * S);
        ctx.imageSmoothingEnabled = true;
        // readability: soft centre column over the burst origin
        if (this.spr.pxVignette) ctx.drawImage(this.spr.pxVignette, w * 0.5 - Math.max(w, h) * 0.55, h * 0.42 - Math.max(w, h) * 0.55, Math.max(w, h) * 1.1, Math.max(w, h) * 1.1);
      }
    } else if (this.theme === 'glowing') {
      // deep base
      var bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#0a0a18'); bg.addColorStop(1, '#0d0d22');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      for (i = 0; i < this.p.length; i++) { p = this.p[i];
        var pulse = 0.5 + 0.5 * Math.sin(p.ph);
        var rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        rg.addColorStop(0, rgba(p.c ? c2 : c1, 0.08 + 0.06 * pulse)); rg.addColorStop(1, rgba(p.c ? c2 : c1, 0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
      for (i = 0; i < this.sparks.length; i++) { var k = this.sparks[i];
        var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(k.ph));
        var kg = ctx.createRadialGradient(k.x, k.y, 0, k.x, k.y, k.r * 5);
        kg.addColorStop(0, rgba(k.c, 0.5 * tw)); kg.addColorStop(1, rgba(k.c, 0));
        ctx.fillStyle = kg; ctx.beginPath(); ctx.arc(k.x, k.y, k.r * 5, 0, 6.283); ctx.fill();
      }
      if (this.spr.vignette) ctx.drawImage(this.spr.vignette, 0, 0, w, h);
    } else if (this.theme === 'magazine') {
      // paper desk base
      var desk = ctx.createLinearGradient(0, 0, 0, h);
      desk.addColorStop(0, '#e9e5dc'); desk.addColorStop(1, '#efeae0');
      ctx.fillStyle = desk; ctx.fillRect(0, 0, w, h);
      var layer = function (arr) { for (var k = 0; k < arr.length; k++) { var e = arr[k]; ctx.save(); ctx.globalAlpha = e.a; ctx.translate(e.x + e.img.width / 2, e.y + e.img.height / 2); ctx.rotate(e.rot); ctx.drawImage(e.img, -e.img.width / 2, -e.img.height / 2); ctx.restore(); } };
      layer(this.spr.dots || []); layer(this.spr.strips || []);
      var sh2 = (this.spr.sheets || []).slice().sort(function (a, b) { return (a.img.width * a.img.height) - (b.img.width * b.img.height); });
      for (i = 0; i < sh2.length; i++) {
        p = sh2[i];
        ctx.save();
        ctx.globalAlpha = p.a * p.settle;
        ctx.translate(p.x + p.img.width / 2, p.y + p.img.height / 2);
        ctx.rotate(p.rot);
        var sc = 1 + (1 - p.settle) * 0.12;       // settle-in: placed with a soft drop
        ctx.scale(sc, sc);
        ctx.drawImage(p.img, -p.img.width / 2, -p.img.height / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      layer(this.spr.frags || []);   // typography fragments float on top
    }
  };

  ThemeScene.prototype.staticFrame = function () {
    if (this.cloudSky) { try { this.cloudSky.staticFrame(); } catch (e) {} return; } // v57: the shader paints its own still
    this.step(0.016); this.draw();
  };

  ThemeScene.prototype.dispose = function () {
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.cloudSky) { try { this.cloudSky.dispose(); } catch (e) {} this.cloudSky = null; } // v56
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
    try { if (window.__pthScene === this) window.__pthScene = null; } catch (e) {}
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  ThemeScene.PALETTE = {
    flame: { c1: '#FF5A00', c2: '#FFC300' },
    glitch: { c1: '#00F0FF', c2: '#FF2BD1' },
    glowing: { c1: '#6ED4BF', c2: '#51A8D9' },   // v55: green+blue derived from the supplied logo
    pixel: { c1: '#E337C4', c2: '#77D5DF' },      // v56: arcade magenta+cyan from the supplied pixel logo
    graffiti: { c1: '#F2F2F2', c2: '#BFBFBF' },  // v55: pure black & white world
    stitch: { c1: '#E8D8C4', c2: '#FF6A5A' },
    cloud: { c1: '#4A9FE8', c2: '#8EC9F5' },
    magazine: { c1: '#FF5A5A', c2: '#222228' }
  };

  // read-only stats for the e2e battery (and curious devs)
  try {
    Object.defineProperty(window, '__pthSceneStats', { get: function () { return window.__pthScene && !window.__pthScene.dead ? window.__pthScene.stats : null; } });
    window.__pthForceEvent = function (kind) { if (window.__pthScene && !window.__pthScene.dead) window.__pthScene.forceEvent(kind); };
  } catch (e) {}

  window.ThemeScene = ThemeScene;
})();
