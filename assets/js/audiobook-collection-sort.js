(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AudiobookCollectionSort = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function asNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function asTime(value) {
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function sortEpisodeRecords(records, mode) {
    const items = Array.from(records || []);
    return items.sort((left, right) => {
      const leftNumber = asNumber(left.number);
      const rightNumber = asNumber(right.number);
      if (mode === "latest") {
        return asTime(right.date) - asTime(left.date) || rightNumber - leftNumber;
      }
      return leftNumber - rightNumber;
    });
  }

  function init() {
    if (typeof document === "undefined") return;
    document.querySelectorAll("[data-audiobook-episode-list]").forEach(list => {
      const select = list.querySelector("[data-audiobook-sort]");
      if (!select || select.dataset.sortReady === "true") return;
      select.dataset.sortReady = "true";
      select.addEventListener("change", () => {
        const nodes = Array.from(list.querySelectorAll(":scope > [data-audio-episode]"));
        const records = nodes.map(node => ({
          node,
          number: node.dataset.audioNumber,
          date: node.dataset.audioDate
        }));
        const sorted = sortEpisodeRecords(records, select.value);
        const fragment = document.createDocumentFragment();
        sorted.forEach(record => fragment.appendChild(record.node));
        const share = list.querySelector(":scope > .sharethis-inline-share-buttons");
        list.insertBefore(fragment, share || null);
      });
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
  }

  return { init, sortEpisodeRecords };
});
