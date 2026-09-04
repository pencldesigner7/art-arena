// Cloud Sky — v56 cloud theme background.
// Ported from the user-supplied Originkit CloudSky component (React/TS) to a
// plain class for Art Arena's no-build stack. The shader, constants and
// preset are verbatim from the source; the lifecycle matches the app's scene
// contract: setMotion(false) freezes the last frame (Animations OFF never
// hides the theme), dispose() tears everything down.
(function () {
  'use strict';

  var MAX_DPR = 2;
  var PUFF_UP = 0.34, PUFF_DOWN = 0.19, ERODE = 0.7, SHADOW_STEP = 0.085;
  var NEAR_CELL = 1.05, FAR_CELL = 2.15, FAR_MIX = 0.55;
  var NEAR_DRIFT = 0.055, FAR_DRIFT = 0.026, CIRRUS_DRIFT = 0.014;
  var PUFF_WMAX = 2.15, SHADE_BLEND = 12.0;

  var VERT_SRC = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }';

  var FRAG_SRC = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 uRes;',
    'uniform float uNearX, uFarX, uCirrusX;',
    'uniform float uCoverage, uSize, uSoftness, uShadow, uCirrus;',
    'uniform vec3 uZenith, uHorizon, uCloud;',
    'uniform vec4 uGlow;',
    'uniform vec2 uSun;',
    'uniform vec2 uParallax;',
    'vec2 hash22(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }',
    'float hash12(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float vnoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }',
    'vec2 blobs(vec2 uv, float seed){',
    '  vec2 id = floor(uv), f = fract(uv);',
    '  float best = -1e4;',
    '  float wsum = 0.0, ysum = 0.0;',
    '  float wMax = min(' + PUFF_WMAX.toFixed(3) + ', 0.72 * uSize);',
    '  float reach = min(2.0, ceil(wMax + 0.85) - 1.0);',
    '  for (int j = -2; j <= 2; j++){',
    '    for (int i = -2; i <= 2; i++){',
    '      vec2 o = vec2(float(i), float(j));',
    '      if (max(abs(o.x), abs(o.y)) > reach) continue;',
    '      vec2 h = hash22(id + o + seed);',
    '      if (fract(h.x * 37.1) > uCoverage) continue;',
    '      vec2 c = o + 0.15 + h * 0.7;',
    '      float w = min(' + PUFF_WMAX.toFixed(3) + ', (0.30 + 0.42 * fract(h.y * 19.7)) * uSize);',
    '      vec2 d = f - c;',
    '      float ry = (d.y > 0.0 ? ' + PUFF_UP.toFixed(3) + ' : ' + PUFF_DOWN.toFixed(3) + ') * uSize * (0.8 + 0.5 * fract(h.y * 7.3));',
    '      float e = length(vec2(d.x / max(w, 1e-3), d.y / max(ry, 1e-3)));',
    '      float val = 1.0 - e;',
    '      float yN = d.y / max(ry, 1e-3);',
    '      if (val > best){',
    '        float k = exp(' + SHADE_BLEND.toFixed(1) + ' * (best - val));',
    '        wsum = wsum * k + 1.0;',
    '        ysum = ysum * k + yN;',
    '        best = val;',
    '      } else {',
    '        float g = exp(' + SHADE_BLEND.toFixed(1) + ' * (val - best));',
    '        wsum += g;',
    '        ysum += g * yN;',
    '      }',
    '    }',
    '  }',
    '  return vec2(best, ysum / max(wsum, 1e-4));',
    '}',
    'vec2 cloudField(vec2 uv, float seed, float detailScale){',
    '  vec2 b = blobs(uv, seed);',
    '  float n = fbm(uv * detailScale + seed * 3.1) * 0.72 + fbm(uv * detailScale * 3.3 + seed * 7.7) * 0.28;',
    '  return vec2(b.x - (1.0 - n) * ' + ERODE.toFixed(3) + ', b.y);',
    '}',
    'vec3 shadeCloud(float dyNorm, vec3 sky){',
    '  float t = smoothstep(-0.95, 0.25, dyNorm);',
    '  vec3 base = mix(uCloud * 0.52, sky, 0.34);',
    '  return mix(mix(uCloud, base, uShadow), uCloud, t);',
    '}',
    'void main(){',
    '  vec2 frag = gl_FragCoord.xy / max(uRes.y, 1.0);',
    '  float aspect = uRes.x / max(uRes.y, 1.0);',
    '  vec2 p = vec2(frag.x, frag.y);',
    '  vec3 sky = mix(uHorizon, uZenith, smoothstep(-0.15, 1.05, p.y));',
    '  vec2 sunP = vec2(uSun.x * aspect, uSun.y);',
    '  float sd = length(p - sunP);',
    '  sky += uGlow.rgb * uGlow.a * exp(-sd * 3.4) * 0.30;',
    '  vec3 col = sky;',
    '  if (uCirrus > 0.0) {',
    '    vec2 cuv = vec2(p.x * 1.4 + uCirrusX, p.y * 5.5);',
    '    float veil = fbm(cuv) * fbm(cuv * 2.3 + 9.0);',
    '    veil = smoothstep(0.24, 0.55, veil) * smoothstep(0.15, 0.7, p.y);',
    '    col = mix(col, uCloud, veil * uCirrus * 0.5);',
    '  }',
    '  vec2 fuv = vec2(p.x + uFarX, p.y) * ' + FAR_CELL.toFixed(3) + ' + uParallax * 0.4;',
    '  vec2 fd = cloudField(fuv, 17.0, 11.0);',
    '  float fa = clamp(fd.x * uSoftness, 0.0, 1.0);',
    '  if (fa > 0.0) {',
    '    vec3 lit = shadeCloud(fd.y, sky);',
    '    col = mix(col, mix(lit, sky, ' + FAR_MIX.toFixed(3) + '), fa);',
    '  }',
    '  vec2 nuv = vec2(p.x + uNearX, p.y) * ' + NEAR_CELL.toFixed(3) + ' + uParallax;',
    '  vec2 nd = cloudField(nuv, 3.0, 8.5);',
    '  float na = clamp(nd.x * uSoftness, 0.0, 1.0);',
    '  if (na > 0.0) {',
    '    vec3 lit = shadeCloud(nd.y, sky);',
    '    float above = clamp(cloudField(nuv + vec2(0.0, ' + SHADOW_STEP.toFixed(3) + '), 3.0, 8.5).x * uSoftness, 0.0, 1.0);',
    '    lit *= 1.0 - 0.18 * uShadow * above;',
    '    lit += uGlow.rgb * uGlow.a * 0.22 * exp(-length(p - sunP) * 1.6);',
    '    col = mix(col, lit, na);',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('CloudSky shader:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function hexToRGBA(str, fb) {
    var s = String(str || '').trim();
    if (s.charAt(0) === '#') {
      var hx = s.slice(1);
      if (hx.length === 3 || hx.length === 4) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2] + (hx.length === 4 ? hx[3] + hx[3] : '');
      if (hx.length >= 6) {
        var r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
        var a = hx.length >= 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1;
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r / 255, g / 255, b / 255, a];
      }
      return fb;
    }
    var m = s.match(/[\d.]+/g);
    if (m && m.length >= 3) return [Math.min(255, parseFloat(m[0])) / 255, Math.min(255, parseFloat(m[1])) / 255, Math.min(255, parseFloat(m[2])) / 255, m.length >= 4 ? Math.min(1, parseFloat(m[3])) : 1];
    return fb;
  }

  // The user's preset (from the supplied component): soft 200, shadow 70,
  // cirrus 100, sun top-right with a white glow; base defaults otherwise.
  var PRESET = {
    zenith: '#0075FF', horizon: '#B4D2F0', cloud: '#FFFFFF',
    density: 100, speed: 64, size: 130,
    softness: 4.5 / Math.max(0.15, 200 / 100),   // softness 200 → 2.25
    shadow: 0.7, cirrus: 1.0,
    sunX: 1.0, sunY: 1.0, glow: '#FFFFFF',
    parallax: 1.0, wind: 1.0, damping: 20
  };

  function CloudSkyScene(host, opts) {
    var self = this;
    this.dead = false;
    this.motion = true;
    this.theme = 'cloud';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    var cs = this.canvas.style;
    cs.position = 'absolute'; cs.inset = '0'; cs.width = '100%'; cs.height = '100%'; cs.display = 'block';
    host.appendChild(this.canvas);
    var gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
    if (!gl) { console.error('CloudSky: WebGL unavailable'); return; }
    this.gl = gl;
    var vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('CloudSky link:', gl.getProgramInfoLog(prog)); return; }
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    var locs = {};
    var u = function (name) { if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name); return locs[name]; };

    var raf = 0, last = 0, nearX = 0, farX = 0, cirrusX = 0, leanX = 0, leanY = 0;
    var ptr = { x: 0, y: 0, inside: false };

    var render = function (now) {
      if (self.dead) return;
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      var v = PRESET;
      var k = 1 - Math.exp(-v.damping * 0.12 * dt);
      leanX += ((ptr.inside ? ptr.x : 0) - leanX) * k;
      leanY += ((ptr.inside ? ptr.y : 0) - leanY) * k;
      var gust = 1 + leanX * v.wind;
      var rate = (v.speed / 50) * gust;
      nearX = (nearX - NEAR_DRIFT * rate * dt) % 1000;
      farX = (farX - FAR_DRIFT * rate * dt) % 1000;
      cirrusX = (cirrusX - CIRRUS_DRIFT * rate * dt) % 1000;

      var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      var cw = host.clientWidth || 0, ch = host.clientHeight || 0;
      if (!cw || !ch || document.hidden) { raf = requestAnimationFrame(render); return; } // hidden: skip the draw, keep the clock
      var bw = Math.max(1, Math.round(cw * dpr)), bh = Math.max(1, Math.round(ch * dpr));
      if (self.canvas.width !== bw || self.canvas.height !== bh) { self.canvas.width = bw; self.canvas.height = bh; }
      gl.viewport(0, 0, bw, bh);
      var zen = hexToRGBA(v.zenith, [0.369, 0.576, 0.824, 1]);
      var hor = hexToRGBA(v.horizon, [0.706, 0.824, 0.941, 1]);
      var cld = hexToRGBA(v.cloud, [1, 1, 1, 1]);
      var glow = hexToRGBA(v.glow, [0.91, 0.953, 1, 0.9]);
      gl.uniform2f(u('uRes'), bw, bh);
      gl.uniform1f(u('uNearX'), nearX);
      gl.uniform1f(u('uFarX'), farX);
      gl.uniform1f(u('uCirrusX'), cirrusX);
      gl.uniform1f(u('uCoverage'), v.density / 100);
      gl.uniform1f(u('uSize'), v.size / 100);
      gl.uniform1f(u('uSoftness'), v.softness);
      gl.uniform1f(u('uShadow'), v.shadow);
      gl.uniform1f(u('uCirrus'), v.cirrus);
      gl.uniform2f(u('uSun'), v.sunX, v.sunY);
      gl.uniform2f(u('uParallax'), -leanX * v.parallax * 0.07, -leanY * v.parallax * 0.05);
      gl.uniform3f(u('uZenith'), zen[0], zen[1], zen[2]);
      gl.uniform3f(u('uHorizon'), hor[0], hor[1], hor[2]);
      gl.uniform3f(u('uCloud'), cld[0], cld[1], cld[2]);
      gl.uniform4f(u('uGlow'), glow[0], glow[1], glow[2], glow[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(render);
    };

    // The host layer is pointer-transparent, so parallax tracks the pointer
    // at window level (still zoom-invariant: the rect ratio is used).
    this._track = function (e) {
      var r = self.canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.y = 1 - ((e.clientY - r.top) / r.height) * 2;
      ptr.inside = true;
    };
    this._onLeave = function () { ptr.inside = false; };
    window.addEventListener('pointermove', this._track, { passive: true });
    window.addEventListener('pointerleave', this._onLeave, { passive: true });

    this.setMotion = function (on) {
      self.motion = !!on;
      if (!on) { if (raf) { cancelAnimationFrame(raf); raf = 0; } } // last WebGL frame stays on screen
      else if (!raf && !self.dead) { last = 0; raf = requestAnimationFrame(render); }
    };
    this.staticFrame = function () {}; // the canvas IS the static frame
    this.dispose = function () {
      self.dead = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', self._track);
      window.removeEventListener('pointerleave', self._onLeave);
      try { gl.getExtension('WEBGL_lose_context'); } catch (e) {} // context dies with the removed canvas
      if (self.canvas.parentNode) self.canvas.parentNode.removeChild(self.canvas);
    };

    last = 0;
    raf = requestAnimationFrame(render);
  }

  window.CloudSkyScene = CloudSkyScene;
})();
