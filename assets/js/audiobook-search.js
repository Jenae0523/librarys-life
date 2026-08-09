(function (root, factory) {
  const queryTools = typeof module === "object" && module.exports
    ? require("./search-query")
    : root.SearchQuery;
  const api = factory(queryTools);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AudiobookSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (SearchQuery) {
  "use strict";

  const PAGE_SIZE = 8;
  const INPUT_DEBOUNCE_MS = 350;
  const TRANSCRIPT_SEEK_LEAD_SECONDS = 2;
  const SEARCH_PROXIMITY_WINDOW = SearchQuery.SEARCH_PROXIMITY_WINDOW;
  const AUDIO_NAVIGATION_WINDOW_SECONDS = 45;
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
    return SearchQuery.normalizeTerm(value);
  }

  function normalizeCollectionTitle(value) {
    return normalizeText(value).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  function splitQuery(value) {
    return SearchQuery.parseQuery(value).effectiveTerms.map(normalizeText);
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

  function queryTermsMatchedByTag(tag, terms) {
    const registeredValues = registeredTagValues(tag).map(normalizeText).filter(Boolean);
    return terms.filter(term =>
      registeredValues.some(value => term.includes(value) || value.includes(term))
    );
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
      matchedTagIds.add(tag.id);
      matchedTagNames.add(String(tag.name || tag.id));
      score += weight * 4;

      const matchingTerms = queryTermsMatchedByTag(tag, terms);
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

  function structuredFieldsForRecord(record, tagsById) {
    return [
      { name: "title", label: "单集标题", values: [record.title] },
      { name: "parent_title", label: "合集标题", values: [record.parent_title] },
      { name: "keywords", label: "关键词", values: record.keywords },
      {
        name: "tag",
        label: "知识点",
        values: toArray(record.tag_ids).map(id => tagsById.get(id)?.name || "")
      },
      { name: "author", label: "作者", values: [record.author] }
    ];
  }

  function buildVocabulary(payload, tagsById) {
    const vocabulary = [];
    toArray(payload?.records).forEach(record => {
      structuredFieldsForRecord(record, tagsById).forEach(field => {
        toArray(field.values).forEach(value => {
          if (String(value || "").trim()) {
            vocabulary.push({ value, field: field.name, label: field.label, recordId: record.id });
          }
        });
      });
    });
    toArray(payload?.query_tags).forEach(tag => {
      if (tag?.name) vocabulary.push({ value: tag.name, field: "tag", label: "知识点", recordId: tag.id });
    });
    return vocabulary;
  }

  function bestTranscriptWindow(shard, episodeId, terms) {
    const episode = toArray(shard?.episodes).find(item => item.id === episodeId);
    let best = null;
    toArray(episode?.segments).forEach(segment => {
      const window = SearchQuery.findShortestWindow(segment.text, terms, SEARCH_PROXIMITY_WINDOW);
      if (!window || (best && best.window.length <= window.length)) return;
      best = { segment, window };
    });
    return best;
  }

  function bestNavigableTranscriptWindow(shard, episodeId, terms, maximumSeconds = AUDIO_NAVIGATION_WINDOW_SECONDS) {
    const episode = toArray(shard?.episodes).find(item => item.id === episodeId);
    const segments = toArray(episode?.segments);
    const naturalTerms = uniqueStrings(terms).map(SearchQuery.normalizeNaturalText).filter(Boolean);
    if (!segments.length || !naturalTerms.length) return null;

    const events = [];
    const termPresence = Array(naturalTerms.length).fill(false);
    segments.forEach((segment, segmentIndex) => {
      const text = SearchQuery.normalizeNaturalText(segment.text);
      naturalTerms.forEach((term, termIndex) => {
        if (!text.includes(term)) return;
        termPresence[termIndex] = true;
        events.push({ termIndex, segmentIndex });
      });
    });
    if (termPresence.some(present => !present)) return null;

    events.sort((left, right) => left.segmentIndex - right.segmentIndex || left.termIndex - right.termIndex);
    const counts = Array(naturalTerms.length).fill(0);
    let covered = 0;
    let left = 0;
    let best = null;

    for (let right = 0; right < events.length; right += 1) {
      if (counts[events[right].termIndex]++ === 0) covered += 1;
      while (covered === naturalTerms.length && left <= right) {
        const firstIndex = events[left].segmentIndex;
        const lastIndex = events[right].segmentIndex;
        const firstStart = Number(segments[firstIndex]?.start);
        const lastEndValue = Number(segments[lastIndex]?.end);
        const lastStart = Number(segments[lastIndex]?.start);
        const lastEnd = Number.isFinite(lastEndValue) ? lastEndValue : lastStart;
        const duration = Number.isFinite(firstStart) && Number.isFinite(lastEnd)
          ? Math.max(0, lastEnd - firstStart)
          : Infinity;

        if (duration <= maximumSeconds) {
          const text = segments.slice(firstIndex, lastIndex + 1)
            .map(segment => String(segment.text || "").trim())
            .filter(Boolean)
            .join(" ");
          const textWindow = SearchQuery.findShortestWindow(text, naturalTerms, Infinity);
          const candidate = {
            firstSegmentIndex: firstIndex,
            lastSegmentIndex: lastIndex,
            earliestMatchTime: firstStart,
            duration,
            segmentCount: lastIndex - firstIndex + 1,
            textWindowLength: textWindow?.length ?? Infinity,
            snippet: SearchQuery.createWindowSnippet(
              text,
              textWindow,
              Math.min(360, Math.max(210, (textWindow?.length || 0) + 70))
            ),
            matchKind: firstIndex === lastIndex ? "single-segment" : "adjacent-segments"
          };
          if (
            !best
            || candidate.duration < best.duration
            || (candidate.duration === best.duration && candidate.segmentCount < best.segmentCount)
            || (candidate.duration === best.duration && candidate.segmentCount === best.segmentCount && candidate.textWindowLength < best.textWindowLength)
            || (candidate.duration === best.duration && candidate.segmentCount === best.segmentCount && candidate.textWindowLength === best.textWindowLength && candidate.earliestMatchTime < best.earliestMatchTime)
          ) {
            best = candidate;
          }
        }

        if (--counts[events[left].termIndex] === 0) covered -= 1;
        left += 1;
      }
    }

    return best;
  }

  function matchAudioStructured(record, tagsById, terms) {
    const fields = structuredFieldsForRecord(record, tagsById);
    const matched = new Map();
    for (const term of terms) {
      const direct = SearchQuery.matchStructured(fields, [term]);
      const aliasMatched = toArray(record.tag_ids).some(id =>
        registeredTagValues(tagsById.get(id)).map(normalizeText).includes(term)
      );
      if (!direct && !aliasMatched) return null;
      toArray(direct?.matchedFields).forEach((field, index) => {
        matched.set(field, direct.matchedFieldLabels[index]);
      });
      if (aliasMatched) matched.set("tag", "知识点");
    }
    return { matchedFields: [...matched.keys()], matchedFieldLabels: [...matched.values()] };
  }

  function audioInterpretationMatch(record, shard, tagsById, parsed, interpretation) {
    const terms = interpretation.terms;
    const naturalTerms = interpretation.naturalTerms || terms;
    const isSplit = interpretation.kind === "split";
    const structural = matchAudioStructured(record, tagsById, terms);
    const descriptionWindow = SearchQuery.findShortestWindow(record.description, naturalTerms, SEARCH_PROXIMITY_WINDOW);
    const transcript = bestNavigableTranscriptWindow(
      shard,
      record.id,
      naturalTerms,
      AUDIO_NAVIGATION_WINDOW_SECONDS
    );
    const title = normalizeText(record.title);
    const titleSet = normalizeText([record.title, record.parent_title].join(" "));
    const normalizedWhole = normalizeText(parsed.normalizedQuery.replace(/[“”"]/gu, ""));
    const candidates = [];

    if (structural) {
      const matchedFieldLabels = uniqueStrings(structural.matchedFieldLabels);
      let score = isSplit ? 8000 : 9500;
      if (terms.every(term => titleSet.includes(term))) score = isSplit ? 9800 : 10000;
      if (normalizedWhole && title === normalizedWhole) {
        score = parsed.quotedPhrases.length ? 12000 : parsed.effectiveTerms.length === 1 ? 11500 : 11000;
      }
      candidates.push({
        score,
        type: isSplit ? "split-structured" : "full-structured",
        fields: structural.matchedFields,
        labels: matchedFieldLabels,
        location: matchedFieldLabels[0] || "结构化字段",
        descriptionSnippet: record.description || "",
        transcriptSnippet: "",
        transcriptStart: null,
        windowLength: null
      });
    }
    if (descriptionWindow) {
      candidates.push({
        score: (isSplit ? 7000 : 9000) + SEARCH_PROXIMITY_WINDOW - descriptionWindow.length,
        type: isSplit ? "split-description" : "full-description",
        fields: ["description"],
        labels: ["简介"],
        location: "简介",
        descriptionSnippet: SearchQuery.createWindowSnippet(record.description, descriptionWindow),
        transcriptSnippet: "",
        transcriptStart: null,
        windowLength: descriptionWindow.length
      });
    }
    if (transcript) {
      candidates.push({
        score: (isSplit ? 6500 : 8500) + Math.max(0, SEARCH_PROXIMITY_WINDOW - transcript.textWindowLength),
        type: isSplit ? "split-transcript" : "full-transcript",
        fields: ["transcript"],
        labels: ["字幕"],
        location: "字幕",
        descriptionSnippet: record.description || "",
        transcriptSnippet: transcript.snippet,
        transcriptStart: transcript.earliestMatchTime,
        windowLength: transcript.textWindowLength
      });
    }
    candidates.sort((left, right) => right.score - left.score || (left.windowLength ?? Infinity) - (right.windowLength ?? Infinity));
    return candidates[0] ? { ...candidates[0], interpretation } : null;
  }

  function search(payload, rawQuery, transcriptShards = {}, options = {}) {
    const collectionSlug = String(options.collection || "");
    const tagId = String(options.tag || "");
    const sort = options.sort === "latest" ? "latest" : "relevance";
    const tagsById = tagLookup(payload);
    const parsed = SearchQuery.parseQuery(rawQuery, buildVocabulary(payload, tagsById));
    if (parsed.isEmpty || parsed.needsMoreSpecific) {
      return { mode: "episodes", query: parsed.rawQuery, query_plan: parsed, sort, results: [] };
    }
    const deduplicatedExactQuery = parsed.effectiveTerms.length === 1 ? parsed.effectiveTerms[0] : "";
    const episode = exactEpisode(payload, rawQuery, collectionSlug)
      || (deduplicatedExactQuery ? exactEpisode(payload, deduplicatedExactQuery, collectionSlug) : null);
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
          matched_location: "单集编号",
          highlight_terms: parsed.effectiveTerms
        }]
      };
    }
    const exact = exactCollection(payload, rawQuery, collectionSlug)
      || (deduplicatedExactQuery ? exactCollection(payload, deduplicatedExactQuery, collectionSlug) : null);
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
          matched_tag_ids: [],
          highlight_terms: parsed.effectiveTerms
        }]
      };
    }
    const results = toArray(payload?.records)
      .filter(record =>
        record.subtype === "episode" &&
        (!collectionSlug || record.book_slug === collectionSlug) &&
        (!tagId || toArray(record.tag_ids).includes(tagId))
      )
      .flatMap(record => {
        const shard = transcriptShards instanceof Map
          ? transcriptShards.get(record.book_slug)
          : transcriptShards[record.book_slug];
        const match = parsed.queryInterpretations
          .map(interpretation => audioInterpretationMatch(record, shard, tagsById, parsed, interpretation))
          .filter(Boolean)
          .sort((left, right) => right.score - left.score || (left.windowLength ?? Infinity) - (right.windowLength ?? Infinity))[0];
        if (!match) return [];
        const navigation = bestNavigableTranscriptWindow(
          shard,
          record.id,
          match.interpretation.naturalTerms || match.interpretation.terms,
          AUDIO_NAVIGATION_WINDOW_SECONDS
        );

        return [{
          record,
          score: Math.round(match.score * 100) / 100,
          matched_fields: match.fields,
          matched_field_labels: match.labels,
          matched_terms: match.interpretation.terms,
          matched_tag_ids: toArray(record.tag_ids).filter(id => match.fields.includes("tag")),
          matched_location: match.location,
          matched_type: match.type,
          match_window_length: match.windowLength,
          relevance_match: {
            type: match.type,
            location: match.location,
            fields: match.fields,
            field_labels: match.labels,
            window_length: match.windowLength
          },
          navigation_match: navigation ? {
            type: navigation.matchKind,
            earliest_match_time: navigation.earliestMatchTime,
            seek_time: transcriptPlaybackStart(navigation.earliestMatchTime),
            duration_seconds: navigation.duration,
            segment_count: navigation.segmentCount,
            first_segment_index: navigation.firstSegmentIndex,
            last_segment_index: navigation.lastSegmentIndex
          } : null,
          query_interpretation: match.interpretation,
          description_snippet: String(record.description || record.summary || "").trim(),
          transcript_snippet: navigation?.snippet || "",
          transcript_start: Number.isFinite(navigation?.earliestMatchTime) ? navigation.earliestMatchTime : null,
          transcript_seek_time: Number.isFinite(navigation?.earliestMatchTime)
            ? transcriptPlaybackStart(navigation.earliestMatchTime)
            : null,
          highlight_terms: match.interpretation.displayTerms
        }];
      });
    const policyCollectionResults = toArray(payload?.records)
      .filter(record => record.subtype === "collection" && (!collectionSlug || record.book_slug === collectionSlug))
      .flatMap(record => {
        const interpretation = parsed.queryInterpretations.find(candidate =>
          candidate.terms.every(term => toArray(payload?.query_tags).some(tag => {
            const exactValues = registeredTagValues(tag).map(normalizeText);
            const targets = toArray(tag.search_policy?.audiobook_collection_expansion_tag_ids).map(String);
            return exactValues.includes(term) && targets.some(id => toArray(record.tag_ids).includes(id));
          }))
        );
        if (!interpretation) return [];
        return [{
          record,
          score: interpretation.kind === "split" ? 7600 : 7800,
          matched_fields: ["knowledge_node_expansion"],
          matched_field_labels: ["知识点关联"],
          matched_terms: interpretation.terms,
          matched_tag_ids: [],
          matched_location: "知识点关联",
          matched_type: "controlled-expansion",
          query_interpretation: interpretation,
          highlight_terms: interpretation.displayTerms
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
      query_plan: parsed,
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

  function renderTagLinks(record, tagsById, terms = []) {
    return toArray(record.tag_ids).map(id => {
      const tag = tagsById.get(id);
      if (!tag) return "";
      return `<a class="u-tags-v1 g-color-main g-brd-around g-brd-gray-light-v3 g-bg-white g-bg-primary--hover g-color-white--hover g-rounded-50 g-py-4 g-px-12" href="/tags/${encodeURIComponent(id)}/" target="_blank" rel="noopener">${highlightHtml(tag.name, terms)}</a>`;
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
    void result;
    void tagsById;
    return "";
  }

  function renderTranscriptPlayHint(result) {
    const start = Number(result.transcript_start);
    const storedSeekTime = result.transcript_seek_time == null
      ? Number.NaN
      : Number(result.transcript_seek_time);
    const seekTime = Number.isFinite(storedSeekTime)
      ? storedSeekTime
      : transcriptPlaybackStart(start);
    if (!result.navigation_match || !Number.isFinite(start) || !Number.isFinite(seekTime) || seekTime <= 0) return "";
    const time = formatTranscriptTime(seekTime);
    return `
      <p class="audiobook-search-play-hint">
        <span>点击播放：</span>
        <button type="button" class="audiobook-search-time-link" data-transcript-seek="${start}" aria-label="从 ${escapeHtml(time)} 开始播放">${escapeHtml(time)}</button>
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
                <a href="/audiobooks/${encodeURIComponent(record.book_slug)}/" class="g-font-weight-700 g-font-size-16 audiobook-search-parent-link">${highlightHtml(record.parent_title, result.highlight_terms)}</a>
                <a href="${escapeHtml(record.url)}" class="g-font-weight-700 g-font-size-16 audio-title-link">${highlightHtml(record.title, result.highlight_terms)}</a>
              </h2>
              ${result.description_snippet ? `<p class="g-font-size-14 g-color-gray-dark-v4 mt-3 mb-2 audiobook-search-description">${highlightHtml(result.description_snippet, result.highlight_terms)}</p>` : ""}
              ${renderTranscriptPlayHint(result)}
              ${result.transcript_snippet ? `
                <div class="audiobook-search-transcript-hit">
                  <strong>字幕摘要</strong>
                  <p>${highlightHtml(result.transcript_snippet, result.highlight_terms)}</p>
                </div>
              ` : ""}
              ${record.tag_ids?.length ? `<div class="audio-card-tags g-mt-10 g-mb-10">${renderTagLinks(record, tagsById, result.highlight_terms)}</div>` : ""}
              ${record.audio_url ? `<audio controls preload="none" data-subtitle="${escapeHtml(record.subtitle_url)}"><source src="${escapeHtml(record.audio_url)}" type="audio/mpeg">您的浏览器不支持音频播放。</audio>` : ""}
              <div class="audiobook-search-meta">
                <p class="audiobook-search-date">${escapeHtml(record.date)}</p>
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
      const query = input.value;
      ["q", "collection", "tag", "sort", "page"].forEach(key => url.searchParams.delete(key));
      if (query.trim()) {
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
      const query = input.value;
      const serial = ++requestSerial;
      if (!query.trim()) {
        resetEmpty();
        updateUrl(options.historyMode || "replace");
        return;
      }
      status.textContent = "正在搜索…";
      emptyElement.hidden = true;
      try {
        await loadIndex();
        const preliminaryPlan = SearchQuery.parseQuery(query, buildVocabulary(payload, tagLookup(payload)));
        if (preliminaryPlan.needsMoreSpecific) {
          currentRawResults = [];
          currentResults = [];
          currentPage = 1;
          resultsElement.innerHTML = "";
          paginationElement.hidden = true;
          status.textContent = "";
          resetFacetControls();
          emptyElement.hidden = false;
          emptyElement.innerHTML = "<p><strong>请输入更具体的关键词。</strong></p>";
          updateUrl(options.historyMode || "replace");
          return;
        }
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
    AUDIO_NAVIGATION_WINDOW_SECONDS,
    INPUT_DEBOUNCE_MS,
    PAGE_SIZE,
    SEARCH_PROXIMITY_WINDOW,
    TRANSCRIPT_SEEK_LEAD_SECONDS,
    buildCollectionFacets,
    buildTagFacets,
    exactCollection,
    exactEpisode,
    bestNavigableTranscriptWindow,
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
