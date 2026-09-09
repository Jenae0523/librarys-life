(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LightQuotes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EXPORT_WIDTH = 1080;
  const EXPORT_HEIGHT = 1920;
  const TEXT_TONE_THRESHOLD = 0.24;

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

  function chooseImage(quote, images, random = Math.random) {
    return randomItem(matchingImages(quote, images), random);
  }

  function channelLuminance(value) {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }

  function textToneForPixels(pixelData, threshold = TEXT_TONE_THRESHOLD) {
    if (!pixelData?.length) return "dark";
    let luminance = 0;
    let pixels = 0;
    for (let index = 0; index + 3 < pixelData.length; index += 4) {
      if (pixelData[index + 3] === 0) continue;
      luminance += 0.2126 * channelLuminance(pixelData[index])
        + 0.7152 * channelLuminance(pixelData[index + 1])
        + 0.0722 * channelLuminance(pixelData[index + 2]);
      pixels += 1;
    }
    if (!pixels) return "dark";
    return luminance / pixels < threshold ? "light" : "dark";
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

  async function analyzeTextBackground(stage, imageUrl, options = {}) {
    const textGroup = stage?.querySelector?.(".light-quote-stage__glow");
    const documentObject = options.documentObject || stage?.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!stage || !textGroup || !documentObject || !imageUrl) return "dark";
    const image = await loadRasterImage(new URL(imageUrl, documentObject.baseURI).href, options.ImageConstructor);
    if (typeof requestAnimationFrame === "function") await new Promise(resolve => requestAnimationFrame(resolve));
    const sample = coverSampleRect(stage.getBoundingClientRect(), textGroup.getBoundingClientRect(), image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (!sample) return "dark";
    const canvas = documentObject.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "dark";
    context.drawImage(image, sample.x, sample.y, sample.width, sample.height, 0, 0, canvas.width, canvas.height);
    return textToneForPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, options.threshold);
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
    return blob;
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
    const snapshot = options.snapshot;
    const blob = await (options.exporter || exportStagePng)(options.stage);
    const filename = momentFilename(snapshot);
    (options.downloader || downloadBlob)(blob, filename);
    return { blob, filename, snapshot, width: EXPORT_WIDTH, height: EXPORT_HEIGHT };
  }

  function resolveQuote(quotes, requestedId, random = Math.random) {
    const items = Array.isArray(quotes) ? quotes : [];
    return items.find(quote => quote.lq_id === requestedId) || randomItem(items, random);
  }

  function initMainPage(rootElement, options = {}) {
    if (!rootElement) return null;
    const quotes = options.quotes || [];
    const images = options.images || [];
    const random = options.random || Math.random;
    const stage = rootElement.querySelector("[data-light-quote-stage]");
    const text = rootElement.querySelector("[data-light-quote-text]");
    const source = rootElement.querySelector("[data-light-quote-source]");
    const sourceBook = rootElement.querySelector("[data-light-quote-book]");
    const sourceAuthor = rootElement.querySelector("[data-light-quote-author]");
    const time = rootElement.querySelector("[data-light-quote-time]");
    const status = rootElement.querySelector("[data-light-quote-status]");
    let currentQuote = null;
    let currentImage = null;
    let encounterTime = null;
    let renderVersion = 0;
    let textTonePromise = Promise.resolve("dark");

    function applyTextTone(tone) {
      const resolvedTone = tone === "light" ? "light" : "dark";
      stage.classList.toggle("light-quote-stage--text-light", resolvedTone === "light");
      stage.classList.toggle("light-quote-stage--text-dark", resolvedTone === "dark");
      stage.dataset.textTone = resolvedTone;
      return resolvedTone;
    }

    function render(quote, updateUrl) {
      if (!quote) return;
      currentQuote = quote;
      currentImage = chooseImage(quote, images, random);
      encounterTime = new Date();
      text.textContent = quote.quote_text;
      if (sourceBook && sourceAuthor) {
        sourceBook.textContent = quote.book_title;
        sourceAuthor.textContent = quote.author;
      } else {
        source.textContent = `${quote.book_title}\n${quote.author}`;
      }
      const pad = value => String(value).padStart(2, "0");
      time.textContent = `${encounterTime.getFullYear()}.${pad(encounterTime.getMonth() + 1)}.${pad(encounterTime.getDate())} · ${pad(encounterTime.getHours())}:${pad(encounterTime.getMinutes())}`;
      const version = ++renderVersion;
      stage.className = `light-quote-stage light-quote-stage--${currentImage?.text_safe_area || "flexible"} light-quote-stage--text-dark`;
      stage.dataset.textTone = "dark";
      if (currentImage) stage.style.backgroundImage = `url("${String(currentImage.url).replace(/"/g, "%22")}")`;
      textTonePromise = currentImage
        ? analyzeTextBackground(stage, currentImage.url)
          .then(tone => version === renderVersion ? applyTextTone(tone) : tone)
          .catch(() => version === renderVersion ? applyTextTone("dark") : "dark")
        : Promise.resolve(applyTextTone("dark"));
      rootElement.dataset.currentQuote = quote.lq_id;
      if (updateUrl && typeof history !== "undefined") {
        const url = new URL(location.href);
        url.searchParams.set("quote", quote.lq_id);
        history.replaceState({}, "", url);
      }
      document.title = `${technicalTitle(quote.quote_text)}・光语录・生命之书 | librarys.life`;
      status.textContent = "";
    }

    function chooseNext() {
      const pool = quotes.length > 1 ? quotes.filter(quote => quote.lq_id !== currentQuote?.lq_id) : quotes;
      render(randomItem(pool, random), true);
    }

    const requestedId = new URL(location.href).searchParams.get("quote");
    render(resolveQuote(quotes, requestedId, random), false);

    rootElement.querySelector("[data-light-quote-next]")?.addEventListener("click", chooseNext);
    rootElement.querySelector("[data-light-quote-copy]")?.addEventListener("click", async function () {
      const shareUrl = new URL("/light-quotes/", location.origin);
      shareUrl.searchParams.set("quote", currentQuote.lq_id);
      const value = `「${currentQuote.quote_text}」\n${currentQuote.book_title} │ ${currentQuote.author}\n${shareUrl.href}`;
      try {
        await navigator.clipboard.writeText(value);
        status.textContent = "文字与固定语录链接已复制。";
      } catch (_) {
        status.textContent = "复制失败，请手动选择文字。";
      }
    });
    rootElement.querySelector("[data-light-quote-freeze]")?.addEventListener("click", async function () {
      const button = this;
      const snapshot = createMomentSnapshot(currentQuote, currentImage, encounterTime);
      button.disabled = true;
      status.textContent = "正在生成 1080 × 1920 PNG…";
      try {
        await textTonePromise;
        const result = await freezeCurrentMoment({ stage, snapshot });
        try { sessionStorage.setItem("light-quote-snapshot", JSON.stringify(snapshot)); } catch (_) {}
        const size = `${(result.blob.size / 1024 / 1024).toFixed(2)} MB`;
        status.textContent = `PNG 已生成并开始下载：1080 × 1920，${size}`;
      } catch (error) {
        console.error("Light quote PNG export failed", error);
        status.textContent = "图片生成失败，请稍后重试。";
      } finally {
        button.disabled = false;
      }
    });
    return { render, chooseNext, getTextTone: () => stage.dataset.textTone || "dark" };
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
    EXPORT_HEIGHT,
    EXPORT_WIDTH,
    TEXT_TONE_THRESHOLD,
    analyzeTextBackground,
    chooseImage,
    coverSampleRect,
    createMomentSnapshot,
    downloadBlob,
    exportStagePng,
    freezeCurrentMoment,
    initMainPage,
    initPreviewModules,
    initTagModule,
    initTagModules,
    loadRasterImage,
    matchingImages,
    momentFilename,
    resolveQuote,
    textToneForPixels,
    technicalTitle
  };
});
