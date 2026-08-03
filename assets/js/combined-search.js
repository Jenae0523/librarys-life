(function combinedSearchModule(root, factory) {
  const articleSearch = typeof module === "object" && module.exports
    ? require("./article-search")
    : root?.ArticleSearch;
  const audiobookSearch = typeof module === "object" && module.exports
    ? require("./audiobook-search")
    : root?.AudiobookSearch;
  const api = factory(articleSearch, audiobookSearch);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  root.CombinedSearch = api;
  const start = () => api.initCombinedSearch();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (ArticleSearch, AudiobookSearch) {
  "use strict";

  const TYPE_ORDER = ["articles", "audio"];
  const DEFAULT_TYPES = TYPE_ORDER.slice();
  const PAGE_SIZE = 20;
  const PLACEHOLDERS = {
    "articles,audio": "搜索文章、有声书、播客与字幕",
    articles: "搜索文章",
    audio: "搜索有声书、播客与字幕"
  };
  let articleIndexPromise = null;
  let audioIndexPromise = null;

  function loadJson(url) {
    return fetch(url).then(response => {
      if (!response.ok) throw new Error(`${url} 载入失败：${response.status}`);
      return response.json();
    });
  }

  function loadArticlePayload() {
    articleIndexPromise ||= loadJson("/search/articles-index.json");
    return articleIndexPromise;
  }

  function loadAudioPayload() {
    audioIndexPromise ||= loadJson("/search/audiobooks-index.json");
    return audioIndexPromise;
  }

  function normalizeTypes(value) {
    if (value == null || String(value).trim() === "") return DEFAULT_TYPES.slice();
    const tokens = Array.isArray(value)
      ? value.map(item => String(item).trim()).filter(Boolean)
      : String(value).split(",").map(item => item.trim()).filter(Boolean);
    if (!tokens.length || tokens.some(type => !TYPE_ORDER.includes(type))) {
      return DEFAULT_TYPES.slice();
    }
    const unique = new Set(tokens);
    return TYPE_ORDER.filter(type => unique.has(type));
  }

  function serializeTypes(types) {
    return normalizeTypes(types).join(",");
  }

  function placeholderForTypes(types) {
    return PLACEHOLDERS[serializeTypes(types)] || PLACEHOLDERS["articles,audio"];
  }

  function normalizePage(value) {
    const page = Number.parseInt(value, 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function paginateResults(results, requestedPage, pageSize = PAGE_SIZE) {
    const items = Array.isArray(results) ? results : [];
    const size = Math.max(1, normalizePage(pageSize));
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    const page = Math.min(normalizePage(requestedPage), pageCount);
    const start = (page - 1) * size;
    return {
      results: items.slice(start, start + size),
      page,
      pageCount,
      total: items.length
    };
  }

  function readUrlState(urlValue) {
    const url = urlValue instanceof URL
      ? urlValue
      : new URL(String(urlValue || ""), "https://example.invalid/search/");
    return {
      query: url.searchParams.get("q") || "",
      types: normalizeTypes(url.searchParams.get("types")),
      category: url.searchParams.get("category") || "",
      tag: url.searchParams.get("tag") || "",
      articlesSort: url.searchParams.get("articlesSort") === "latest" ? "latest" : "relevance",
      articlesPage: normalizePage(url.searchParams.get("articlesPage")),
      audioCollection: url.searchParams.get("audioCollection") || "",
      audioTag: url.searchParams.get("audioTag") || "",
      audioSort: url.searchParams.get("audioSort") === "latest" ? "latest" : "relevance",
      audioPage: normalizePage(url.searchParams.get("audioPage"))
    };
  }

  function writeUrlState(urlValue, state = {}) {
    const url = urlValue instanceof URL
      ? new URL(urlValue.href)
      : new URL(String(urlValue || ""), "https://example.invalid/search/");
    const query = String(state.query || "").trim();
    const types = normalizeTypes(state.types);
    url.searchParams.delete("q");
    url.searchParams.delete("types");
    url.searchParams.delete("category");
    url.searchParams.delete("tag");
    url.searchParams.delete("articlesSort");
    url.searchParams.delete("articlesPage");
    url.searchParams.delete("audioCollection");
    url.searchParams.delete("audioTag");
    url.searchParams.delete("audioSort");
    url.searchParams.delete("audioPage");
    if (query) url.searchParams.set("q", query);
    url.searchParams.set("types", serializeTypes(types));
    if (state.category) url.searchParams.set("category", String(state.category));
    if (state.tag) url.searchParams.set("tag", String(state.tag));
    url.searchParams.set("articlesSort", state.articlesSort === "latest" ? "latest" : "relevance");
    if (state.audioCollection) url.searchParams.set("audioCollection", String(state.audioCollection));
    if (state.audioTag) url.searchParams.set("audioTag", String(state.audioTag));
    url.searchParams.set("audioSort", state.audioSort === "latest" ? "latest" : "relevance");
    if (query && types.includes("articles") && normalizePage(state.articlesPage) > 1) {
      url.searchParams.set("articlesPage", String(normalizePage(state.articlesPage)));
    }
    if (query && types.includes("audio") && normalizePage(state.audioPage) > 1) {
      url.searchParams.set("audioPage", String(normalizePage(state.audioPage)));
    }
    return url;
  }

  function selectedTypes(checkboxes) {
    return TYPE_ORDER.filter(type =>
      checkboxes.some(checkbox => checkbox.value === type && checkbox.checked)
    );
  }

  function applyTypes(checkboxes, types) {
    const selected = new Set(normalizeTypes(types));
    checkboxes.forEach(checkbox => {
      checkbox.checked = selected.has(checkbox.value);
    });
  }

  function setupEntry(entry, options = {}) {
    if (!entry || entry.dataset.combinedSearchReady === "true") return null;
    entry.dataset.combinedSearchReady = "true";
    const form = entry.querySelector("[data-combined-search-form]");
    const input = entry.querySelector("[data-combined-search-input]");
    const hiddenTypes = entry.querySelector("[data-combined-search-types-value]");
    const status = entry.querySelector("[data-combined-search-status]");
    const clearButton = entry.querySelector("[data-combined-search-clear]");
    const checkboxes = [...entry.querySelectorAll("[data-combined-search-type]")];
    if (!form || !input || !hiddenTypes || checkboxes.length !== 2) return null;
    const updateStatus = (prefix = "") => {
      status.textContent = prefix;
    };

    const sync = () => {
      const types = selectedTypes(checkboxes);
      hiddenTypes.value = serializeTypes(types);
      input.placeholder = placeholderForTypes(types);
      input.setAttribute("aria-label", input.placeholder);
      return types;
    };

    applyTypes(checkboxes, options.initialTypes || DEFAULT_TYPES);
    if (options.initialQuery != null) input.value = String(options.initialQuery);
    sync();
    updateStatus();

    checkboxes.forEach(checkbox => {
      checkbox.addEventListener("change", () => {
        if (!selectedTypes(checkboxes).length) {
          checkbox.checked = true;
          updateStatus("搜索范围至少保留一项，已为你保留当前选项。");
          sync();
          return;
        }
        const types = sync();
        updateStatus();
        options.onTypesChange?.({ query: input.value.trim(), types });
      });
    });

    form.addEventListener("submit", event => {
      const types = sync();
      if (options.onSubmit) {
        event.preventDefault();
        options.onSubmit({ query: input.value.trim(), types });
      }
    });

    clearButton?.addEventListener("click", () => {
      input.value = "";
      options.onClear?.({ types: sync() });
      input.focus();
    });

    return {
      form,
      input,
      status,
      checkboxes,
      getTypes: () => selectedTypes(checkboxes),
      setState(state) {
        applyTypes(checkboxes, state.types);
        input.value = String(state.query || "");
        sync();
      }
    };
  }

  function renderArticleResults(results, payload) {
    const tagByName = ArticleSearch.buildCanonicalTagLookup(payload?.query_tags);
    return results.map(result => ArticleSearch.renderResult(result, tagByName)).join("");
  }

  function renderAudioResults(result, payload) {
    const tagsById = new Map((payload?.query_tags || []).map(tag => [tag.id, tag]));
    if (result.mode === "collection") {
      return result.results.length
        ? AudiobookSearch.renderCollectionResult(result.results[0].record)
        : "";
    }
    return result.results.map(item => item.record.subtype === "collection"
      ? AudiobookSearch.renderCollectionResult(item.record)
      : AudiobookSearch.renderEpisodeResult(item, tagsById)
    ).join("");
  }

  function filterArticleResults(results, payload, state = {}) {
    const source = Array.isArray(results) ? results : [];
    const categoryFacets = ArticleSearch.buildCategoryFacets(source);
    const requestedCategory = String(state.category || "");
    const category = categoryFacets.options.some(option => String(option.id) === requestedCategory)
      ? requestedCategory
      : "";
    const categoryResults = ArticleSearch.filterResultsByCategory(
      source,
      category,
      categoryFacets.registry
    );
    const tagFacets = ArticleSearch.buildTagFacets(
      source,
      payload?.query_tags,
      categoryResults
    );
    const visibleTagFacets = ArticleSearch.buildVisibleTagFacets(tagFacets, state.tag);
    const requestedTag = String(state.tag || "");
    const tag = visibleTagFacets.some(option =>
      String(option.canonical_id || option.id) === requestedTag
    ) ? requestedTag : "";
    const tagResults = ArticleSearch.filterResultsByTag(categoryResults, tag);
    const articlesSort = state.articlesSort === "latest" ? "latest" : "relevance";
    return {
      results: ArticleSearch.sortFacetedResults(tagResults, articlesSort),
      category,
      categoryOptions: categoryFacets.options,
      categoryTotal: source.length,
      tag,
      tagOptions: visibleTagFacets,
      tagTotal: categoryResults.length,
      articlesSort
    };
  }

  function pageNumbers(page, pageCount) {
    const visible = Math.min(5, pageCount);
    const start = Math.max(1, Math.min(page - 2, pageCount - visible + 1));
    return Array.from({ length: visible }, (_, index) => start + index);
  }

  function renderPagination(container, type, pagination) {
    if (!container || pagination.pageCount <= 1) {
      if (container) {
        container.hidden = true;
        container.innerHTML = "";
      }
      return;
    }
    const label = type === "articles" ? "文章" : "有声书";
    const button = (text, page, disabled = false, current = false, ariaLabel = "") => `
      <button
        class="site-pagination__button"
        type="button"
        data-combined-search-page="${page}"
        ${disabled ? "disabled" : ""}
        ${current ? 'aria-current="page"' : ""}
        ${ariaLabel ? `aria-label="${ariaLabel}"` : ""}
      >${text}</button>
    `;
    container.innerHTML = [
      button("‹", Math.max(1, pagination.page - 1), pagination.page === 1, false, `${label}结果上一页`),
      ...pageNumbers(pagination.page, pagination.pageCount).map(page =>
        button(String(page), page, false, page === pagination.page, `${label}结果第 ${page} 页`)
      ),
      button("›", Math.min(pagination.pageCount, pagination.page + 1), pagination.page === pagination.pageCount, false, `${label}结果下一页`),
      `<span class="site-pagination__status">第 ${pagination.page} / ${pagination.pageCount} 页</span>`
    ].join("");
    container.hidden = false;
  }

  function searchSections(articlePayload, audioPayload, transcriptShards, query, types) {
    const enabled = normalizeTypes(types);
    return {
      articles: enabled.includes("articles")
        ? ArticleSearch.search(articlePayload, query, { sort: "relevance" })
        : null,
      audio: enabled.includes("audio")
        ? AudiobookSearch.search(audioPayload, query, transcriptShards, { sort: "relevance" })
        : null
    };
  }

  function initCombinedSearchPage(pageRoot) {
    if (!pageRoot || !ArticleSearch || !AudiobookSearch) return;
    const entry = pageRoot.querySelector("[data-combined-search-entry]");
    const summary = pageRoot.querySelector("[data-combined-search-summary]");
    const allEmpty = pageRoot.querySelector("[data-combined-search-empty-all]");
    const categorySelect = pageRoot.querySelector("[data-combined-search-category]");
    const tagSelect = pageRoot.querySelector("[data-combined-search-tag]");
    const articlesSortSelect = pageRoot.querySelector("[data-combined-search-articles-sort]");
    const audioCollectionSelect = pageRoot.querySelector("[data-combined-search-audio-collection]");
    const audioTagSelect = pageRoot.querySelector("[data-combined-search-audio-tag]");
    const audioSortSelect = pageRoot.querySelector("[data-combined-search-audio-sort]");
    const sectionElements = Object.fromEntries(TYPE_ORDER.map(type => [
      type,
      {
        section: pageRoot.querySelector(`[data-combined-search-section="${type}"]`),
        count: pageRoot.querySelector(`[data-combined-search-count="${type}"]`),
        results: pageRoot.querySelector(`[data-combined-search-results="${type}"]`),
        empty: pageRoot.querySelector(`[data-combined-search-empty="${type}"]`),
        pagination: pageRoot.querySelector(`[data-combined-search-pagination="${type}"]`)
      }
    ]));
    const initialState = readUrlState(window.location.href);
    let audioShardsPromise = null;
    let requestSerial = 0;
    let currentSettled = null;
    let currentState = initialState;

    const loadAudioShards = payload => {
      if (audioShardsPromise) return audioShardsPromise;
      const slugs = (payload.records || [])
        .filter(record => record.subtype === "collection")
        .map(record => record.book_slug);
      audioShardsPromise = Promise.all(slugs.map(slug =>
        loadJson(`/search/audiobook-transcripts/${encodeURIComponent(slug)}.json`)
          .then(shard => [slug, shard])
      )).then(entries => new Map(entries));
      return audioShardsPromise;
    };

    function updateUrl(state, mode) {
      if (mode === "none") return;
      const url = writeUrlState(window.location.href, state);
      history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
    }

    function resetArticleFilterControls(state = {}) {
      ArticleSearch.populateFacetSelect(categorySelect, "全部栏目", 0, [], "");
      ArticleSearch.populateFacetSelect(tagSelect, "全部知识点", 0, [], "");
      articlesSortSelect.value = state.articlesSort === "latest" ? "latest" : "relevance";
    }

    function renderArticleFilterControls(filtered) {
      ArticleSearch.populateFacetSelect(
        categorySelect,
        "全部栏目",
        filtered.categoryTotal,
        filtered.categoryOptions,
        filtered.category
      );
      ArticleSearch.populateFacetSelect(
        tagSelect,
        "全部知识点",
        filtered.tagTotal,
        filtered.tagOptions,
        filtered.tag
      );
      articlesSortSelect.value = filtered.articlesSort;
    }

    function resetAudioFilterControls(state = {}) {
      AudiobookSearch.populateFacetSelect(audioCollectionSelect, "全部合集", 0, [], "");
      AudiobookSearch.populateFacetSelect(audioTagSelect, "全部知识点", 0, [], "");
      audioSortSelect.value = state.audioSort === "latest" ? "latest" : "relevance";
    }

    function renderAudioFilterControls(filtered) {
      AudiobookSearch.populateFacetSelect(
        audioCollectionSelect,
        "全部合集",
        filtered.collectionTotal,
        filtered.collectionOptions,
        filtered.audioCollection
      );
      AudiobookSearch.populateFacetSelect(
        audioTagSelect,
        "全部知识点",
        filtered.tagTotal,
        filtered.tagOptions,
        filtered.audioTag
      );
      audioSortSelect.value = filtered.audioSort;
    }

    function resetDisplay(types, state, message) {
      TYPE_ORDER.forEach(type => {
        const elements = sectionElements[type];
        elements.section.hidden = true;
        elements.results.innerHTML = "";
        elements.empty.hidden = true;
        elements.count.textContent = "0";
        renderPagination(elements.pagination, type, { pageCount: 1 });
      });
      allEmpty.hidden = true;
      allEmpty.innerHTML = "";
      summary.textContent = message || "输入关键词后，将按内容类型分别显示结果。";
      resetArticleFilterControls(state);
      resetAudioFilterControls(state);
      types.forEach(type => {
        sectionElements[type].section.hidden = true;
      });
    }

    function renderSettled(settled, state, options = {}) {
      const query = String(state.query || "").trim();
      const types = normalizeTypes(state.types);
      const normalizedState = {
        query,
        types,
        category: String(state.category || ""),
        tag: String(state.tag || ""),
        articlesSort: state.articlesSort === "latest" ? "latest" : "relevance",
        articlesPage: normalizePage(state.articlesPage),
        audioCollection: String(state.audioCollection || ""),
        audioTag: String(state.audioTag || ""),
        audioSort: state.audioSort === "latest" ? "latest" : "relevance",
        audioPage: normalizePage(state.audioPage)
      };
      let total = 0;
      let failed = 0;
      settled.forEach(([type, outcome]) => {
        const elements = sectionElements[type];
        elements.section.hidden = false;
        if (outcome.error) {
          failed += 1;
          elements.empty.hidden = false;
          elements.empty.textContent = type === "articles"
            ? "文章搜索暂时不可用，请稍后重试。"
            : "音频搜索暂时不可用，请稍后重试。";
          renderPagination(elements.pagination, type, { pageCount: 1 });
          return;
        }
        let visibleResults = outcome.value.result.results;
        if (type === "articles") {
          const filtered = filterArticleResults(
            visibleResults,
            outcome.value.payload,
            normalizedState
          );
          visibleResults = filtered.results;
          normalizedState.category = filtered.category;
          normalizedState.tag = filtered.tag;
          normalizedState.articlesSort = filtered.articlesSort;
          renderArticleFilterControls(filtered);
        } else {
          const filtered = AudiobookSearch.filterFacetedResults(
            visibleResults,
            outcome.value.payload,
            normalizedState
          );
          visibleResults = filtered.results;
          normalizedState.audioCollection = filtered.audioCollection;
          normalizedState.audioTag = filtered.audioTag;
          normalizedState.audioSort = filtered.audioSort;
          renderAudioFilterControls(filtered);
        }
        const count = visibleResults.length;
        const pageKey = `${type}Page`;
        const pagination = paginateResults(visibleResults, normalizedState[pageKey]);
        normalizedState[pageKey] = pagination.page;
        total += count;
        elements.count.textContent = String(count);
        elements.results.innerHTML = type === "articles"
          ? renderArticleResults(pagination.results, outcome.value.payload)
          : renderAudioResults({ ...outcome.value.result, results: pagination.results }, outcome.value.payload);
        elements.empty.hidden = count > 0;
        elements.empty.textContent = type === "articles"
          ? "文章中没有找到相关结果。"
          : "有声书、播客与字幕中没有找到相关结果。";
        renderPagination(elements.pagination, type, pagination);
      });

      window.AudioCard?.init(sectionElements.audio.results);
      if (!total && !failed && types.length === TYPE_ORDER.length) {
        settled.forEach(([type]) => {
          sectionElements[type].empty.hidden = true;
        });
        allEmpty.hidden = false;
        allEmpty.innerHTML = `
          <p><strong>没有找到与“${ArticleSearch.highlightHtml(query, [])}”相关的内容。</strong></p>
          <p>可以尝试缩短关键词，或清空后重新搜索。</p>
          <button class="article-search-button article-search-button--secondary" type="button" data-combined-search-clear-all>清空搜索</button>
        `;
      }
      summary.textContent = failed
        ? `已找到 ${total} 个结果，另有 ${failed} 个分区载入失败。`
        : `共找到 ${total} 个结果，已按内容类型分区显示。`;
      currentState = normalizedState;
      updateUrl(normalizedState, options.historyMode || "replace");
      if (options.scrollType) {
        sectionElements[options.scrollType].section.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    async function runSearch(state, options = {}) {
      const query = String(state.query || "").trim();
      const types = normalizeTypes(state.types);
      const requestedState = {
        query,
        types,
        category: String(state.category || ""),
        tag: String(state.tag || ""),
        articlesSort: state.articlesSort === "latest" ? "latest" : "relevance",
        articlesPage: normalizePage(state.articlesPage),
        audioCollection: String(state.audioCollection || ""),
        audioTag: String(state.audioTag || ""),
        audioSort: state.audioSort === "latest" ? "latest" : "relevance",
        audioPage: normalizePage(state.audioPage)
      };
      const serial = ++requestSerial;
      currentState = requestedState;
      currentSettled = null;
      controller.setState({ query, types });
      if (!query) {
        updateUrl(requestedState, options.historyMode || "replace");
        resetDisplay(types, requestedState);
        return;
      }

      allEmpty.hidden = true;
      summary.textContent = "正在搜索…";
      TYPE_ORDER.forEach(type => {
        const elements = sectionElements[type];
        elements.section.hidden = !types.includes(type);
        elements.results.innerHTML = "";
        elements.empty.hidden = true;
        elements.count.textContent = "0";
        renderPagination(elements.pagination, type, { pageCount: 1 });
      });

      const jobs = {};
      if (types.includes("articles")) {
        jobs.articles = loadArticlePayload().then(payload => ({
          payload,
          result: ArticleSearch.search(payload, query, { sort: "relevance" })
        }));
      }
      if (types.includes("audio")) {
        jobs.audio = loadAudioPayload().then(async payload => {
          const exact = AudiobookSearch.exactCollection(payload, query, "")
            || AudiobookSearch.exactEpisode(payload, query, "");
          const shards = exact ? new Map() : await loadAudioShards(payload);
          return {
            payload,
            result: AudiobookSearch.search(payload, query, shards, { sort: "relevance" })
          };
        });
      }

      const settled = await Promise.all(types.map(async type => {
        try {
          return [type, { value: await jobs[type] }];
        } catch (error) {
          console.error(`[combined-search:${type}]`, error);
          return [type, { error }];
        }
      }));
      if (serial !== requestSerial) return;
      currentSettled = settled;
      renderSettled(settled, requestedState, options);
    }

    const controller = setupEntry(entry, {
      initialQuery: initialState.query,
      initialTypes: initialState.types,
      onSubmit: state => runSearch(
        { ...currentState, ...state, articlesPage: 1, audioPage: 1 },
        { historyMode: "push" }
      ),
      onTypesChange: state => runSearch(
        { ...currentState, ...state },
        { historyMode: "push" }
      ),
      onClear: state => runSearch({
        query: "",
        types: state.types,
        category: "",
        tag: "",
        articlesSort: "relevance",
        articlesPage: 1,
        audioCollection: "",
        audioTag: "",
        audioSort: "relevance",
        audioPage: 1
      }, { historyMode: "push" })
    });
    if (!controller) return;

    const applyArticleFilterChange = () => {
      const nextState = {
        ...currentState,
        category: categorySelect.value,
        tag: tagSelect.value,
        articlesSort: articlesSortSelect.value,
        articlesPage: 1
      };
      if (currentSettled) {
        renderSettled(currentSettled, nextState, { historyMode: "push" });
      } else {
        currentState = nextState;
        updateUrl(nextState, "push");
      }
    };
    categorySelect.addEventListener("change", applyArticleFilterChange);
    tagSelect.addEventListener("change", applyArticleFilterChange);
    articlesSortSelect.addEventListener("change", applyArticleFilterChange);

    const applyAudioFilterChange = () => {
      const nextState = {
        ...currentState,
        audioCollection: audioCollectionSelect.value,
        audioTag: audioTagSelect.value,
        audioSort: audioSortSelect.value,
        audioPage: 1
      };
      if (currentSettled) {
        renderSettled(currentSettled, nextState, { historyMode: "push" });
      } else {
        currentState = nextState;
        updateUrl(nextState, "push");
      }
    };
    audioCollectionSelect.addEventListener("change", applyAudioFilterChange);
    audioTagSelect.addEventListener("change", applyAudioFilterChange);
    audioSortSelect.addEventListener("change", applyAudioFilterChange);

    sectionElements.audio.results.addEventListener("click", AudiobookSearch.handleTranscriptSeekClick);
    TYPE_ORDER.forEach(type => {
      sectionElements[type].pagination?.addEventListener("click", event => {
        const button = event.target.closest?.("[data-combined-search-page]");
        if (!button || button.disabled || !currentSettled) return;
        const pageKey = `${type}Page`;
        const nextState = { ...currentState, [pageKey]: normalizePage(button.dataset.combinedSearchPage) };
        renderSettled(currentSettled, nextState, { historyMode: "push", scrollType: type });
      });
    });
    allEmpty.addEventListener("click", event => {
      if (!event.target.closest?.("[data-combined-search-clear-all]")) return;
      runSearch({
        query: "",
        types: controller.getTypes(),
        category: "",
        tag: "",
        articlesSort: "relevance",
        articlesPage: 1,
        audioCollection: "",
        audioTag: "",
        audioSort: "relevance",
        audioPage: 1
      }, { historyMode: "push" });
      controller.input.focus();
    });
    window.addEventListener("popstate", () => {
      runSearch(readUrlState(window.location.href), { historyMode: "none" });
    });

    runSearch(initialState, { historyMode: "replace" });
  }

  function initCombinedSearch() {
    if (typeof document === "undefined") return;
    const pageRoot = document.querySelector("[data-combined-search]");
    if (pageRoot) initCombinedSearchPage(pageRoot);
    document.querySelectorAll("[data-combined-search-entry]").forEach(entry => {
      if (!entry.closest("[data-combined-search]")) setupEntry(entry);
    });
  }

  return {
    DEFAULT_TYPES,
    PAGE_SIZE,
    TYPE_ORDER,
    filterArticleResults,
    initCombinedSearch,
    normalizeTypes,
    paginateResults,
    placeholderForTypes,
    readUrlState,
    searchSections,
    serializeTypes,
    writeUrlState
  };
});
