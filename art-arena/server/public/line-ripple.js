// Line Ripple Background — vanilla port of the Originkit "custom-style"
// React component the user supplied (v46). Two theme versions were given,
// identical except for colors:
//   DARK  → strokeColor #EA69F1 on backgroundColor #09070D
//   LIGHT → strokeColor #F200FF on backgroundColor #FFFFFF
// This port keeps the original physics verbatim (simplex-noise curl field,
// seeded permutation, BASE_ANGLE 0 / CURL 3 / SEED 0.5, count 82 → the same
// grid gap curve, movement 14, resolution 1 → the same line half-length) so
// the animation is frame-for-frame the one they approved in the preview.
// The React mouse-bend interaction (hover/force) was NOT ported: the supplied
// presets run with hover=false + force=0, i.e. it is inert in their code too.
// Instead of two mounted components, ONE instance lives on the page and its
// stroke follows the app theme — so exactly one animation is ever active.
(function () {
  'use strict';

  function createNoise2D(seed) {
    var F2 = 0.5 * (Math.sqrt(3) - 1);
    var G2 = (3 - Math.sqrt(3)) / 6;
    var G22 = (3 - Math.sqrt(3)) / 3;
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    var seededRandom = function (index) {
      var x = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    for (var k = 255; k > 0; k--) {
      var n = Math.floor((k + 1) * seededRandom(k));
      var q = p[k]; p[k] = p[n]; p[n] = q;
    }
    var perm = new Uint8Array(512);
    var permMod12 = new Uint8Array(512);
    for (var w = 0; w < 512; w++) { perm[w] = p[w & 255]; permMod12[w] = perm[w] % 12; }
    var grad2 = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);
    var fastFloor = function (x) { return Math.floor(x) | 0; };
    return function noise2D(x, y) {
      var s = (x + y) * F2;
      var i = fastFloor(x + s);
      var j = fastFloor(y + s);
      var t = (i + j) * G2;
      var x0 = x - (i - t);
      var y0 = y - (j - t);
      var i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      var x2 = x0 - 1 + G22, y2 = y0 - 1 + G22;
      var ii = i & 255, jj = j & 255;
      var gi0 = permMod12[ii + perm[jj]];
      var gi1 = permMod12[ii + i1 + perm[jj + j1]];
      var gi2 = permMod12[ii + 1 + perm[jj + 1]];
      var n0 = 0, n1 = 0, n2 = 0;
      var t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (grad2[gi0 * 2] * x0 + grad2[gi0 * 2 + 1] * y0); }
      var t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (grad2[gi1 * 2] * x1 + grad2[gi1 * 2 + 1] * y1); }
      var t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (grad2[gi2 * 2] * x2 + grad2[gi2 * 2 + 1] * y2); }
      return 70 * (n0 + n1 + n2);
    };
  }

  var BASE_ANGLE = 0;
  var CURL = 3;
  var SEED = 0.5;

  function LineRipple(host, opts) {
    opts = opts || {};
    this._host = host;
    this._stroke = opts.strokeColor || '#EA69F1';
    this._count = Math.max(1, Math.min(100, opts.count != null ? opts.count : 82));
    this._movement = opts.movement != null ? opts.movement : 14;
    this._resolution = opts.resolution != null ? opts.resolution : 1;
    this._noise = createNoise2D(SEED);
    this._points = [];
    this._raf = null;
    this._visible = true;
    this._ro = null;
    this._io = null;
    this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    this._svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    this._path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this._path.setAttribute('fill', 'none');
    this._path.setAttribute('stroke', this._stroke);
    this._path.setAttribute('stroke-width', '1.5');
    this._path.setAttribute('stroke-linecap', 'round');
    this._svg.appendChild(this._path);
    host.appendChild(this._svg);
    this._setSize();
    this._setLines();
    var self = this;
    this._ro = new ResizeObserver(function () { self._setSize(); self._setLines(); });
    this._ro.observe(host);
    this._io = new IntersectionObserver(function (entries) {
      self._visible = entries[0].isIntersecting;
    }, { threshold: 0.1 });
    this._io.observe(host);
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  LineRipple.prototype._setSize = function () {
    var w = this._host.clientWidth || this._host.offsetWidth || 1;
    var h = this._host.clientHeight || this._host.offsetHeight || 1;
    this._w = w; this._h = h;
    this._svg.setAttribute('width', String(w));
    this._svg.setAttribute('height', String(h));
  };

  // Same grid math as the component: count → gap via the original curve.
  LineRipple.prototype._setLines = function () {
    var w = this._w, h = this._h;
    var c = this._count;
    var gap = 90 - ((c - 1) / 99) * 82;
    var cols = Math.ceil((w + gap) / gap);
    var rows = Math.ceil((h + gap) / gap);
    var xStart = (w - gap * (cols - 1)) / 2;
    var yStart = (h - gap * (rows - 1)) / 2;
    var points = [];
    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        points.push({ x: xStart + gap * i, y: yStart + gap * j, angle: 0 });
      }
    }
    this._points = points;
    this._path.setAttribute('stroke', this._stroke);
  };

  LineRipple.prototype._tick = function (time) {
    var self = this;
    if (this._visible) {
      var movement = this._movement;
      var drift = time * movement * 8e-6;
      var dirX = Math.cos(BASE_ANGLE) * drift;
      var dirY = Math.sin(BASE_ANGLE) * drift;
      var points = this._points;
      var half = (6 + (this._resolution / 10) * 20) / 2;
      var d = '';
      for (var idx = 0; idx < points.length; idx++) {
        var p = points[idx];
        var nz = this._noise(p.x * 0.004 - dirX, p.y * 0.004 - dirY);
        var target = BASE_ANGLE + nz * Math.PI * CURL;
        var diff = target - p.angle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        p.angle += diff * 0.12;
        var ux = Math.cos(p.angle) * half;
        var uy = Math.sin(p.angle) * half;
        d += 'M ' + (p.x - ux).toFixed(1) + ' ' + (p.y - uy).toFixed(1) +
             ' L ' + (p.x + ux).toFixed(1) + ' ' + (p.y + uy).toFixed(1) + ' ';
      }
      this._path.setAttribute('d', d);
    }
    this._raf = requestAnimationFrame(function (t) { self._tick(t); });
  };

  // Theme switch: restyle in place — still exactly ONE animation running.
  LineRipple.prototype.setStroke = function (color) {
    this._stroke = color;
    this._path.setAttribute('stroke', color);
  };

  LineRipple.prototype.dispose = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._ro) this._ro.disconnect();
    if (this._io) this._io.disconnect();
    if (this._svg.parentNode) this._svg.parentNode.removeChild(this._svg);
    this._points = [];
  };

  // The two palettes the user supplied, verbatim.
  LineRipple.THEMES = {
    dark: { strokeColor: '#EA69F1' },   // dark/black version (#EA69F1 on #09070D)
    light: { strokeColor: '#F200FF' }   // white/light version (#F200FF on #FFFFFF)
  };

  window.LineRipple = LineRipple;
})();
