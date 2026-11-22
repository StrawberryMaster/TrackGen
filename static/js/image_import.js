/*
 * Import track points from a map image
 *
 * Weird stuff here. The idea is to:
 *   1. Align the uploaded image to the default equirectangular world map by
 *      multi-scale template matching (coarse pass + fine pass, wrapping across ±180°)
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
  const WORK_MAX_WIDTH = 2048;       // preserve native pixel detail up to 2048px wide

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
  // wrapX=true wraps horizontally across ±180° for full-globe equirectangular references
  function nccAt(q, qStats, probes, ref, ox, oy, wrapX) {
    const rw = ref.w;
    let sr = 0, sr2 = 0, sqr = 0;
    for (let k = 0; k < probes.n; k++) {
      const ry = oy + probes.py[k];
      if (ry < 0 || ry >= ref.h) return -2;
      let rx = ox + probes.px[k];
      if (wrapX) {
        rx = ((rx % rw) + rw) % rw;
      } else if (rx < 0 || rx >= rw) {
        return -2;
      }
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

  // mask out white basin/track lines and vivid markers
  // so georeferencing locks onto coastlines/land
  function cleanAlignmentCanvas(workCanvas) {
    const w = workCanvas.width, h = workCanvas.height;
    const clean = document.createElement("canvas");
    clean.width = w;
    clean.height = h;
    const cctx = clean.getContext("2d", { willReadFrequently: true });
    cctx.drawImage(workCanvas, 0, 0);
    const imgData = cctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    const rawMask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < rawMask.length; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      const spread = mx - mn;
      const isWhiteLine = mn >= 195 && spread <= 35;
      const isVividMarker = mx >= 150 && (spread >= 95 || (b > r + 35 && g > 140));
      if (isWhiteLine || isVividMarker) rawMask[i] = 1;
    }

    // dilate by 2px so anti-aliased rims around lines/markers don't bleed into resizedGray
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!rawMask[y * w + x]) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx >= 0 && nx < w) mask[ny * w + nx] = 1;
          }
        }
      }
    }

    const out = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        for (let dist = 1; dist <= 25 && !cnt; dist += 2) {
          const dirs = [[dist, 0], [-dist, 0], [0, dist], [0, -dist]];
          for (let k = 0; k < 4; k++) {
            const nx = x + dirs[k][0], ny = y + dirs[k][1];
            if (nx >= 0 && nx < w && ny >= 0 && ny < h && !mask[ny * w + nx]) {
              const np = (ny * w + nx) * 4;
              sr += d[np]; sg += d[np + 1]; sb += d[np + 2];
              cnt++;
            }
          }
        }
        const p = (y * w + x) * 4;
        if (cnt > 0) {
          out[p] = Math.round(sr / cnt);
          out[p + 1] = Math.round(sg / cnt);
          out[p + 2] = Math.round(sb / cnt);
        } else {
          out[p] = 11; out[p + 1] = 10; out[p + 2] = 50;
        }
      }
    }

    imgData.data.set(out);
    cctx.putImageData(imgData, 0, 0);
    return clean;
  }

  // sample normalized (u, v) probe positions weighted toward land/coastline features
  // so small islands (e.g. Hawaii) pin the scale just as strongly as large landmasses
  function buildFeatureProbeUVs(canvas, points) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;

    // estimate dominant background color (ocean) via median of a coarse grid
    const rs = [], gs = [], bs = [];
    for (let iy = 0; iy < 9; iy++) {
      const y = Math.min(h - 1, Math.floor((iy + 0.5) * h / 9));
      for (let ix = 0; ix < 11; ix++) {
        const x = Math.min(w - 1, Math.floor((ix + 0.5) * w / 11));
        const p = (y * w + x) * 4;
        rs.push(d[p]); gs.push(d[p + 1]); bs.push(d[p + 2]);
      }
    }
    rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
    const mid = rs.length >> 1;
    const bgR = rs[mid], bgG = gs[mid], bgB = bs[mid];

    const gxN = 44, gyN = 30;
    const featUV = [], bgUV = [];

    for (let gy = 0; gy < gyN; gy++) {
      const y0 = Math.floor(gy * h / gyN);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * h / gyN));
      for (let gx = 0; gx < gxN; gx++) {
        const x0 = Math.floor(gx * w / gxN);
        const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * w / gxN));

        let bestDiff = -1, bestX = (x0 + x1) >> 1, bestY = (y0 + y1) >> 1;
        for (let sy = 0; sy < 4; sy++) {
          const py = Math.min(h - 1, y0 + Math.floor((sy + 0.5) * (y1 - y0) / 4));
          for (let sx = 0; sx < 4; sx++) {
            const px = Math.min(w - 1, x0 + Math.floor((sx + 0.5) * (x1 - x0) / 4));
            if (points && points.some((pt) => Math.hypot(px - pt.x, py - pt.y) <= pt.dim * 1.25)) continue;
            const p = (py * w + px) * 4;
            const diff = Math.abs(d[p] - bgR) + Math.abs(d[p + 1] - bgG) + Math.abs(d[p + 2] - bgB);
            if (diff > bestDiff) {
              bestDiff = diff;
              bestX = px;
              bestY = py;
            }
          }
        }

        if (bestDiff > 28) {
          featUV.push([bestX / w, bestY / h]);
        } else if ((gx + gy) % 3 === 0) {
          bgUV.push([((x0 + x1) * 0.5) / w, ((y0 + y1) * 0.5) / h]);
        }
      }
    }

    // fallback to uniform probes if feature set is too small
    if (featUV.length < 15) return null;
    return featUV.concat(bgUV);
  }

  function probesFromUVs(uvs, w, h) {
    if (!uvs) return makeProbes(w, h, 36, 26);
    const px = new Int32Array(uvs.length);
    const py = new Int32Array(uvs.length);
    for (let k = 0; k < uvs.length; k++) {
      px[k] = Math.min(w - 1, Math.max(0, Math.floor(uvs[k][0] * w)));
      py[k] = Math.min(h - 1, Math.max(0, Math.floor(uvs[k][1] * h)));
    }
    return { px, py, n: uvs.length };
  }

  // georeferencing (supports crops crossing ±180° antimeridian)
  function findCrop(workCanvas) {
    const alignCanvas = cleanAlignmentCanvas(workCanvas);
    const featUVs = buildFeatureProbeUVs(alignCanvas, null);
    const aspect = workCanvas.width / workCanvas.height;
    const ref = refCoarse;
    const maxW = Math.min(ref.w, ref.h * aspect);
    const scales = [];
    for (let w = 16; w <= maxW * 1.02; w *= 1.12) scales.push(Math.max(8, Math.round(w)));
    if (scales[scales.length - 1] !== Math.round(maxW)) scales.push(Math.round(maxW));

    const coarseByScale = [];

    // coarse pass: keep the best position per scale so tiny scales can't hide the true zoom
    for (const candidate of scales) {
      const w = Math.min(candidate, ref.w);
      const h = Math.max(8, Math.min(ref.h, Math.round(w / aspect)));
      const g = resizedGray(alignCanvas, w, h);
      const q = wrapGray(g, w, h);
      const probes = makeProbes(w, h, 20, 15);
      const stats = probeStats(q, probes);
      const step = w < 140 ? 2 : 4;

      let scaleBest = { score: -Infinity, x: 0, y: 0, w, h };
      for (let oy = 0; oy + h <= ref.h; oy += step) {
        for (let ox = 0; ox < ref.w; ox += step) {
          const score = nccAt(q, stats, probes, ref, ox, oy, true);
          if (score > scaleBest.score) {
            scaleBest = { score, x: ox, y: oy, w, h };
          }
        }
      }
      if (Number.isFinite(scaleBest.score)) coarseByScale.push(scaleBest);
    }

    coarseByScale.sort((a, b) => b.score - a.score);
    const topCoarse = coarseByScale.slice(0, 10);
    const bestLarge = coarseByScale.find((c) => c.w >= 36);
    if (bestLarge && !topCoarse.includes(bestLarge)) topCoarse.push(bestLarge);

    // verify top coarse scale candidates directly on refFine before full fine search
    const fine = refFine;
    const scaleFactor = fine.w / ref.w;
    let best = topCoarse[0] || { score: -Infinity, x: 0, y: 0, w: scales[0], h: Math.round(scales[0] / aspect) };
    let bestFineVerify = -Infinity;
    for (const c of topCoarse) {
      const fw = Math.max(16, Math.min(fine.w, Math.round(c.w * scaleFactor)));
      const fh = Math.max(16, Math.min(fine.h, Math.round(fw / aspect)));
      if (fh > fine.h) continue;
      const q = wrapGray(resizedGray(alignCanvas, fw, fh), fw, fh);
      const probes = probesFromUVs(featUVs, fw, fh);
      const stats = probeStats(q, probes);
      const cx = Math.round(c.x * scaleFactor), cy = Math.round(c.y * scaleFactor);
      for (let oy = Math.max(0, cy - 16); oy <= Math.min(fine.h - fh, cy + 16); oy += 4) {
        for (let ox = cx - 16; ox <= cx + 16; ox += 4) {
          const score = nccAt(q, stats, probes, fine, ox, oy, true);
          if (score > bestFineVerify) {
            bestFineVerify = score;
            best = { score, x: ox / scaleFactor, y: oy / scaleFactor, w: c.w, h: c.h };
          }
        }
      }
    }

    // fine pass on the full resolution reference, around the verified coarse result
    const baseX = best.x * scaleFactor;
    const baseY = best.y * scaleFactor;
    const baseW = best.w * scaleFactor;
    const fineBest = { score: -Infinity, x: baseX, y: baseY, w: baseW, h: best.h * scaleFactor };

    const radius = Math.max(60, Math.round(baseW * 0.14));
    const factors = [0.88, 0.92, 0.96, 1, 1.04, 1.08, 1.12];
    for (const factor of factors) {
      const w = Math.max(16, Math.min(fine.w, Math.round(baseW * factor)));
      const h = Math.max(16, Math.min(fine.h, Math.round(w / aspect)));
      if (w > fine.w || h > fine.h) continue;
      const g = resizedGray(alignCanvas, w, h);
      const q = wrapGray(g, w, h);
      const probes = probesFromUVs(featUVs, w, h);
      const stats = probeStats(q, probes);

      for (let oy = Math.max(0, Math.round(baseY - radius)); oy <= Math.min(fine.h - h, Math.round(baseY + radius)); oy += 8) {
        for (let ox = Math.round(baseX - radius); ox <= Math.round(baseX + radius); ox += 8) {
          const score = nccAt(q, stats, probes, fine, ox, oy, true);
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
    for (const factor of [0.97, 0.98, 0.99, 1, 1.01, 1.02, 1.03]) {
      const w = Math.max(16, Math.min(fine.w, Math.round(refineBaseW * factor)));
      const h = Math.max(16, Math.min(fine.h, Math.round(w / aspect)));
      if (h > fine.h) continue;
      const g = resizedGray(alignCanvas, w, h);
      const q = wrapGray(g, w, h);
      const probes = probesFromUVs(featUVs, w, h);
      const stats = probeStats(q, probes);
      for (let oy = Math.max(0, refineBaseY - 12); oy <= Math.min(fine.h - h, refineBaseY + 12); oy++) {
        for (let ox = refineBaseX - 12; ox <= refineBaseX + 12; ox++) {
          const score = nccAt(q, stats, probes, fine, ox, oy, true);
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

    fineBest.x = ((fineBest.x % fine.w) + fine.w) % fine.w;
    return { ...fineBest, confidence: fineBest.score };
  }

  function sampleCropBackground(crop, width, height) {
    if (!refImage || crop.confidence < 0.3 || crop.w <= 0 || crop.h <= 0) return null;
    try {
      const natW = refImage.naturalWidth;
      const natH = refImage.naturalHeight;
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = width;
      bgCanvas.height = height;
      const bgCtx = bgCanvas.getContext("2d", { willReadFrequently: true });
      let sx = ((crop.x / refFine.w) * natW) % natW;
      if (sx < 0) sx += natW;
      const sy = (crop.y / refFine.h) * natH;
      const sw = (crop.w / refFine.w) * natW;
      const sh = (crop.h / refFine.h) * natH;

      if (sx + sw <= natW) {
        bgCtx.drawImage(refImage, sx, sy, sw, sh, 0, 0, width, height);
      } else {
        const sw1 = natW - sx;
        const sw2 = Math.min(natW, sw - sw1);
        const dw1 = width * (sw1 / sw);
        bgCtx.drawImage(refImage, sx, sy, sw1, sh, 0, 0, dw1, height);
        bgCtx.drawImage(refImage, 0, sy, sw2, sh, dw1, 0, width - dw1, height);
      }
      return bgCtx.getImageData(0, 0, width, height).data;
    } catch (err) {
      return null;
    }
  }

  // refine alignment at up to full 8k resolution (wrapping across ±180°)
  function refineCrop8k(workCanvas, crop, points) {
    if (!refImage || !refImage.naturalWidth || crop.confidence < 0.25) return crop;

    const alignCanvas = cleanAlignmentCanvas(workCanvas);
    const featUVs = buildFeatureProbeUVs(alignCanvas, points);
    const natW = refImage.naturalWidth;
    const natH = refImage.naturalHeight;
    const scaleX8k = natW / refFine.w;
    const scaleY8k = natH / refFine.h;
    const pad = 56;
    const rx0 = Math.floor(crop.x * scaleX8k) - pad;
    const rx1 = Math.ceil((crop.x + crop.w) * scaleX8k) + pad;
    const ry0 = Math.max(0, Math.floor(crop.y * scaleY8k) - pad);
    const ry1 = Math.min(natH, Math.ceil((crop.y + crop.h) * scaleY8k) + pad);
    const srcW = rx1 - rx0, srcH = ry1 - ry0;
    if (srcW < 32 || srcH < 32 || srcW > natW) return crop;

    // keep full 8k resolution on regional crops; cap only on near-global views
    const patchScale = Math.min(1, 2400 / Math.max(srcW, srcH));
    const rw = Math.round(srcW * patchScale);
    const rh = Math.round(srcH * patchScale);

    const rc = document.createElement("canvas");
    rc.width = rw;
    rc.height = rh;
    const rctx = rc.getContext("2d", { willReadFrequently: true });

    let curSrcX = rx0;
    let curDstX = 0;
    let remW = srcW;
    while (remW > 0) {
      const modX = ((curSrcX % natW) + natW) % natW;
      const take = Math.min(remW, natW - modX);
      const dstTake = (take / srcW) * rw;
      rctx.drawImage(refImage, modX, ry0, take, srcH, curDstX, 0, dstTake, rh);
      curSrcX += take;
      curDstX += dstTake;
      remW -= take;
    }

    const rGray = grayFromImageData(rctx.getImageData(0, 0, rw, rh).data, rw, rh);
    blurGray(rGray, rw, rh);
    const refPatch = { w: rw, h: rh, gray: rGray };

    // Identify bright white pixels (track lines, grid lines) in workCanvas so probes avoid them
    const wCtx = workCanvas.getContext("2d", { willReadFrequently: true });
    const wData = wCtx.getImageData(0, 0, workCanvas.width, workCanvas.height).data;
    const ww = workCanvas.width, wh = workCanvas.height;

    const aspect = ww / wh;
    const baseW = crop.w * scaleX8k * patchScale;
    const baseOx = (crop.x * scaleX8k - rx0) * patchScale;
    const baseOy = (crop.y * scaleY8k - ry0) * patchScale;

    const filterProbes = (w, h, raw) => {
      const px = [], py = [];
      for (let k = 0; k < raw.n; k++) {
        const wx = Math.min(ww - 1, Math.max(0, Math.round((raw.px[k] / w) * ww)));
        const wy = Math.min(wh - 1, Math.max(0, Math.round((raw.py[k] / h) * wh)));
        const wp = (wy * ww + wx) * 4;
        const mn = Math.min(wData[wp], wData[wp + 1], wData[wp + 2]);
        const mx = Math.max(wData[wp], wData[wp + 1], wData[wp + 2]);
        if (mn >= 195 && mx - mn <= 35) continue; // skip bright white lines / gridlines
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

    let best = { score: -Infinity, ox: baseOx, oy: baseOy, w: Math.round(baseW), h: Math.round(baseW / aspect), factor: 1, q: null, stats: null, probes: null };
    const searchRad = Math.max(20, Math.round(44 * patchScale));

    for (const factor of [0.96, 0.97, 0.98, 0.99, 1, 1.01, 1.02, 1.03, 1.04]) {
      const w = Math.max(16, Math.min(rw, Math.round(baseW * factor)));
      const h = Math.max(16, Math.min(rh, Math.round(w / aspect)));
      if (h > rh) continue;
      const q = wrapGray(resizedGray(alignCanvas, w, h), w, h);
      const probes = filterProbes(w, h, probesFromUVs(featUVs, w, h));
      const stats = probeStats(q, probes);

      for (let oy = Math.max(0, Math.round(baseOy - searchRad)); oy <= Math.min(rh - h, Math.round(baseOy + searchRad)); oy += 2) {
        for (let ox = Math.max(0, Math.round(baseOx - searchRad)); ox <= Math.min(rw - w, Math.round(baseOx + searchRad)); ox += 2) {
          const score = nccAt(q, stats, probes, refPatch, ox, oy, false);
          if (score > best.score) best = { score, ox, oy, w, h, factor, q, stats, probes };
        }
      }
    }

    if (!best.q) return crop;

    // Micro-scale polish around winning factor
    const winFactor = best.factor;
    const winOx = best.ox, winOy = best.oy;
    for (const df of [-0.005, -0.0025, 0.0025, 0.005]) {
      const f = winFactor + df;
      const w = Math.max(16, Math.min(rw, Math.round(baseW * f)));
      const h = Math.max(16, Math.min(rh, Math.round(w / aspect)));
      if (h > rh) continue;
      const q = wrapGray(resizedGray(alignCanvas, w, h), w, h);
      const probes = filterProbes(w, h, probesFromUVs(featUVs, w, h));
      const stats = probeStats(q, probes);
      for (let oy = Math.max(0, winOy - 3); oy <= Math.min(rh - h, winOy + 3); oy++) {
        for (let ox = Math.max(0, winOx - 3); ox <= Math.min(rw - w, winOx + 3); ox++) {
          const score = nccAt(q, stats, probes, refPatch, ox, oy, false);
          if (score > best.score) best = { score, ox, oy, w, h, factor: f, q, stats, probes };
        }
      }
    }

    // 1-px pass + parabolic sub-pixel peak around the winning position
    const cx0 = best.ox, cy0 = best.oy;
    for (let oy = Math.max(0, cy0 - 3); oy <= Math.min(rh - best.h, cy0 + 3); oy++) {
      for (let ox = Math.max(0, cx0 - 3); ox <= Math.min(rw - best.w, cx0 + 3); ox++) {
        const score = nccAt(best.q, best.stats, best.probes, refPatch, ox, oy, false);
        if (score > best.score) { best.score = score; best.ox = ox; best.oy = oy; }
      }
    }

    let dx = 0, dy = 0;
    if (best.ox > 0 && best.ox + best.w < rw) {
      const sL = nccAt(best.q, best.stats, best.probes, refPatch, best.ox - 1, best.oy, false);
      const sR = nccAt(best.q, best.stats, best.probes, refPatch, best.ox + 1, best.oy, false);
      const denom = sL + sR - 2 * best.score;
      if (denom < -1e-7) dx = Math.max(-0.5, Math.min(0.5, 0.5 * (sL - sR) / denom));
    }
    if (best.oy > 0 && best.oy + best.h < rh) {
      const sU = nccAt(best.q, best.stats, best.probes, refPatch, best.ox, best.oy - 1, false);
      const sD = nccAt(best.q, best.stats, best.probes, refPatch, best.ox, best.oy + 1, false);
      const denom = sU + sD - 2 * best.score;
      if (denom < -1e-7) dy = Math.max(-0.5, Math.min(0.5, 0.5 * (sU - sD) / denom));
    }

    let finalX = (rx0 + (best.ox + dx) / patchScale) / scaleX8k;
    finalX = ((finalX % refFine.w) + refFine.w) % refFine.w;

    return {
      ...crop,
      x: finalX,
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
    const sizeWindows = [[0.42, 1.4], [0.28, 1.85], [0.18, 2.5]];
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
        const hiD = Math.ceil(Math.max(loD + 5, loD * 1.95));
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

    // median ring contrast tolerates 2-3 neighboring dots in tight loops/chains
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
      return rdists[rdists.length >> 1];
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
          dist: dist,
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
      if (picked.length >= 2000) break;
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

    // flood-fill each seed using its own colour, falling back to Voronoi-bounded
    // segmentation when touching dots of the same colour merge together
    const rawPoints = [];
    const half = Math.max(6, Math.round(r * 2.6));
    const colourTolerance2 = 38 * 38;
    const maxRad = Math.max(3.5, r * 1.25);
    const maxRad2 = maxRad * maxRad;
    const neighborSearch2 = Math.pow(r * 3.2, 2);
    const bgRad = Math.max(6, Math.round(r));
    const bgStep = Math.max(1, Math.round(bgRad / 4));

    const runFlood = (c, bounded, sameNeighbors) => {
      const x0 = Math.max(0, c.x - half), x1 = Math.min(w - 1, c.x + half);
      const y0 = Math.max(0, c.y - half), y1 = Math.min(h - 1, c.y + half);
      const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
      if (rw < 3 || rh < 3) return null;

      const visited = new Uint8Array(rw * rh);
      const stack = new Int32Array(rw * rh);
      let sp = 0;
      const start = (c.y - y0) * rw + (c.x - x0);
      visited[start] = 1;
      stack[sp++] = start;

      const pixLX = [], pixLY = [], pixR = [], pixG = [], pixB = [];
      let count = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0;
      let minX = rw, maxX = 0, minY = rh, maxY = 0;
      let hitsBorder = 0;

      while (sp > 0) {
        const idx = stack[--sp];
        const lx = idx % rw, ly = (idx / rw) | 0;
        const gx = x0 + lx, gy = y0 + ly;

        if (bounded) {
          const dxSelf = gx - c.x, dySelf = gy - c.y;
          const dSelf2 = dxSelf * dxSelf + dySelf * dySelf;
          if (dSelf2 > maxRad2) continue;
          let closerOther = false;
          for (let q = 0; q < sameNeighbors.length; q++) {
            const nq = sameNeighbors[q];
            const dxO = gx - nq.x, dyO = gy - nq.y;
            if (dxO * dxO + dyO * dyO < dSelf2) {
              closerOther = true;
              break;
            }
          }
          if (closerOther) continue;
        }

        const p = (gy * w + gx) * 4;
        const pr = d[p], pg = d[p + 1], pb = d[p + 2];
        const dr = pr - c.r, dg = pg - c.g, db = pb - c.b;
        if (dr * dr + dg * dg + db * db > colourTolerance2) continue;

        // prevent pale coloured dots from leaking onto neutral white track lines
        const pSpread = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
        if (c.spread >= 28 && pSpread < 12) continue;

        pixLX.push(lx);
        pixLY.push(ly);
        pixR.push(pr);
        pixG.push(pg);
        pixB.push(pb);
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

      if (count === 0) return null;
      const boxW = maxX - minX + 1, boxH = maxY - minY + 1;
      return {
        x0, y0, rw, rh, pixLX, pixLY, pixR, pixG, pixB,
        count, sx, sy, sr, sg, sb,
        minX, maxX, minY, maxY, boxW, boxH,
        maxDim: Math.max(boxW, boxH),
        fill: count / (boxW * boxH),
        aspect: boxW / boxH,
        hitsBorder
      };
    };

    for (let idxC = 0; idxC < picked.length; idxC++) {
      const c = picked[idxC];
      let res = runFlood(c, false, null);
      if (!res || res.count < 7) continue;

      let usedBounded = false;
      const isCompact =
        res.hitsBorder <= Math.max(3, res.count * 0.08) &&
        res.maxDim <= Math.max(6, r * 2.7) &&
        res.fill >= 0.44 && res.fill <= 1.02 &&
        res.aspect >= 0.65 && res.aspect <= 1.6;

      if (!isCompact) {
        if (c.stdIn > (c.dist < 25 ? 12.5 : 8.5)) continue;
        const sameNeighbors = [];
        for (let j = 0; j < picked.length; j++) {
          if (j === idxC) continue;
          const q = picked[j];
          const dx = q.x - c.x, dy = q.y - c.y;
          if (dx * dx + dy * dy > neighborSearch2) continue;
          const cd2 = (q.r - c.r) * (q.r - c.r) + (q.g - c.g) * (q.g - c.g) + (q.b - c.b) * (q.b - c.b);
          if (cd2 < 55 * 55 && (q.stdIn <= 10 || q.score <= c.score + 10)) {
            sameNeighbors.push(q);
          }
        }
        res = runFlood(c, true, sameNeighbors);
        if (!res || res.count < 7) continue;
        if (res.fill < 0.44 || res.aspect < 0.55 || res.aspect > 1.85) continue;
        usedBounded = true;
      }

      const {
        x0, y0, rw, pixLX, pixLY, pixR, pixG, pixB,
        count, sx, sy, sr, sg, sb,
        minX, maxX, minY, maxY, maxDim, fill
      } = res;

      const mr = sr / count, mg = sg / count, mb = sb / count;

      // verify immediate exterior contrast just outside the bounding box (median tolerates chain neighbors)
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
      const borderContrast = bDists[bDists.length >> 1];
      if (borderContrast < 42) continue;

      const cx = sx / count, cy = sy / count;

      // reject textured terrain patches (e.g. desert/coastlines) that lack a flat marker core
      let coreCnt = 0;
      const coreCheckTol2 = 18 * 18;
      for (let i = 0; i < count; i++) {
        const dr = pixR[i] - mr, dg = pixG[i] - mg, db = pixB[i] - mb;
        if (dr * dr + dg * dg + db * db <= coreCheckTol2) coreCnt++;
      }
      const coreFrac = coreCnt / count;

      const ixC = Math.min(w - 1, Math.max(0, Math.round(cx)));
      const iyC = Math.min(h - 1, Math.max(0, Math.round(cy)));
      let csR = 0, csG = 0, csB = 0, csR2 = 0, csG2 = 0, csB2 = 0, csN = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = iyC + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = ixC + dx;
          if (nx < 0 || nx >= w) continue;
          const p = (ny * w + nx) * 4;
          const pr = d[p], pg = d[p + 1], pb = d[p + 2];
          csR += pr; csG += pg; csB += pb;
          csR2 += pr * pr; csG2 += pg * pg; csB2 += pb * pb;
          csN++;
        }
      }
      const cenStd = csN ? Math.sqrt(Math.max(0,
        (csR2 - csR * csR / csN) + (csG2 - csG * csG / csN) + (csB2 - csB * csB / csN)
      ) / (3 * csN)) : 0;

      const maxCenStd = r < 3.5 ? 14 : 8.5;
      if (cenStd > maxCenStd || coreFrac < 0.62) continue;
      if (borderContrast < 120 && (cenStd > 5.0 || coreFrac < 0.72)) continue;

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
        if (minBgDist < 42 && cenStd > 2.0 && borderContrast < 180) continue;
      }

      // use crisp core pixels (<= 26 RGB dist from marker mean) to classify triangle vs circle vs square
      const coreTol2 = 26 * 26;
      const coreIdx = [];
      for (let i = 0; i < count; i++) {
        const dr = pixR[i] - mr, dg = pixG[i] - mg, db = pixB[i] - mb;
        if (dr * dr + dg * dg + db * db <= coreTol2) coreIdx.push(i);
      }
      const useCore = coreIdx.length >= 6;
      const sCount = useCore ? coreIdx.length : count;
      let sMinX = rw, sMaxX = 0, sMinY = rw + h, sMaxY = 0;
      for (let k = 0; k < sCount; k++) {
        const i = useCore ? coreIdx[k] : k;
        const lx = pixLX[i], ly = pixLY[i];
        if (lx < sMinX) sMinX = lx;
        if (lx > sMaxX) sMaxX = lx;
        if (ly < sMinY) sMinY = ly;
        if (ly > sMaxY) sMaxY = ly;
      }
      const sBoxW = sMaxX - sMinX + 1, sBoxH = sMaxY - sMinY + 1;
      const sFill = sCount / (sBoxW * sBoxH);
      const sMaxDim = Math.max(sBoxW, sBoxH);

      const topCut = sMinY + sBoxH / 3;
      const botCut = sMaxY - sBoxH / 3;
      let topMin = rw, topMax = -1, botMin = rw, botMax = -1;
      for (let k = 0; k < sCount; k++) {
        const i = useCore ? coreIdx[k] : k;
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
      const isTriangle = !usedBounded && (
        (sFill < 0.66 && botW > topW * 1.25) ||
        (sFill < 0.78 && botW > topW * 1.55)
      );
      const isSquare = !usedBounded && !isTriangle && (
        sFill >= 0.93 || (sMaxDim >= 8 && sFill >= 0.91)
      );

      let stage;
      if (isTriangle) stage = "Extratropical cyclone";
      else if (isSquare) stage = "Subtropical cyclone";
      else stage = "Tropical cyclone";

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
        usedBounded: usedBounded,
        occluded: false,
        contrast: borderContrast,
        minBgDist: minBgDist,
        cenStd: cenStd,
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
        const minSep = cd2 < 45 * 45
          ? Math.min(r * 1.05, 0.52 * Math.max(q.dim, p.dim))
          : 0.35 * Math.min(q.dim, p.dim);
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
    const validShape = points.filter((p) =>
      !(p.fill < 0.62 && !p.isTriangle && !p.occluded && !p.usedBounded && (p.distance >= 22 || p.fill < 0.48))
    );
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
            p.domDist <= 34 ||
            (p.domDist <= 48 && p.contrast >= 130) ||
            (p.cenStd <= 2.5 && p.contrast >= 140 && p.domDist <= 85)
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
        const suspect = p.stdIn > 3.5 || p.cenStd > 2.5 || p.dim < medDim * 0.85 || p.contrast < 150 || p.minBgDist < 38;
        return !suspect;
      });
      if (kept.length >= 3) cluster = kept;
    }

    return cluster;
  }

  // reconstruct track sequence using connector-line evidence, crossing-aware skip checks,
  // colour continuity, degree-<=2 path merging, and local 2-opt polish
  function orderPoints(points, imageData) {
    const n = points.length;
    if (n < 3) return points.slice();

    const w = imageData ? imageData.width : 0;
    const h = imageData ? imageData.height : 0;
    const d = imageData ? imageData.data : null;

    const segLineScore = (a, b) => {
      const pa = points[a], pb = points[b];
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return { lf: 1, gap: 0 };
      const ra = Math.max(3.5, pa.dim * 0.65);
      const rb = Math.max(3.5, pb.dim * 0.65);
      const gap = dist - ra - rb;
      if (gap <= 2.0 || !d) return { lf: 1, gap };

      const ux = dx / dist, uy = dy / dist;
      const px = -uy, py = ux;
      const nSteps = Math.max(3, Math.floor(gap));
      let hits = 0;
      const offs = [-1.5, -0.75, 0, 0.75, 1.5];
      for (let k = 0; k <= nSteps; k++) {
        const t = ra + (k / nSteps) * gap;
        const sx = pa.x + ux * t;
        const sy = pa.y + uy * t;
        let hit = false;
        for (let oi = 0; oi < offs.length; oi++) {
          const ix = Math.round(sx + px * offs[oi]);
          const iy = Math.round(sy + py * offs[oi]);
          if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
            const idx = (iy * w + ix) * 4;
            const R = d[idx], G = d[idx + 1], B = d[idx + 2];
            const mn = Math.min(R, G, B), mx = Math.max(R, G, B);
            const lum = 0.299 * R + 0.587 * G + 0.114 * B;
            if (lum >= 145 && mx - mn <= 40) {
              hit = true;
              break;
            }
          }
        }
        if (hit) hits++;
      }
      return { lf: hits / (nSteps + 1), gap };
    };

    // pairwise distances
    const distMat = new Float64Array(n * n);
    const nn1 = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        distMat[i * n + j] = dist;
        distMat[j * n + i] = dist;
        if (dist < nn1[i]) nn1[i] = dist;
        if (dist < nn1[j]) nn1[j] = dist;
      }
    }
    const nnSorted = Array.from(nn1).sort((a, b) => a - b);
    const medNN = nnSorted[n >> 1] || 10;

    // build EMST first to detect whether the image renders white track connector lines
    const inTree = new Uint8Array(n);
    const minDist = new Float64Array(n).fill(Infinity);
    const par = new Int32Array(n).fill(-1);
    minDist[0] = 0;
    const emstLines = [];
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      for (let i = 0; i < n; i++) {
        if (!inTree[i] && (u === -1 || minDist[i] < minDist[u])) u = i;
      }
      inTree[u] = 1;
      if (par[u] !== -1 && d) {
        const info = segLineScore(u, par[u]);
        if (info.gap > 3.0) emstLines.push(info.lf);
      }
      for (let v = 0; v < n; v++) {
        if (!inTree[v]) {
          const dist = distMat[u * n + v];
          if (dist < minDist[v]) {
            minDist[v] = dist;
            par[v] = u;
          }
        }
      }
    }
    emstLines.sort((a, b) => a - b);
    const hasWhiteLines = emstLines.length >= 3 && emstLines[emstLines.length >> 1] >= 0.55;

    const edgeCache = new Map();
    const evalEdge = (u, v) => {
      const a = u < v ? u : v;
      const b = u < v ? v : u;
      const key = a * n + b;
      let cached = edgeCache.get(key);
      if (cached) return cached;

      const dist = distMat[key];
      const { lf, gap } = segLineScore(a, b);

      let skipsSameStrand = false;
      let crossesOtherStrand = false;
      const maxEndpointDim = Math.max(points[a].dim, points[b].dim);
      if (dist > maxEndpointDim * 1.2) {
        const abx = points[b].x - points[a].x;
        const aby = points[b].y - points[a].y;
        const ab2 = abx * abx + aby * aby;
        if (ab2 > 1e-6) {
          for (let m = 0; m < n; m++) {
            if (m === a || m === b) continue;
            const t = ((points[m].x - points[a].x) * abx + (points[m].y - points[a].y) * aby) / ab2;
            if (t > 0.15 && t < 0.85) {
              const px = points[a].x + t * abx;
              const py = points[a].y + t * aby;
              const pdist = Math.hypot(points[m].x - px, points[m].y - py);
              if (pdist < Math.max(2.5, 0.45 * points[m].dim)) {
                const cdAB = Math.hypot(points[a].mr - points[b].mr, points[a].mg - points[b].mg, points[a].mb - points[b].mb);
                const cdAM = Math.hypot(points[a].mr - points[m].mr, points[a].mg - points[m].mg, points[a].mb - points[m].mb);
                const cdBM = Math.hypot(points[b].mr - points[m].mr, points[b].mg - points[m].mg, points[b].mb - points[m].mb);
                if (cdAB < 65 && Math.min(cdAM, cdBM) > 110) {
                  crossesOtherStrand = true;
                } else {
                  skipsSameStrand = true;
                  break;
                }
              }
            }
          }
        }
      }

      const cdist = Math.hypot(
        points[a].mr - points[b].mr,
        points[a].mg - points[b].mg,
        points[a].mb - points[b].mb
      );

      let mult = 1.0;
      if (gap > 2.5 && d) {
        if (lf >= 0.65) mult *= 0.35;
        else if (lf >= 0.40) mult *= 0.75;
        else if (hasWhiteLines) mult *= 5.0;
      }
      if (skipsSameStrand) {
        mult *= (gap > 2.5 && lf >= 0.65) ? 2.0 : 5.5;
      } else if (crossesOtherStrand) {
        mult *= 1.3;
      }
      mult *= 1.0 + 0.5 * Math.min(1.0, cdist / 120.0);

      cached = { cost: dist * mult, lf, gap };
      edgeCache.set(key, cached);
      return cached;
    };

    // evaluate k-nearest candidate edges
    const kNbrs = Math.min(n - 1, 15);
    const seenPairs = new Set();
    const candEdges = [];
    const indices = Array.from({ length: n }, (_, idx) => idx);

    for (let i = 0; i < n; i++) {
      const rowOff = i * n;
      indices.sort((a, b) => distMat[rowOff + a] - distMat[rowOff + b]);
      for (let ki = 1; ki <= kNbrs; ki++) {
        const j = indices[ki];
        const a = i < j ? i : j;
        const b = i < j ? j : i;
        const key = a * n + b;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        candEdges.push({ cost: evalEdge(a, b).cost, a, b });
      }
    }

    candEdges.sort((u, v) => u.cost - v.cost);

    // Union-Find + degree <= 2 greedy path building
    const ufParent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (x) => {
      while (ufParent[x] !== x) {
        ufParent[x] = ufParent[ufParent[x]];
        x = ufParent[x];
      }
      return x;
    };

    const deg = new Uint8Array(n);
    const adj = Array.from({ length: n }, () => []);
    let edgesUsed = 0;

    for (let i = 0; i < candEdges.length; i++) {
      const { a, b } = candEdges[i];
      if (deg[a] >= 2 || deg[b] >= 2) continue;
      const ra = find(a), rb = find(b);
      if (ra === rb) continue;
      ufParent[ra] = rb;
      deg[a]++;
      deg[b]++;
      adj[a].push(b);
      adj[b].push(a);
      edgesUsed++;
      if (edgesUsed === n - 1) break;
    }

    // connect any remaining disconnected chain fragments via closest degree-<2 endpoints
    while (edgesUsed < n - 1) {
      const ends = [];
      for (let i = 0; i < n; i++) {
        if (deg[i] < 2) ends.push(i);
      }
      let bestD = Infinity, bestU = -1, bestV = -1;
      for (let i = 0; i < ends.length; i++) {
        const u = ends[i];
        const ru = find(u);
        for (let j = i + 1; j < ends.length; j++) {
          const v = ends[j];
          if (ru !== find(v)) {
            const dist = distMat[u * n + v];
            if (dist < bestD) {
              bestD = dist;
              bestU = u;
              bestV = v;
            }
          }
        }
      }
      if (bestU === -1) break;
      ufParent[find(bestU)] = find(bestV);
      deg[bestU]++;
      deg[bestV]++;
      adj[bestU].push(bestV);
      adj[bestV].push(bestU);
      edgesUsed++;
    }

    let start = 0;
    for (let i = 0; i < n; i++) {
      if (deg[i] === 1) {
        start = i;
        break;
      }
    }

    const path = [];
    let prev = -1;
    let curr = start;
    while (curr !== -1) {
      path.push(curr);
      const nbrs = adj[curr];
      const next = nbrs[0] !== prev ? nbrs[0] : (nbrs.length > 1 ? nbrs[1] : -1);
      prev = curr;
      curr = next !== undefined ? next : -1;
    }

    // local 2-opt polish: untangle tight cluster fold-backs without breaking strong white-line edges
    const turnPenalty = (idxA, idxB, idxC) => {
      if (idxA < 0 || idxC < 0) return 0;
      const a = points[idxA], b = points[idxB], c = points[idxC];
      const v1x = b.x - a.x, v1y = b.y - a.y;
      const v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-6 || l2 < 1e-6) return 0;
      const cosA = (v1x * v2x + v1y * v2y) / (l1 * l2);
      return cosA < -0.35 ? 10.0 * (-cosA - 0.35) : 0;
    };

    const maxLocalDist = medNN * 6.0;
    let improved = true;
    for (let pass = 0; pass < 6 && improved; pass++) {
      improved = false;
      for (let i = 0; i < path.length - 3; i++) {
        const a = path[i], b = path[i + 1];
        const eAB = evalEdge(a, b);
        const strongAB = d && eAB.gap > 2.5 && eAB.lf >= 0.75;
        for (let j = i + 2; j < path.length - 1; j++) {
          const c = path[j], dNode = path[j + 1];
          if (distMat[a * n + c] > maxLocalDist && distMat[b * n + dNode] > maxLocalDist) continue;
          const eCD = evalEdge(c, dNode);
          const strongCD = d && eCD.gap > 2.5 && eCD.lf >= 0.75;
          const eAC = evalEdge(a, c);
          const eBD = evalEdge(b, dNode);
          if (strongAB && !(d && eAC.gap > 2.5 && eAC.lf >= 0.75)) continue;
          if (strongCD && !(d && eBD.gap > 2.5 && eBD.lf >= 0.75)) continue;

          const before = eAB.cost + eCD.cost +
            turnPenalty(i > 0 ? path[i - 1] : -1, a, b) +
            turnPenalty(a, b, path[i + 2]) +
            turnPenalty(path[j - 1], c, dNode) +
            turnPenalty(c, dNode, j + 2 < path.length ? path[j + 2] : -1);

          const after = eAC.cost + eBD.cost +
            turnPenalty(i > 0 ? path[i - 1] : -1, a, c) +
            turnPenalty(a, c, path[j - 1]) +
            turnPenalty(path[i + 2], b, dNode) +
            turnPenalty(b, dNode, j + 2 < path.length ? path[j + 2] : -1);

          if (after + 0.5 < before) {
            for (let l = i + 1, rIdx = j; l < rIdx; l++, rIdx--) {
              const tmp = path[l];
              path[l] = path[rIdx];
              path[rIdx] = tmp;
            }
            improved = true;
            break;
          }
        }
      }
    }

    return path.map((idx) => points[idx]);
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
      const ordered = orderPoints(points, imageData);

      // orient track from tropical/lower-latitude origin toward higher-latitude/extratropical end
      if (ordered.length >= 2) {
        const ll0 = cropToLatLon(crop, ordered[0].x, ordered[0].y, workCanvas.width, workCanvas.height);
        const ll1 = cropToLatLon(crop, ordered[ordered.length - 1].x, ordered[ordered.length - 1].y, workCanvas.width, workCanvas.height);
        const startIsTri = ordered[0].stage === "Extratropical cyclone";
        const endIsTri = ordered[ordered.length - 1].stage === "Extratropical cyclone";
        if ((startIsTri && !endIsTri) || (startIsTri === endIsTri && Math.abs(ll0.lat) > Math.abs(ll1.lat) + 5)) {
          ordered.reverse();
        }
      }

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
