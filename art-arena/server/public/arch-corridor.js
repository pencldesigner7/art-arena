/* Art Arena — login background: "Arch Corridor" (ported from the user's React/Three.js
 * Originkit component to plain JS, no build step). Exposes window.ArchCorridorScene.
 * Preset values below are the user's own export preset. */
(function () {
    "use strict";
    if (typeof window === "undefined" || typeof THREE === "undefined") return;

    // Length of the corridor in world units.
    const SPAN = 22;
    const ARC_STEPS = 10;
    const EDGE_STEPS = 5;

    const DEFAULTS = {
        background: "#000000",
        near: "#FF00CD",
        far: "#00E4FF",
        arches: 14,
        twist: 20,
        gauge: 4,
        cornerRadius: 34,
        opening: 100,
        glow: 20,
        animate: true,
        speed: 4,
        direction: "forward",
        sizePercent: 100,
    };

    // THE PRESET BAKED INTO THE USER'S DEFAULT EXPORT — USE THESE VALUES:
    const PRESET = {
        background: "#070115",
        near: "#FF00CD",
        far: "#17ADD6",
        arches: 14,
        twist: 14,
        gauge: 4,
        cornerRadius: 61,
        opening: 100,
        glow: 4,
        animate: true,
        speed: 3,
        direction: "reverse",
        sizePercent: 106,
    };

    function clamp(v, lo, hi, fallback) {
        const n = typeof v === "number" && isFinite(v) ? v : fallback;
        return Math.max(lo, Math.min(hi, n));
    }

    function settingsFor(cfg) {
        const arches = clamp(cfg.arches, 1, 20, DEFAULTS.arches);
        // Squared: the first few arches change the whole read of the corridor, the
        // last few only thicken a colonnade that is already dense.
        const count = Math.round(6 + arches * arches * 0.55);
        return {
            count,
            spacing: SPAN / count,
            opening: clamp(cfg.opening, 30, 100, DEFAULTS.opening) * 0.01,
            corner: 0.02 + clamp(cfg.cornerRadius, 0, 100, DEFAULTS.cornerRadius) * 0.0096,
            twist: clamp(cfg.twist, 0, 20, DEFAULTS.twist) * 0.022,
            width: 0.008 + clamp(cfg.gauge, 1, 20, DEFAULTS.gauge) * 0.0085,
            glow: 0.25 + clamp(cfg.glow, 1, 20, DEFAULTS.glow) * 0.13,
            speed: clamp(cfg.speed, 0, 20, DEFAULTS.speed) * 0.38,
            heading: cfg.direction === "reverse" ? -1 : 1,
            zoom: 100 / clamp(cfg.sizePercent, 40, 200, DEFAULTS.sizePercent),
        };
    }

    /** Unit rounded-square outline as a closed loop of points (half-size 1). */
    function traceOutline(corner) {
        const c = Math.min(Math.max(corner, 0.02), 0.98);
        const k = 1 - c;
        const centres = [[k, -k], [k, k], [-k, k], [-k, -k]];
        const pts = [];
        for (let q = 0; q < 4; q++) {
            const [cx, cy] = centres[q];
            const a0 = (q * Math.PI) / 2 - Math.PI / 2;
            for (let j = 0; j <= ARC_STEPS; j++) {
                const a = a0 + (j / ARC_STEPS) * (Math.PI / 2);
                pts.push(new THREE.Vector2(cx + Math.cos(a) * c, cy + Math.sin(a) * c));
            }
            const from = pts[pts.length - 1];
            const nq = (q + 1) % 4;
            const b0 = (nq * Math.PI) / 2 - Math.PI / 2;
            const to = new THREE.Vector2(
                centres[nq][0] + Math.cos(b0) * c,
                centres[nq][1] + Math.sin(b0) * c
            );
            if (from.distanceTo(to) > 1e-4) {
                for (let j = 1; j < EDGE_STEPS; j++) {
                    const t = j / EDGE_STEPS;
                    pts.push(new THREE.Vector2(
                        from.x + (to.x - from.x) * t,
                        from.y + (to.y - from.y) * t
                    ));
                }
            }
        }
        return pts;
    }

    /** Outline widened into a ribbon: two verts per point, pushed apart in the
     *  shader along the curve normal stored here. */
    function buildOutline(corner) {
        const pts = traceOutline(corner);
        const n = pts.length;
        const cols = n + 1; // one extra column repeating the first point → clean seam
        const pos = new Float32Array(cols * 2 * 3);
        const nrm = new Float32Array(cols * 2 * 2);
        const side = new Float32Array(cols * 2);
        const dir = new THREE.Vector2();
        const prev = new THREE.Vector2();
        const next = new THREE.Vector2();
        for (let i = 0; i < cols; i++) {
            const idx = i % n;
            const p = pts[idx];
            prev.subVectors(p, pts[(idx - 1 + n) % n]);
            next.subVectors(pts[(idx + 1 + n) % n], p);
            if (prev.lengthSq() > 1e-12) prev.normalize();
            if (next.lengthSq() > 1e-12) next.normalize();
            dir.addVectors(prev, next);
            if (dir.lengthSq() < 1e-12) dir.copy(next);
            dir.normalize();
            const nx = dir.y;
            const ny = -dir.x;
            for (let s = 0; s < 2; s++) {
                const v = i * 2 + s;
                pos[v * 3 + 0] = p.x;
                pos[v * 3 + 1] = p.y;
                pos[v * 3 + 2] = 0;
                nrm[v * 2 + 0] = nx;
                nrm[v * 2 + 1] = ny;
                side[v] = s === 0 ? -1 : 1;
            }
        }
        const index = [];
        for (let i = 0; i < cols - 1; i++) {
            const a = i * 2;
            index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("aNormal", new THREE.BufferAttribute(nrm, 2));
        geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
        geo.setIndex(index);
        return geo;
    }

    const ARCH_VERTEX = /* glsl */ `
attribute vec2 aNormal;
attribute float aSide;
attribute float aSlot;

uniform float uTime;
uniform float uSpacing;
uniform float uSpan;
uniform float uTwist;
uniform float uOpening;
uniform float uWidth;

varying float vSide;
varying float vDepth;

void main() {
    float z = mod(aSlot * uSpacing + uTime, uSpan);
    float w = uWidth * (0.5 + z * 0.35);
    vec2 p = position.xy * uOpening + aNormal * aSide * w * 0.5;
    float a = z * uTwist;
    float ca = cos(a);
    float sa = sin(a);
    p = mat2(ca, sa, -sa, ca) * p;
    vSide = aSide;
    vDepth = z / uSpan;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, -z, 1.0);
}
`;

    const ARCH_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uNear;
uniform vec3 uFar;
uniform float uGlow;

varying float vSide;
varying float vDepth;

void main() {
    float across = 1.0 - abs(vSide);
    float shape = pow(across, 5.0) + pow(across, 1.6) * 0.35;
    vec3 col = mix(uNear, uFar, vDepth);
    float fog = (1.0 - smoothstep(0.35, 0.95, vDepth)) * smoothstep(0.0, 0.06, vDepth);
    float amount = shape * fog * uGlow;
    gl_FragColor = vec4(col * amount, amount);
}
`;

    class ArchCorridorScene {
        constructor(container, cfg) {
            this.container = container;
            this.cfg = Object.assign({}, PRESET, cfg || {});
            this.S = settingsFor(this.cfg);
            this.time = 0;
            this.lastT = performance.now();
            this.disposed = false;
            this.raf = 0;

            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setClearColor(0x000000, 0);
            if ("outputColorSpace" in this.renderer) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            const cv = this.renderer.domElement;
            cv.style.position = "absolute";
            cv.style.inset = "0";
            cv.style.width = "100%";
            cv.style.height = "100%";
            container.appendChild(cv);

            this.scene = new THREE.Scene();
            this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, SPAN + 6);
            this.camera.position.set(0, 0, 0);
            this.camera.lookAt(0, 0, -1);

            const S = this.S;
            this.uniforms = {
                uTime: { value: 0 },
                uSpacing: { value: S.spacing },
                uSpan: { value: SPAN },
                uTwist: { value: S.twist },
                uOpening: { value: S.opening },
                uWidth: { value: S.width },
                uNear: { value: new THREE.Color(this.cfg.near || PRESET.near) },
                uFar: { value: new THREE.Color(this.cfg.far || PRESET.far) },
                uGlow: { value: S.glow },
            };
            this.material = new THREE.ShaderMaterial({
                vertexShader: ARCH_VERTEX,
                fragmentShader: ARCH_FRAGMENT,
                uniforms: this.uniforms,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                depthTest: false,
                side: THREE.DoubleSide,
            });
            this.rebuild();
            this.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
        }

        rebuild() {
            if (this.mesh) {
                this.scene.remove(this.mesh);
                this.mesh.dispose();
                this.mesh.geometry.dispose();
                this.mesh = null;
            }
            const S = this.S;
            const geo = buildOutline(S.corner);
            this.mesh = new THREE.InstancedMesh(geo, this.material, S.count);
            // GOTCHA: the instance matrix buffer is zero-filled → every arch collapses
            // to a point. Write the identity matrix once for all instances.
            const ident = new THREE.Matrix4();
            for (let i = 0; i < S.count; i++) this.mesh.setMatrixAt(i, ident);
            this.mesh.instanceMatrix.needsUpdate = true; // as in the original
            const slot = new Float32Array(S.count);
            for (let i = 0; i < S.count; i++) slot[i] = i;
            geo.setAttribute("aSlot", new THREE.InstancedBufferAttribute(slot, 1));
            this.mesh.frustumCulled = false;
            this.scene.add(this.mesh);
            this.uniforms.uSpacing.value = S.spacing;
        }

        start() {
            this.stop();
            this.lastT = performance.now();
            const loop = (now) => {
                if (this.disposed) return;
                this.step(now);
                this.raf = requestAnimationFrame(loop);
            };
            this.raf = requestAnimationFrame(loop);
        }

        stop() {
            if (this.raf) cancelAnimationFrame(this.raf);
            this.raf = 0;
        }

        step(now) {
            let dt = (now - this.lastT) / 1000;
            this.lastT = now;
            if (dt < 0) dt = 0;
            if (dt > 0.05) dt = 0.05; // tab-return must not teleport
            if (this.cfg.animate) this.time += dt * this.S.speed * this.S.heading;
            this.uniforms.uTime.value = this.time;
            this.renderer.render(this.scene, this.camera);
        }

        resize(w, h) {
            w = Math.max(1, w | 0);
            h = Math.max(1, h | 0);
            this.renderer.setSize(w, h, false);
            this.updateCamera();
        }

        updateCamera() {
            const S = this.S;
            const w = this.container.clientWidth || window.innerWidth;
            const h = this.container.clientHeight || window.innerHeight;
            const aspect = Math.max(0.1, w / Math.max(1, h));
            const span = S.opening * 2.1 * S.zoom;
            const visibleHeight = aspect < 1 ? span / aspect : span;
            this.camera.aspect = aspect;
            this.camera.fov = 2 * Math.atan(visibleHeight / 2 / 1.0) * (180 / Math.PI);
            this.camera.updateProjectionMatrix();
        }

        updateConfig(newCfg) {
            const oldArches = this.cfg.arches;
            const oldCorner = this.cfg.cornerRadius;
            const oldSize = this.cfg.sizePercent;
            Object.assign(this.cfg, newCfg || {});
            this.S = settingsFor(this.cfg);
            this.uniforms.uTwist.value = this.S.twist;
            this.uniforms.uOpening.value = this.S.opening;
            this.uniforms.uWidth.value = this.S.width;
            this.uniforms.uGlow.value = this.S.glow;
            this.uniforms.uNear.value.set(this.cfg.near);
            this.uniforms.uFar.value.set(this.cfg.far);
            if (this.cfg.arches !== oldArches || this.cfg.cornerRadius !== oldCorner) this.rebuild();
            if (this.cfg.sizePercent !== oldSize) this.updateCamera();
        }

        dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.stop();
            if (this.mesh) {
                this.scene.remove(this.mesh);
                this.mesh.dispose();
                this.mesh.geometry.dispose();
                this.mesh = null;
            }
            this.material.dispose();
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
    }

    window.ArchCorridorScene = ArchCorridorScene;
    window.ArchCorridorPreset = PRESET;
})();
