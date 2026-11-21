/*
 * Import track points from a map image
 *
 * Weird stuff here. The idea is to:
 *   1. Align the uploaded image to the default equirectangular world map by
 *      multi-scale template matching (coarse pass + fine pass)
 *   2. Detect coloured dots/triangles/squares using the active colour scale
 *   3. Convert pixel positions to lat/lon and representative wind speeds, then
 *      hand the result to the existing importPoints() helper so the points
 *      behave exactly like manually entered points (regenerate, export, ...)
 *
 * Obvious limitations: a colour only carries a category, not an exact wind speed, and
 * names cannot be recovered from an image, so all detected points are imported
 * as a single, optionally named, track
 */

(function () {
  "use strict";

  const COARSE_W = 512, COARSE_H = 256;
  const FINE_W = 2048, FINE_H = 1024;
  const COLOUR_DISTANCE = 32;        // RGB distance tolerated when matching palette colours
  const DOT_RADIUS_FRACTION = 0.29890625 / 360; // dot radius as a fraction of the full map width
  const WORK_MAX_WIDTH = 1400;       // cap working resolution of uploaded images

  let refCoarse = null;             // { w, h, gray }
  let refFine = null;
  let refImage = null;              // cached full-resolution reference Image for background checks
  let referencePromise = null;
  let selectedFile = null;          // set by file picker, drag & drop, or paste
  let thumbUrl = null;

  // helpers
  function setStatus(message, isError) {
    const el = document.getElementById("image-import-status");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#ff6b6b" : "";
  }

  function setSelectedFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("Please choose a valid image file.", true);
      return;
    }
    selectedFile = file;

    const thumb = document.getElementById("image-thumb");
    const nameEl = document.getElementById("image-file-name");
    const prompt = document.getElementById("image-drop-prompt");
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = URL.createObjectURL(file);
    thumb.src = thumbUrl;
    thumb.classList.remove("hidden");
    nameEl.textContent = file.name || "Pasted image";
    nameEl.classList.remove("hidden");
    prompt.classList.add("hidden");
    document.getElementById("image-import-preview")?.classList.add("hidden");

    setStatus("Image ready — detecting tracks…");
    importFromImage();
  }

  function setupImageInput() {
    const zone = document.getElementById("image-drop-zone");
    const input = document.getElementById("track-image-upload");
    const choose = document.getElementById("image-choose-file");

    choose?.addEventListener("click", (e) => {
      e.stopPropagation();
      input.click();
    });
    zone?.addEventListener("click", (e) => {
      if (!e.target.closest("#image-choose-file")) input.click();
    });
    zone?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });

    input?.addEventListener("change", () => setSelectedFile(input.files?.[0]));

    ["dragenter", "dragover"].forEach((type) => {
      zone?.addEventListener(type, (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        zone.classList.add("drag-over");
      });
    });
    zone?.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("drag-over");
    });
    zone?.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      const file = Array.from(e.dataTransfer?.files || [])
        .find((f) => f.type.startsWith("image/"));
      if (file) setSelectedFile(file);
      else setStatus("Please drop an image file.", true);
    });

    // paste works anywhere, but only when the clipboard holds an image
    document.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        e.preventDefault();
        const ext = item.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const file = blob.name ? blob : new File([blob], `pasted-image.${ext}`, { type: item.type });
        setSelectedFile(file);
        return;
      }
    });
  }

  function grayFromImageData(data, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return g;
  }

  // light separable blur [1,2,1]/4 - this reduces the influence of track dots when matching
  function blurGray(g, w, h) {
    const tmp = new Float32Array(g.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const l = g[row + Math.max(0, x - 1)];
        const c = g[row + x];
        const r = g[row + Math.min(w - 1, x + 1)];
        tmp[row + x] = (l + 2 * c + r) * 0.25;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w;
      const mid = y * w;
      const dn = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) {
        g[mid + x] = (tmp[up + x] + 2 * tmp[mid + x] + tmp[dn + x]) * 0.25;
      }
    }
  }

  function resizedGray(srcCanvas, w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(srcCanvas, 0, 0, w, h);
    const g = grayFromImageData(cx.getImageData(0, 0, w, h).data, w, h);
    blurGray(g, w, h);
    return g;
  }

  function loadReference() {
    if (referencePromise) return referencePromise;
    referencePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          refImage = img;
          const fine = document.createElement("canvas");
          fine.width = FINE_W;
          fine.height = FINE_H;
          const fctx = fine.getContext("2d", { willReadFrequently: true });
          fctx.drawImage(img, 0, 0, FINE_W, FINE_H);

          const coarse = document.createElement("canvas");
          coarse.width = COARSE_W;
          coarse.height = COARSE_H;
          const cctx = coarse.getContext("2d", { willReadFrequently: true });
          cctx.drawImage(fine, 0, 0, COARSE_W, COARSE_H);

          refCoarse = { w: COARSE_W, h: COARSE_H, gray: grayFromImageData(cctx.getImageData(0, 0, COARSE_W, COARSE_H).data, COARSE_W, COARSE_H) };
          blurGray(refCoarse.gray, COARSE_W, COARSE_H);
          refFine = { w: FINE_W, h: FINE_H, gray: grayFromImageData(fctx.getImageData(0, 0, FINE_W, FINE_H).data, FINE_W, FINE_H) };
          blurGray(refFine.gray, FINE_W, FINE_H);
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Could not load the default map used for alignment."));
      img.src = "static/media/bg8192.png";
    });
    return referencePromise;
  }

  function makeProbes(w, h, nx, ny) {
    const px = new Int32Array(nx * ny);
    const py = new Int32Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const k = iy * nx + ix;
        px[k] = Math.min(w - 1, Math.floor((ix + 0.5) * w / nx));
        py[k] = Math.min(h - 1, Math.floor((iy + 0.5) * h / ny));
      }
    }
    return { px, py, n: px.length };
  }

  function probeStats(q, probes) {
    let sum = 0, sum2 = 0;
    for (let k = 0; k < probes.n; k++) {
      const v = q[probes.py[k] * q.width + probes.px[k]];
      sum += v;
      sum2 += v * v;
    }
    const mean = sum / probes.n;
    const variance = Math.max(0, sum2 / probes.n - mean * mean);
    return { mean, variance };
  }

  // normalized cross correlation between a query crop and a reference position
  function nccAt(q, qStats, probes, ref, ox, oy) {
    const rw = ref.w;
    let sr = 0, sr2 = 0, sqr = 0;
    for (let k = 0; k < probes.n; k++) {
      const rx = ox + probes.px[k];
      const ry = oy + probes.py[k];
      if (rx < 0 || ry < 0 || rx >= rw || ry >= ref.h) return -2;
      const rv = ref.gray[ry * rw + rx];
      const qv = q[probes.py[k] * q.width + probes.px[k]];
      sr += rv;
      sr2 += rv * rv;
      sqr += qv * rv;
    }
    const n = probes.n;
    const rMean = sr / n;
    const rVar = Math.max(1e-6, sr2 / n - rMean * rMean);
    if (qStats.variance < 1e-6) return -2;
    return (sqr / n - qStats.mean * rMean) / Math.sqrt(qStats.variance * rVar);
  }

  function wrapGray(g, w, h) {
    // keep the raw typed array indexable while carrying its dimensions
    g.width = w;
    g.height = h;
    return g;
  }

  // georeferencing
  function findCrop(workCanvas) {
    const aspect = workCanvas.width / workCanvas.height;
    const ref = refCoarse;
    const maxW = Math.min(ref.w, ref.h * aspect);
    const scales = [];
    for (let w = 16; w <= maxW * 1.02; w *= 1.18) scales.push(Math.max(8, Math.round(w)));
    if (scales[scales.length - 1] !== Math.round(maxW)) scales.push(Math.round(maxW));

    let best = { score: -Infinity, x: 0, y: 0, w: scales[0], h: Math.round(scales[0] / aspect) };

    // coarse pass over every candidate zoom / position
    for (const candidate of scales) {
      const w = Math.min(candidate, ref.w);
      const h = Math.max(8, Math.min(ref.h, Math.round(w / aspect)));
      const g = resizedGray(workCanvas, w, h);
      const q = wrapGray(g, w, h);
      const probes = makeProbes(w, h, 16, 12);
      const stats = probeStats(q, probes);

      for (let oy = 0; oy + h <= ref.h; oy += 4) {
        for (let ox = 0; ox + w <= ref.w; ox += 4) {
          const score = nccAt(q, stats, probes, ref, ox, oy);
          if (score > best.score) {
            best = { score, x: ox, y: oy, w, h };
          }
        }
      }
    }

    // fine pass on the full resolution reference, around the coarse result
    const fine = refFine;
    const scaleFactor = fine.w / ref.w;
    const baseX = best.x * scaleFactor;
    const baseY = best.y * scaleFactor;
    const baseW = best.w * scaleFactor;
    const fineBest = { score: -Infinity, x: baseX, y: baseY, w: baseW, h: best.h * scaleFactor };

    const radius = Math.max(60, Math.round(baseW * 0.14));
    const factors = [0.9, 0.95, 1, 1.04, 1.08, 1.12];
    for (const factor of factors) {
      const w = Math.max(16, Math.min(fine.w, Math.round(baseW * factor)));
      const h = Math.max(16, Math.min(fine.h, Math.round(w / aspect)));
      if (w > fine.w || h > fine.h) continue;
      const g = resizedGray(workCanvas, w, h);
      const q = wrapGray(g, w, h);
      const probes = makeProbes(w, h, 28, 20);
      const stats = probeStats(q, probes);

      for (let oy = Math.max(0, Math.round(baseY - radius)); oy <= Math.min(fine.h - h, Math.round(baseY + radius)); oy += 8) {
        for (let ox = Math.max(0, Math.round(baseX - radius)); ox <= Math.min(fine.w - w, Math.round(baseX + radius)); ox += 8) {
          const score = nccAt(q, stats, probes, fine, ox, oy);
          if (score > fineBest.score) {
            fineBest.score = score;
            fineBest.x = ox;
            fineBest.y = oy;
            fineBest.w = w;
            fineBest.h = h;
          }
        }
      }
    }

    // final scale + sub-position refinement around the best fine match
    const refineBaseW = fineBest.w;
    const refineBaseX = fineBest.x;
    const refineBaseY = fineBest.y;
    for (const factor of [0.97, 0.985, 1, 1.015, 1.03]) {
      const w = Math.max(16, Math.min(fine.w, Math.round(refineBaseW * factor)));
      const h = Math.max(16, Math.min(fine.h, Math.round(w / aspect)));
      if (h > fine.h) continue;
      const g = resizedGray(workCanvas, w, h);
      const q = wrapGray(g, w, h);
      const probes = makeProbes(w, h, 40, 28);
      const stats = probeStats(q, probes);
      for (let oy = Math.max(0, refineBaseY - 12); oy <= Math.min(fine.h - h, refineBaseY + 12); oy++) {
        for (let ox = Math.max(0, refineBaseX - 12); ox <= Math.min(fine.w - w, refineBaseX + 12); ox++) {
          const score = nccAt(q, stats, probes, fine, ox, oy);
          if (score > fineBest.score) {
            fineBest.score = score;
            fineBest.x = ox;
            fineBest.y = oy;
            fineBest.w = w;
            fineBest.h = h;
          }
        }
      }
    }

    return { ...fineBest, confidence: fineBest.score };
  }

  function sampleCropBackground(crop, width, height) {
    if (!refImage || crop.confidence < 0.5 || crop.w <= 0 || crop.h <= 0) return null;
    try {
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = width;
      bgCanvas.height = height;
      const bgCtx = bgCanvas.getContext("2d", { willReadFrequently: true });
      const sx = (crop.x / refFine.w) * refImage.naturalWidth;
      const sy = (crop.y / refFine.h) * refImage.naturalHeight;
      const sw = (crop.w / refFine.w) * refImage.naturalWidth;
      const sh = (crop.h / refFine.h) * refImage.naturalHeight;
      bgCtx.drawImage(refImage, sx, sy, sw, sh, 0, 0, width, height);
      return bgCtx.getImageData(0, 0, width, height).data;
    } catch (err) {
      return null;
    }
  }

  // refine alignment
  function refineCrop8k(workCanvas, crop, points) {
    if (!refImage || !refImage.naturalWidth || crop.confidence < 0.25) return crop;

    const scaleX8k = refImage.naturalWidth / refFine.w;
    const scaleY8k = refImage.naturalHeight / refFine.h;
    const pad = 28;
    const rx0 = Math.max(0, Math.floor(crop.x * scaleX8k) - pad);
    const ry0 = Math.max(0, Math.floor(crop.y * scaleY8k) - pad);
    const rx1 = Math.min(refImage.naturalWidth, Math.ceil((crop.x + crop.w) * scaleX8k) + pad);
    const ry1 = Math.min(refImage.naturalHeight, Math.ceil((crop.y + crop.h) * scaleY8k) + pad);
    const srcW = rx1 - rx0, srcH = ry1 - ry0;
    if (srcW < 32 || srcH < 32) return crop;

    // keep full 8k resolution on regional crops; cap only on near-global views
    const patchScale = Math.min(1, 2400 / Math.max(srcW, srcH));
    const rw = Math.round(srcW * patchScale);
    const rh = Math.round(srcH * patchScale);

    const rc = document.createElement("canvas");
    rc.width = rw;
    rc.height = rh;
    const rctx = rc.getContext("2d", { willReadFrequently: true });
    rctx.drawImage(refImage, rx0, ry0, srcW, srcH, 0, 0, rw, rh);
    const rGray = grayFromImageData(rctx.getImageData(0, 0, rw, rh).data, rw, rh);
    blurGray(rGray, rw, rh);
    const refPatch = { w: rw, h: rh, gray: rGray };

    const aspect = workCanvas.width / workCanvas.height;
    const baseW = crop.w * scaleX8k * patchScale;
    const baseOx = (crop.x * scaleX8k - rx0) * patchScale;
    const baseOy = (crop.y * scaleY8k - ry0) * patchScale;

    const filterProbes = (w, h, raw) => {
      const px = [], py = [];
      for (let k = 0; k < raw.n; k++) {
        const wx = (raw.px[k] / w) * workCanvas.width;
        const wy = (raw.py[k] / h) * workCanvas.height;
        let onDot = false;
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (Math.hypot(wx - p.x, wy - p.y) <= p.dim * 1.2) {
            onDot = true;
            break;
          }
        }
        if (!onDot) { px.push(raw.px[k]); py.push(raw.py[k]); }
      }
      if (px.length < 40) return raw;
      return { px: new Int32Array(px), py: new Int32Array(py), n: px.length };
    };

    let best = { score: -Infinity, ox: baseOx, oy: baseOy, w: Math.round(baseW), h: Math.round(baseW / aspect), q: null, stats: null, probes: null };
    const searchRad = Math.max(10, Math.round(20 * patchScale));

    for (const factor of [0.984, 0.992, 1, 1.008, 1.016]) {
      const w = Math.max(16, Math.min(rw, Math.round(baseW * factor)));
      const h = Math.max(16, Math.min(rh, Math.round(w / aspect)));
      if (h > rh) continue;
      const q = wrapGray(resizedGray(workCanvas, w, h), w, h);
      const probes = filterProbes(w, h, makeProbes(w, h, 36, 26));
      const stats = probeStats(q, probes);

      for (let oy = Math.max(0, Math.round(baseOy - searchRad)); oy <= Math.min(rh - h, Math.round(baseOy + searchRad)); oy += 2) {
        for (let ox = Math.max(0, Math.round(baseOx - searchRad)); ox <= Math.min(rw - w, Math.round(baseOx + searchRad)); ox += 2) {
          const score = nccAt(q, stats, probes, refPatch, ox, oy);
          if (score > best.score) best = { score, ox, oy, w, h, q, stats, probes };
        }
      }
    }

    if (!best.q) return crop;

    // 1-px pass + parabolic sub-pixel peak around the winning position
    const cx0 = best.ox, cy0 = best.oy;
    for (let oy = Math.max(0, cy0 - 3); oy <= Math.min(rh - best.h, cy0 + 3); oy++) {
      for (let ox = Math.max(0, cx0 - 3); ox <= Math.min(rw - best.w, cx0 + 3); ox++) {
        const score = nccAt(best.q, best.stats, best.probes, refPatch, ox, oy);
        if (score > best.score) { best.score = score; best.ox = ox; best.oy = oy; }
      }
    }

    let dx = 0, dy = 0;
    if (best.ox > 0 && best.ox + best.w < rw) {
      const sL = nccAt(best.q, best.stats, best.probes, refPatch, best.ox - 1, best.oy);
      const sR = nccAt(best.q, best.stats, best.probes, refPatch, best.ox + 1, best.oy);
      const denom = sL + sR - 2 * best.score;
      if (denom < -1e-7) dx = Math.max(-0.5, Math.min(0.5, 0.5 * (sL - sR) / denom));
    }
    if (best.oy > 0 && best.oy + best.h < rh) {
      const sU = nccAt(best.q, best.stats, best.probes, refPatch, best.ox, best.oy - 1);
      const sD = nccAt(best.q, best.stats, best.probes, refPatch, best.ox, best.oy + 1);
      const denom = sU + sD - 2 * best.score;
      if (denom < -1e-7) dy = Math.max(-0.5, Math.min(0.5, 0.5 * (sU - sD) / denom));
    }

    return {
      ...crop,
      x: (rx0 + (best.ox + dx) / patchScale) / scaleX8k,
      y: (ry0 + (best.oy + dy) / patchScale) / scaleY8k,
      w: (best.w / patchScale) / scaleX8k,
      h: (best.h / patchScale) / scaleY8k,
      confidence: Math.max(crop.confidence, best.score)
    };
  }

  // point detection
  function buildPalettes() {
    const palettes = {};
    if (typeof getScaleList !== "function" || typeof getScaleMaps !== "function") return palettes;

    getScaleList().forEach((name) => {
      const maps = getScaleMaps(name);
      const entries = [];
      const seen = new Set();
      ["tropical", "subtropical", "extratropical"].forEach((type) => {
        maps[type].forEach((hex, cat) => {
          const key = String(hex).toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          const h = key.replace("#", "");
          entries.push({
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
            cat: cat,
            type: type
          });
        });
      });
      palettes[name] = entries;
    });
    return palettes;
  }

  // one flat palette containing every colour from every available scale
  function buildGlobalPalette(palettes) {
    const entries = [];
    Object.keys(palettes).forEach((name) => {
      palettes[name].forEach((entry) => {
        entries.push({
          r: entry.r, g: entry.g, b: entry.b,
          cat: entry.cat, scale: name
        });
      });
    });
    return entries;
  }

  function nearestEntry(r, g, b, entries) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const dr = r - e.r, dg = g - e.g, db = b - e.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return { entry: best, distance: bestDist };
  }

  // LUT so per-pixel nearest-colour lookups stay cheap over several passes
  function buildPaletteLUT(entries) {
    const size = 1 << 18; // 6 bits per channel
    const dist = new Uint16Array(size);
    for (let i = 0; i < size; i++) {
      const r = ((i >> 12) & 63) * 4 + 2;
      const g = ((i >> 6) & 63) * 4 + 2;
      const b = (i & 63) * 4 + 2;
      let best = Infinity;
      for (let j = 0; j < entries.length; j++) {
        const e = entries[j];
        const dr = r - e.r, dg = g - e.g, db = b - e.b;
        const d = dr * dr + dg * dg + db * db;
        if (d < best) best = d;
      }
      dist[i] = Math.min(65535, best);
    }
    return { dist: dist, entries: entries };
  }

  function lutKey(r, g, b) {
    return ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
  }

  function detectAllPoints(imageData, palettes, expectedDotRadius, bgData) {
    const entries = buildGlobalPalette(palettes);
    if (!entries.length) return [];
    const lut = buildPaletteLUT(entries);
    return detectFlatDots(imageData, lut, palettes, expectedDotRadius, bgData);
  }

  // markers of different shapes (circles, triangles, squares) on the same map
  // share a linear bounding dimension rather than raw pixel area
  function filterConsistentSizes(points, expectedDiam) {
    if (points.length < 3) return points;
    const sizeWindows = [[0.48, 1.35], [0.3, 1.85], [0.18, 2.5]];
    let bestCluster = [];

    for (const [loF, hiF] of sizeWindows) {
      const inWin = points.filter((p) => p.dim >= expectedDiam * loF && p.dim <= expectedDiam * hiF);
      if (inWin.length < 3) {
        if (inWin.length > bestCluster.length) bestCluster = inWin;
        continue;
      }
      const dims = inWin.map((p) => p.dim).sort((a, b) => a - b);
      let bestC = [];
      let bestScore = -1;
      for (let i = 0; i < dims.length; i++) {
        const loD = dims[i];
        const hiD = Math.ceil(Math.max(loD + 4, loD * 1.7));
        const cl = inWin.filter((p) => p.dim >= loD && p.dim <= hiD);
        if (!cl.length) continue;
        const avgDist = cl.reduce((s, p) => s + p.distance, 0) / cl.length;
        const avgCtr = cl.reduce((s, p) => s + p.contrast, 0) / cl.length;
        const lineFrac = cl.filter((p) => p.lineScore >= 2).length / cl.length;
        const score = cl.length * (1 + 0.4 * lineFrac) *
          (1 + Math.min(2, avgCtr / 150)) / (1 + avgDist / 35);
        if (score > bestScore) {
          bestScore = score;
          bestC = cl;
        }
      }
      if (bestC.length > bestCluster.length) bestCluster = bestC;
      if (bestCluster.length >= 3) break;
    }

    return bestCluster.length ? bestCluster : points;
  }

  function dominantScale(points) {
    const weights = new Map();
    points.forEach((p) => {
      // closer colour matches carry more weight
      const w = 1 / (1 + p.distance / 20);
      weights.set(p.scale, (weights.get(p.scale) || 0) + w);
    });
    let best = null;
    let bestWeight = -1;
    weights.forEach((weight, scale) => {
      if (weight > bestWeight) {
        bestWeight = weight;
        best = scale;
      }
    });
    return best;
  }

  function detectFlatDots(imageData, lut, palettes, expectedDotRadius, bgData) {
    const w = imageData.width, h = imageData.height;
    const d = imageData.data;
    const entries = lut.entries;
    const r = Math.max(2, expectedDotRadius);

    // tight inner cross stays inside small dots, triangles, and occluded circles
    const pIn = r > 14 ? 2 : 1;
    const inOffsets = [[0, 0], [pIn, 0], [-pIn, 0], [0, pIn], [0, -pIn]];
    const step = Math.max(1, Math.min(3, Math.round(r * 0.25)));

    // outer rings at 1.4*r and 2.4*r verify sharp marker-to-background contrast
    const ringR1 = Math.max(3, Math.round(r * 1.4));
    const ringR2 = Math.max(5, Math.round(r * 2.4));
    const ring1 = [], ring2 = [];
    for (let a = 0; a < 8; a++) {
      const ang = (a * Math.PI) / 4;
      ring1.push([Math.round(ringR1 * Math.cos(ang)), Math.round(ringR1 * Math.sin(ang))]);
      ring2.push([Math.round(ringR2 * Math.cos(ang)), Math.round(ringR2 * Math.sin(ang))]);
    }

    const ringContrast = (cx, cy, mr, mg, mb, offsets) => {
      const rdists = [];
      for (let k = 0; k < offsets.length; k++) {
        const rx = cx + offsets[k][0];
        const ry = cy + offsets[k][1];
        if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
        const p = (ry * w + rx) * 4;
        const dr = d[p] - mr, dg = d[p + 1] - mg, db = d[p + 2] - mb;
        rdists.push(Math.sqrt(dr * dr + dg * dg + db * db));
      }
      if (rdists.length < 4) return 0;
      rdists.sort((a, b) => a - b);
      return rdists[Math.max(0, Math.floor(rdists.length / 3) - 1)];
    };

    // white connector mask (used as a soft ranking signal)
    const whiteMask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < whiteMask.length; i++, p += 4) {
      const mn = Math.min(d[p], d[p + 1], d[p + 2]);
      const mx = Math.max(d[p], d[p + 1], d[p + 2]);
      if (mn >= 215 && mx - mn <= 32) whiteMask[i] = 1;
    }

    const candidates = [];
    const margin = Math.max(pIn + 1, 2);
    for (let y = margin; y < h - margin; y += step) {
      for (let x = margin; x < w - margin; x += step) {
        const idx = y * w + x;
        if (lut.dist[lutKey(d[idx * 4], d[idx * 4 + 1], d[idx * 4 + 2])] > 130 * 130) continue;

        let sr = 0, sg = 0, sb = 0, sr2 = 0, sg2 = 0, sb2 = 0;
        const n = inOffsets.length;
        for (let k = 0; k < n; k++) {
          const p = ((y + inOffsets[k][1]) * w + (x + inOffsets[k][0])) * 4;
          const pr = d[p], pg = d[p + 1], pb = d[p + 2];
          sr += pr; sg += pg; sb += pb;
          sr2 += pr * pr; sg2 += pg * pg; sb2 += pb * pb;
        }
        const mr = sr / n, mg = sg / n, mb = sb / n;
        const variance = Math.max(0, (sr2 - sr * sr / n) +
          (sg2 - sg * sg / n) + (sb2 - sb * sb / n)) / (3 * n);
        const stdIn = Math.sqrt(variance);
        if (stdIn > 16) continue;

        const luminance = 0.299 * mr + 0.587 * mg + 0.114 * mb;
        if (luminance < 65) continue;
        const spread = Math.max(mr, mg, mb) - Math.min(mr, mg, mb);
        if (luminance >= 220 && spread <= 25) continue; // skip white connector lines

        const hit = nearestEntry(mr, mg, mb, entries);
        if (!hit.entry || hit.distance > 130 * 130) continue;

        const greyDot = Math.abs(mr - mg) < 14 && Math.abs(mg - mb) < 14 && hit.distance < 45 * 45;
        if (spread < 18 && !greyDot) continue;

        const contrast = Math.max(
          ringContrast(x, y, mr, mg, mb, ring1),
          ringContrast(x, y, mr, mg, mb, ring2)
        );
        if (contrast < 42) continue;

        const dist = Math.sqrt(hit.distance);
        candidates.push({
          x: x, y: y, r: mr, g: mg, b: mb,
          spread: spread,
          stdIn: stdIn,
          score: dist + stdIn * 2.5 - Math.min(50, contrast * 0.1)
        });
      }
    }

    // colour-aware NMS: preserves closely overlapping dots of different colours
    candidates.sort((a, b) => a.score - b.score);
    const picked = [];
    const sameSep2 = Math.pow(Math.max(4, r * 0.9), 2);
    const diffSep2 = Math.pow(Math.max(3, r * 0.45), 2);
    for (const c of candidates) {
      if (picked.length >= 500) break;
      let tooClose = false;
      for (const p of picked) {
        const dx = p.x - c.x, dy = p.y - c.y;
        const cd2 = (p.r - c.r) * (p.r - c.r) + (p.g - c.g) * (p.g - c.g) + (p.b - c.b) * (p.b - c.b);
        const sep2 = cd2 < 45 * 45 ? sameSep2 : diffSep2;
        if (dx * dx + dy * dy < sep2) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) picked.push(c);
    }

    // flood-fill each seed using its own colour and classify shape
    const rawPoints = [];
    const half = Math.max(6, Math.round(r * 2.6));
    const colourTolerance2 = 38 * 38;
    const bgRad = Math.max(6, Math.round(r));
    const bgStep = Math.max(1, Math.round(bgRad / 4));

    for (const c of picked) {
      const x0 = Math.max(0, c.x - half), x1 = Math.min(w - 1, c.x + half);
      const y0 = Math.max(0, c.y - half), y1 = Math.min(h - 1, c.y + half);
      const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
      if (rw < 3 || rh < 3) continue;

      const visited = new Uint8Array(rw * rh);
      const stack = new Int32Array(rw * rh);
      let sp = 0;
      const start = (c.y - y0) * rw + (c.x - x0);
      visited[start] = 1;
      stack[sp++] = start;

      const pixLX = [], pixLY = [];
      let count = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0;
      let minX = rw, maxX = 0, minY = rh, maxY = 0;
      let hitsBorder = 0;

      while (sp > 0) {
        const idx = stack[--sp];
        const lx = idx % rw, ly = (idx / rw) | 0;
        const gx = x0 + lx, gy = y0 + ly;
        const p = (gy * w + gx) * 4;
        const pr = d[p], pg = d[p + 1], pb = d[p + 2];
        const dr = pr - c.r, dg = pg - c.g, db = pb - c.b;
        if (dr * dr + dg * dg + db * db > colourTolerance2) continue;

        // prevent pale coloured dots from leaking onto neutral white track lines
        const pSpread = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
        if (c.spread >= 28 && pSpread < 12) continue;

        pixLX.push(lx);
        pixLY.push(ly);
        count++;
        sx += gx; sy += gy;
        sr += pr; sg += pg; sb += pb;
        if (lx < minX) minX = lx;
        if (lx > maxX) maxX = lx;
        if (ly < minY) minY = ly;
        if (ly > maxY) maxY = ly;
        if (lx === 0 || lx === rw - 1 || ly === 0 || ly === rh - 1) hitsBorder++;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = ly + dy;
          if (ny < 0 || ny >= rh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = lx + dx;
            if (nx < 0 || nx >= rw) continue;
            const ni = ny * rw + nx;
            if (!visited[ni]) {
              visited[ni] = 1;
              stack[sp++] = ni;
            }
          }
        }
      }

      if (count < 9) continue;
      if (hitsBorder > Math.max(3, count * 0.08)) continue;

      const boxW = maxX - minX + 1, boxH = maxY - minY + 1;
      const maxDim = Math.max(boxW, boxH);
      const fill = count / (boxW * boxH);
      const aspect = boxW / boxH;
      if (fill < 0.44 || fill > 1.02) continue;
      if (aspect < 0.65 || aspect > 1.6) continue;

      const mr = sr / count, mg = sg / count, mb = sb / count;

      // verify immediate exterior contrast just outside the bounding box
      const bx0 = Math.max(0, x0 + minX - 2), bx1 = Math.min(w - 1, x0 + maxX + 2);
      const by0 = Math.max(0, y0 + minY - 2), by1 = Math.min(h - 1, y0 + maxY + 2);
      const bxMid = (bx0 + bx1) >> 1, byMid = (by0 + by1) >> 1;
      const bSamples = [
        [bx0, by0], [bxMid, by0], [bx1, by0],
        [bx0, byMid], [bx1, byMid],
        [bx0, by1], [bxMid, by1], [bx1, by1]
      ];
      const bDists = bSamples.map(([bx, by]) => {
        const p = (by * w + bx) * 4;
        const dr = d[p] - mr, dg = d[p + 1] - mg, db = d[p + 2] - mb;
        return Math.sqrt(dr * dr + dg * dg + db * db);
      }).sort((a, b) => a - b);
      const borderContrast = bDists[Math.max(0, Math.floor(bDists.length / 3) - 1)];
      if (borderContrast < 42) continue;

      const cx = sx / count, cy = sy / count;

      // check against background (and reject static terrain like salt flats)
      let minBgDist = Infinity;
      if (bgData) {
        let minBgDist2 = Infinity;
        const ix = Math.round(cx), iy = Math.round(cy);
        for (let gy = Math.max(0, iy - bgRad); gy <= Math.min(h - 1, iy + bgRad); gy += bgStep) {
          for (let gx = Math.max(0, ix - bgRad); gx <= Math.min(w - 1, ix + bgRad); gx += bgStep) {
            const bp = (gy * w + gx) * 4;
            const dr = mr - bgData[bp], dg = mg - bgData[bp + 1], db = mb - bgData[bp + 2];
            const d2 = dr * dr + dg * dg + db * db;
            if (d2 < minBgDist2) minBgDist2 = d2;
          }
        }
        minBgDist = Math.sqrt(minBgDist2);
        if (minBgDist < 24 && (c.stdIn > 2 || borderContrast < 150)) continue;
      }

      // compare top-third vs bottom-third horizontal width to separate triangles from circles
      const topCut = minY + boxH / 3;
      const botCut = maxY - boxH / 3;
      let topMin = rw, topMax = -1, botMin = rw, botMax = -1;
      for (let i = 0; i < count; i++) {
        const lx = pixLX[i], ly = pixLY[i];
        if (ly <= topCut) {
          if (lx < topMin) topMin = lx;
          if (lx > topMax) topMax = lx;
        }
        if (ly >= botCut) {
          if (lx < botMin) botMin = lx;
          if (lx > botMax) botMax = lx;
        }
      }
      const topW = topMax >= topMin ? topMax - topMin + 1 : 0;
      const botW = botMax >= botMin ? botMax - botMin + 1 : 0;
      const isTriangle = (fill < 0.64 && botW > topW * 1.25) || (fill < 0.72 && botW > topW * 1.65);

      let stage;
      if (isTriangle) stage = "Extratropical cyclone";
      else if (fill < 0.88) stage = "Tropical cyclone";
      else stage = "Subtropical cyclone";

      const colour = nearestEntry(mr, mg, mb, entries);
      if (!colour.entry) continue;

      let lineScore = 0;
      const ringOuter = maxDim * 1.6, ringInner = maxDim * 0.4;
      const reach = Math.ceil(ringOuter);
      for (let gy = Math.max(0, Math.floor(cy - reach)); gy <= Math.min(h - 1, Math.ceil(cy + reach)); gy++) {
        const dy = gy - cy;
        for (let gx = Math.max(0, Math.floor(cx - reach)); gx <= Math.min(w - 1, Math.ceil(cx + reach)); gx++) {
          const dx = gx - cx;
          const dist2 = dx * dx + dy * dy;
          if (dist2 >= ringInner * ringInner && dist2 <= ringOuter * ringOuter && whiteMask[gy * w + gx]) {
            lineScore++;
          }
        }
      }

      rawPoints.push({
        x: cx,
        y: cy,
        mr: mr, mg: mg, mb: mb,
        cat: colour.entry.cat,
        scale: colour.entry.scale,
        stage: stage,
        colour: colour.entry,
        distance: Math.sqrt(colour.distance),
        count: count,
        dim: maxDim,
        fill: fill,
        isTriangle: isTriangle,
        occluded: false,
        contrast: borderContrast,
        minBgDist: minBgDist,
        stdIn: c.stdIn,
        lineScore: lineScore,
        seedScore: c.score
      });
    }

    // deduplicate same-colour components whose centroids overlap after flood-fill
    rawPoints.sort((a, b) => (a.distance - b.distance) || (a.seedScore - b.seedScore));
    const points = [];
    for (const p of rawPoints) {
      let dup = false;
      for (const q of points) {
        const dx = q.x - p.x, dy = q.y - p.y;
        const cd2 = (q.mr - p.mr) * (q.mr - p.mr) + (q.mg - p.mg) * (q.mg - p.mg) + (q.mb - p.mb) * (q.mb - p.mb);
        const minSep = cd2 < 45 * 45 ? 0.65 * Math.max(q.dim, p.dim) : 0.35 * Math.min(q.dim, p.dim);
        if (dx * dx + dy * dy < minSep * minSep) {
          dup = true;
          break;
        }
      }
      if (!dup) points.push(p);
    }

    // detect top-occluded circles (overlapped by a subsequent dot just above them)
    for (const p of points) {
      for (const q of points) {
        if (q === p) continue;
        const dx = Math.abs(q.x - p.x);
        const dy = p.y - q.y;
        if (dy > 0.3 * p.dim && dy < 1.15 * p.dim && dx < 0.75 * p.dim) {
          p.occluded = true;
          if (p.stage === "Extratropical cyclone") p.stage = "Tropical cyclone";
          break;
        }
      }
    }

    // reject unoccluded irregular low-fill blobs that are neither triangles nor circles/squares
    const validShape = points.filter((p) => !(p.fill < 0.62 && !p.isTriangle && !p.occluded));
    let cluster = filterConsistentSizes(validShape, 2 * r);

    // dominant-scale verification and outlier filtering
    if (cluster.length >= 3) {
      const domScale = dominantScale(cluster);
      const domEntries = domScale && palettes[domScale] ? palettes[domScale] : null;
      if (domEntries && domEntries.length) {
        cluster.forEach((p) => {
          const hit = nearestEntry(p.mr, p.mg, p.mb, domEntries);
          p.domDist = hit.entry ? Math.sqrt(hit.distance) : Infinity;
          p.domHit = hit.entry;
        });
        const closeCnt = cluster.filter((p) => p.domDist <= COLOUR_DISTANCE).length;
        if (closeCnt >= Math.max(3, Math.ceil(cluster.length * 0.6))) {
          cluster = cluster.filter((p) =>
            p.domDist <= 34 || (p.domDist <= 48 && p.contrast >= 130)
          );
          cluster.forEach((p) => {
            if (p.domHit) {
              p.scale = domScale;
              p.cat = p.domHit.cat;
              p.colour = p.domHit;
              p.distance = p.domDist;
            }
          });
        } else {
          cluster = cluster.filter((p) => p.contrast >= 95 && p.distance <= 115);
        }
      }
    }

    // prune isolated terrain specks far outside the track chain
    if (cluster.length >= 4) {
      const nns = cluster.map((p, i) => {
        let bestD = Infinity;
        for (let j = 0; j < cluster.length; j++) {
          if (i === j) continue;
          const dist = Math.hypot(p.x - cluster[j].x, p.y - cluster[j].y);
          if (dist < bestD) bestD = dist;
        }
        return bestD;
      });
      const medNN = nns.slice().sort((a, b) => a - b)[nns.length >> 1];
      const medDim = cluster.map((p) => p.dim).sort((a, b) => a - b)[cluster.length >> 1];
      const isoThresh = Math.max(medDim * 7, medNN * 4.5);
      const kept = cluster.filter((p, i) => {
        if (nns[i] <= isoThresh) return true;
        const suspect = p.stdIn > 3.5 || p.dim < medDim * 0.85 || p.contrast < 150 || p.minBgDist < 38;
        return !suspect;
      });
      if (kept.length >= 3) cluster = kept;
    }

    return cluster;
  }

  // reconstruct track sequence via Euclidean Minimum Spanning Tree diameter
  // this way curved/J-shaped tracks order cleanly from one endpoint to the other
  function orderPoints(points) {
    const n = points.length;
    if (n < 3) return points.slice();

    const inTree = new Uint8Array(n);
    const minDist = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    minDist[0] = 0;
    const adj = Array.from({ length: n }, () => []);

    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      for (let i = 0; i < n; i++) {
        if (!inTree[i] && (u === -1 || minDist[i] < minDist[u])) u = i;
      }
      inTree[u] = 1;
      if (parent[u] !== -1) {
        const p = parent[u];
        const w = Math.hypot(points[u].x - points[p].x, points[u].y - points[p].y);
        adj[u].push([p, w]);
        adj[p].push([u, w]);
      }
      for (let v = 0; v < n; v++) {
        if (!inTree[v]) {
          const dx = points[u].x - points[v].x;
          const dy = points[u].y - points[v].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < minDist[v]) {
            minDist[v] = d2;
            parent[v] = u;
          }
        }
      }
    }

    const farthest = (start) => {
      const dist = new Float64Array(n).fill(-1);
      const prev = new Int32Array(n).fill(-1);
      dist[start] = 0;
      const stack = [start];
      let best = start;
      while (stack.length) {
        const u = stack.pop();
        if (dist[u] > dist[best]) best = u;
        for (const [v, w] of adj[u]) {
          if (dist[v] < 0) {
            dist[v] = dist[u] + w;
            prev[v] = u;
            stack.push(v);
          }
        }
      }
      return { node: best, prev: prev };
    };

    const endA = farthest(0).node;
    const { node: endB, prev: prevB } = farthest(endA);

    const onSpine = new Set();
    for (let curr = endB; curr !== -1; curr = prevB[curr]) onSpine.add(curr);

    const ordered = [];
    const visited = new Uint8Array(n);
    const dfs = (u) => {
      visited[u] = 1;
      ordered.push(points[u]);
      const neighbors = adj[u].slice().sort((a, b) => {
        const sa = onSpine.has(a[0]) ? 1 : 0;
        const sb = onSpine.has(b[0]) ? 1 : 0;
        return sa !== sb ? sa - sb : a[1] - b[1];
      });
      for (const [v] of neighbors) {
        if (!visited[v]) dfs(v);
      }
    };
    dfs(endA);
    return ordered;
  }

  function representativeSpeed(cat, scaleName) {
    if (cat === -999) return 0;
    if (typeof getScaleCategoryForSpeed !== "function") return 0;
    // pick the middle speed that renders in this category (works for custom scales too!)
    const matching = [];
    for (let s = 1; s <= 200; s++) {
      if (getScaleCategoryForSpeed(scaleName, s) === cat) matching.push(s);
    }
    return matching.length ? matching[Math.floor(matching.length / 2)] : 0;
  }

  function formatLat(v) {
    const lat = Math.max(-90, Math.min(90, v));
    return Math.abs(lat).toFixed(2) + (lat < 0 ? "S" : "N");
  }

  function formatLon(v) {
    let lon = ((v + 180) % 360 + 360) % 360 - 180;
    if (Object.is(lon, -0)) lon = 0;
    return Math.abs(lon).toFixed(2) + (lon < 0 ? "W" : "E");
  }

  function cropToLatLon(crop, px, py, workW, workH) {
    // position inside the matched crop, in fine-map pixel coordinates
    const refX = crop.x + (px / workW) * crop.w;
    const refY = crop.y + (py / workH) * crop.h;
    return {
      lat: 90 - (refY / refFine.h) * 180,
      lon: (refX / refFine.w) * 360 - 180
    };
  }

  // preview
  function drawPreview(workCanvas, points, crop) {
    const canvas = document.getElementById("image-import-preview");
    if (!canvas) return;
    const displayW = Math.min(460, workCanvas.width);
    const displayH = Math.round(displayW * workCanvas.height / workCanvas.width);
    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(workCanvas, 0, 0, displayW, displayH);
    const sx = displayW / workCanvas.width;
    const sy = displayH / workCanvas.height;

    points.forEach((p) => {
      const hex = "#" + [p.colour.r, p.colour.g, p.colour.b]
        .map((v) => v.toString(16).padStart(2, "0")).join("");
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 7, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(255,255,255,.95)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = hex;
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 4.5, 0, 2 * Math.PI);
      ctx.fill();
    });
    canvas.classList.remove("hidden");
    return { sw: workCanvas.width / displayW, sh: workCanvas.height / displayH };
  }

  // main
  async function importFromImage() {
    const fileInput = document.getElementById("track-image-upload");
    const file = selectedFile || (fileInput && fileInput.files && fileInput.files[0]);
    if (!file) {
      setStatus("Choose, drop or paste an image first.", true);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setStatus("Please choose a valid image file.", true);
      return;
    }

    const button = document.getElementById("import-from-image");
    if (button) button.disabled = true;
    setStatus("Loading default map for alignment…");

    try {
      await loadReference();

      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not read the selected image."));
        img.src = URL.createObjectURL(file);
      });

      const workScale = Math.min(1, WORK_MAX_WIDTH / image.width);
      const workCanvas = document.createElement("canvas");
      workCanvas.width = Math.max(1, Math.round(image.width * workScale));
      workCanvas.height = Math.max(1, Math.round(image.height * workScale));
      const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, workCanvas.width, workCanvas.height);
      if (image.src.startsWith("blob:")) URL.revokeObjectURL(image.src);

      setStatus("Aligning image to the map…");
      await new Promise((r) => setTimeout(r, 0));
      let crop = findCrop(workCanvas);

      if (crop.confidence < 0.25) {
        setStatus("Warning: the image could not be matched to the default map confidently; coordinates may be inaccurate.", true);
      } else {
        setStatus("Detecting track points…");
      }
      await new Promise((r) => setTimeout(r, 0));

      const imageData = ctx.getImageData(0, 0, workCanvas.width, workCanvas.height);
      const bgData = sampleCropBackground(crop, workCanvas.width, workCanvas.height);
      const palettes = buildPalettes();
      const expectedDotRadius = DOT_RADIUS_FRACTION * refFine.w * (workCanvas.width / crop.w);
      const points = detectAllPoints(imageData, palettes, expectedDotRadius, bgData);

      if (!points.length) {
        setStatus("No track points were detected in this image.", true);
        return;
      }

      crop = refineCrop8k(workCanvas, crop, points);

      const scaleName = dominantScale(points);
      const looseMatches = points.filter((p) => p.distance > COLOUR_DISTANCE).length;
      drawPreview(workCanvas, points, crop);
      const ordered = orderPoints(points);
      const name = (document.getElementById("image-storm-name").value || "").trim() || "Imported Storm";

      const data = ordered.map((p) => {
        const ll = cropToLatLon(crop, p.x, p.y, workCanvas.width, workCanvas.height);
        return {
          name: name,
          latitude: formatLat(ll.lat),
          longitude: formatLon(ll.lon),
          speed: representativeSpeed(p.cat, p.scale),
          stage: p.stage
        };
      });

      if (typeof importPoints === "function") {
        await importPoints(data);
      } else {
        throw new Error("The import helper is not available.");
      }
      document.getElementById("inputs")?.dispatchEvent(new Event("input", { bubbles: true }));

      const noun = data.length === 1 ? "point" : "points";
      const scaleNote = scaleName ? ` using the ${scaleName} scale` : "";
      const approxNote = looseMatches > data.length / 2
        ? " Marker colours differed slightly from built-in scales, so double-check intensities."
        : "";
      setStatus(
        `Imported ${data.length} track ${noun}${scaleNote} (wind speeds estimated from marker colours).${approxNote}`
      );
    } catch (err) {
      console.error("Image import failed:", err);
      setStatus(err && err.message ? err.message : "Image import failed.", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupImageInput();
    document.getElementById("import-from-image")?.addEventListener("click", importFromImage);
  });
})();
