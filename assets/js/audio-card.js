(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AudioCard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const initializedCards = typeof WeakSet === "function" ? new WeakSet() : null;

  function smoothScrollTo(container, target) {
    if (!container || !target) return;
    const targetTop = target.offsetTop - container.offsetTop;
    const start = container.scrollTop;
    const end = targetTop - container.clientHeight / 2 + target.clientHeight / 2;
    const distance = end - start;
    const duration = 400;
    const startTime = performance.now();

    function step(now) {
      const progress = Math.min((now - startTime) / duration, 1);
      const ease = 0.5 - Math.cos(progress * Math.PI) / 2;
      container.scrollTop = start + distance * ease;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function renderSubtitleSegments(container, data) {
    const fragment = document.createDocumentFragment();
    data.forEach(segment => {
      const paragraph = document.createElement("p");
      paragraph.dataset.start = String(segment.start);
      paragraph.dataset.end = String(segment.end);
      paragraph.style.margin = "0.4em 0";
      paragraph.textContent = String(segment.text || "");
      fragment.appendChild(paragraph);
    });
    container.replaceChildren(fragment);
    return Array.from(container.querySelectorAll("p"));
  }

  function initSubtitle(card) {
    const button = card.querySelector(".show-subtitles");
    const audio = card.querySelector("audio");
    const container = card.querySelector(".subtitle-box");
    if (!button || !audio || !container) return;

    let subtitles = [];
    let currentIndex = -1;
    let loadingPromise = null;

    const highlightSubtitles = () => {
      if (!subtitles.length) return;
      const time = audio.currentTime;
      const index = subtitles.findIndex(paragraph =>
        time >= Number(paragraph.dataset.start) && time <= Number(paragraph.dataset.end)
      );
      if (index < 0 || index === currentIndex) return;
      subtitles.forEach((paragraph, paragraphIndex) => {
        paragraph.classList.toggle("is-current-subtitle", paragraphIndex === index);
      });
      smoothScrollTo(container, subtitles[index]);
      currentIndex = index;
    };

    const loadSubtitles = () => {
      if (subtitles.length) return Promise.resolve(subtitles);
      if (loadingPromise) return loadingPromise;
      loadingPromise = fetch(button.dataset.subtitle)
        .then(response => {
          if (!response.ok) throw new Error(`字幕载入失败：${response.status}`);
          return response.json();
        })
        .then(data => {
          if (!Array.isArray(data)) throw new Error("字幕格式无效");
          subtitles = renderSubtitleSegments(container, data);
          currentIndex = -1;
          return subtitles;
        })
        .catch(error => {
          container.textContent = "加载字幕失败。";
          container.classList.add("subtitle-box--error");
          console.error("字幕加载失败：", error);
          throw error;
        });
      return loadingPromise;
    };

    button.addEventListener("click", async () => {
      const isHidden = container.hidden || getComputedStyle(container).display === "none";
      if (isHidden) {
        container.hidden = false;
        container.style.display = "block";
        button.textContent = "关闭字幕";
        button.setAttribute("aria-expanded", "true");
        try {
          await loadSubtitles();
          highlightSubtitles();
        } catch (_) {
          // Error state is rendered in the subtitle container.
        }
      } else {
        container.hidden = true;
        container.style.display = "none";
        button.textContent = "显示字幕";
        button.setAttribute("aria-expanded", "false");
        currentIndex = -1;
      }
    });

    ["timeupdate", "play", "loadedmetadata"].forEach(eventName =>
      audio.addEventListener(eventName, highlightSubtitles)
    );
    audio.addEventListener("seeked", () => {
      currentIndex = -1;
      highlightSubtitles();
    });
  }

  function initPlayback(card) {
    const audio = card.querySelector("audio");
    if (!audio) return;
    audio.addEventListener("play", () => {
      document.querySelectorAll("article.audio-card audio").forEach(otherAudio => {
        if (otherAudio !== audio && !otherAudio.paused) otherAudio.pause();
      });
      card.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center"
      });
    });
    audio.addEventListener("ended", () => {
      if (audio.currentTime === 0) return;
      const audios = Array.from(document.querySelectorAll("article.audio-card audio"));
      const nextAudio = audios[audios.indexOf(audio) + 1];
      if (nextAudio) nextAudio.play().catch(() => {});
    });
  }

  function init(scope) {
    if (typeof document === "undefined") return;
    const root = scope && scope.querySelectorAll ? scope : document;
    const cards = root.matches?.("article.audio-card")
      ? [root]
      : Array.from(root.querySelectorAll("article.audio-card"));
    cards.forEach(card => {
      if (initializedCards?.has(card)) return;
      initializedCards?.add(card);
      initSubtitle(card);
      initPlayback(card);
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => init(document), { once: true });
    } else {
      init(document);
    }
  }

  return { init, renderSubtitleSegments };
});
