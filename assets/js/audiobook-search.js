(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AudiobookSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PAGE_SIZE = 8;
  const INPUT_DEBOUNCE_MS = 350;
  const TRANSCRIPT_SEEK_LEAD_SECONDS = 2;
  const FIELD_WEIGHTS = {
    title: 10,
    parent_title: 8,
    tags: 7,
    description: 5,
    keywords: 4,
    transcript: 1
  };

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function uniqueStrings(values) {
    return [...new Set(toArray(values).map(value => String(value || "").trim()).filter(Boolean))];
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\s　]+/gu, "")
      .replace(/[，,。.!！?？；;：:“”"'‘’（）()【】\[\]《》<>「」『』·・—–_\-/\\|]+/gu, "");
  }

  function normalizeCollectionTitle(value) {
    return normalizeText(value).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  function splitQuery(value) {
    const raw = String(value || "").normalize("NFKC").trim();
    const spacedTerms = raw.split(/[\s　,，;；、]+/u).map(normalizeText).filter(Boolean);
    return uniqueStrings(spacedTerms.length > 1 ? spacedTerms : [normalizeText(raw)]);
  }

  function tagLookup(payload) {
    return new Map(toArray(payload?.query_tags).map(tag => [tag.id, tag]));
  }

  function registeredTagValues(tag) {
    return uniqueStrings([
      tag?.name,
      ...toArray(tag?.aliases),
      ...toArray(tag?.phrases)
    ]);
  }

  function resolveQueryTags(tagsById, query, terms) {
    const lookupTerms = new Set([...terms, query].filter(Boolean));
    return [...tagsById.values()].filter(tag => {
      const exactValues = [tag?.name, ...toArray(tag?.aliases)].map(normalizeText).filter(Boolean);
      if (exactValues.some(value => lookupTerms.has(value))) return true;
      const phrases = toArray(tag?.phrases).map(normalizeText).filter(Boolean);
      return phrases.includes(query);
    });
  }

  function tagMatches(record, queryTags, query, terms, weight) {
    const matched = new Set();
    const matchedTagIds = new Set();
    const matchedTagNames = new Set();
    let score = 0;

    queryTags.forEach(tag => {
      if (!toArray(record.tag_ids).includes(tag.id)) return;
      const registeredValues = registeredTagValues(tag).map(normalizeText).filter(Boolean);
      matchedTagIds.add(tag.id);
      matchedTagNames.add(String(tag.name || tag.id));
      score += weight * 4;

      const matchingTerms = terms.filter(term =>
        registeredValues.some(value => term.includes(value))
      );
      if (matchingTerms.length) mergeMatches(matched, matchingTerms);
      else if (query) matched.add(query);
    });

    return { score, matched, matchedTagIds, matchedTagNames };
  }

  function fieldMatches(values, query, terms, weight) {
    const normalizedValues = toArray(values).map(normalizeText).filter(Boolean);
    const matched = new Set();
    let score = 0;
    normalizedValues.forEach(value => {
      if (query && value.includes(query)) score = Math.max(score, weight * 3);
      terms.forEach(term => {
        if (term && value.includes(term)) {
          matched.add(term);
          score += weight;
        }
      });
    });
    return { score, matched };
  }

  function mergeMatches(target, source) {
    source.forEach(value => target.add(value));
  }

  function findTranscriptHit(shard, episodeId, query, terms) {
    const episode = toArray(shard?.episodes).find(item => item.id === episodeId);
    if (!episode) return { score: 0, matched: new Set(), snippet: "", start: null };
    const segments = toArray(episode.segments);
    let bestIndex = -1;
    let bestScore = 0;
    const allMatched = new Set();
    let totalOccurrences = 0;

    segments.forEach((segment, index) => {
      const text = normalizeText(segment.text);
      let segmentScore = 0;
      if (query && text.includes(query)) segmentScore += FIELD_WEIGHTS.transcript * 4;
      terms.forEach(term => {
        if (!term || !text.includes(term)) return;
        allMatched.add(term);
        segmentScore += FIELD_WEIGHTS.transcript;
        totalOccurrences += 1;
      });
      if (segmentScore > bestScore) {
        bestScore = segmentScore;
        bestIndex = index;
      }
    });

    if (bestIndex < 0) return { score: 0, matched: allMatched, snippet: "", start: null };
    const first = Math.max(0, bestIndex - 1);
    const last = Math.min(segments.length, bestIndex + 2);
    const snippet = segments.slice(first, last).map(segment => segment.text).join(" ");
    return {
      score: bestScore + Math.min(totalOccurrences, 6) * 0.15,
      matched: allMatched,
      snippet,
      start: Number(segments[bestIndex]?.start)
    };
  }

  function exactCollection(payload, query, collectionSlug) {
    const normalizedQuery = normalizeCollectionTitle(query);
    if (!normalizedQuery) return null;
    return toArray(payload?.records).find(record =>
      record.subtype === "collection" &&
      (!collectionSlug || record.book_slug === collectionSlug) &&
      normalizeCollectionTitle(record.title) === normalizedQuery
    ) || null;
  }

  function exactEpisode(payload, rawQuery, collectionSlug) {
    const phrase = String(rawQuery || "").normalize("NFKC").trim().toLocaleLowerCase();
    if (!phrase) return null;
    return toArray(payload?.records).find(record => {
      if (record.subtype !== "episode") return false;
      if (collectionSlug && record.book_slug !== collectionSlug) return false;
      return uniqueStrings([
        record.phrase,
        record.canonical_id,
        record.episode_id,
        ...toArray(record.aliases)
      ]).some(value =>
        String(value).normalize("NFKC").trim().toLocaleLowerCase() === phrase
      );
    }) || null;
  }

  function search(payload, rawQuery, transcriptShards = {}, options = {}) {
    const query = normalizeText(rawQuery);
    const terms = splitQuery(rawQuery);
    const collectionSlug = String(options.collection || "");
    const tagId = String(options.tag || "");
    const sort = options.sort === "latest" ? "latest" : "relevance";
    const episode = exactEpisode(payload, rawQuery, collectionSlug);
    if (episode) {
      return {
        mode: "episode",
        query: rawQuery,
        sort,
        results: [{
          record: episode,
          score: Infinity,
          matched_fields: ["episode_phrase"],
          matched_terms: uniqueStrings([String(rawQuery || "").trim()]),
          matched_tag_ids: [],
          matched_location: "单集编号"
        }]
      };
    }
    const exact = exactCollection(payload, rawQuery, collectionSlug);
    if (exact) {
      return {
        mode: "collection",
        query: rawQuery,
        sort,
        results: [{
          record: exact,
          score: Infinity,
          matched_fields: ["collection_title"],
          matched_terms: uniqueStrings([String(rawQuery || "").trim()]),
          matched_tag_ids: []
        }]
      };
    }
    if (!query || !terms.length) return { mode: "episodes", query: rawQuery, sort, results: [] };

    const tagsById = tagLookup(payload);
    const queryTags = resolveQueryTags(tagsById, query, terms);
    const policyCollectionResults = toArray(payload?.records)
      .filter(record =>
        record.subtype === "collection"
        && (!collectionSlug || record.book_slug === collectionSlug)
      )
      .flatMap(record => {
        const matchedPolicies = queryTags.filter(tag =>
          toArray(tag.search_policy?.audiobook_collection_expansion_tag_ids)
            .some(id => toArray(record.tag_ids).includes(id))
        );
        if (!matchedPolicies.length) return [];
        return [{
          record,
          score: 240,
          matched_fields: ["knowledge_node_expansion"],
          matched_terms: matchedPolicies.map(tag => tag.name),
          matched_tag_ids: matchedPolicies.map(tag => tag.id),
          matched_location: "知识点关联"
        }];
      });
    const results = toArray(payload?.records)
      .filter(record =>
        record.subtype === "episode" &&
        (!collectionSlug || record.book_slug === collectionSlug) &&
        (!tagId || toArray(record.tag_ids).includes(tagId))
      )
      .flatMap(record => {
        const ownMatched = new Set();
        const matchedFields = new Set();
        const matchedTerms = new Set();
        const matchedTagIds = new Set();
        let score = 0;
        let matchedLocation = "";

        const ownFields = [
          ["title", [record.title], FIELD_WEIGHTS.title, "单集标题"],
          ["description", [record.description], FIELD_WEIGHTS.description, "简介"],
          ["keywords", record.keywords, FIELD_WEIGHTS.keywords, "关键词"]
        ];
        ownFields.forEach(([field, values, weight, location]) => {
          const match = fieldMatches(values, query, terms, weight);
          score += match.score;
          if (match.score) {
            matchedFields.add(field);
            mergeMatches(matchedTerms, match.matched);
            if (!matchedLocation) matchedLocation = location;
          }
          mergeMatches(ownMatched, match.matched);
        });

        const tagMatch = tagMatches(record, queryTags, query, terms, FIELD_WEIGHTS.tags);
        score += tagMatch.score;
        if (tagMatch.score) {
          matchedFields.add("tag");
          mergeMatches(matchedTerms, tagMatch.matchedTagNames);
          mergeMatches(matchedTagIds, tagMatch.matchedTagIds);
          if (!matchedLocation) matchedLocation = "知识点";
        }
        mergeMatches(ownMatched, tagMatch.matched);

        const shard = transcriptShards instanceof Map
          ? transcriptShards.get(record.book_slug)
          : transcriptShards[record.book_slug];
        const transcript = findTranscriptHit(shard, record.id, query, terms);
        score += transcript.score;
        if (transcript.score) {
          matchedFields.add("transcript");
          mergeMatches(matchedTerms, transcript.matched);
          if (!matchedLocation) matchedLocation = "字幕";
        }
        mergeMatches(ownMatched, transcript.matched);

        if (!ownMatched.size) return [];

        const parentMatch = fieldMatches([record.parent_title], query, terms, FIELD_WEIGHTS.parent_title);
        score += parentMatch.score;
        const coverage = ownMatched.size / Math.max(terms.length, 1);
        if (coverage === 1) score = score * 1.35 + (terms.length > 1 ? 20 : 0);
        else if (coverage >= 0.5) score *= 0.78;
        else score *= 0.42;

        return [{
          record,
          score: Math.round(score * 100) / 100,
          matched_fields: [...matchedFields],
          matched_terms: [...matchedTerms],
          matched_tag_ids: [...matchedTagIds],
          matched_location: matchedLocation,
          transcript_snippet: transcript.snippet,
          transcript_start: Number.isFinite(transcript.start) ? transcript.start : null,
          highlight_terms: uniqueStrings([String(rawQuery || "").trim(), ...terms])
        }];
      });

    results.push(...policyCollectionResults);
    results.sort((left, right) => {
      if (sort === "latest") {
        const dateOrder = String(right.record.date || "").localeCompare(String(left.record.date || ""));
        if (dateOrder) return dateOrder;
      }
      return right.score - left.score ||
        String(right.record.date || "").localeCompare(String(left.record.date || "")) ||
        Number(right.record.number || 0) - Number(left.record.number || 0) ||
        left.record.id.localeCompare(right.record.id);
    });
    return {
      mode: policyCollectionResults.length ? "mixed" : "episodes",
      query: rawQuery,
      sort,
      results
    };
  }

  function readUrlState(urlValue, payload) {
    const url = urlValue instanceof URL ? urlValue : new URL(String(urlValue), "https://example.invalid");
    const collections = new Set(
      toArray(payload?.records).filter(record => record.subtype === "collection").map(record => record.book_slug)
    );
    const tags = new Set(toArray(payload?.query_tags).map(tag => tag.id));
    const requestedCollection = url.searchParams.get("collection") || "";
    const requestedTag = url.searchParams.get("tag") || "";
    return {
      query: url.searchParams.get("q") || "",
      collection: collections.has(requestedCollection) ? requestedCollection : "",
      tag: tags.has(requestedTag) ? requestedTag : "",
      sort: url.searchParams.get("sort") === "latest" ? "latest" : "relevance",
      page: Math.max(Number.parseInt(url.searchParams.get("page"), 10) || 1, 1)
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightHtml(value, terms) {
    const escaped = escapeHtml(value);
    const patterns = uniqueStrings(terms)
      .map(term => normalizeText(term) ? String(term).trim() : "")
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .map(term => escapeRegExp(escapeHtml(term)));
    if (!patterns.length) return escaped;
    return escaped.replace(new RegExp(`(${patterns.join("|")})`, "giu"), '<mark class="article-search-highlight">$1</mark>');
  }

  function renderTagLinks(record, tagsById) {
    return toArray(record.tag_ids).map(id => {
      const tag = tagsById.get(id);
      if (!tag) return "";
      return `<a class="u-tags-v1 g-color-main g-brd-around g-brd-gray-light-v3 g-bg-white g-bg-primary--hover g-color-white--hover g-rounded-50 g-py-4 g-px-12" href="/tags/${encodeURIComponent(id)}/" target="_blank" rel="noopener">${escapeHtml(tag.name)}</a>`;
    }).join("");
  }

  function formatTranscriptTime(value) {
    if (!Number.isFinite(value)) return "";
    const totalSeconds = Math.max(0, Math.floor(value));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${String(minutes).padStart(2, "0")}:${seconds}`;
  }

  function waitForAudioMetadata(audio) {
    if (Number(audio?.readyState) >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", handleLoaded);
        audio.removeEventListener("error", handleError);
      };
      const handleLoaded = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("音频载入失败，无法跳转到字幕时间。"));
      };
      audio.addEventListener("loadedmetadata", handleLoaded);
      audio.addEventListener("error", handleError);
      try {
        audio.load();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async function seekAudioTo(audio, rawStart, options = {}) {
    const start = Number(rawStart);
    if (!audio || !Number.isFinite(start)) throw new TypeError("字幕时间无效。");
    await waitForAudioMetadata(audio);
    const duration = Number(audio.duration);
    const target = Number.isFinite(duration)
      ? Math.min(Math.max(start, 0), Math.max(duration, 0))
      : Math.max(start, 0);
    audio.currentTime = target;
    if (options.play !== false) await audio.play();
    return target;
  }

  function transcriptPlaybackStart(rawStart) {
    const start = Number(rawStart);
    return Number.isFinite(start)
      ? Math.max(0, start - TRANSCRIPT_SEEK_LEAD_SECONDS)
      : null;
  }

  function renderMatchSource(result, tagsById) {
    const fieldLabels = {
      title: "标题",
      description: "简介",
      keywords: "关键词",
      tag: "知识点",
      transcript: "字幕"
    };
    const fieldOrder = ["title", "description", "keywords", "tag", "transcript"];
    const fields = new Set(toArray(result.matched_fields));
    const tagNames = uniqueStrings(toArray(result.matched_tag_ids).map(id => tagsById.get(id)?.name || id));
    const parts = fieldOrder.flatMap(field => {
      if (!fields.has(field)) return [];
      let label = fieldLabels[field];
      if (field === "tag" && tagNames.length) label += ` · ${tagNames.join("、")}`;
      return [escapeHtml(label)];
    });
    if (!parts.length && result.matched_location) parts.push(escapeHtml(result.matched_location));
    return parts.length
      ? `<p class="audiobook-search-match-source">匹配来源：${parts.join("、")}</p>`
      : "";
  }

  function renderTranscriptPlayHint(result) {
    const start = Number(result.transcript_start);
    const time = formatTranscriptTime(start);
    if (!toArray(result.matched_fields).includes("transcript") || !time) return "";
    return `
      <p class="audiobook-search-play-hint">
        <span>点击播放：</span>
        <button type="button" class="audiobook-search-time-link" data-transcript-seek="${start}" aria-label="从字幕命中时间 ${escapeHtml(time)} 前 2 秒开始播放">${escapeHtml(time)}</button>
      </p>
    `;
  }

  async function handleTranscriptSeekClick(event) {
    const button = event.target.closest?.("[data-transcript-seek]");
    if (!button) return;
    const card = button.closest("[data-audio-search-result]");
    const audio = card?.querySelector("audio");
    const start = Number(button.dataset.transcriptSeek);
    if (!audio || !Number.isFinite(start)) return;

    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await seekAudioTo(audio, transcriptPlaybackStart(start));
    } catch (error) {
      console.error("[audiobook-search] 字幕时间跳转失败：", error);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function renderEpisodeResult(result, tagsById) {
    const record = result.record;
    return `
      <div class="audiobook-search-audio-item" data-audio-search-result>
        <article class="audio-card d-flex u-shadow-v19 g-bg-white rounded g-pt-20 g-pb-20 g-pl-30 g-pr-30 align-items-center flex-column">
          <div class="d-flex w-100 align-items-center mb-2">
            <div class="d-flex flex-column align-items-center justify-content-center g-mr-30 audiobook-search-audio-cover">
              <a href="/audiobooks/${encodeURIComponent(record.book_slug)}/">
                <img class="rounded mb-2" src="${escapeHtml(record.cover)}" alt="${escapeHtml(record.title)}" loading="lazy">
              </a>
              ${record.subtitle_url ? `<button class="btn btn-sm show-subtitles" data-subtitle="${escapeHtml(record.subtitle_url)}" aria-expanded="false">显示字幕</button>` : ""}
            </div>
            <div class="flex-grow-1 audiobook-search-audio-main">
              <h2 class="mb-2">
                <a href="/audiobooks/${encodeURIComponent(record.book_slug)}/" class="g-font-weight-700 g-font-size-16 audiobook-search-parent-link">${escapeHtml(record.parent_title)}</a>
                <a href="${escapeHtml(record.url)}" class="g-font-weight-700 g-font-size-16 audio-title-link">${highlightHtml(record.title, result.highlight_terms)}</a>
              </h2>
              ${record.description ? `<p class="g-font-size-14 g-color-gray-dark-v4 mt-3 mb-2 audiobook-search-description">${highlightHtml(record.description, result.highlight_terms)}</p>` : ""}
              ${renderTranscriptPlayHint(result)}
              ${result.transcript_snippet ? `
                <div class="audiobook-search-transcript-hit">
                  <strong>字幕摘要</strong>
                  <p>${highlightHtml(result.transcript_snippet, result.highlight_terms)}</p>
                </div>
              ` : ""}
              ${record.tag_ids?.length ? `<div class="audio-card-tags g-mt-10 g-mb-10">${renderTagLinks(record, tagsById)}</div>` : ""}
              ${record.audio_url ? `<audio controls preload="none" data-subtitle="${escapeHtml(record.subtitle_url)}"><source src="${escapeHtml(record.audio_url)}" type="audio/mpeg">您的浏览器不支持音频播放。</audio>` : ""}
              <div class="audiobook-search-meta">
                <p class="audiobook-search-date">${escapeHtml(record.date)}</p>
                ${renderMatchSource(result, tagsById)}
              </div>
              ${record.related_article_url ? `<a class="audiobook-search-related" href="${escapeHtml(record.related_article_url)}" target="_blank" rel="noopener noreferrer">阅读相关文章 <span aria-hidden="true">→</span></a>` : ""}
            </div>
          </div>
          ${record.subtitle_url ? `<div class="subtitle-box w-100" hidden></div>` : ""}
        </article>
      </div>
    `;
  }

  function renderCollectionResult(record) {
    return `
      <section class="audiobook-search-collection-result" aria-label="合集精确匹配">
        <a href="${escapeHtml(record.url)}" class="audiobook-link">
          <article class="audiobook-card">
            <div class="cover-wrapper"><img src="${escapeHtml(record.cover)}" alt="${escapeHtml(record.title)}" class="cover-img"></div>
            <h2 class="book-title">${escapeHtml(record.title)}</h2>
            <p class="book-author">${escapeHtml(record.author)}</p>
            <p class="book-summary">${escapeHtml(record.summary || record.description)}</p>
          </article>
        </a>
      </section>
    `;
  }

  function debounce(callback, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => callback.apply(this, args), delay);
    };
  }

  function populateFacetSelect(select, allLabel, total, options, requestedValue) {
    if (!select) return "";
    select.innerHTML = `<option value="">${allLabel}（${total}）</option>` +
      toArray(options).map(option =>
        `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}（${option.count}）</option>`
      ).join("");
    const value = toArray(options).some(option => option.id === requestedValue) ? requestedValue : "";
    select.value = value;
    select.disabled = total === 0 || toArray(options).length === 0;
    return value;
  }

  function buildCollectionFacets(results, payload) {
    const collectionBySlug = new Map(
      toArray(payload?.records)
        .filter(record => record.subtype === "collection")
        .map(record => [record.book_slug, record])
    );
    const counts = new Map();
    toArray(results).forEach(result => {
      const slug = result.record.book_slug;
      counts.set(slug, (counts.get(slug) || 0) + 1);
    });
    return [...counts.entries()].map(([slug, count]) => ({
      id: slug,
      name: collectionBySlug.get(slug)?.title || slug,
      count
    })).sort((left, right) => left.name.localeCompare(right.name, "zh-Hans"));
  }

  function buildTagFacets(results, payload) {
    const tagsById = tagLookup(payload);
    const counts = new Map();
    toArray(results).forEach(result => {
      toArray(result.record.tag_ids).forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
    });
    return [...counts.entries()].flatMap(([id, count]) => {
      const tag = tagsById.get(id);
      return tag ? [{ id, name: tag.name, count }] : [];
    });
  }

  function sortFacetedResults(results, sort) {
    return toArray(results).slice().sort((left, right) => {
      if (sort === "latest") {
        const dateOrder = String(right.record.date || "").localeCompare(String(left.record.date || ""));
        if (dateOrder) return dateOrder;
      }
      return right.score - left.score ||
        String(right.record.date || "").localeCompare(String(left.record.date || "")) ||
        Number(right.record.number || 0) - Number(left.record.number || 0) ||
        left.record.id.localeCompare(right.record.id);
    });
  }

  function filterFacetedResults(results, payload, state = {}) {
    const source = toArray(results);
    const collectionOptions = buildCollectionFacets(source, payload);
    const requestedCollection = String(
      Object.prototype.hasOwnProperty.call(state, "audioCollection")
        ? state.audioCollection || ""
        : state.collection || ""
    );
    const audioCollection = collectionOptions.some(option => option.id === requestedCollection)
      ? requestedCollection
      : "";
    const collectionResults = source.filter(result =>
      !audioCollection || result.record.book_slug === audioCollection
    );
    const tagOptions = buildTagFacets(collectionResults, payload);
    const requestedTag = String(
      Object.prototype.hasOwnProperty.call(state, "audioTag")
        ? state.audioTag || ""
        : state.tag || ""
    );
    const audioTag = tagOptions.some(option => option.id === requestedTag) ? requestedTag : "";
    const audioSort = state.audioSort === "latest" ? "latest" : "relevance";
    const tagResults = collectionResults.filter(result =>
      !audioTag || toArray(result.record.tag_ids).includes(audioTag)
    );
    return {
      results: sortFacetedResults(tagResults, audioSort),
      audioCollection,
      collectionOptions,
      collectionTotal: source.length,
      audioTag,
      tagOptions,
      tagTotal: collectionResults.length,
      audioSort
    };
  }

  function initAudiobookSearchPage() {
    if (typeof document === "undefined") return;
    const root = document.querySelector("[data-audiobook-search]");
    if (!root) return;

    const form = root.querySelector("[data-search-form]");
    const input = root.querySelector("[data-search-input]");
    const clearButton = root.querySelector("[data-search-clear]");
    const collectionSelect = root.querySelector("[data-search-collection]");
    const tagSelect = root.querySelector("[data-search-tag]");
    const sortSelect = root.querySelector("[data-search-sort]");
    const status = root.querySelector("[data-search-status]");
    const resultsElement = root.querySelector("[data-search-results]");
    const paginationElement = root.querySelector("[data-search-pagination]");
    const emptyElement = root.querySelector("[data-search-empty]");
    let payload = null;
    let indexPromise = null;
    let currentRawResults = [];
    let currentResults = [];
    let currentMode = "episodes";
    let currentRawMode = "episodes";
    let currentScopeCollection = "";
    let currentPage = 1;
    let requestSerial = 0;
    const shardCache = new Map();
    resultsElement.addEventListener("click", handleTranscriptSeekClick);

    const loadIndex = () => {
      if (payload) return Promise.resolve(payload);
      if (indexPromise) return indexPromise;
      status.textContent = "正在载入有声书索引…";
      indexPromise = fetch("/search/audiobooks-index.json")
        .then(response => {
          if (!response.ok) throw new Error(`索引载入失败：${response.status}`);
          return response.json();
        })
        .then(data => {
          payload = data;
          return data;
        });
      return indexPromise;
    };

    const loadShard = slug => {
      if (shardCache.has(slug)) return Promise.resolve(shardCache.get(slug));
      return fetch(`/search/audiobook-transcripts/${encodeURIComponent(slug)}.json`)
        .then(response => {
          if (!response.ok) throw new Error(`字幕分片载入失败：${slug} / ${response.status}`);
          return response.json();
        })
        .then(shard => {
          shardCache.set(slug, shard);
          return shard;
        });
    };

    const loadRequiredShards = collectionSlug => {
      const slugs = collectionSlug
        ? [collectionSlug]
        : toArray(payload.records).filter(record => record.subtype === "collection").map(record => record.book_slug);
      return Promise.all(slugs.map(loadShard)).then(() => shardCache);
    };

    function resetFacetControls() {
      collectionSelect.innerHTML = '<option value="">全部合集（0）</option>';
      tagSelect.innerHTML = '<option value="">全部知识点（0）</option>';
      collectionSelect.disabled = true;
      tagSelect.disabled = true;
    }

    function applyFacetsAndRender(options = {}) {
      const requestedCollection = options.requestedCollection == null
        ? collectionSelect.value
        : String(options.requestedCollection);
      const requestedTag = options.requestedTag == null
        ? tagSelect.value
        : String(options.requestedTag);
      const collectionOptions = buildCollectionFacets(currentRawResults, payload);
      const selectedCollection = populateFacetSelect(
        collectionSelect,
        "全部合集",
        currentRawResults.length,
        collectionOptions,
        requestedCollection
      );
      const collectionResults = currentRawResults.filter(result =>
        !selectedCollection || result.record.book_slug === selectedCollection
      );
      const tagOptions = buildTagFacets(collectionResults, payload);
      const selectedTag = populateFacetSelect(
        tagSelect,
        "全部知识点",
        collectionResults.length,
        tagOptions,
        requestedTag
      );
      currentResults = sortFacetedResults(collectionResults.filter(result =>
        !selectedTag || toArray(result.record.tag_ids).includes(selectedTag)
      ), sortSelect.value);
      currentMode = currentRawMode;
      if (!options.preservePage) currentPage = 1;
      status.textContent = currentMode === "collection" && currentResults.length === 1
        ? "找到 1 个精确匹配的合集"
        : currentMode === "mixed"
          ? `找到 ${currentResults.length} 个合集或音频结果`
          : `找到 ${currentResults.length} 个音频`;
      emptyElement.hidden = currentResults.length > 0;
      emptyElement.innerHTML = currentResults.length
        ? ""
        : "<p><strong>当前筛选条件下没有找到音频。</strong></p><p>可尝试清除筛选或缩短关键词。</p>";
      renderPage(Boolean(options.shouldScroll), options.historyMode || "replace");
    }

    function updateUrl(mode) {
      if (mode === "none") return;
      const url = new URL(window.location.href);
      const query = input.value.trim();
      ["q", "collection", "tag", "sort", "page"].forEach(key => url.searchParams.delete(key));
      if (query) {
        url.searchParams.set("q", query);
        if (collectionSelect.value) url.searchParams.set("collection", collectionSelect.value);
        if (tagSelect.value) url.searchParams.set("tag", tagSelect.value);
        url.searchParams.set("sort", sortSelect.value);
        if (currentPage > 1) url.searchParams.set("page", String(currentPage));
      }
      history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
    }

    function resetEmpty() {
      currentResults = [];
      currentRawResults = [];
      currentMode = "episodes";
      currentRawMode = "episodes";
      currentScopeCollection = "";
      currentPage = 1;
      resultsElement.innerHTML = "";
      paginationElement.innerHTML = "";
      paginationElement.hidden = true;
      emptyElement.hidden = false;
      emptyElement.innerHTML = "<p>输入关键词，搜索有声书、播客单集与字幕。</p>";
      status.textContent = payload
        ? `可搜索 ${payload.stats.collections} 个合集、${payload.stats.episodes} 个音频`
        : "";
      resetFacetControls();
    }

    function makePageButton(label, page, disabled, current) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "site-pagination__button";
      button.textContent = label;
      button.disabled = disabled;
      if (current) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => {
        currentPage = page;
        renderPage(true, "push");
      });
      return button;
    }

    function renderPagination() {
      const pageCount = Math.ceil(currentResults.length / PAGE_SIZE);
      paginationElement.replaceChildren();
      if (currentMode === "collection" || pageCount <= 1) {
        paginationElement.hidden = true;
        return;
      }
      paginationElement.hidden = false;
      paginationElement.appendChild(makePageButton("‹", currentPage - 1, currentPage === 1, false));
      const first = Math.max(1, Math.min(currentPage - 2, Math.max(1, pageCount - 4)));
      const last = Math.min(pageCount, first + 4);
      for (let page = first; page <= last; page += 1) {
        paginationElement.appendChild(makePageButton(String(page), page, false, page === currentPage));
      }
      paginationElement.appendChild(makePageButton("›", currentPage + 1, currentPage === pageCount, false));
      const summary = document.createElement("span");
      summary.className = "site-pagination__status";
      summary.textContent = `第 ${currentPage} / ${pageCount} 页，共 ${currentResults.length} 个音频`;
      paginationElement.appendChild(summary);
    }

    function renderPage(shouldScroll, historyMode) {
      const tagsById = tagLookup(payload);
      if (currentMode === "collection") {
        resultsElement.innerHTML = currentResults.length
          ? renderCollectionResult(currentResults[0].record)
          : "";
      } else {
        const pageCount = Math.ceil(currentResults.length / PAGE_SIZE);
        currentPage = Math.min(Math.max(currentPage, 1), pageCount || 1);
        const offset = (currentPage - 1) * PAGE_SIZE;
        resultsElement.innerHTML = currentResults.slice(offset, offset + PAGE_SIZE)
          .map(result => result.record.subtype === "collection"
            ? renderCollectionResult(result.record)
            : renderEpisodeResult(result, tagsById)
          ).join("");
        window.AudioCard?.init(resultsElement);
      }
      renderPagination();
      updateUrl(historyMode);
      if (shouldScroll) resultsElement.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function runSearch(options = {}) {
      const query = input.value.trim();
      const serial = ++requestSerial;
      if (!query) {
        resetEmpty();
        updateUrl(options.historyMode || "replace");
        return;
      }
      status.textContent = "正在搜索…";
      emptyElement.hidden = true;
      try {
        await loadIndex();
        const state = {
          collection: options.requestedCollection == null
            ? collectionSelect.value
            : String(options.requestedCollection),
          tag: options.requestedTag == null
            ? tagSelect.value
            : String(options.requestedTag),
          sort: sortSelect.value
        };
        const exact = exactCollection(payload, query, state.collection);
        const searchOptions = {
          collection: state.collection,
          sort: "relevance"
        };
        let result;
        if (exact) {
          result = search(payload, query, new Map(), searchOptions);
        } else {
          status.textContent = state.collection ? "正在载入所选合集字幕…" : "正在载入字幕分片…";
          const shards = await loadRequiredShards(state.collection);
          if (serial !== requestSerial) return;
          result = search(payload, query, shards, searchOptions);
        }
        if (serial !== requestSerial) return;
        currentRawMode = result.mode;
        currentRawResults = result.results;
        currentScopeCollection = state.collection;
        applyFacetsAndRender({
          requestedCollection: state.collection,
          requestedTag: state.tag,
          preservePage: options.preservePage,
          shouldScroll: options.shouldScroll,
          historyMode: options.historyMode || "replace"
        });
      } catch (error) {
        if (serial !== requestSerial) return;
        console.error("[audiobook-search]", error);
        resultsElement.innerHTML = "";
        paginationElement.hidden = true;
        emptyElement.hidden = false;
        emptyElement.innerHTML = "<p>有声书搜索暂时不可用，请稍后重试。</p>";
        status.textContent = "搜索载入失败";
      }
    }

    const debouncedSearch = debounce(() => runSearch({ historyMode: "replace" }), INPUT_DEBOUNCE_MS);
    form.addEventListener("submit", event => {
      event.preventDefault();
      runSearch({ historyMode: "push", shouldScroll: true });
    });
    input.addEventListener("input", () => {
      if (!input.value.trim()) {
        requestSerial += 1;
        resetEmpty();
        updateUrl("replace");
        return;
      }
      debouncedSearch();
    });
    clearButton.addEventListener("click", () => {
      requestSerial += 1;
      input.value = "";
      sortSelect.value = "relevance";
      resetEmpty();
      updateUrl("push");
      input.focus();
    });
    collectionSelect.addEventListener("change", () => {
      if (currentScopeCollection && !collectionSelect.value) {
        runSearch({ requestedCollection: "", requestedTag: tagSelect.value, historyMode: "push" });
        return;
      }
      applyFacetsAndRender({
        requestedCollection: collectionSelect.value,
        requestedTag: tagSelect.value,
        historyMode: "push"
      });
    });
    tagSelect.addEventListener("change", () => applyFacetsAndRender({
      requestedCollection: collectionSelect.value,
      requestedTag: tagSelect.value,
      historyMode: "push"
    }));
    sortSelect.addEventListener("change", () => applyFacetsAndRender({
      requestedCollection: collectionSelect.value,
      requestedTag: tagSelect.value,
      historyMode: "push"
    }));
    window.addEventListener("popstate", async () => {
      await loadIndex();
      const state = readUrlState(window.location.href, payload);
      input.value = state.query;
      currentPage = state.page;
      sortSelect.value = state.sort;
      if (state.query.trim()) runSearch({
        requestedCollection: state.collection,
        requestedTag: state.tag,
        preservePage: true,
        historyMode: "none"
      });
      else resetEmpty();
    });

    loadIndex()
      .then(() => {
        const state = readUrlState(window.location.href, payload);
        input.value = state.query;
        currentPage = state.page;
        sortSelect.value = state.sort;
        resetFacetControls();
        if (state.query.trim()) runSearch({
          requestedCollection: state.collection,
          requestedTag: state.tag,
          preservePage: true,
          historyMode: "replace"
        });
        else resetEmpty();
      })
      .catch(error => {
        console.error("[audiobook-search]", error);
        status.textContent = "有声书索引暂时无法载入。";
      });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initAudiobookSearchPage, { once: true });
    } else {
      initAudiobookSearchPage();
    }
  }

  return {
    FIELD_WEIGHTS,
    INPUT_DEBOUNCE_MS,
    PAGE_SIZE,
    TRANSCRIPT_SEEK_LEAD_SECONDS,
    buildCollectionFacets,
    buildTagFacets,
    exactCollection,
    exactEpisode,
    findTranscriptHit,
    filterFacetedResults,
    highlightHtml,
    handleTranscriptSeekClick,
    initAudiobookSearchPage,
    normalizeCollectionTitle,
    normalizeText,
    populateFacetSelect,
    readUrlState,
    renderCollectionResult,
    renderEpisodeResult,
    renderMatchSource,
    renderTranscriptPlayHint,
    seekAudioTo,
    search,
    sortFacetedResults,
    splitQuery,
    transcriptPlaybackStart
  };
});
