/* Art Arena — matchmaking globe background (v40).
   Vanilla JS port of the Globe component provided for this feature (the
   Originkit "Globe" — React + three.js + d3-geo, preset `custom-style`),
   ported 1:1: same math, same defaults, same scene graph, same interaction
   model. React plumbing (useRef/useEffect/useState) becomes an explicit
   create()/dispose() lifecycle so the card can own the effect:

     window.GlobeWrap.create(containerElement, options?) -> { dispose() }

   Defaults are the component's provided values (all of them):
   speed 10 · smoothing 8 · dots { #ffffff, size 5, density 8, allDots false }
   · fill "dots" · fillColor #ffffff · scale 7 · stopOnHover false ·
   markerConfig { markers [], #00f7ff, size 40 } · direction "left" ·
   initial 23 / -23 · ocean #000000 · outline #ffffff · grid #D4D4D4 ·
   outlineWidth 1 · dragSpeed 5 · detail 5.

   Integration contract (index.html): the container is #mm-globe-layer — an
   absolute, z-index-0 layer INSIDE the matchmaking card (the card keeps its
   own background; the section clips the layer with overflow:hidden). Every
   piece of matchmaking content renders at z-index 1, ABOVE the effect.
   The land bitmap is the same ne_50m_land.json the component fetches —
   vendored at /vendor/land.json (same-origin, no external dependency at
   runtime), with the component's original remote URL as fallback. */
(function () {
  'use strict';
  // Vendor libs are classic scripts loaded after the app script. If they are
  // missing (blocked script tag, test environments without resources), the
  // effect stays disabled silently — the matchmaking card simply keeps its
  // normal background. No error UI is injected into the app.
  if (typeof THREE === 'undefined' || typeof d3 === 'undefined' ||
      typeof d3.geoEquirectangular !== 'function' || typeof d3.geoPath !== 'function') {
    return;
  }
  const T = THREE;

  // ---- colour / scale helpers (verbatim from the provided component) ------
  function parseColorToRgba(input) {
    if (!input || input.trim() === '') return { r: 0, g: 0, b: 0, a: 0 };
    const str = input.trim();
    const rgbaMatch = str.match(
      /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i
    );
    if (rgbaMatch) {
      const r = Math.max(0, Math.min(255, parseFloat(rgbaMatch[1]))) / 255;
      const g = Math.max(0, Math.min(255, parseFloat(rgbaMatch[2]))) / 255;
      const b = Math.max(0, Math.min(255, parseFloat(rgbaMatch[3]))) / 255;
      const a =
        rgbaMatch[4] !== undefined
          ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4])))
          : 1;
      return { r, g, b, a };
    }
    const hex = str.replace(/^#/, '');
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: 1,
      };
    }
    if (hex.length === 4) {
      return {
        r: parseInt(hex[0] + hex[0], 16) / 255,
        g: parseInt(hex[1] + hex[1], 16) / 255,
        b: parseInt(hex[2] + hex[2], 16) / 255,
        a: parseInt(hex[3] + hex[3], 16) / 255,
      };
    }
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16) / 255,
        g: parseInt(hex[1] + hex[1], 16) / 255,
        b: parseInt(hex[2] + hex[2], 16) / 255,
        a: 1,
      };
    }
    return { r: 0, g: 0, b: 0, a: 1 };
  }

  function mapLinear(value, inMin, inMax, outMin, outMax) {
    if (inMax === inMin) return outMin;
    const t = (value - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
  }

  function mapSpeedUiToInternal(ui) {
    if (ui === 0) return 0;
    const clamped = Math.max(0, Math.min(10, ui));
    return mapLinear(clamped, 0, 10, 0, 0.9);
  }
  function mapDensityUiToSpacing(ui) {
    const clamped = Math.max(1, Math.min(10, ui));
    return mapLinear(clamped, 1, 10, 24, 8);
  }
  function mapScaleUiToMultiplier(ui) {
    const clamped = Math.max(1, Math.min(20, ui));
    return mapLinear(clamped, 1, 20, 0.2, 2);
  }
  function mapDotSizeUiToMultiplier(ui) {
    const clamped = Math.max(1, Math.min(10, ui));
    return mapLinear(clamped, 1, 10, 0.1, 0.5);
  }
  function mapMarkerDotSizeUiToMultiplier(ui) {
    const clamped = Math.max(0, Math.min(100, ui));
    return mapLinear(clamped, 0, 100, 0.1, 2.5);
  }
  function normalizeSmoothing(ui) {
    return Math.max(0, Math.min(1, ui / 10));
  }
  function mapDragSpeedUiToSensitivity(ui) {
    return mapLinear(Math.max(0, Math.min(10, ui)), 0, 10, 0.001, 0.02);
  }
  function mapDetailToStepSize(ui) {
    const clamped = Math.max(1, Math.min(10, ui));
    return mapLinear(clamped, 1, 10, 10, 1);
  }

  function simplifyRing(ring, detail) {
    if (ring.length < 2) return ring;
    if (detail >= 10) return ring;
    const stepSize = Math.max(1, Math.floor(mapDetailToStepSize(detail)));
    const simplified = [];
    simplified.push(ring[0]);
    for (let i = stepSize; i < ring.length - 1; i += stepSize) {
      const idx = Math.min(i, ring.length - 1);
      simplified.push(ring[idx]);
    }
    const lastPoint = ring[ring.length - 1];
    const firstPoint = ring[0];
    const isClosed =
      Math.abs(lastPoint[0] - firstPoint[0]) < 1e-4 &&
      Math.abs(lastPoint[1] - firstPoint[1]) < 1e-4;
    if (!isClosed) {
      simplified.push(lastPoint);
    }
    return simplified.length >= 2 ? simplified : ring;
  }

  function latLngToPosition(lat, lng) {
    const latRad = lat * (Math.PI / 180);
    const lngRad = lng * (Math.PI / 180);
    const x = Math.cos(latRad) * Math.sin(lngRad);
    const y = Math.sin(latRad);
    const z = Math.cos(latRad) * Math.cos(lngRad);
    return { x, y, z };
  }

  // ---- the component's provided defaults ("custom-style" preset) ----------
  const DEFAULTS = {
    speed: 10,
    smoothing: 8,
    dots: { color: '#ffffff', size: 5, density: 8, allDots: false },
    fill: 'dots',
    fillColor: '#ffffff',
    scale: 7,
    stopOnHover: false,
    markerConfig: { markers: [], color: '#00f7ff', size: 40 },
    direction: 'left',
    initialLatitude: 23,
    initialLongitude: -23,
    oceanColor: '#000000',
    outlineColor: '#ffffff',
    showOutline: true,
    graticuleColor: '#D4D4D4',
    showGrid: true,
    outlineWidth: 1,
    dragSpeed: 5,
    detail: 5,
  };

  // Same ne_50m_land.json the component uses — vendored locally first
  // (same-origin: no CORS, no external dependency, works on the deployed
  // host), the component's original remote URL as fallback.
  const LAND_URLS = [
    '/vendor/land.json',
    'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/50m/physical/ne_50m_land.json',
  ];

  function create(container, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const dotsCfg = Object.assign({}, DEFAULTS.dots, (opts && opts.dots) || {});
    const markerConfig = Object.assign({}, DEFAULTS.markerConfig, (opts && opts.markerConfig) || {});

    const dotColor = dotsCfg.color;
    const dotSize = dotsCfg.size;
    const density = dotsCfg.density;
    const allDots = dotsCfg.allDots;
    const gridWidth = 1;
    const smoothingN = normalizeSmoothing(cfg.smoothing);

    const baseRotationSpeed = mapSpeedUiToInternal(cfg.speed);
    const rotationSpeed =
      cfg.direction === 'left' ? -baseRotationSpeed : baseRotationSpeed;
    const dotSpacing = mapDensityUiToSpacing(density);
    const dotSizeMultiplier = mapDotSizeUiToMultiplier(dotSize);
    const markerRadiusMultiplier = mapMarkerDotSizeUiToMultiplier(markerConfig.size);
    const scaleMultiplier = mapScaleUiToMultiplier(cfg.scale);

    const containerWidth = container.clientWidth || container.offsetWidth || 800;
    const containerHeight = container.clientHeight || container.offsetHeight || 600;

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(
      50,
      containerWidth / containerHeight,
      0.1,
      1e3
    );
    const baseRadius = 1;
    const globeRadius = baseRadius * scaleMultiplier;
    const cameraDistance = 2.5 / scaleMultiplier;
    camera.position.set(0, 0, cameraDistance);
    camera.lookAt(0, 0, 0);

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(containerWidth, containerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // (component: renderer.outputColorSpace = "srgb" — same intent, r147 API)
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = 'srgb';
    else if ('outputEncoding' in renderer) renderer.outputEncoding = T.sRGBEncoding;
    const canvas = renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.opacity = '0';
    canvas.style.visibility = 'hidden';
    container.appendChild(canvas);

    const resolvedOceanColor = cfg.oceanColor;
    const resolvedOutlineColor = cfg.outlineColor;
    const resolvedDotColor = dotColor;
    const resolvedMarkerColor = markerConfig.color;
    const resolvedGraticuleColor = cfg.graticuleColor;
    const resolvedFillColor = cfg.fillColor;
    const oceanRgba = parseColorToRgba(resolvedOceanColor);
    const outlineRgba = parseColorToRgba(resolvedOutlineColor);
    const dotRgba = parseColorToRgba(resolvedDotColor);
    const graticuleRgba = parseColorToRgba(resolvedGraticuleColor);
    const fillRgba = parseColorToRgba(resolvedFillColor);

    const oceanGeometry = new T.SphereGeometry(globeRadius, 64, 64);
    const oceanColorObj = resolvedOceanColor
      ? new T.Color(resolvedOceanColor)
      : new T.Color(0, 0, 0);
    const oceanMaterial = new T.MeshBasicMaterial({
      color: oceanColorObj,
      transparent: oceanRgba.a < 1 || oceanRgba.a === 0,
      opacity: oceanRgba.a,
    });
    const oceanMesh = new T.Mesh(oceanGeometry, oceanMaterial);
    scene.add(oceanMesh);

    let globeOutlineMesh = null;
    if (cfg.showOutline && cfg.outlineColor && outlineRgba.a > 0) {
      const outlinePositions = [];
      const segments = 128;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * globeRadius;
        const y = Math.sin(angle) * globeRadius;
        const z = 0;
        outlinePositions.push(x, y, z);
      }
      const outlinePoints = [];
      for (let i = 0; i < outlinePositions.length; i += 3) {
        outlinePoints.push(
          new T.Vector3(
            outlinePositions[i],
            outlinePositions[i + 1],
            outlinePositions[i + 2]
          )
        );
      }
      if (outlinePoints.length >= 2) {
        outlinePoints.push(outlinePoints[0].clone());
        const outlineColorObj = new T.Color(resolvedOutlineColor);
        const outlineMaterial = new T.MeshBasicMaterial({
          color: outlineColorObj,
          transparent: outlineRgba.a < 1,
          opacity: outlineRgba.a,
        });
        const curve = new T.CatmullRomCurve3(outlinePoints);
        const radius = (cfg.outlineWidth / 10) * 0.01;
        const tubeGeometry = new T.TubeGeometry(
          curve,
          outlinePoints.length * 2,
          radius,
          8,
          false
        );
        globeOutlineMesh = new T.Mesh(tubeGeometry, outlineMaterial);
      }
    }
    void globeOutlineMesh; // same as the provided component: rim built, never added

    const continentOutlineGroup = new T.Group();

    const graticuleGroup = new T.Group();
    if (cfg.showGrid && cfg.graticuleColor && graticuleRgba.a > 0) {
      const graticuleColorObj = cfg.graticuleColor
        ? new T.Color(cfg.graticuleColor)
        : new T.Color(1, 1, 1);
      const graticuleMaterial = new T.MeshBasicMaterial({
        color: graticuleColorObj,
        transparent: graticuleRgba.a < 1 || graticuleRgba.a === 0,
        opacity: graticuleRgba.a,
      });
      const gridSpacing = 15;
      for (let lat = -90; lat <= 90; lat += gridSpacing) {
        const positions = [];
        const segs = 64;
        for (let i = 0; i <= segs; i++) {
          const lng = (i / segs) * 360 - 180;
          const pos = latLngToPosition(lat, lng);
          positions.push(
            pos.x * globeRadius,
            pos.y * globeRadius,
            pos.z * globeRadius
          );
        }
        if (positions && positions.length >= 6) {
          const points = [];
          for (let i = 0; i < positions.length; i += 3) {
            points.push(
              new T.Vector3(
                positions[i],
                positions[i + 1],
                positions[i + 2]
              )
            );
          }
          if (points.length >= 2) {
            const curve = new T.CatmullRomCurve3(points);
            const radius = (gridWidth / 10) * 0.01;
            const tubeGeometry = new T.TubeGeometry(
              curve,
              points.length * 2,
              radius,
              8,
              false
            );
            const tubeMesh = new T.Mesh(tubeGeometry, graticuleMaterial);
            tubeMesh.renderOrder = 0;
            graticuleGroup.add(tubeMesh);
          }
        }
      }
      for (let lng = -180; lng < 180; lng += gridSpacing) {
        const positions = [];
        const segs = 64;
        for (let i = 0; i <= segs; i++) {
          const lat = (i / segs) * 180 - 90;
          const pos = latLngToPosition(lat, lng);
          positions.push(
            pos.x * globeRadius,
            pos.y * globeRadius,
            pos.z * globeRadius
          );
        }
        if (positions && positions.length >= 6) {
          const points = [];
          for (let i = 0; i < positions.length; i += 3) {
            points.push(
              new T.Vector3(
                positions[i],
                positions[i + 1],
                positions[i + 2]
              )
            );
          }
          if (points.length >= 2) {
            const curve = new T.CatmullRomCurve3(points);
            const radius = (gridWidth / 10) * 0.01;
            const tubeGeometry = new T.TubeGeometry(
              curve,
              points.length * 2,
              radius,
              8,
              false
            );
            const tubeMesh = new T.Mesh(tubeGeometry, graticuleMaterial);
            tubeMesh.renderOrder = 0;
            graticuleGroup.add(tubeMesh);
          }
        }
      }
    }

    let dotInstances = null;
    let markerMeshes = [];

    const loadWorldData = async () => {
      try {
        let landFeatures = null;
        let lastErr = null;
        for (const url of LAND_URLS) {
          try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to load land data');
            landFeatures = await response.json();
            break;
          } catch (e) {
            lastErr = e; // try the next source
          }
        }
        if (!landFeatures) throw lastErr || new Error('Failed to load land data');

        while (continentOutlineGroup.children.length > 0) {
          continentOutlineGroup.remove(
            continentOutlineGroup.children[0]
          );
        }
        if (cfg.showOutline && cfg.outlineColor && outlineRgba.a > 0) {
          const outlineColorObj = new T.Color(resolvedOutlineColor);
          const outlineMaterial = new T.MeshBasicMaterial({
            color: outlineColorObj,
            transparent: outlineRgba.a < 1,
            opacity: outlineRgba.a,
            depthTest: true,
            depthWrite: true,
          });
          const projection = d3.geoEquirectangular();
          const pathGenerator = d3.geoPath().projection(projection);
          let processedCount = 0;
          let skippedCount = 0;
          landFeatures.features.forEach((feature) => {
            const featureType =
              (feature.properties && (feature.properties.featurecla || feature.properties.type)) ||
              '';
            const featureName = (feature.properties && feature.properties.name) || '';
            if (
              featureType.toLowerCase().includes('graticule') ||
              featureType.toLowerCase().includes('grid') ||
              featureType.toLowerCase().includes('line') ||
              featureName.toLowerCase().includes('graticule') ||
              featureName.toLowerCase().includes('grid') ||
              featureName.toLowerCase().includes('line')
            ) {
              skippedCount++;
              return;
            }
            processedCount++;
            const pathString = pathGenerator(feature);
            if (!pathString) return;
            const commands = pathString.match(/[ML][^MLZ]*/g) || [];
            if (commands.length === 0) return;

            const geometry = feature.geometry;
            if (!geometry || !geometry.coordinates) return;

            const processRing = (ring) => {
              if (ring.length < 2) return;
              const simplifiedRing = simplifyRing(ring, cfg.detail);
              const positions = [];
              simplifiedRing.forEach((coord) => {
                const lng = coord[0];
                const lat = coord[1];
                const pos = latLngToPosition(lat, lng);
                positions.push(
                  pos.x * globeRadius,
                  pos.y * globeRadius,
                  pos.z * globeRadius
                );
              });
              if (positions && positions.length >= 6) {
                const points = [];
                for (let i = 0; i < positions.length; i += 3) {
                  points.push(
                    new T.Vector3(
                      positions[i],
                      positions[i + 1],
                      positions[i + 2]
                    )
                  );
                }
                if (
                  points.length > 0 &&
                  points[0].distanceTo(
                    points[points.length - 1]
                  ) > 0.001
                ) {
                  points.push(points[0].clone());
                }
                if (points.length >= 2) {
                  const curve = new T.CatmullRomCurve3(points);
                  const radius = (cfg.outlineWidth / 10) * 0.01;
                  const tubeGeometry = new T.TubeGeometry(
                    curve,
                    points.length * 2,
                    radius,
                    8,
                    false
                  );
                  const tubeMesh = new T.Mesh(tubeGeometry, outlineMaterial);
                  tubeMesh.renderOrder = 0;
                  continentOutlineGroup.add(tubeMesh);
                }
              }
            };
            if (
              geometry.type === 'Polygon' &&
              geometry.coordinates.length > 0
            ) {
              processRing(geometry.coordinates[0]);
            } else if (geometry.type === 'MultiPolygon') {
              geometry.coordinates.forEach((polygon) => {
                if (polygon.length > 0) {
                  processRing(polygon[0]);
                }
              });
            }
          });
          console.log(
            `[Globe] Processed ${processedCount} land features, skipped ${skippedCount} grid features`
          );
        }

        const bitmapWidth = 2048;
        const bitmapHeight = 1024;
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = bitmapWidth;
        offscreenCanvas.height = bitmapHeight;
        const ctx = offscreenCanvas.getContext('2d', {
          willReadFrequently: true,
        });
        if (!ctx) throw new Error('Canvas not supported');
        const projection = d3.geoEquirectangular().fitSize(
          [bitmapWidth, bitmapHeight],
          { type: 'Sphere' }
        );
        const pathGenerator = d3.geoPath()
          .projection(projection)
          .context(ctx);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, bitmapWidth, bitmapHeight);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        landFeatures.features.forEach((feature) => {
          pathGenerator(feature);
        });
        ctx.fill();
        const imageData = ctx.getImageData(
          0,
          0,
          bitmapWidth,
          bitmapHeight
        );
        const pixels = imageData.data;
        const isOnLand = (lng, lat) => {
          const x =
            Math.round(((lng + 180) / 360) * bitmapWidth) %
            bitmapWidth;
          const y = Math.round(((90 - lat) / 180) * bitmapHeight);
          const clampedY = Math.max(0, Math.min(bitmapHeight - 1, y));
          const idx = (clampedY * bitmapWidth + x) * 4;
          return pixels[idx] > 128;
        };

        if (cfg.fill === 'solid') {
          const texW = 1024;
          const texH = 512;
          const fillCanvas = document.createElement('canvas');
          fillCanvas.width = texW;
          fillCanvas.height = texH;
          const fctx = fillCanvas.getContext('2d');
          const img = fctx.createImageData(texW, texH);
          const data = img.data;
          const fr = Math.round(fillRgba.r * 255);
          const fg = Math.round(fillRgba.g * 255);
          const fb = Math.round(fillRgba.b * 255);
          const fa = Math.round((fillRgba.a || 1) * 255);
          for (let ty = 0; ty < texH; ty++) {
            for (let tx = 0; tx < texW; tx++) {
              const u = tx / texW;
              const v = ty / texH;
              let lng = (u - 0.25) * 360;
              lng = ((((lng + 180) % 360) + 360) % 360) - 180;
              const lat = (v - 0.5) * 180;
              const onLand = allDots || isOnLand(lng, lat);
              const idx = (ty * texW + tx) * 4;
              if (onLand) {
                data[idx] = fr;
                data[idx + 1] = fg;
                data[idx + 2] = fb;
                data[idx + 3] = fa;
              } else {
                data[idx + 3] = 0;
              }
            }
          }
          fctx.putImageData(img, 0, 0);
          const fillTexture = new T.CanvasTexture(fillCanvas);
          fillTexture.flipY = false;
          fillTexture.needsUpdate = true;
          const fillGeometry = new T.SphereGeometry(
            globeRadius * 1.002,
            64,
            64
          );
          const fillMaterial = new T.MeshBasicMaterial({
            map: fillTexture,
            transparent: true,
          });
          dotInstances = new T.Mesh(fillGeometry, fillMaterial);
          globeGroup.add(dotInstances);
        } else {
          const dotCoordinates = [];
          const baseStep = dotSpacing * 0.08;
          for (let lat = -90; lat <= 90; lat += baseStep) {
            const latRad = (Math.abs(lat) * Math.PI) / 180;
            const cosLat = Math.cos(latRad);
            const lngStep =
              cosLat > 0.01
                ? baseStep / Math.max(0.3, cosLat)
                : 360;
            for (let lng = -180; lng < 180; lng += lngStep) {
              if (allDots || isOnLand(lng, lat)) {
                dotCoordinates.push([lng, lat]);
              }
            }
          }

          if (dotCoordinates.length > 0) {
            const dotGeometry = new T.SphereGeometry(
              0.01 * dotSizeMultiplier,
              4,
              4
            );
            const dotColorObj = resolvedDotColor
              ? new T.Color(resolvedDotColor)
              : new T.Color(0.6, 0.6, 0.6);
            const dotMaterial = new T.MeshBasicMaterial({
              color: dotColorObj,
              transparent: dotRgba.a < 1 || dotRgba.a === 0,
              opacity: dotRgba.a,
            });
            const instanced = new T.InstancedMesh(
              dotGeometry,
              dotMaterial,
              dotCoordinates.length
            );
            const matrix = new T.Matrix4();
            for (let i = 0; i < dotCoordinates.length; i++) {
              const lng = dotCoordinates[i][0];
              const lat = dotCoordinates[i][1];
              const pos = latLngToPosition(lat, lng);
              matrix.makeScale(1, 1, 1);
              matrix.setPosition(
                pos.x * globeRadius,
                pos.y * globeRadius,
                pos.z * globeRadius
              );
              instanced.setMatrixAt(i, matrix);
            }
            instanced.instanceMatrix.needsUpdate = true;
            dotInstances = instanced;
            globeGroup.add(dotInstances);
          }
        }

        updateMarkers();
        renderer.render(scene, camera);
        canvas.style.opacity = '1';
        canvas.style.visibility = 'visible';
      } catch (err) {
        // Integration call: no in-app error screen — the matchmaking card
        // simply keeps its normal background (the standalone component's
        // error UI would be an out-of-place UI element inside the app).
        console.warn('[Globe] Earth visualization disabled:', (err && err.message) || err);
        if (canvas.parentNode === container) container.removeChild(canvas);
      }
    };

    const updateMarkers = () => {
      markerMeshes.forEach((mesh) => globeGroup.remove(mesh));
      markerMeshes = [];
      if (markerConfig.markers && markerConfig.markers.length > 0) {
        const markerSize = 0.01 * markerRadiusMultiplier;
        const markerGeometry = new T.SphereGeometry(markerSize, 16, 16);
        const markerColorObj = resolvedMarkerColor
          ? new T.Color(resolvedMarkerColor)
          : new T.Color(1, 1, 1);
        const markerMaterial = new T.MeshBasicMaterial({
          color: markerColorObj,
        });
        markerConfig.markers.forEach((marker) => {
          if (
            !marker ||
            typeof marker.lat !== 'number' ||
            typeof marker.lng !== 'number'
          )
            return;
          const pos = latLngToPosition(marker.lat, marker.lng);
          const markerMesh = new T.Mesh(
            markerGeometry,
            markerMaterial.clone()
          );
          markerMesh.position.set(
            pos.x * globeRadius,
            pos.y * globeRadius,
            pos.z * globeRadius
          );
          globeGroup.add(markerMesh);
          markerMeshes.push(markerMesh);
        });
      }
    };

    const initialLongitudeRad = (cfg.initialLongitude * Math.PI) / 180;
    const initialLatitudeRad = (cfg.initialLatitude * Math.PI) / 180;
    const rotation = { x: initialLongitudeRad, y: initialLatitudeRad };
    const targetRotation = {
      x: initialLongitudeRad,
      y: initialLatitudeRad,
    };
    const velocity = { x: 0, y: 0 };
    let isDragging = false;
    let isHovering = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let animationFrameId = null;
    const lerpFactor =
      smoothingN === 0 ? 1 : mapLinear(smoothingN, 0, 1, 0.4, 0.03);
    const velocityDecay = mapLinear(smoothingN, 0, 1, 0.7, 0.96);

    const globeGroup = new T.Group();
    globeGroup.rotation.y = initialLongitudeRad;
    globeGroup.rotation.x = initialLatitudeRad;
    scene.add(globeGroup);
    globeGroup.add(oceanMesh);
    if (cfg.showGrid && cfg.graticuleColor && graticuleRgba.a > 0) {
      globeGroup.add(graticuleGroup);
    }
    globeGroup.add(continentOutlineGroup);
    markerMeshes.forEach((mesh) => globeGroup.add(mesh));

    const animate = () => {
      let needsRender = false;
      const threshold = 0.01;
      if (
        !isDragging &&
        rotationSpeed !== 0 &&
        (!cfg.stopOnHover || !isHovering)
      ) {
        targetRotation.x += rotationSpeed * 0.01;
      }
      if (!isDragging && smoothingN > 0) {
        if (
          Math.abs(velocity.x) > threshold ||
          Math.abs(velocity.y) > threshold
        ) {
          targetRotation.x += velocity.x;
          targetRotation.y += velocity.y;
          targetRotation.y = Math.max(
            -Math.PI / 2,
            Math.min(Math.PI / 2, targetRotation.y)
          );
          velocity.x *= velocityDecay;
          velocity.y *= velocityDecay;
        } else {
          velocity.x = 0;
          velocity.y = 0;
        }
      }
      const dx = targetRotation.x - rotation.x;
      const dy = targetRotation.y - rotation.y;
      if (
        Math.abs(dx) > threshold ||
        Math.abs(dy) > threshold ||
        rotationSpeed !== 0 ||
        isDragging
      ) {
        rotation.x += dx * lerpFactor;
        rotation.y += dy * lerpFactor;
        rotation.y = Math.max(
          -Math.PI / 2,
          Math.min(Math.PI / 2, rotation.y)
        );
        needsRender = true;
      }
      if (needsRender || rotationSpeed !== 0 || isDragging) {
        globeGroup.rotation.y = rotation.x;
        globeGroup.rotation.x = rotation.y;
        renderer.render(scene, camera);
      }
      const hasVelocity =
        Math.abs(velocity.x) > threshold ||
        Math.abs(velocity.y) > threshold;
      const hasLerpDelta =
        Math.abs(dx) > threshold || Math.abs(dy) > threshold;
      const needsContinue =
        isDragging || rotationSpeed !== 0 || hasVelocity || hasLerpDelta;
      if (needsContinue) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        animationFrameId = null;
      }
    };

    const startAnimation = () => {
      if (animationFrameId === null) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };
    if (rotationSpeed !== 0) {
      startAnimation();
    }

    const handleMouseDown = (event) => {
      isDragging = true;
      velocity.x = 0;
      velocity.y = 0;
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      startAnimation();
      const handleMouseMoveDrag = (moveEvent) => {
        const sensitivity = mapDragSpeedUiToSensitivity(cfg.dragSpeed);
        const dx = moveEvent.clientX - lastMouseX;
        const dy = moveEvent.clientY - lastMouseY;
        targetRotation.x += dx * sensitivity;
        targetRotation.y += dy * sensitivity;
        targetRotation.y = Math.max(
          -Math.PI / 2,
          Math.min(Math.PI / 2, targetRotation.y)
        );
        velocity.x = dx * sensitivity * 0.3;
        velocity.y = dy * sensitivity * 0.3;
        lastMouseX = moveEvent.clientX;
        lastMouseY = moveEvent.clientY;
      };
      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMoveDrag);
        document.removeEventListener('mouseup', handleMouseUp);
        isDragging = false;
      };
      document.addEventListener('mousemove', handleMouseMoveDrag);
      document.addEventListener('mouseup', handleMouseUp);
    };
    canvas.addEventListener('mousedown', handleMouseDown);

    const raycaster = new T.Raycaster();
    const mouse = new T.Vector2();
    const handleMouseMove = (event) => {
      if (!cfg.stopOnHover) return;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(oceanMesh);
      isHovering = intersects.length > 0;
    };
    canvas.addEventListener('mousemove', handleMouseMove);

    const resizeObserver = new ResizeObserver(() => {
      const newWidth =
        container.clientWidth || container.offsetWidth || 800;
      const newHeight =
        container.clientHeight || container.offsetHeight || 600;
      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(newWidth, newHeight);
      const newCameraDistance = 2.5 / scaleMultiplier;
      camera.position.set(0, 0, newCameraDistance);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    });
    resizeObserver.observe(container);

    loadWorldData();

    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      resizeObserver.disconnect();
      // Full GPU teardown: the card re-creates the effect on every entry, so
      // nothing may leak between sessions (geometry / material / textures).
      // The rim outline is built but (as in the provided component) never
      // added to the scene — dispose it explicitly so the traverse covers it.
      if (globeOutlineMesh) {
        if (globeOutlineMesh.geometry) globeOutlineMesh.geometry.dispose();
        if (globeOutlineMesh.material) globeOutlineMesh.material.dispose();
      }
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (m && m.map) m.map.dispose();
            if (m) m.dispose();
          });
        }
      });
      renderer.dispose();
      if (canvas.parentNode === container) container.removeChild(canvas);
    }

    return { dispose };
  }

  window.GlobeWrap = {
    create,
    // Test-only hooks for the port's pure math (used by test/globe_port_check.js).
    _test: {
      parseColorToRgba,
      mapLinear,
      mapSpeedUiToInternal,
      mapDensityUiToSpacing,
      mapScaleUiToMultiplier,
      mapDotSizeUiToMultiplier,
      mapMarkerDotSizeUiToMultiplier,
      normalizeSmoothing,
      mapDragSpeedUiToSensitivity,
      mapDetailToStepSize,
      simplifyRing,
      latLngToPosition,
      DEFAULTS,
    },
  };
})();
