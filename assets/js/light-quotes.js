(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LightQuotes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EXPORT_WIDTH = 1080;
  const EXPORT_HEIGHT = 1920;
  const MIN_EXPORT_BYTES = 1250000;
  const READABLE_CONTRAST_RATIO = 4.5;
  const CONTRAST_COVERAGE_TIE = 0.03;
  const DARK_TEXT_LUMINANCE = 0.2126 * channelLuminance(32)
    + 0.7152 * channelLuminance(36)
    + 0.0722 * channelLuminance(42);
  const READY_IMAGE_QUEUE_LIMIT = 2;

  function randomItem(items, random = Math.random) {
    return items.length ? items[Math.floor(random() * items.length)] : null;
  }

  function matchingImages(quote, images) {
    const quoteTags = new Set(Array.isArray(quote?.visual_tags) ? quote.visual_tags : []);
    const usable = (Array.isArray(images) ? images : []).filter(image => image?.status === "可用");
    const scored = usable.map(image => ({
      image,
      overlap: (image.visual_tags || []).filter(tag => quoteTags.has(tag)).length
    }));
    const strong = scored.filter(item => item.overlap >= 2).map(item => item.image);
    if (strong.length) return strong;
    const weak = scored.filter(item => item.overlap === 1).map(item => item.image);
    if (weak.length) return weak;
    const quietSoft = usable.filter(image =>
      image.visual_tags?.includes("quiet") && image.visual_tags?.includes("soft")
    );
    if (quietSoft.length) return quietSoft;
    const quietOrSoft = usable.filter(image =>
      image.visual_tags?.includes("quiet") || image.visual_tags?.includes("soft")
    );
    return quietOrSoft.length ? quietOrSoft : usable;
  }

  function normalizeMatchingMode(value) {
    return value === "visual_tags" ? "visual_tags" : "random";
  }

  function candidateImages(quote, images, matchingMode) {
    const usable = (Array.isArray(images) ? images : []).filter(image => image?.status === "可用");
    return normalizeMatchingMode(matchingMode) === "visual_tags"
      ? matchingImages(quote, usable)
      : usable;
  }

  function chooseImage(quote, images, random = Math.random, options = {}) {
    const candidates = candidateImages(quote, images, options.matchingMode);
    const currentImage = options.currentImage;
    const excludedUrls = new Set(Array.isArray(options.excludedUrls) ? options.excludedUrls : []);
    if (currentImage?.url) excludedUrls.add(currentImage.url);
    let alternatives = candidates.filter(image => !excludedUrls.has(image.url));
    if (!alternatives.length && currentImage && candidates.length > 1) {
      alternatives = candidates.filter(image => image.url !== currentImage.url);
    }
    return randomItem(alternatives.length ? alternatives : candidates, random);
  }

  function channelLuminance(value) {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }

  function pixelLuminances(pixelData) {
    if (!pixelData?.length) return [];
    const luminances = [];
    for (let index = 0; index + 3 < pixelData.length; index += 4) {
      if (pixelData[index + 3] === 0) continue;
      luminances.push(0.2126 * channelLuminance(pixelData[index])
        + 0.7152 * channelLuminance(pixelData[index + 1])
        + 0.0722 * channelLuminance(pixelData[index + 2]));
    }
    return luminances;
  }

  function percentile(sortedValues, ratio) {
    if (!sortedValues.length) return 0;
    const position = (sortedValues.length - 1) * ratio;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const weight = position - lowerIndex;
    return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
  }

  function luminanceStats(pixelData) {
    const luminances = pixelLuminances(pixelData);
    if (!luminances.length) return null;
    luminances.sort((left, right) => left - right);
    return {
      mean: luminances.reduce((sum, value) => sum + value, 0) / luminances.length,
      lower: percentile(luminances, 0.2),
      upper: percentile(luminances, 0.8)
    };
  }

  function contrastRatio(firstLuminance, secondLuminance) {
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function contrastMetrics(luminances, textLuminance) {
    if (!luminances.length) return null;
    const ratios = luminances
      .map(backgroundLuminance => contrastRatio(backgroundLuminance, textLuminance))
      .sort((left, right) => left - right);
    return {
      coverage: ratios.filter(ratio => ratio >= READABLE_CONTRAST_RATIO).length / ratios.length,
      lowerQuartile: percentile(ratios, 0.25),
      median: percentile(ratios, 0.5)
    };
  }

  function textContrastComparison(pixelData) {
    const luminances = pixelLuminances(pixelData);
    if (!luminances.length) return null;
    return {
      dark: contrastMetrics(luminances, DARK_TEXT_LUMINANCE),
      light: contrastMetrics(luminances, 1)
    };
  }

  function textToneForPixels(pixelData) {
    const comparison = textContrastComparison(pixelData);
    if (!comparison) return "light";
    const coverageDelta = comparison.dark.coverage - comparison.light.coverage;
    if (Math.abs(coverageDelta) > CONTRAST_COVERAGE_TIE) return coverageDelta > 0 ? "dark" : "light";

    const lowerQuartileDelta = comparison.dark.lowerQuartile - comparison.light.lowerQuartile;
    if (Math.abs(lowerQuartileDelta) > 0.1) return lowerQuartileDelta > 0 ? "dark" : "light";

    const medianDelta = comparison.dark.median - comparison.light.median;
    if (Math.abs(medianDelta) > 0.1) return medianDelta > 0 ? "dark" : "light";
    if (coverageDelta !== 0) return coverageDelta > 0 ? "dark" : "light";
    return medianDelta > 0 ? "dark" : "light";
  }

  function coverSampleRect(stageRect, textRect, imageWidth, imageHeight) {
    if (!stageRect?.width || !stageRect?.height || !textRect?.width || !textRect?.height || !imageWidth || !imageHeight) return null;
    const scale = Math.max(stageRect.width / imageWidth, stageRect.height / imageHeight);
    const renderedWidth = imageWidth * scale;
    const renderedHeight = imageHeight * scale;
    const offsetX = (stageRect.width - renderedWidth) / 2;
    const offsetY = (stageRect.height - renderedHeight) / 2;
    const left = Math.max(0, (textRect.left - stageRect.left - offsetX) / scale);
    const top = Math.max(0, (textRect.top - stageRect.top - offsetY) / scale);
    const right = Math.min(imageWidth, (textRect.right - stageRect.left - offsetX) / scale);
    const bottom = Math.min(imageHeight, (textRect.bottom - stageRect.top - offsetY) / scale);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function loadRasterImage(url, ImageConstructor) {
    const Constructor = ImageConstructor || (typeof Image !== "undefined" ? Image : null);
    if (!Constructor) return Promise.reject(new Error("Image loading is unavailable"));
    return new Promise((resolve, reject) => {
      const image = new Constructor();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Background image could not be analyzed"));
      image.src = url;
    });
  }

  async function decodeRasterImage(url, ImageConstructor) {
    const image = await loadRasterImage(url, ImageConstructor);
    if (typeof image.decode === "function") await image.decode();
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if ((typeof width === "number" && width <= 0) || (typeof height === "number" && height <= 0)) {
      throw new Error("Background image decoded without dimensions");
    }
    return image;
  }

  function createImagePreloader(ImageConstructor) {
    const cache = new Map();
    return function preloadImage(url) {
      if (!url) return Promise.resolve(null);
      if (!cache.has(url)) {
        const pending = decodeRasterImage(url, ImageConstructor).catch(error => {
          cache.delete(url);
          throw error;
        });
        cache.set(url, pending);
      }
      return cache.get(url);
    };
  }

  function createReadyImageQueue(options = {}) {
    const limit = Math.max(1, Number(options.limit) || READY_IMAGE_QUEUE_LIMIT);
    const ready = [];
    const pending = new Map();
    const failedUrls = new Set();

    function entryUrl(entry) {
      return entry?.image?.url || entry?.url || "";
    }

    function isBlocked(image) {
      return !image?.url || Boolean(options.isBlocked?.(image));
    }

    function pruneBlocked() {
      for (let index = ready.length - 1; index >= 0; index -= 1) {
        if (isBlocked(ready[index].image)) ready.splice(index, 1);
      }
    }

    function fill() {
      pruneBlocked();
      while (ready.length + pending.size < limit) {
        const excludedUrls = [
          ...ready.map(entryUrl),
          ...pending.keys(),
          ...failedUrls
        ];
        const image = options.selectCandidate?.(excludedUrls);
        if (!image?.url || excludedUrls.includes(image.url) || isBlocked(image)) break;

        const request = Promise.resolve()
          .then(() => options.preloadImage(image.url))
          .then(decodedImage => {
            pending.delete(image.url);
            if (!decodedImage || isBlocked(image) || ready.some(entry => entry.image.url === image.url)) return;
            if (ready.length < limit) ready.push({ image, decodedImage });
          })
          .catch(() => {
            pending.delete(image.url);
            failedUrls.add(image.url);
          })
          .finally(fill);
        pending.set(image.url, request);
      }
    }

    async function consume() {
      while (true) {
        pruneBlocked();
        if (ready.length) {
          const entry = ready.shift();
          return entry;
        }
        fill();
        if (!pending.size) return null;
        await Promise.race([...pending.values()]);
      }
    }

    function refresh() {
      pruneBlocked();
      fill();
    }

    return {
      consume,
      fill,
      refresh,
      getFailedUrls: () => [...failedUrls],
      getPendingCount: () => pending.size,
      getReadyEntries: () => [...ready],
      getReadyCount: () => ready.length,
      limit
    };
  }

  function textLineRects(textGroup, documentObject) {
    const targets = textGroup?.querySelectorAll
      ? [...textGroup.querySelectorAll("[data-light-quote-text], [data-light-quote-book], [data-light-quote-author]")]
      : [];
    const rects = [];
    if (targets.length && typeof documentObject?.createRange === "function") {
      targets.forEach(target => {
        const range = documentObject.createRange();
        try {
          range.selectNodeContents(target);
          [...range.getClientRects()].forEach(rect => {
            if (rect.width > 0 && rect.height > 0) rects.push(rect);
          });
        } finally {
          range.detach?.();
        }
      });
    }
    if (rects.length) return rects;
    const fallback = textGroup?.getBoundingClientRect?.();
    return fallback?.width > 0 && fallback?.height > 0 ? [fallback] : [];
  }

  function sampleTextPixels(stage, textGroup, image, documentObject) {
    const stageRect = stage.getBoundingClientRect();
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    const pixels = [];
    for (const textRect of textLineRects(textGroup, documentObject)) {
      const sample = coverSampleRect(stageRect, textRect, imageWidth, imageHeight);
      if (!sample) continue;
      const canvas = documentObject.createElement("canvas");
      canvas.width = Math.max(8, Math.min(64, Math.round((textRect.width / stageRect.width) * 64)));
      canvas.height = Math.max(4, Math.min(24, Math.round((textRect.height / stageRect.height) * 64)));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) continue;
      context.drawImage(image, sample.x, sample.y, sample.width, sample.height, 0, 0, canvas.width, canvas.height);
      pixels.push(...context.getImageData(0, 0, canvas.width, canvas.height).data);
    }
    return Uint8ClampedArray.from(pixels);
  }

  async function analyzeTextBackground(stage, imageUrl, options = {}) {
    const textGroup = stage?.querySelector?.(".light-quote-stage__glow");
    const documentObject = options.documentObject || stage?.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!stage || !textGroup || !documentObject || !imageUrl) return "light";
    const image = options.image || await decodeRasterImage(new URL(imageUrl, documentObject.baseURI).href, options.ImageConstructor);
    if (typeof requestAnimationFrame === "function") await new Promise(resolve => requestAnimationFrame(resolve));
    return textToneForPixels(sampleTextPixels(stage, textGroup, image, documentObject));
  }

  function technicalTitle(text, length = 28) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > length ? `${value.slice(0, length)}…` : value;
  }

  function createMomentSnapshot(quote, image, encounteredAt) {
    return Object.freeze({
      quote_id: quote?.lq_id || "",
      quote_text: quote?.quote_text || "",
      book_title: quote?.book_title || "",
      author: quote?.author || "",
      image_id: image?.image_id || "",
      image_url: image?.url || "",
      encountered_at: new Date(encounteredAt).toISOString()
    });
  }

  function momentFilename(snapshot) {
    const date = new Date(snapshot.encountered_at);
    const pad = value => String(value).padStart(2, "0");
    return `light-quote_${snapshot.quote_id}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.png`;
  }

  async function exportStagePng(stage, htmlToImageApi) {
    const api = htmlToImageApi || (typeof globalThis !== "undefined" ? globalThis.htmlToImage : null);
    if (!stage || typeof api?.toBlob !== "function") throw new Error("PNG exporter is unavailable");
    if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready;
    const blob = await api.toBlob(stage, {
      canvasWidth: EXPORT_WIDTH,
      canvasHeight: EXPORT_HEIGHT,
      pixelRatio: 1,
      skipAutoScale: true,
      skipFonts: true,
      cacheBust: false,
      backgroundColor: "#d9d7d0"
    });
    if (!blob || blob.type !== "image/png") throw new Error("PNG generation returned no image");
    if (blob.size < MIN_EXPORT_BYTES) throw new Error(`PNG generation returned an implausibly small image (${blob.size} bytes)`);
    return blob;
  }

  async function renderStageOverlay(stage, htmlToImageApi) {
    const api = htmlToImageApi || (typeof globalThis !== "undefined" ? globalThis.htmlToImage : null);
    if (!stage || typeof api?.toBlob !== "function") throw new Error("PNG exporter is unavailable");
    if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready;
    const rect = stage.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) throw new Error("PNG stage has no dimensions");
    const blob = await api.toBlob(stage, {
      pixelRatio: EXPORT_WIDTH / rect.width,
      skipAutoScale: true,
      skipFonts: true,
      cacheBust: false,
      backgroundColor: null
    });
    if (!blob || blob.type !== "image/png") throw new Error("PNG overlay generation returned no image");
    return blob;
  }

  async function composeMomentPng(backgroundImage, overlayBlob, options = {}) {
    const doc = options.documentObject || (typeof document !== "undefined" ? document : null);
    const urls = options.urlApi || (typeof URL !== "undefined" ? URL : null);
    if (!doc || !urls?.createObjectURL || !backgroundImage || !overlayBlob) throw new Error("PNG composition is unavailable");
    const canvas = doc.createElement("canvas");
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG Canvas is unavailable");
    const imageWidth = backgroundImage.naturalWidth || backgroundImage.width;
    const imageHeight = backgroundImage.naturalHeight || backgroundImage.height;
    const scale = Math.max(EXPORT_WIDTH / imageWidth, EXPORT_HEIGHT / imageHeight);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    context.drawImage(backgroundImage, (EXPORT_WIDTH - width) / 2, (EXPORT_HEIGHT - height) / 2, width, height);
    const overlayUrl = urls.createObjectURL(overlayBlob);
    try {
      const overlayImage = await decodeRasterImage(overlayUrl, options.ImageConstructor);
      if (Math.abs(overlayImage.naturalWidth - EXPORT_WIDTH) > 1 || Math.abs(overlayImage.naturalHeight - EXPORT_HEIGHT) > 1) {
        throw new Error(`PNG overlay has unexpected dimensions (${overlayImage.naturalWidth} × ${overlayImage.naturalHeight})`);
      }
      context.drawImage(overlayImage, 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
    } finally {
      urls.revokeObjectURL(overlayUrl);
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob || blob.type !== "image/png") throw new Error("PNG composition returned no image");
    if (blob.size < MIN_EXPORT_BYTES) throw new Error(`PNG composition returned an implausibly small image (${blob.size} bytes)`);
    return blob;
  }

  async function prepareExportBackground(imageUrl, options = {}) {
    const fetcher = options.fetcher || (typeof fetch === "function" ? fetch : null);
    const urls = options.urlApi || (typeof URL !== "undefined" ? URL : null);
    if (!fetcher || !urls?.createObjectURL || !imageUrl) throw new Error("Background preparation is unavailable");
    const response = await fetcher(imageUrl, {
      mode: "cors",
      credentials: "omit",
      cache: "force-cache"
    });
    if (!response?.ok) throw new Error(`Background request failed (${response?.status || "network"})`);
    const blob = await response.blob();
    if (!blob?.type?.startsWith("image/") || !blob.size) throw new Error("Background response is not a usable image");
    const objectUrl = urls.createObjectURL(blob);
    try {
      const image = await decodeRasterImage(objectUrl, options.ImageConstructor);
      return {
        blob,
        image,
        objectUrl,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        release() { urls.revokeObjectURL(objectUrl); }
      };
    } catch (error) {
      urls.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  async function cloneStageForExport(stage, backgroundUrl, documentObject) {
    const doc = documentObject || stage?.ownerDocument;
    if (!stage?.cloneNode || !doc?.body) throw new Error("Export stage cannot be cloned");
    const rect = stage.getBoundingClientRect();
    const clone = stage.cloneNode(true);
    clone.removeAttribute("data-light-quote-stage");
    clone.setAttribute("aria-hidden", "true");
    Object.assign(clone.style, {
      position: "fixed",
      top: "0",
      left: "0",
      zIndex: "-2147483647",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      backgroundImage: "none",
      backgroundColor: "transparent",
      borderRadius: doc.defaultView?.getComputedStyle?.(stage)?.borderRadius || "",
      containerType: "inline-size",
      isolation: "isolate",
      pointerEvents: "none"
    });
    const shade = clone.querySelector(".light-quote-stage__shade");
    const body = clone.querySelector(".light-quote-stage__body");
    const footer = clone.querySelector(".light-quote-stage__footer");
    if (shade) shade.style.zIndex = "0";
    if (body) body.style.zIndex = "1";
    if (footer) footer.style.zIndex = "1";
    doc.body.appendChild(clone);
    return clone;
  }

  async function generateMomentPng(options) {
    const snapshot = options.snapshot;
    const background = await (options.backgroundPreparer || prepareExportBackground)(snapshot.image_url, options);
    let exportStage = null;
    try {
      exportStage = await (options.stageFactory || cloneStageForExport)(options.stage, background.objectUrl, options.documentObject);
      const blob = options.exporter
        ? await options.exporter(exportStage, options.htmlToImageApi)
        : await composeMomentPng(
          background.image,
          await renderStageOverlay(exportStage, options.htmlToImageApi),
          options
        );
      return { blob, filename: momentFilename(snapshot), snapshot, width: EXPORT_WIDTH, height: EXPORT_HEIGHT };
    } finally {
      exportStage?.remove?.();
      background?.release?.();
    }
  }

  function downloadBlob(blob, filename, documentObject, urlApi) {
    const doc = documentObject || document;
    const urls = urlApi || URL;
    const objectUrl = urls.createObjectURL(blob);
    const anchor = doc.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => urls.revokeObjectURL(objectUrl), 1000);
  }

  async function freezeCurrentMoment(options) {
    const result = await generateMomentPng(options);
    (options.downloader || downloadBlob)(result.blob, result.filename);
    return result;
  }

  function isTouchDevice(navigatorObject, windowObject) {
    return Number(navigatorObject?.maxTouchPoints || 0) > 0
      || Boolean(windowObject?.matchMedia?.("(pointer: coarse)")?.matches);
  }

  function createPngFile(blob, filename, FileConstructor) {
    const Constructor = FileConstructor || (typeof File !== "undefined" ? File : null);
    return Constructor ? new Constructor([blob], filename, { type: "image/png" }) : null;
  }

  async function deliverMomentPng(result, options = {}) {
    const navigatorObject = options.navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
    const windowObject = options.windowObject || (typeof window !== "undefined" ? window : null);
    const mobile = options.mobile ?? isTouchDevice(navigatorObject, windowObject);
    if (!mobile) {
      (options.downloader || downloadBlob)(result.blob, result.filename, options.documentObject, options.urlApi);
      return { mode: "download" };
    }
    const file = createPngFile(result.blob, result.filename, options.FileConstructor);
    if (file && typeof navigatorObject?.canShare === "function" && typeof navigatorObject?.share === "function"
      && navigatorObject.canShare({ files: [file] })) {
      if (typeof options.sharePresenter === "function") {
        options.sharePresenter(file, result);
        return { mode: "share-ready", file };
      }
      try {
        await navigatorObject.share({ files: [file], title: "光语录" });
        return { mode: "share", file };
      } catch (error) {
        if (error?.name === "AbortError") return { mode: "cancelled", file };
      }
    }
    if (typeof options.previewer !== "function") throw new Error("Image preview is unavailable");
    options.previewer(result.blob, result.filename);
    return { mode: "preview", file };
  }

  async function copyTextValue(value, options = {}) {
    const navigatorObject = options.navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
    const documentObject = options.documentObject || (typeof document !== "undefined" ? document : null);
    try {
      if (typeof navigatorObject?.clipboard?.writeText !== "function") throw new Error("Clipboard API unavailable");
      await navigatorObject.clipboard.writeText(value);
      return true;
    } catch (_) {
      if (!documentObject?.body || typeof documentObject.execCommand !== "function") return false;
      const textarea = documentObject.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      Object.assign(textarea.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
      documentObject.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try { copied = documentObject.execCommand("copy"); } catch (_) {}
      textarea.remove();
      return copied;
    }
  }

  function resolveQuote(quotes, requestedId, random = Math.random) {
    const items = Array.isArray(quotes) ? quotes : [];
    return items.find(quote => quote.lq_id === requestedId) || randomItem(items, random);
  }

  function textOffsetBounds(stageRect, textRect, footerRect, currentOffsetRatio = 0, options = {}) {
    const stageHeight = Number(stageRect?.height) || 0;
    if (!stageHeight || !textRect || !footerRect) return { min: 0, max: 0 };
    const topSafeRatio = options.topSafeRatio ?? 0.08;
    const footerGapRatio = options.footerGapRatio ?? 0.025;
    const stageTop = Number(stageRect.top) || 0;
    const textTop = Number(textRect.top) || 0;
    const textBottom = Number(textRect.bottom) || textTop + (Number(textRect.height) || 0);
    const footerTop = Number(footerRect.top) || 0;
    const min = currentOffsetRatio + ((stageTop + stageHeight * topSafeRatio) - textTop) / stageHeight;
    const max = currentOffsetRatio + ((footerTop - stageHeight * footerGapRatio) - textBottom) / stageHeight;
    return max < min ? { min: currentOffsetRatio, max: currentOffsetRatio } : { min, max };
  }

  function clampTextOffset(value, bounds) {
    const number = Number.isFinite(value) ? value : 0;
    return Math.min(bounds.max, Math.max(bounds.min, number));
  }

  function createTextPositionController(options = {}) {
    const stage = options.stage;
    const body = options.body;
    const textGroup = options.textGroup;
    const footer = options.footer;
    const adjustButton = options.adjustButton;
    const resetButton = options.resetButton;
    const status = options.status;
    let offsetRatio = 0;
    let adjustmentMode = false;
    let dragging = false;
    let pointerId = null;
    let startClientY = 0;
    let startOffsetRatio = 0;
    let dragBounds = { min: 0, max: 0 };

    function applyOffset() {
      if (!body?.style) return;
      const value = `${offsetRatio * 100}%`;
      if (typeof body.style.setProperty === "function") body.style.setProperty("--lq-text-offset-y", value);
      else body.style["--lq-text-offset-y"] = value;
    }

    function finishDrag(event) {
      if (!dragging || (event?.pointerId != null && event.pointerId !== pointerId)) return;
      textGroup?.releasePointerCapture?.(pointerId);
      dragging = false;
      pointerId = null;
      textGroup?.classList?.toggle?.("is-dragging", false);
    }

    function setMode(active) {
      adjustmentMode = Boolean(active);
      if (!adjustmentMode) finishDrag();
      textGroup?.classList?.toggle?.("is-adjusting", adjustmentMode);
      adjustButton?.setAttribute?.("aria-pressed", String(adjustmentMode));
      if (adjustButton) adjustButton.textContent = adjustmentMode ? "完成" : "调整文字";
      if (resetButton) resetButton.hidden = !adjustmentMode;
      if (status) status.textContent = adjustmentMode ? "上下拖动文字，调整完成后请点击“完成”。" : "";
      return adjustmentMode;
    }

    function reset() {
      offsetRatio = 0;
      applyOffset();
      if (status && adjustmentMode) status.textContent = "文字已恢复默认位置。";
    }

    function pointerDown(event) {
      if (!adjustmentMode || dragging || event?.button > 0) return;
      const stageRect = stage?.getBoundingClientRect?.();
      const textRect = textGroup?.getBoundingClientRect?.();
      const footerRect = footer?.getBoundingClientRect?.();
      if (!stageRect?.height || !textRect || !footerRect) return;
      event.preventDefault?.();
      dragging = true;
      pointerId = event.pointerId;
      startClientY = event.clientY;
      startOffsetRatio = offsetRatio;
      dragBounds = textOffsetBounds(stageRect, textRect, footerRect, offsetRatio, options);
      textGroup.setPointerCapture?.(pointerId);
      textGroup.classList?.toggle?.("is-dragging", true);
    }

    function pointerMove(event) {
      if (!dragging || event.pointerId !== pointerId) return;
      const stageHeight = stage?.getBoundingClientRect?.().height || 0;
      if (!stageHeight) return;
      event.preventDefault?.();
      offsetRatio = clampTextOffset(startOffsetRatio + (event.clientY - startClientY) / stageHeight, dragBounds);
      applyOffset();
    }

    adjustButton?.addEventListener?.("click", () => setMode(!adjustmentMode));
    resetButton?.addEventListener?.("click", reset);
    textGroup?.addEventListener?.("pointerdown", pointerDown);
    textGroup?.addEventListener?.("pointermove", pointerMove);
    textGroup?.addEventListener?.("pointerup", finishDrag);
    textGroup?.addEventListener?.("pointercancel", finishDrag);
    applyOffset();

    return {
      reset,
      setMode,
      getOffsetRatio: () => offsetRatio,
      isAdjustmentMode: () => adjustmentMode,
      isDragging: () => dragging
    };
  }

  function initMainPage(rootElement, options = {}) {
    if (!rootElement) return null;
    const quotes = options.quotes || [];
    const images = options.images || [];
    const random = options.random || Math.random;
    const matchingMode = normalizeMatchingMode(options.matchingMode);
    const stage = rootElement.querySelector("[data-light-quote-stage]");
    const text = rootElement.querySelector("[data-light-quote-text]");
    const source = rootElement.querySelector("[data-light-quote-source]");
    const sourceBook = rootElement.querySelector("[data-light-quote-book]");
    const sourceAuthor = rootElement.querySelector("[data-light-quote-author]");
    const time = rootElement.querySelector("[data-light-quote-time]");
    const status = rootElement.querySelector("[data-light-quote-status]");
    const nextButton = rootElement.querySelector("[data-light-quote-next]");
    const backgroundButton = rootElement.querySelector("[data-light-quote-background]");
    const textAdjustButton = rootElement.querySelector("[data-light-quote-text-adjust]");
    const textResetButton = rootElement.querySelector("[data-light-quote-text-reset]");
    const freezeButton = rootElement.querySelector("[data-light-quote-freeze]");
    const preview = rootElement.querySelector("[data-light-quote-image-preview]");
    const previewImage = rootElement.querySelector("[data-light-quote-preview-image]");
    const previewShare = rootElement.querySelector("[data-light-quote-preview-share]");
    const previewClose = rootElement.querySelector("[data-light-quote-preview-close]");
    const preloadImage = options.imagePreloader || createImagePreloader(options.ImageConstructor);
    const analyzeBackground = options.backgroundAnalyzer || analyzeTextBackground;
    const textPosition = createTextPositionController({
      stage,
      body: stage?.querySelector?.(".light-quote-stage__body"),
      textGroup: stage?.querySelector?.(".light-quote-stage__glow"),
      footer: stage?.querySelector?.(".light-quote-stage__footer"),
      adjustButton: textAdjustButton,
      resetButton: textResetButton,
      status
    });
    let currentQuote = null;
    let currentImage = null;
    let encounterTime = null;
    let renderVersion = 0;
    let currentImagePromise = Promise.resolve(null);
    let textTonePromise = Promise.resolve("light");
    let previewUrl = null;
    let previewFile = null;
    let backgroundBusy = false;
    let actionSequence = 0;
    const recentImageUrls = [];
    const readyImages = createReadyImageQueue({
      limit: READY_IMAGE_QUEUE_LIMIT,
      preloadImage,
      isBlocked: image => image?.url === currentImage?.url || recentImageUrls.includes(image?.url),
      selectCandidate: queueExcludedUrls => chooseImage(currentQuote, images, random, {
        matchingMode,
        currentImage,
        excludedUrls: [...recentImageUrls, ...queueExcludedUrls]
      })
    });

    function rememberPreviousImage(image) {
      if (!image?.url) return;
      const existingIndex = recentImageUrls.indexOf(image.url);
      if (existingIndex !== -1) recentImageUrls.splice(existingIndex, 1);
      recentImageUrls.push(image.url);
      if (recentImageUrls.length > 2) recentImageUrls.splice(0, recentImageUrls.length - 2);
    }

    function applyTextTone(tone) {
      const resolvedTone = tone === "dark" ? "dark" : "light";
      stage.classList.toggle("light-quote-stage--text-light", resolvedTone === "light");
      stage.classList.toggle("light-quote-stage--text-dark", resolvedTone === "dark");
      stage.dataset.textTone = resolvedTone;
      return resolvedTone;
    }

    function scheduleReadyPreload(version) {
      Promise.allSettled([currentImagePromise, textTonePromise]).then(() => {
        if (version === renderVersion) readyImages.refresh();
      });
    }

    function render(quote, updateUrl, preparedImage, decodedImage) {
      if (!quote) return;
      const previousImage = currentImage;
      currentQuote = quote;
      currentImage = preparedImage || chooseImage(quote, images, random, {
        matchingMode,
        currentImage,
        excludedUrls: recentImageUrls
      });
      if (previousImage?.url && currentImage?.url !== previousImage.url) rememberPreviousImage(previousImage);
      encounterTime = new Date();
      text.textContent = quote.quote_text;
      if (sourceBook && sourceAuthor) {
        sourceBook.textContent = quote.book_title;
        sourceAuthor.textContent = quote.author;
      } else {
        source.textContent = `${quote.book_title}\n${quote.author}`;
      }
      textPosition.reset();
      const pad = value => String(value).padStart(2, "0");
      time.textContent = `${encounterTime.getFullYear()}.${pad(encounterTime.getMonth() + 1)}.${pad(encounterTime.getDate())} · ${pad(encounterTime.getHours())}:${pad(encounterTime.getMinutes())}`;
      const version = ++renderVersion;
      stage.className = `light-quote-stage light-quote-stage--${currentImage?.text_safe_area || "flexible"} light-quote-stage--text-light`;
      stage.dataset.textTone = "light";
      if (currentImage) stage.style.backgroundImage = `url("${String(currentImage.url).replace(/"/g, "%22")}")`;
      currentImagePromise = decodedImage
        ? Promise.resolve(decodedImage)
        : currentImage ? preloadImage(currentImage.url) : Promise.resolve(null);
      textTonePromise = currentImage
        ? currentImagePromise.then(image => analyzeTextBackground(stage, currentImage.url, { image }))
          .then(tone => version === renderVersion ? applyTextTone(tone) : tone)
          .catch(() => version === renderVersion ? applyTextTone("light") : "light")
        : Promise.resolve(applyTextTone("light"));
      rootElement.dataset.currentQuote = quote.lq_id;
      if (updateUrl && typeof history !== "undefined") {
        const url = new URL(location.href);
        url.searchParams.set("quote", quote.lq_id);
        history.replaceState({}, "", url);
      }
      document.title = `${technicalTitle(quote.quote_text)}・光语录・生命之书 | librarys.life`;
      status.textContent = "";
      if (decodedImage) readyImages.refresh();
      scheduleReadyPreload(version);
    }

    async function chooseNext() {
      if (nextButton?.disabled) return;
      const actionToken = ++actionSequence;
      const pool = quotes.length > 1 ? quotes.filter(quote => quote.lq_id !== currentQuote?.lq_id) : quotes;
      const quote = randomItem(pool, random);
      if (nextButton) nextButton.disabled = true;
      status.textContent = "图片还在准备，请稍候…";
      try {
        const prepared = await readyImages.consume();
        if (!prepared) throw new Error("No decoded background candidate is available");
        if (actionToken !== actionSequence) return false;
        render(quote, true, prepared.image, prepared.decodedImage);
        return true;
      } catch (error) {
        console.error("Light quote background preload failed", error);
        if (actionToken === actionSequence) status.textContent = "背景图片加载失败，请稍后重试。";
        return false;
      } finally {
        if (nextButton) nextButton.disabled = false;
      }
    }

    async function changeBackground() {
      if (backgroundBusy || backgroundButton?.disabled || !currentQuote || !currentImage) return false;
      const previousImage = currentImage;
      const versionAtStart = renderVersion;
      const actionToken = ++actionSequence;

      backgroundBusy = true;
      if (backgroundButton) backgroundButton.disabled = true;
      status.textContent = "正在准备新背景…";
      try {
        const prepared = await readyImages.consume();
        if (!prepared) throw new Error("No decoded background candidate is available");
        const { image: candidate, decodedImage } = prepared;
        if (actionToken !== actionSequence || versionAtStart !== renderVersion || currentImage !== previousImage) return false;
        let tone = "light";
        try {
          tone = await analyzeBackground(stage, candidate.url, { image: decodedImage });
        } catch (_) {}
        if (actionToken !== actionSequence || versionAtStart !== renderVersion || currentImage !== previousImage) return false;

        rememberPreviousImage(previousImage);
        currentImage = candidate;
        currentImagePromise = Promise.resolve(decodedImage);
        const version = ++renderVersion;
        stage.className = `light-quote-stage light-quote-stage--${candidate.text_safe_area || "flexible"} light-quote-stage--text-${tone}`;
        stage.dataset.textTone = tone;
        stage.style.backgroundImage = `url("${String(candidate.url).replace(/"/g, "%22")}")`;
        textTonePromise = Promise.resolve(applyTextTone(tone));
        status.textContent = "背景已更换。";
        readyImages.refresh();
        scheduleReadyPreload(version);
        return true;
      } catch (error) {
        console.error("Light quote background change failed", error);
        if (versionAtStart === renderVersion && currentImage === previousImage) {
          status.textContent = "背景图片加载失败，已保留当前背景。";
        }
        return false;
      } finally {
        backgroundBusy = false;
        if (backgroundButton) backgroundButton.disabled = false;
      }
    }

    function closePreview() {
      if (preview) preview.hidden = true;
      if (previewImage) previewImage.removeAttribute("src");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      previewFile = null;
      if (previewShare) previewShare.hidden = true;
    }

    function showPreview(blob, filename, file) {
      if (!preview || !previewImage) throw new Error("Image preview is unavailable");
      closePreview();
      previewUrl = URL.createObjectURL(blob);
      previewFile = file || null;
      previewImage.src = previewUrl;
      previewImage.alt = `${filename}，请长按保存`;
      if (previewShare) previewShare.hidden = !previewFile;
      preview.hidden = false;
      (previewFile ? previewShare : previewClose)?.focus?.();
    }

    const requestedId = new URL(location.href).searchParams.get("quote");
    render(resolveQuote(quotes, requestedId, random), false);

    nextButton?.addEventListener("click", chooseNext);
    backgroundButton?.addEventListener("click", changeBackground);
    rootElement.querySelector("[data-light-quote-copy]")?.addEventListener("click", async function () {
      const shareUrl = new URL("/light-quotes/", location.origin);
      shareUrl.searchParams.set("quote", currentQuote.lq_id);
      const value = `「${currentQuote.quote_text}」\n${currentQuote.book_title} │ ${currentQuote.author}\n${shareUrl.href}`;
      const copied = await copyTextValue(value);
      status.textContent = copied ? "文字与固定语录链接已复制。" : "复制失败，请手动选择文字。";
    });
    previewClose?.addEventListener("click", closePreview);
    preview?.addEventListener("click", event => { if (event.target === preview) closePreview(); });
    previewShare?.addEventListener("click", async function () {
      if (!previewFile || typeof navigator.share !== "function") return;
      this.disabled = true;
      try {
        await navigator.share({ files: [previewFile], title: "光语录" });
        closePreview();
        status.textContent = "图片已交给系统分享面板。";
      } catch (error) {
        if (error?.name === "AbortError") {
          closePreview();
          status.textContent = "已取消分享；需要时可再次点击“定格此刻”。";
        } else {
          this.hidden = true;
          status.textContent = "系统分享不可用，请长按图片保存。";
        }
      } finally {
        this.disabled = false;
      }
    });
    freezeButton?.addEventListener("click", async function () {
      const button = this;
      const snapshot = createMomentSnapshot(currentQuote, currentImage, encounterTime);
      const frozenVersion = renderVersion;
      button.disabled = true;
      status.textContent = "图片还在准备，请稍候…";
      try {
        await currentImagePromise;
        await textTonePromise;
        if (frozenVersion !== renderVersion) throw new Error("Quote changed while preparing the image");
        status.textContent = "正在生成 1080 × 1920 PNG…";
        const result = await generateMomentPng({ stage, snapshot });
        if (frozenVersion !== renderVersion) throw new Error("Quote changed while generating the image");
        const delivery = await deliverMomentPng(result, {
          previewer: (blob, filename) => showPreview(blob, filename, null),
          sharePresenter: (file, shareResult) => showPreview(shareResult.blob, shareResult.filename, file)
        });
        try { sessionStorage.setItem("light-quote-snapshot", JSON.stringify(snapshot)); } catch (_) {}
        const size = `${(result.blob.size / 1024 / 1024).toFixed(2)} MB`;
        if (delivery.mode === "download") status.textContent = `PNG 已生成并开始下载：1080 × 1920，${size}`;
        if (delivery.mode === "share") status.textContent = `图片已生成：1080 × 1920，${size}`;
        if (delivery.mode === "share-ready") status.textContent = `图片已生成，请点击“保存 / 分享图片”：1080 × 1920，${size}`;
        if (delivery.mode === "preview") status.textContent = `图片已生成，请长按预览图保存：1080 × 1920，${size}`;
        if (delivery.mode === "cancelled") status.textContent = "已取消分享；需要时可再次点击“定格此刻”。";
      } catch (error) {
        console.error("Light quote PNG export failed", error);
        status.textContent = error?.message?.includes("Quote changed")
          ? "当前语录已切换，请重新点击“定格此刻”。"
          : "图片生成失败，请稍后重试。";
      } finally {
        button.disabled = false;
      }
    });
    return {
      render,
      chooseNext,
      changeBackground,
      closePreview,
      getCurrentImage: () => currentImage,
      getCurrentQuote: () => currentQuote,
      getEncounterTime: () => encounterTime,
      getRecentImageUrls: () => [...recentImageUrls],
      getReadyImageCount: () => readyImages.getReadyCount(),
      getPendingImageCount: () => readyImages.getPendingCount(),
      getReadyImageUrls: () => readyImages.getReadyEntries().map(entry => entry.image.url),
      getTextTone: () => stage.dataset.textTone || "light",
      isBackgroundBusy: () => backgroundBusy,
      getTextOffsetRatio: textPosition.getOffsetRatio,
      isTextAdjustmentMode: textPosition.isAdjustmentMode,
      isTextDragging: textPosition.isDragging,
      resetTextPosition: textPosition.reset
    };
  }

  function initPreviewModules(documentObject = document, random = Math.random) {
    documentObject.querySelectorAll("[data-quote-preview]").forEach(module => {
      const items = [...module.querySelectorAll("[data-quote-preview-item]")];
      items.forEach(item => { item.hidden = true; });
      const selected = randomItem(items, random);
      if (selected) selected.hidden = false;
    });
  }

  function initTagModule(module, random = Math.random, scheduler) {
    const timers = scheduler || (typeof window !== "undefined" ? window : globalThis);
    const items = [...module.querySelectorAll("[data-tag-quote-item]")];
    let current = null;
    let intervalId = null;
    let switchTimeoutId = null;
    let stopped = false;

    function replaceCurrent() {
      const pool = items.length > 1 ? items.filter(item => item !== current) : items;
      items.forEach(item => { item.hidden = true; });
      current = randomItem(pool, random);
      if (current) current.hidden = false;
    }

    function showRandom(animate = true) {
      if (stopped || items.length < 2) return current;
      if (!animate) {
        replaceCurrent();
        return current;
      }
      module.classList.add("is-switching");
      if (switchTimeoutId !== null) timers.clearTimeout(switchTimeoutId);
      switchTimeoutId = timers.setTimeout(() => {
        switchTimeoutId = null;
        if (stopped || module.isConnected === false) {
          cleanup();
          return;
        }
        replaceCurrent();
        module.classList.remove("is-switching");
      }, 240);
      return current;
    }

    function cleanup() {
      if (stopped) return;
      stopped = true;
      if (intervalId !== null) timers.clearInterval(intervalId);
      if (switchTimeoutId !== null) timers.clearTimeout(switchTimeoutId);
      intervalId = null;
      switchTimeoutId = null;
      module.classList.remove("is-switching");
    }

    replaceCurrent();
    if (items.length > 1) intervalId = timers.setInterval(() => showRandom(true), 60000);
    return { cleanup, showRandom, getCurrent: () => current, intervalMs: items.length > 1 ? 60000 : null };
  }

  function initTagModules(documentObject = document, random = Math.random, scheduler) {
    return [...documentObject.querySelectorAll("[data-tag-quote-module]")].map(module => {
      module.__lightQuoteController?.cleanup();
      const controller = initTagModule(module, random, scheduler);
      module.__lightQuoteController = controller;
      documentObject.defaultView?.addEventListener("pagehide", controller.cleanup, { once: true });
      return controller;
    });
  }

  return {
    CONTRAST_COVERAGE_TIE,
    EXPORT_HEIGHT,
    EXPORT_WIDTH,
    MIN_EXPORT_BYTES,
    READY_IMAGE_QUEUE_LIMIT,
    READABLE_CONTRAST_RATIO,
    analyzeTextBackground,
    candidateImages,
    chooseImage,
    cloneStageForExport,
    composeMomentPng,
    contrastMetrics,
    contrastRatio,
    clampTextOffset,
    copyTextValue,
    coverSampleRect,
    createImagePreloader,
    createReadyImageQueue,
    createTextPositionController,
    createMomentSnapshot,
    createPngFile,
    decodeRasterImage,
    deliverMomentPng,
    downloadBlob,
    exportStagePng,
    freezeCurrentMoment,
    generateMomentPng,
    initMainPage,
    initPreviewModules,
    initTagModule,
    initTagModules,
    isTouchDevice,
    loadRasterImage,
    luminanceStats,
    matchingImages,
    momentFilename,
    normalizeMatchingMode,
    prepareExportBackground,
    renderStageOverlay,
    resolveQuote,
    sampleTextPixels,
    textContrastComparison,
    textLineRects,
    textOffsetBounds,
    textToneForPixels,
    technicalTitle
  };
});
