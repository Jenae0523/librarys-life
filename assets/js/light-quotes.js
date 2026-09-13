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
  const LIGHT_QUOTES_BUILD = "20260913-5";

  function userActivationState(navigatorObject) {
    return typeof navigatorObject?.userActivation?.isActive === "boolean"
      ? navigatorObject.userActivation.isActive
      : null;
  }

  function errorDiagnostic(error, stage) {
    const details = {
      name: error?.name || "Error",
      message: error?.message || String(error || "Unknown error")
    };
    if (stage) details.stage = stage;
    if (error?.stack) details.stack = String(error.stack);
    return details;
  }

  function createDebugReporter(rootElement, options = {}) {
    const doc = options.documentObject || rootElement?.ownerDocument || (typeof document !== "undefined" ? document : null);
    const win = options.windowObject || doc?.defaultView || (typeof window !== "undefined" ? window : null);
    const navigatorObject = options.navigatorObject || win?.navigator || (typeof navigator !== "undefined" ? navigator : null);
    const earlyDebug = win?.__lightQuoteDebug;
    if (typeof earlyDebug?.report === "function") {
      earlyDebug.report("RUNTIME_READY", { build: LIGHT_QUOTES_BUILD });
      return earlyDebug.report;
    }
    const panel = rootElement?.querySelector?.("[data-light-quote-debug]");
    const output = panel?.querySelector?.("[data-light-quote-debug-output]");
    let enabled = false;
    try { enabled = new URL(win.location.href).searchParams.get("lqdebug") === "1"; } catch (_) {}
    if (panel) panel.hidden = !enabled;
    const entries = [];
    const report = (event, details = {}) => {
      if (!enabled) return;
      const entry = { event, ...details };
      entries.push(entry);
      if (entries.length > 120) entries.shift();
      if (output) output.textContent = entries.map(item => JSON.stringify(item)).join("\n");
      console.info("Light quote debug", entry);
    };
    if (enabled) {
      const script = doc?.querySelector?.('script[src*="/assets/js/light-quotes.js"]');
      const stylesheet = doc?.querySelector?.('link[href*="/assets/css/light-quotes.css"]');
      report("BUILD", {
        build: LIGHT_QUOTES_BUILD,
        js: script?.getAttribute?.("src") || "unknown",
        css: stylesheet?.getAttribute?.("href") || "unknown",
        userAgent: navigatorObject?.userAgent || "unknown",
        isSecureContext: Boolean(win?.isSecureContext)
      });
    }
    report.enabled = enabled;
    report.entries = entries;
    return report;
  }

  function textShadowDiagnostics(stage, documentObject) {
    const doc = documentObject || stage?.ownerDocument || (typeof document !== "undefined" ? document : null);
    const view = doc?.defaultView || (typeof window !== "undefined" ? window : null);
    const read = selector => {
      const element = stage?.querySelector?.(selector);
      try { return element && view?.getComputedStyle ? view.getComputedStyle(element).textShadow || "none" : "unavailable"; } catch (_) { return "unavailable"; }
    };
    return {
      cssSupportsCqw: Boolean(view?.CSS?.supports?.("width", "1cqw")),
      quote: read("[data-light-quote-text]"),
      source: read("[data-light-quote-source]"),
      footer: read(".light-quote-stage__footer")
    };
  }

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

  function runtimeImageUrl(url, documentObject) {
    if (!url || !documentObject?.baseURI) return url;
    try {
      const requested = new URL(url, documentObject.baseURI);
      const page = new URL(documentObject.baseURI);
      const decodedPathname = decodeURIComponent(requested.pathname);
      if ((page.hostname === "127.0.0.1" || page.hostname === "localhost")
        && requested.protocol === "https:"
        && requested.hostname === "img.librarys.life"
        && requested.port === ""
        && requested.search === ""
        && requested.hash === ""
        && /^\/img\/light-quotes\/[A-Za-z0-9][A-Za-z0-9._() -]*\.webp$/i.test(decodedPathname)) {
        return new URL(`/__light-quote-image${requested.pathname}`, page.origin).href;
      }
    } catch (_) {}
    return url;
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

  function splitCssList(value) {
    const parts = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < String(value || "").length; index += 1) {
      const character = value[index];
      if (character === "(") depth += 1;
      if (character === ")") depth = Math.max(0, depth - 1);
      if (character === "," && depth === 0) {
        parts.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
    const tail = String(value || "").slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
  }

  function cssPixels(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseTextShadows(value) {
    if (!value || value === "none") return [];
    return splitCssList(value).map(layer => {
      const colorMatch = layer.match(/rgba?\([^)]*\)|#[\da-f]{3,8}|\btransparent\b|\b[a-z]+\b/i);
      const color = colorMatch?.[0] || "rgba(0,0,0,0)";
      const lengths = layer.replace(color, " ").match(/-?(?:\d+\.?\d*|\.\d+)px/g) || [];
      return {
        color,
        offsetX: cssPixels(lengths[0]),
        offsetY: cssPixels(lengths[1]),
        blur: Math.max(0, cssPixels(lengths[2]))
      };
    }).filter(layer => layer.color !== "transparent");
  }

  function textNodeLines(element, documentObject) {
    const textNode = [...(element?.childNodes || [])].find(node => node.nodeType === 3 && node.nodeValue);
    const textValue = textNode?.nodeValue || element?.textContent || "";
    if (!textValue) return [];
    if (!textNode || typeof documentObject?.createRange !== "function") {
      const rect = element?.getBoundingClientRect?.();
      return rect?.width > 0 && rect?.height > 0 ? [{ text: textValue, rect }] : [];
    }

    const lines = [];
    let offset = 0;
    for (const character of Array.from(textValue)) {
      const nextOffset = offset + character.length;
      if (character === "\n" || character === "\r") {
        offset = nextOffset;
        continue;
      }
      const range = documentObject.createRange();
      let rect = null;
      try {
        range.setStart(textNode, offset);
        range.setEnd(textNode, nextOffset);
        rect = [...range.getClientRects()].find(item => item.width > 0 && item.height > 0) || null;
      } finally {
        range.detach?.();
      }
      offset = nextOffset;
      if (!rect) continue;
      let line = lines.length ? lines[lines.length - 1] : null;
      if (!line || Math.abs(line.rect.top - rect.top) > Math.max(2, rect.height * 0.35)) {
        line = { text: "", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
        lines.push(line);
      }
      line.text += character;
      line.rect.left = Math.min(line.rect.left, rect.left);
      line.rect.top = Math.min(line.rect.top, rect.top);
      line.rect.right = Math.max(line.rect.right, rect.right);
      line.rect.bottom = Math.max(line.rect.bottom, rect.bottom);
    }
    return lines.map(line => ({
      text: line.text,
      rect: {
        ...line.rect,
        width: line.rect.right - line.rect.left,
        height: line.rect.bottom - line.rect.top
      }
    }));
  }

  function createTextRenderPlan(stage, options = {}) {
    const doc = options.documentObject || stage?.ownerDocument || (typeof document !== "undefined" ? document : null);
    const view = doc?.defaultView || (typeof window !== "undefined" ? window : null);
    const stageRect = stage?.getBoundingClientRect?.();
    if (!doc || !view?.getComputedStyle || !(stageRect?.width > 0) || !(stageRect?.height > 0)) {
      throw new Error("PNG stage has no measurable layout");
    }
    const scaleX = EXPORT_WIDTH / stageRect.width;
    const scaleY = EXPORT_HEIGHT / stageRect.height;
    const selectors = [
      { selector: "[data-light-quote-text]", role: "text" },
      { selector: "[data-light-quote-book]", role: "text" },
      { selector: "[data-light-quote-author]", role: "text" },
      { selector: "[data-light-quote-time]", role: "footer" },
      { selector: ".light-quote-stage__footer > span", role: "footer" }
    ];
    const entries = [];
    selectors.forEach(({ selector, role }) => {
      const element = stage.querySelector(selector);
      if (!element) return;
      const style = view.getComputedStyle(element);
      const fontSize = cssPixels(style.fontSize) * scaleY;
      textNodeLines(element, doc).forEach(line => {
        entries.push({
          role,
          text: line.text,
          x: ((line.rect.left + line.rect.right) / 2 - stageRect.left) * scaleX,
          centerY: ((line.rect.top + line.rect.bottom) / 2 - stageRect.top) * scaleY,
          maxWidth: Math.max(1, line.rect.width * scaleX),
          font: `${style.fontStyle || "normal"} ${style.fontVariant || "normal"} ${style.fontWeight || "400"} ${fontSize}px ${style.fontFamily || "sans-serif"}`,
          lineHeight: style.lineHeight === "normal" ? "normal" : cssPixels(style.lineHeight) * scaleY,
          color: style.color,
          opacity: Number.isFinite(Number.parseFloat(style.opacity)) ? Number.parseFloat(style.opacity) : 1,
          letterSpacing: style.letterSpacing === "normal" ? 0 : cssPixels(style.letterSpacing) * scaleX,
          shadows: parseTextShadows(style.textShadow).map(shadow => ({
            color: shadow.color,
            offsetX: shadow.offsetX * scaleX,
            offsetY: shadow.offsetY * scaleY,
            blur: shadow.blur * ((scaleX + scaleY) / 2)
          }))
        });
      });
    });
    return { entries, scaleX, scaleY, stageRect };
  }

  function backgroundPositionRatio(value, axis) {
    const normalized = String(value || "50%").trim().toLowerCase();
    const keywords = axis === "x" ? { left: 0, center: 0.5, right: 1 } : { top: 0, center: 0.5, bottom: 1 };
    if (Object.prototype.hasOwnProperty.call(keywords, normalized)) return keywords[normalized];
    if (normalized.endsWith("%")) return Math.min(1, Math.max(0, cssPixels(normalized) / 100));
    return 0.5;
  }

  function drawCoverBackground(context, image, backgroundPosition = "50% 50%") {
    const imageWidth = image?.naturalWidth || image?.width;
    const imageHeight = image?.naturalHeight || image?.height;
    if (!(imageWidth > 0) || !(imageHeight > 0)) throw new Error("Background image has no dimensions");
    const scale = Math.max(EXPORT_WIDTH / imageWidth, EXPORT_HEIGHT / imageHeight);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    const positions = String(backgroundPosition || "50% 50%").trim().split(/\s+/);
    const positionX = backgroundPositionRatio(positions[0], "x");
    const positionY = backgroundPositionRatio(positions[1] || positions[0], "y");
    context.drawImage(image, -(width - EXPORT_WIDTH) * positionX, -(height - EXPORT_HEIGHT) * positionY, width, height);
  }

  function gradientStops(value) {
    const match = String(value || "").match(/^linear-gradient\((.*)\)$/i);
    if (!match) return [];
    const parts = splitCssList(match[1]);
    if (parts[0] && !/rgba?\(|#/.test(parts[0])) parts.shift();
    const stops = parts.map((part, index) => {
      const color = part.match(/rgba?\([^)]*\)|#[\da-f]{3,8}/i)?.[0];
      const rest = color ? part.replace(color, "") : "";
      const position = rest.match(/-?(?:\d+\.?\d*|\.\d+)%/)?.[0];
      return color ? { color, position: position ? cssPixels(position) / 100 : (parts.length > 1 ? index / (parts.length - 1) : 0) } : null;
    }).filter(Boolean);
    return stops;
  }

  function drawStageShade(context, stage, options = {}) {
    const doc = options.documentObject || stage?.ownerDocument || (typeof document !== "undefined" ? document : null);
    const shade = stage?.querySelector?.(".light-quote-stage__shade");
    const style = shade && doc?.defaultView?.getComputedStyle?.(shade);
    const stops = gradientStops(style?.backgroundImage);
    if (!stops.length) return;
    const gradient = context.createLinearGradient(0, 0, 0, EXPORT_HEIGHT);
    stops.forEach(stop => gradient.addColorStop(Math.min(1, Math.max(0, stop.position)), stop.color));
    context.save();
    context.globalAlpha = Number.isFinite(Number.parseFloat(style.opacity)) ? Number.parseFloat(style.opacity) : 1;
    context.fillStyle = gradient;
    context.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
    context.restore();
  }

  function drawTextRenderPlan(context, plan) {
    plan.entries.forEach(entry => {
      context.save();
      context.font = entry.font;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = entry.color;
      context.globalAlpha = entry.opacity;
      if ("letterSpacing" in context) context.letterSpacing = `${entry.letterSpacing}px`;
      [...entry.shadows].sort((left, right) => right.blur - left.blur).forEach(shadow => {
        context.shadowColor = shadow.color;
        context.shadowBlur = shadow.blur;
        context.shadowOffsetX = shadow.offsetX;
        context.shadowOffsetY = shadow.offsetY;
        context.fillText(entry.text, entry.x, entry.centerY, entry.maxWidth);
      });
      context.shadowColor = "rgba(0,0,0,0)";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
      context.fillText(entry.text, entry.x, entry.centerY, entry.maxWidth);
      context.restore();
    });
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encoding returned no image")), "image/png");
      } catch (error) {
        reject(error);
      }
    });
  }

  async function prepareExportBackground(imageUrl, options = {}) {
    const fetcher = options.fetcher || (typeof fetch === "function" ? fetch : null);
    const urls = options.urlApi || (typeof URL !== "undefined" ? URL : null);
    if (!fetcher || !urls?.createObjectURL || !imageUrl) throw new Error("Background preparation is unavailable");
    const requestUrl = runtimeImageUrl(imageUrl, options.documentObject);
    const report = options.reportDiagnostic || (() => {});
    options.onDiagnostic?.("resolvedBackgroundUrl", requestUrl);
    options.onStage?.("background-fetch");
    report("BG_FETCH_START", { url: requestUrl });
    let response;
    try {
      response = await fetcher(requestUrl, {
        mode: "cors",
        credentials: "omit",
        cache: "no-store"
      });
    } catch (error) {
      report("BG_FETCH_FAIL", errorDiagnostic(error, "background-fetch"));
      throw error;
    }
    const responseType = response?.headers?.get?.("content-type") || "unknown";
    if (!response?.ok) {
      const error = new Error(`Background request failed (${response?.status || "network"})`);
      report("BG_FETCH_FAIL", { status: response?.status || 0, contentType: responseType, ...errorDiagnostic(error, "background-fetch") });
      throw error;
    }
    options.onDiagnostic?.("fetchOk", true);
    let blob;
    try {
      blob = await response.blob();
    } catch (error) {
      report("BG_FETCH_FAIL", { status: response.status, contentType: responseType, ...errorDiagnostic(error, "background-blob") });
      throw error;
    }
    report("BG_FETCH_OK", { status: response.status, contentType: responseType, blobSize: blob?.size || 0 });
    report("BG_BLOB", { stage: "background-blob", contentType: blob?.type || responseType, blobSize: blob?.size || 0 });
    if (!blob?.type?.startsWith("image/") || !blob.size) {
      const error = new Error("Background response is not a usable image");
      report("BG_FETCH_FAIL", { status: response.status, contentType: responseType, blobSize: blob?.size || 0, ...errorDiagnostic(error, "background-blob") });
      throw error;
    }
    let objectUrl;
    try {
      options.onStage?.("background-object-url");
      objectUrl = urls.createObjectURL(blob);
    } catch (error) {
      report("BG_DECODE_FAIL", errorDiagnostic(error, "background-object-url"));
      throw error;
    }
    try {
      options.onStage?.("background-decode");
      report("BG_DECODE_START", { stage: "background-decode" });
      const image = await decodeRasterImage(objectUrl, options.ImageConstructor);
      options.onDiagnostic?.("decodeOk", true);
      report("BG_DECODE_OK", { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
      let released = false;
      const prepared = {
        blob,
        image,
        objectUrl,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        release() {
          if (released) return;
          released = true;
          try {
            if (prepared.image && "src" in prepared.image) prepared.image.src = "";
            prepared.image?.close?.();
          } catch (_) {}
          urls.revokeObjectURL(objectUrl);
          prepared.image = null;
          prepared.blob = null;
        }
      };
      return prepared;
    } catch (error) {
      report("BG_DECODE_FAIL", errorDiagnostic(error, "background-decode"));
      urls.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  async function generateMomentPng(options) {
    const snapshot = options.snapshot;
    const doc = options.documentObject || options.stage?.ownerDocument || (typeof document !== "undefined" ? document : null);
    const diagnostics = options.diagnostics || {};
    const report = options.reportDiagnostic || (() => {});
    const onStage = stage => { diagnostics.stage = stage; };
    const onDiagnostic = (key, value) => { diagnostics[key] = value; };
    diagnostics.backgroundUrl = snapshot.image_url;
    diagnostics.canvas = `${EXPORT_WIDTH}x${EXPORT_HEIGHT}`;
    diagnostics.fetchOk = false;
    diagnostics.decodeOk = false;
    report("EXPORT_START", { stage: "export-start", operationId: diagnostics.operationId || null, backgroundUrl: snapshot.image_url, width: EXPORT_WIDTH, height: EXPORT_HEIGHT });
    if (!doc?.createElement) {
      const error = new Error("PNG Canvas is unavailable");
      report("EXPORT_FAIL", errorDiagnostic(error, "export-start"));
      throw error;
    }
    onStage("fonts");
    try {
      if (doc.fonts?.ready) await doc.fonts.ready;
    } catch (error) {
      report("EXPORT_FAIL", errorDiagnostic(error, "fonts"));
      throw error;
    }
    onStage("layout");
    let textPlan;
    let stageStyle;
    try {
      textPlan = (options.textPlanFactory || createTextRenderPlan)(options.stage, { ...options, documentObject: doc });
      stageStyle = doc.defaultView?.getComputedStyle?.(options.stage);
    } catch (error) {
      report("EXPORT_FAIL", errorDiagnostic(error, "layout"));
      throw error;
    }
    const backgroundPosition = stageStyle?.backgroundPosition || "50% 50%";
    const background = await (options.backgroundPreparer || prepareExportBackground)(snapshot.image_url, {
      ...options,
      documentObject: doc,
      onStage,
      onDiagnostic,
      reportDiagnostic: report
    });
    let canvas = null;
    try {
      onStage("canvas-create");
      let context;
      try {
        canvas = doc.createElement("canvas");
        canvas.width = EXPORT_WIDTH;
        canvas.height = EXPORT_HEIGHT;
        context = canvas.getContext("2d");
        if (!context) throw new Error("PNG Canvas 2D context is unavailable");
        report("CANVAS_CREATE", { stage: "canvas-create", width: canvas.width, height: canvas.height });
      } catch (error) {
        report("CANVAS_CREATE_FAIL", errorDiagnostic(error, "canvas-create"));
        throw error;
      }
      try {
        onStage("canvas-draw-background");
        drawCoverBackground(context, background.image, backgroundPosition);
        drawStageShade(context, options.stage, { ...options, documentObject: doc });
        report("CANVAS_DRAW_BG", { stage: "canvas-draw-background" });
        onStage("canvas-draw-text");
        drawTextRenderPlan(context, { ...textPlan, entries: textPlan.entries.filter(entry => entry.role !== "footer") });
        report("CANVAS_DRAW_TEXT", { stage: "canvas-draw-text", lines: textPlan.entries.filter(entry => entry.role !== "footer").length });
        onStage("canvas-draw-footer");
        drawTextRenderPlan(context, { ...textPlan, entries: textPlan.entries.filter(entry => entry.role === "footer") });
        report("CANVAS_DRAW_FOOTER", { stage: "canvas-draw-footer", lines: textPlan.entries.filter(entry => entry.role === "footer").length });
      } catch (error) {
        report("CANVAS_DRAW_FAIL", errorDiagnostic(error, diagnostics.stage));
        throw error;
      }
      report("CANVAS_DRAW_OK", { width: canvas.width, height: canvas.height });
      onStage("to-blob");
      report("TO_BLOB_START", { stage: "to-blob", width: canvas.width, height: canvas.height });
      let blob;
      try {
        blob = options.exporter ? await options.exporter(canvas) : await canvasToPngBlob(canvas);
      } catch (error) {
        report("TO_BLOB_FAIL", errorDiagnostic(error, "to-blob"));
        throw error;
      }
      diagnostics.toBlobOk = Boolean(blob);
      if (!blob || blob.type !== "image/png") {
        const error = new Error("PNG generation returned no image");
        report("TO_BLOB_FAIL", errorDiagnostic(error, "to-blob"));
        throw error;
      }
      if (blob.size < MIN_EXPORT_BYTES) {
        const error = new Error(`PNG generation returned an implausibly small image (${blob.size} bytes)`);
        report("TO_BLOB_FAIL", { blobSize: blob.size, ...errorDiagnostic(error, "to-blob") });
        throw error;
      }
      report("TO_BLOB_OK", { blobSize: blob.size, type: blob.type });
      onStage("complete");
      report("EXPORT_OK", { stage: "complete", blobSize: blob.size, width: EXPORT_WIDTH, height: EXPORT_HEIGHT });
      return { blob, filename: momentFilename(snapshot), snapshot, width: EXPORT_WIDTH, height: EXPORT_HEIGHT };
    } finally {
      background?.release?.();
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
        canvas = null;
      }
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

  function createObjectUrlStore(urlApi) {
    const urls = urlApi || (typeof URL !== "undefined" ? URL : null);
    let current = null;
    return {
      create(blob) {
        this.revoke();
        current = urls.createObjectURL(blob);
        return current;
      },
      revoke() {
        if (!current) return;
        urls.revokeObjectURL(current);
        current = null;
      },
      get: () => current
    };
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

  async function shareExistingPngFile(file, options = {}) {
    const navigatorObject = options.navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
    const report = options.reportDiagnostic || (() => {});
    if (!file || typeof navigatorObject?.share !== "function") return { mode: "unsupported" };
    report("SHARE_START", {
      userActivation: userActivationState(navigatorObject),
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size
    });
    try {
      await navigatorObject.share({ files: [file], title: "光语录" });
      report("SHARE_OK");
      return { mode: "share", file };
    } catch (error) {
      report("SHARE_FAIL", errorDiagnostic(error));
      return { mode: error?.name === "AbortError" ? "cancelled" : "share-failed", file, error };
    }
  }

  async function deliverMomentPng(result, options = {}) {
    const navigatorObject = options.navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
    const windowObject = options.windowObject || (typeof window !== "undefined" ? window : null);
    const mobile = options.mobile ?? (isTouchDevice(navigatorObject, windowObject) || Number(windowObject?.innerWidth || 0) <= 575);
    if (!mobile) {
      (options.downloader || downloadBlob)(result.blob, result.filename, options.documentObject, options.urlApi);
      options.reportDiagnostic?.("FALLBACK", { mode: "download" });
      return { mode: "download" };
    }
    let file = null;
    try {
      file = createPngFile(result.blob, result.filename, options.FileConstructor);
      if (!file) throw new Error("PNG File is unavailable");
      const fileDetails = {
        stage: "file-create",
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size
      };
      options.reportDiagnostic?.("FILE_CREATED", fileDetails);
      options.reportDiagnostic?.("FILE_CREATE_OK", fileDetails);
    } catch (error) {
      options.reportDiagnostic?.("FILE_CREATE_FAIL", errorDiagnostic(error, "file-create"));
    }
    const hasShare = typeof navigatorObject?.share === "function";
    const hasCanShare = typeof navigatorObject?.canShare === "function";
    options.reportDiagnostic?.("SHARE_CAPABILITIES", { hasShare, hasCanShare });
    let canShareFiles = false;
    if (file && hasCanShare) {
      try {
        canShareFiles = Boolean(navigatorObject.canShare({ files: [file] }));
        options.reportDiagnostic?.("CAN_SHARE", { result: canShareFiles });
      } catch (error) {
        options.reportDiagnostic?.("CAN_SHARE_FAIL", errorDiagnostic(error));
      }
    } else {
      options.reportDiagnostic?.("CAN_SHARE", { result: false });
    }
    const activation = userActivationState(navigatorObject);
    options.reportDiagnostic?.("SHARE_ACTIVATION", { userActivation: activation });
    const present = mode => {
      if (canShareFiles && typeof options.sharePresenter === "function") {
        options.sharePresenter(file, result);
      } else if (typeof options.previewer === "function") {
        options.previewer(result.blob, result.filename, file, canShareFiles);
      } else {
        throw new Error("Image preview is unavailable");
      }
      options.reportDiagnostic?.("FALLBACK", { mode });
    };
    if (file && hasShare && canShareFiles && activation === true) {
      const shared = await shareExistingPngFile(file, { navigatorObject, reportDiagnostic: options.reportDiagnostic });
      if (shared.mode === "share") return shared;
      present(shared.mode === "cancelled" ? "preview-after-cancel" : "preview-after-share-failure");
      return shared;
    }
    if (file && hasShare && canShareFiles) {
      present("second-user-gesture");
      return { mode: "share-ready", file };
    }
    present("preview-download-long-press");
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
      if (adjustButton) adjustButton.textContent = adjustmentMode ? "锁定文字" : "调整文字";
      if (status) status.textContent = adjustmentMode ? "上下拖动文字，调整后请点击“锁定文字”。" : "";
      return adjustmentMode;
    }

    function resetForNewQuote() {
      offsetRatio = 0;
      applyOffset();
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
    textGroup?.addEventListener?.("pointerdown", pointerDown);
    textGroup?.addEventListener?.("pointermove", pointerMove);
    textGroup?.addEventListener?.("pointerup", finishDrag);
    textGroup?.addEventListener?.("pointercancel", finishDrag);
    applyOffset();

    return {
      resetForNewQuote,
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
    const freezeButton = rootElement.querySelector("[data-light-quote-freeze]");
    const preview = rootElement.querySelector("[data-light-quote-image-preview]");
    const previewImage = rootElement.querySelector("[data-light-quote-preview-image]");
    const previewShare = rootElement.querySelector("[data-light-quote-preview-share]");
    const previewDownload = rootElement.querySelector("[data-light-quote-preview-download]");
    const previewClose = rootElement.querySelector("[data-light-quote-preview-close]");
    const navigatorObject = options.navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
    const windowObject = options.windowObject || rootElement.ownerDocument?.defaultView || (typeof window !== "undefined" ? window : null);
    const reportDiagnostic = options.reportDiagnostic || createDebugReporter(rootElement, {
      documentObject: rootElement.ownerDocument,
      windowObject,
      navigatorObject
    });
    const rawPreloadImage = options.imagePreloader || createImagePreloader(options.ImageConstructor);
    const preloadImage = url => rawPreloadImage(url);
    const analyzeBackground = options.backgroundAnalyzer || analyzeTextBackground;
    const textPosition = createTextPositionController({
      stage,
      body: stage?.querySelector?.(".light-quote-stage__body"),
      textGroup: stage?.querySelector?.(".light-quote-stage__glow"),
      footer: stage?.querySelector?.(".light-quote-stage__footer"),
      adjustButton: textAdjustButton,
      status
    });
    let currentQuote = null;
    let currentImage = null;
    let encounterTime = null;
    let renderVersion = 0;
    let currentImagePromise = Promise.resolve(null);
    let textTonePromise = Promise.resolve("light");
    const previewUrls = createObjectUrlStore(options.urlApi);
    let previewFile = null;
    let backgroundBusy = false;
    let exportBusy = false;
    let shareBusy = false;
    let exportOperationSequence = 0;
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
      reportDiagnostic("TEXT_SHADOW", { tone: resolvedTone, ...textShadowDiagnostics(stage, rootElement.ownerDocument) });
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
      textPosition.resetForNewQuote();
      const pad = value => String(value).padStart(2, "0");
      time.textContent = `${encounterTime.getFullYear()}.${pad(encounterTime.getMonth() + 1)}.${pad(encounterTime.getDate())} · ${pad(encounterTime.getHours())}:${pad(encounterTime.getMinutes())}`;
      const version = ++renderVersion;
      stage.className = `light-quote-stage light-quote-stage--${currentImage?.text_safe_area || "flexible"} light-quote-stage--text-light`;
      stage.dataset.textTone = "light";
      reportDiagnostic("TEXT_SHADOW", { tone: "light", ...textShadowDiagnostics(stage, rootElement.ownerDocument) });
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
      previewUrls.revoke();
      previewFile = null;
      if (previewShare) previewShare.hidden = true;
      if (previewDownload) {
        previewDownload.hidden = true;
        previewDownload.removeAttribute("href");
        previewDownload.removeAttribute("download");
      }
      reportDiagnostic("PREVIEW_CLOSED");
    }

    rootElement.ownerDocument?.defaultView?.addEventListener?.("pagehide", closePreview, { once: true });

    function showPreview(blob, filename, file, canShareFile = Boolean(file)) {
      if (!preview || !previewImage) throw new Error("Image preview is unavailable");
      closePreview();
      const previewUrl = previewUrls.create(blob);
      previewFile = file || null;
      previewImage.src = previewUrl;
      previewImage.alt = `${filename}，请长按保存`;
      if (previewShare) previewShare.hidden = !previewFile || !canShareFile;
      if (previewDownload) {
        previewDownload.href = previewUrl;
        previewDownload.download = filename;
        previewDownload.hidden = false;
      }
      preview.hidden = false;
      reportDiagnostic("PREVIEW_READY", { fileName: filename, blobSize: blob.size, canShareFile });
      (!previewShare?.hidden ? previewShare : previewDownload || previewClose)?.focus?.();
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
    previewDownload?.addEventListener("click", () => reportDiagnostic("FALLBACK", { mode: "download-existing-blob" }));
    previewShare?.addEventListener("click", async function () {
      if (shareBusy || !previewFile || typeof navigatorObject?.share !== "function") return;
      const file = previewFile;
      shareBusy = true;
      this.disabled = true;
      try {
        reportDiagnostic("SECOND_CLICK", { userActivation: userActivationState(navigatorObject) });
        const shared = await shareExistingPngFile(file, { navigatorObject, reportDiagnostic });
        if (shared.mode === "share") {
          closePreview();
          status.textContent = "图片已交给系统分享面板。";
        } else if (shared.mode === "cancelled") {
          status.textContent = "已取消分享；PNG 仍保留在预览中。";
        } else {
          status.textContent = "系统分享失败；PNG 仍可下载或长按保存。";
        }
      } finally {
        shareBusy = false;
        this.disabled = false;
      }
    });
    freezeButton?.addEventListener("click", async function () {
      if (exportBusy) return;
      const button = this;
      const snapshot = createMomentSnapshot(currentQuote, currentImage, encounterTime);
      const frozenVersion = renderVersion;
      const operationId = ++exportOperationSequence;
      const userAgent = navigatorObject?.userAgent || "";
      const diagnostics = {
        operationId,
        stage: "queued",
        backgroundUrl: snapshot.image_url,
        fetchOk: false,
        decodeOk: false,
        canvas: `${EXPORT_WIDTH}x${EXPORT_HEIGHT}`,
        toBlobOk: false,
        mobile: isTouchDevice(navigatorObject, typeof window !== "undefined" ? window : null)
          || Number(typeof window !== "undefined" ? window.innerWidth : 0) <= 575,
        ios: /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && Number(navigatorObject?.maxTouchPoints || 0) > 1)
      };
      const originalButtonText = button.textContent;
      exportBusy = true;
      button.disabled = true;
      button.textContent = "生成中…";
      status.textContent = "图片还在准备，请稍候…";
      reportDiagnostic("CLICK", { operationId, userActivation: userActivationState(navigatorObject) });
      try {
        let result;
        try {
          await textTonePromise;
          if (frozenVersion !== renderVersion) throw new Error("Quote changed while preparing the image");
          status.textContent = "正在生成 1080 × 1920 PNG…";
          result = await (options.pngGenerator || generateMomentPng)({ stage, snapshot, diagnostics, reportDiagnostic });
          if (frozenVersion !== renderVersion) throw new Error("Quote changed while generating the image");
          reportDiagnostic("PNG_GENERATION_OK", { operationId, blobSize: result.blob.size });
        } catch (error) {
          reportDiagnostic("PNG_GENERATION_FAIL", { operationId, stage: diagnostics.stage, ...errorDiagnostic(error) });
          console.error("Light quote PNG generation failed", JSON.stringify(diagnostics), error);
          status.textContent = error?.message?.includes("Quote changed")
            ? "当前语录已切换，请重新点击“定格此刻”。"
            : "图片生成失败，请稍后重试。";
          return;
        }
        try { sessionStorage.setItem("light-quote-snapshot", JSON.stringify(snapshot)); } catch (_) {}
        const size = `${(result.blob.size / 1024 / 1024).toFixed(2)} MB`;
        try {
          const delivery = await (options.pngDeliverer || deliverMomentPng)(result, {
            navigatorObject,
            windowObject,
            reportDiagnostic,
            previewer: (blob, filename, file, canShareFile) => showPreview(blob, filename, file, canShareFile),
            sharePresenter: (file, shareResult) => showPreview(shareResult.blob, shareResult.filename, file, true)
          });
          if (delivery.mode === "download") status.textContent = `PNG 已生成并开始下载：1080 × 1920，${size}`;
          if (delivery.mode === "share") status.textContent = `PNG 已生成并交给系统分享：1080 × 1920，${size}`;
          if (delivery.mode === "share-ready") status.textContent = `图片已生成，请点击“保存 / 分享图片”：1080 × 1920，${size}`;
          if (delivery.mode === "preview") status.textContent = `图片已生成，请下载或长按预览图保存：1080 × 1920，${size}`;
          if (delivery.mode === "cancelled") status.textContent = "已取消分享；PNG 仍保留在预览中。";
          if (delivery.mode === "share-failed") status.textContent = "PNG 已生成；系统分享失败，仍可下载或长按保存。";
        } catch (error) {
          reportDiagnostic("DELIVERY_FAIL", errorDiagnostic(error));
          console.error("Light quote PNG delivery failed", error);
          status.textContent = `PNG 已生成，但保存界面打开失败：1080 × 1920，${size}`;
        }
      } finally {
        exportBusy = false;
        button.disabled = false;
        button.textContent = originalButtonText;
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
      isExportBusy: () => exportBusy,
      isShareBusy: () => shareBusy,
      getTextOffsetRatio: textPosition.getOffsetRatio,
      isTextAdjustmentMode: textPosition.isAdjustmentMode,
      isTextDragging: textPosition.isDragging
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
    LIGHT_QUOTES_BUILD,
    MIN_EXPORT_BYTES,
    READY_IMAGE_QUEUE_LIMIT,
    READABLE_CONTRAST_RATIO,
    analyzeTextBackground,
    candidateImages,
    chooseImage,
    createTextRenderPlan,
    contrastMetrics,
    contrastRatio,
    clampTextOffset,
    copyTextValue,
    coverSampleRect,
    createImagePreloader,
    createObjectUrlStore,
    createReadyImageQueue,
    createTextPositionController,
    createMomentSnapshot,
    createDebugReporter,
    createPngFile,
    decodeRasterImage,
    deliverMomentPng,
    downloadBlob,
    drawCoverBackground,
    drawStageShade,
    drawTextRenderPlan,
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
    parseTextShadows,
    resolveQuote,
    runtimeImageUrl,
    sampleTextPixels,
    shareExistingPngFile,
    textContrastComparison,
    textLineRects,
    textOffsetBounds,
    textToneForPixels,
    technicalTitle,
    textShadowDiagnostics,
    userActivationState
  };
});
