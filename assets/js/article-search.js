(function articleSearchModule(root, factory) {
  const queryTools = typeof module === "object" && module.exports
    ? require("./search-query")
    : root.SearchQuery;
  const api = factory(queryTools);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  root.ArticleSearch = api;

  const start = () => api.initArticleSearchPage();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createArticleSearchApi(SearchQuery) {
  "use strict";

  const FIELD_WEIGHTS = {
    title: 10,
    titleLines: 9,
    headings: 7,
    tags: 7,
    keywords: 6,
    description: 5,
    category: 3,
    content: 1
  };

  const payloadCache = new WeakMap();
  const SEARCH_PROXIMITY_WINDOW = SearchQuery.SEARCH_PROXIMITY_WINDOW;

  function toArray(value) {
    return Array.isArray(value) ? value : value == null ? [] : [value];
  }

  function uniqueStrings(values) {
    return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
  }

  function normalizeText(value) {
    return SearchQuery.normalizeTerm(value);
  }

  function splitQuery(query) {
    return SearchQuery.parseQuery(query).effectiveTerms;
  }

  function countOccurrences(text, term) {
    if (!text || !term) return 0;
    let count = 0;
    let position = 0;

    while ((position = text.indexOf(term, position)) !== -1) {
      count += 1;
      position += Math.max(1, term.length);
      if (count >= 4) break;
    }

    return count;
  }

  function levenshteinWithin(left, right, maxDistance) {
    if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let row = 1; row <= left.length; row += 1) {
      const current = [row];
      let rowMinimum = row;

      for (let column = 1; column <= right.length; column += 1) {
        const cost = left[row - 1] === right[column - 1] ? 0 : 1;
        const value = Math.min(
          previous[column] + 1,
          current[column - 1] + 1,
          previous[column - 1] + cost
        );
        current.push(value);
        rowMinimum = Math.min(rowMinimum, value);
      }

      if (rowMinimum > maxDistance) return maxDistance + 1;
      previous = current;
    }

    return previous[right.length];
  }

  function fuzzyDistanceLimit(term) {
    const hasCjk = /[\u3400-\u9fff]/.test(term);
    if (hasCjk) {
      if (term.length < 4) return 0;
      return term.length >= 7 ? 2 : 1;
    }
    if (term.length < 5) return 0;
    return term.length >= 10 ? 2 : 1;
  }

  function fuzzyIncludes(candidate, term) {
    const text = normalizeText(candidate);
    const query = normalizeText(term);
    const limit = fuzzyDistanceLimit(query);
    if (!limit || !text || !query) return 0;
    if (text.includes(query)) return 1;

    const minimumLength = Math.max(1, query.length - limit);
    const maximumLength = Math.min(text.length, query.length + limit);
    let best = 0;

    for (let length = minimumLength; length <= maximumLength; length += 1) {
      for (let start = 0; start + length <= text.length; start += 1) {
        const distance = levenshteinWithin(text.slice(start, start + length), query, limit);
        if (distance <= limit) {
          best = Math.max(best, 1 - distance / Math.max(query.length, length));
        }
      }
    }

    return best;
  }

  function prepareArticle(article) {
    const headings = toArray(article.headings);
    const categories = toArray(article.categories);
    const categoryParts = [
      article.category?.name,
      article.category?.parentName,
      ...categories.flatMap(category => [category?.name, category?.parentName])
    ];
    const titleLines = [article.title_line1, article.title_line2];
    const tags = toArray(article.tags);
    const keywords = toArray(article.keywords);
    const contentBlocks = toArray(article.content_blocks).length
      ? toArray(article.content_blocks).map((text, index) => {
        const section = toArray(article.sections).find(candidate =>
          index >= Number(candidate.block_start) && index < Number(candidate.block_end)
        );
        return { text, heading: section?.heading || "", anchor: section?.anchor || "" };
      })
      : toArray(article.sections).length
        ? toArray(article.sections).map(section => ({
          text: section.text || "",
          heading: section.heading || "",
          anchor: section.anchor || ""
        }))
        : [{ text: article.content || "", heading: "", anchor: "" }];
    const structuredFields = [
      { name: "title", label: "标题", values: [article.title] },
      { name: "titleLines", label: "标题", values: titleLines },
      { name: "headings", label: "章节", values: headings.map(heading => heading.text) },
      { name: "tags", label: "知识点", values: tags },
      { name: "keywords", label: "关键词", values: keywords },
      { name: "author", label: "作者", values: [article.author] },
      { name: "category", label: "栏目", values: categoryParts }
    ];

    return {
      article,
      structuredFields,
      contentBlocks,
      normalized: {
        title: normalizeText(article.title),
        titleLines: normalizeText(titleLines.join(" ")),
        headings: normalizeText(headings.map(heading => heading.text).join(" ")),
        tags: normalizeText(tags.join(" ")),
        keywords: normalizeText(keywords.join(" ")),
        description: normalizeText(article.description),
        category: normalizeText(categoryParts.join(" ")),
        content: normalizeText(article.content || contentBlocks.map(block => block.text).join(" "))
      },
      values: {
        title: [article.title],
        titleLines,
        headings: headings.map(heading => heading.text),
        tags,
        keywords,
        description: [article.description],
        category: categoryParts,
        content: [article.content || contentBlocks.map(block => block.text).join(" ")]
      },
      tagIds: new Set(toArray(article.tag_ids).map(String))
    };
  }

  function preparePayload(payload) {
    const source = Array.isArray(payload) ? { articles: payload, query_tags: [] } : payload || {};
    if (source && typeof source === "object" && payloadCache.has(source)) {
      return payloadCache.get(source);
    }

    const queryTags = toArray(source.query_tags);
    const registryTerms = new Map();
    const registryByName = new Map();
    const registryById = new Map();

    queryTags.forEach(tag => {
      registryByName.set(normalizeText(tag.name), tag);
      registryById.set(String(tag.id), tag);

      const add = (value, kind) => {
        const key = normalizeText(value);
        if (!key) return;
        const entries = registryTerms.get(key) || [];
        entries.push({ tag, kind });
        registryTerms.set(key, entries);
      };

      add(tag.name, "name");
      toArray(tag.aliases).forEach(value => add(value, "alias"));
      toArray(tag.phrases).forEach(value => add(value, "phrase"));
    });

    const articles = toArray(source.articles).map(prepareArticle);
    const vocabulary = articles.flatMap(preparedArticle =>
      preparedArticle.structuredFields.flatMap(field =>
        toArray(field.values).flatMap(value => String(value || "").trim()
          ? [{ value, field: field.name, label: field.label, recordId: preparedArticle.article.id }]
          : []
        )
      )
    );
    queryTags.forEach(tag => {
      if (tag?.name) vocabulary.push({ value: tag.name, field: "tags", label: "知识点", recordId: String(tag.id) });
    });

    const prepared = {
      articles,
      vocabulary,
      queryTags,
      registryTerms,
      registryByName,
      registryById
    };

    if (source && typeof source === "object") payloadCache.set(source, prepared);
    return prepared;
  }

  function exactPhraseScore(prepared, normalizedQuery) {
    const field = prepared.normalized;
    const values = prepared.values;
    let score = 0;
    let location = "";

    if (field.title === normalizedQuery) return { score: 5000, location: "标题" };
    if (field.title.includes(normalizedQuery)) return { score: 2500, location: "标题" };

    if (values.titleLines.some(value => normalizeText(value) === normalizedQuery)) {
      return { score: 2200, location: "标题" };
    }
    if (field.titleLines.includes(normalizedQuery)) {
      return { score: 1700, location: "标题" };
    }

    if (values.headings.some(value => normalizeText(value) === normalizedQuery)) {
      return { score: 1600, location: "章节" };
    }
    if (field.headings.includes(normalizedQuery)) {
      return { score: 1200, location: "章节" };
    }

    if (values.tags.some(value => normalizeText(value) === normalizedQuery)) {
      return { score: 1400, location: "知识点" };
    }
    if (field.tags.includes(normalizedQuery)) {
      return { score: 900, location: "知识点" };
    }

    if (values.keywords.some(value => normalizeText(value) === normalizedQuery)) {
      return { score: 1000, location: "关键词" };
    }
    if (field.keywords.includes(normalizedQuery)) {
      return { score: 650, location: "关键词" };
    }

    if (field.description.includes(normalizedQuery)) {
      score = 450;
      location = "简介";
    } else if (field.category.includes(normalizedQuery)) {
      score = 250;
      location = "栏目";
    } else if (field.content.includes(normalizedQuery)) {
      score = 80;
      location = "正文";
    }

    return { score, location };
  }

  function scoreTerm(prepared, normalizedTerm) {
    let score = 0;
    let matched = false;
    let location = "";
    let locationWeight = -1;

    Object.entries(FIELD_WEIGHTS).forEach(([fieldName, weight]) => {
      const field = prepared.normalized[fieldName];
      if (!field || !field.includes(normalizedTerm)) return;

      matched = true;
      const occurrences = countOccurrences(field, normalizedTerm);
      const exactValue = prepared.values[fieldName].some(
        value => normalizeText(value) === normalizedTerm
      );
      score += weight * (10 + Math.min(12, normalizedTerm.length) + occurrences * 2);
      if (exactValue) score += weight * 16;

      if (weight > locationWeight) {
        locationWeight = weight;
        location = {
          title: "标题",
          titleLines: "标题",
          headings: "章节",
          tags: "知识点",
          keywords: "关键词",
          description: "简介",
          category: "栏目",
          content: "正文"
        }[fieldName];
      }
    });

    return { score, matched, location };
  }

  function scoreFuzzyTerm(prepared, rawTerm) {
    const fields = ["title", "titleLines", "headings", "tags", "keywords", "description", "category"];
    let best = { score: 0, location: "" };

    fields.forEach(fieldName => {
      prepared.values[fieldName].forEach(value => {
        const similarity = fuzzyIncludes(value, rawTerm);
        if (!similarity) return;
        const score = FIELD_WEIGHTS[fieldName] * 14 * similarity;
        if (score > best.score) {
          best = {
            score,
            location: fieldName === "headings"
              ? "章节"
              : fieldName === "tags"
                ? "知识点"
                : fieldName === "title" || fieldName === "titleLines"
                  ? "标题"
                  : "模糊匹配"
          };
        }
      });
    });

    return best;
  }

  function resolveRegistryMatches(preparedPayload, normalizedTerms) {
    return normalizedTerms.flatMap(term =>
      (preparedPayload.registryTerms.get(term) || []).map(match => ({
        ...match,
        lookupTerm: term
      }))
    );
  }

  function scoreRegistryMatches(preparedArticle, registryMatches, preparedPayload) {
    let score = 0;
    let matched = false;
    const expandedTerms = [];
    const matchedLookupTerms = [];

    registryMatches.forEach(match => {
      const { tag, kind } = match;
      let nodeMatched = false;
      expandedTerms.push(tag.name, ...toArray(tag.aliases), ...toArray(tag.phrases));

      if (preparedArticle.tagIds.has(String(tag.id))) {
        score += kind === "phrase" ? 1250 : 1500;
        matched = true;
        nodeMatched = true;
        matchedLookupTerms.push(match.lookupTerm);
      } else {
        const canonical = normalizeText(tag.name);
        if (
          preparedArticle.normalized.title.includes(canonical) ||
          preparedArticle.normalized.headings.includes(canonical) ||
          preparedArticle.normalized.keywords.includes(canonical) ||
          preparedArticle.normalized.content.includes(canonical)
        ) {
          score += kind === "phrase" ? 180 : 220;
          matched = true;
          nodeMatched = true;
          matchedLookupTerms.push(match.lookupTerm);
        }
      }

      const expansionIds = toArray(tag.search_policy?.article_expansion_tag_ids).map(String);
      if (!preparedArticle.tagIds.has(String(tag.id)) && expansionIds.some(id => preparedArticle.tagIds.has(id))) {
        score += 800;
        matched = true;
        nodeMatched = true;
        matchedLookupTerms.push(match.lookupTerm);
      }

      toArray(tag.related_ids).forEach(relatedId => {
        if (preparedArticle.tagIds.has(String(relatedId))) score += 45;
      });

      if (nodeMatched) {
        toArray(tag.context_terms).forEach(contextTerm => {
          const normalizedContext = normalizeText(contextTerm);
          if (
            normalizedContext
            && (
              preparedArticle.normalized.title.includes(normalizedContext)
              || preparedArticle.normalized.headings.includes(normalizedContext)
              || preparedArticle.normalized.keywords.includes(normalizedContext)
              || preparedArticle.normalized.content.includes(normalizedContext)
            )
          ) {
            score += 12;
          }
        });
      }
    });

    return {
      score,
      matched,
      expandedTerms: uniqueStrings(expandedTerms),
      matchedLookupTerms: uniqueStrings(matchedLookupTerms)
    };
  }

  function matchesFilters(article, filters = {}) {
    if (filters.category) {
      const categoryId = String(filters.category);
      const categoryIds = [
        article.category?.id,
        ...toArray(article.categories).map(category => category?.id)
      ].filter(Boolean);
      if (!categoryIds.includes(categoryId)) return false;
    }

    if (filters.tag && !toArray(article.tag_ids).map(String).includes(String(filters.tag))) {
      return false;
    }

    if (filters.dateFrom && String(article.date || "") < String(filters.dateFrom)) return false;
    if (filters.dateTo && String(article.date || "") > String(filters.dateTo)) return false;
    return true;
  }

  function resultArticle(result) {
    return result?.article || result || {};
  }

  function articleCategoryRecords(article) {
    const records = [article?.category, ...toArray(article?.categories)]
      .filter(category => category && (category.id || category.name));
    const seen = new Set();

    return records.filter(category => {
      const key = String(category.id || category.name || "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function buildCategoryRegistry(results) {
    const registry = new Map();

    const upsert = category => {
      const id = String(category?.id || "").trim();
      if (!id) return;
      const current = registry.get(id) || {};
      registry.set(id, {
        id,
        name: String(category?.name || current.name || id).trim(),
        parent: String(category?.parent || current.parent || "").trim(),
        parentName: String(category?.parentName || current.parentName || "").trim()
      });
    };

    toArray(results).forEach(result => {
      articleCategoryRecords(resultArticle(result)).forEach(upsert);
    });

    [...registry.values()].forEach(category => {
      if (!category.parent || registry.has(category.parent)) return;
      upsert({
        id: category.parent,
        name: category.parentName || category.parent
      });
    });

    return registry;
  }

  function categoryDisplayName(categoryId, registry) {
    const id = String(categoryId || "");
    const category = registry.get(id);
    if (!category) return id;
    const name = String(category.name || id).trim();
    const levels = name.split(/\s*\/\s*/).filter(Boolean);
    return levels.at(-1) || name || id;
  }

  function articleCategoryIds(article, registry) {
    const ids = new Set();

    articleCategoryRecords(article).forEach(category => {
      let categoryId = String(category.id || "").trim();
      const visited = new Set();

      while (categoryId && !visited.has(categoryId)) {
        ids.add(categoryId);
        visited.add(categoryId);
        const registered = registry.get(categoryId);
        categoryId = String(registered?.parent || (
          category.id === categoryId ? category.parent : ""
        ) || "").trim();
      }
    });

    return ids;
  }

  function buildCategoryFacets(results) {
    const source = toArray(results);
    const registry = buildCategoryRegistry(source);
    const counts = new Map();

    source.forEach(result => {
      articleCategoryIds(resultArticle(result), registry).forEach(categoryId => {
        counts.set(categoryId, (counts.get(categoryId) || 0) + 1);
      });
    });

    const options = [...counts.entries()]
      .map(([id, count]) => ({
        id,
        name: categoryDisplayName(id, registry),
        count
      }))
      .sort((left, right) =>
        right.count - left.count || left.name.localeCompare(right.name, "zh-CN")
      );

    return { registry, options };
  }

  function filterResultsByCategory(results, categoryId, registry) {
    const id = String(categoryId || "").trim();
    const source = toArray(results);
    if (!id) return source.slice();
    const categoryRegistry = registry || buildCategoryRegistry(source);
    return source.filter(result =>
      articleCategoryIds(resultArticle(result), categoryRegistry).has(id)
    );
  }

  function buildTagFacets(results, queryTags, scopedResults = results) {
    const activeTags = new Map();
    const counts = new Map();

    toArray(queryTags).forEach(tag => {
      const canonicalId = String(tag?.canonical_id || tag?.id || "").trim();
      const canonicalName = String(tag?.canonical_name || tag?.name || "").trim();
      if (!canonicalId || !canonicalName || canonicalId === "articles" || activeTags.has(canonicalId)) {
        return;
      }
      activeTags.set(canonicalId, {
        canonical_id: canonicalId,
        canonical_name: canonicalName,
        aliases: uniqueStrings(tag.aliases)
      });
    });

    toArray(scopedResults).forEach(result => {
      const tagIds = new Set(
        toArray(resultArticle(result).tag_ids)
          .map(String)
          .filter(tagId => activeTags.has(tagId))
      );
      tagIds.forEach(tagId => counts.set(tagId, (counts.get(tagId) || 0) + 1));
    });

    return [...activeTags.values()]
      .map(tag => ({
        id: tag.canonical_id,
        name: tag.canonical_name,
        canonical_id: tag.canonical_id,
        canonical_name: tag.canonical_name,
        aliases: tag.aliases,
        count: counts.get(tag.canonical_id) || 0,
        current_count: counts.get(tag.canonical_id) || 0,
        selected: false
      }))
      .sort((left, right) =>
        right.count - left.count || left.name.localeCompare(right.name, "zh-CN")
      );
  }

  function buildVisibleTagFacets(facets, selectedTagId) {
    const selectedId = String(selectedTagId || "").trim();
    return toArray(facets)
      .filter(option => {
        const canonicalId = String(option?.canonical_id || option?.id || "").trim();
        const currentCount = Number(option?.current_count ?? option?.count) || 0;
        return currentCount > 0 || (selectedId && canonicalId === selectedId);
      })
      .map(option => {
        const canonicalId = String(option?.canonical_id || option?.id || "").trim();
        return {
          ...option,
          selected: Boolean(selectedId && canonicalId === selectedId)
        };
      });
  }

  function filterResultsByTag(results, tagId) {
    const id = String(tagId || "").trim();
    if (!id) return toArray(results).slice();
    return toArray(results).filter(result =>
      new Set(toArray(resultArticle(result).tag_ids).map(String)).has(id)
    );
  }

  function sortFacetedResults(results, sort) {
    const sorted = toArray(results).slice();
    if (sort !== "latest") return sorted;
    return sorted.sort((left, right) => {
      const dateOrder = String(resultArticle(right).date || "")
        .localeCompare(String(resultArticle(left).date || ""));
      return dateOrder || Number(right.score || 0) - Number(left.score || 0);
    });
  }

  function readSearchUrlState(urlValue) {
    const url = urlValue instanceof URL
      ? urlValue
      : new URL(String(urlValue || ""), "https://example.invalid");
    return {
      query: url.searchParams.get("q") || "",
      category: url.searchParams.get("category") || "",
      tag: url.searchParams.get("tag") || "",
      sort: url.searchParams.get("sort") === "latest" ? "latest" : "relevance",
      page: Math.max(parseInt(url.searchParams.get("page"), 10) || 1, 1)
    };
  }

  function writeSearchUrlState(urlValue, state = {}) {
    const url = urlValue instanceof URL
      ? new URL(urlValue.href)
      : new URL(String(urlValue || ""), "https://example.invalid");
    const cleanQuery = String(state.query || "");

    if (!cleanQuery.trim()) {
      ["q", "category", "tag", "sort", "page"].forEach(parameter =>
        url.searchParams.delete(parameter)
      );
      return url;
    }

    url.searchParams.set("q", cleanQuery);
    if (state.category) url.searchParams.set("category", String(state.category));
    else url.searchParams.delete("category");
    if (state.tag) url.searchParams.set("tag", String(state.tag));
    else url.searchParams.delete("tag");
    url.searchParams.set("sort", state.sort === "latest" ? "latest" : "relevance");
    const page = Math.max(parseInt(state.page, 10) || 1, 1);
    if (page > 1) url.searchParams.set("page", String(page));
    else url.searchParams.delete("page");
    return url;
  }

  function populateFacetSelect(select, allLabel, total, options, requestedValue, documentObject) {
    const documentApi = documentObject || (
      typeof document === "undefined" ? null : document
    );
    if (!select || !documentApi?.createElement) return "";

    select.innerHTML = "";
    const allOption = documentApi.createElement("option");
    allOption.value = "";
    allOption.textContent = `${allLabel}（${total}）`;
    select.appendChild(allOption);

    const seenCanonicalIds = new Set();
    const canonicalOptions = [];
    toArray(options).forEach(option => {
      const canonicalId = String(option?.canonical_id || option?.id || "").trim();
      const canonicalName = String(option?.canonical_name || option?.name || "").trim();
      if (!canonicalId || !canonicalName || seenCanonicalIds.has(canonicalId)) return;
      seenCanonicalIds.add(canonicalId);
      canonicalOptions.push({
        canonical_id: canonicalId,
        canonical_name: canonicalName,
        current_count: Number(option?.current_count ?? option?.count) || 0
      });
    });

    canonicalOptions.forEach(option => {
      const element = documentApi.createElement("option");
      element.value = option.canonical_id;
      element.textContent = `${option.canonical_name}（${option.current_count}）`;
      if (element.dataset) {
        element.dataset.canonicalId = option.canonical_id;
        element.dataset.canonicalName = option.canonical_name;
      }
      select.appendChild(element);
    });

    const requestedId = String(requestedValue || "");
    const validValue = seenCanonicalIds.has(requestedId) ? requestedId : "";
    select.value = validValue;
    select.disabled = canonicalOptions.length === 0;
    return validValue;
  }

  function findLiteralIndex(text, terms) {
    const source = String(text || "");
    const lower = source.toLocaleLowerCase();
    let best = -1;

    terms.forEach(term => {
      const index = lower.indexOf(String(term).toLocaleLowerCase());
      if (index !== -1 && (best === -1 || index < best)) best = index;
    });

    return best;
  }

  function createSnippet(text, terms, length = 210) {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    if (!source) return "";
    const index = findLiteralIndex(source, terms);
    const center = index === -1 ? 0 : index;
    const start = Math.max(0, center - Math.floor(length * 0.32));
    const end = Math.min(source.length, start + length);
    return `${start > 0 ? "…" : ""}${source.slice(start, end).trim()}${end < source.length ? "…" : ""}`;
  }

  function chooseSnippet(article, actualTerms, expandedTerms) {
    const sections = toArray(article.sections);
    const actualNormalized = actualTerms.map(normalizeText).filter(Boolean);
    const expandedNormalized = expandedTerms.map(normalizeText).filter(Boolean);

    const findSection = normalizedTerms => sections.find(section => {
      const heading = normalizeText(section.heading);
      const text = normalizeText(section.text);
      return normalizedTerms.some(term => heading.includes(term) || text.includes(term));
    });

    const actualSection = findSection(actualNormalized);
    const expandedSection = actualSection ? null : findSection(expandedNormalized);
    const section = actualSection || expandedSection;

    if (section) {
      return {
        snippet: createSnippet(section.text, actualTerms),
        heading: section.heading || "",
        anchor: section.anchor || "",
        location: "章节"
      };
    }

    const descriptionHasActual = actualNormalized.some(
      term => normalizeText(article.description).includes(term)
    );
    if (descriptionHasActual || article.description) {
      return {
        snippet: createSnippet(article.description, actualTerms),
        heading: "",
        anchor: "",
        location: descriptionHasActual ? "简介" : ""
      };
    }

    return {
      snippet: createSnippet(article.content, actualTerms),
      heading: "",
      anchor: "",
      location: "正文"
    };
  }

  function bestNaturalBlock(blocks, terms) {
    let best = null;
    toArray(blocks).forEach(block => {
      const window = SearchQuery.findShortestWindow(block.text, terms, SEARCH_PROXIMITY_WINDOW);
      if (!window || (best && best.window.length <= window.length)) return;
      best = { block, window };
    });
    return best;
  }

  function bestNaturalSectionWindow(preparedArticle, terms) {
    const article = preparedArticle.article;
    const blocks = toArray(article.content_blocks);
    let best = null;
    toArray(article.sections).forEach(section => {
      const start = Math.max(0, Number(section.block_start) || 0);
      const end = Math.max(start, Math.min(blocks.length, Number(section.block_end) || start));
      const bodyText = blocks.slice(start, end).join(" ").replace(/\s+/g, " ").trim();
      const text = [section.heading, bodyText].filter(Boolean).join(" ");
      const window = SearchQuery.findShortestWindow(text, terms, SEARCH_PROXIMITY_WINDOW);
      if (!window || (best && best.window.length <= window.length)) return;
      best = {
        block: { text, heading: section.heading || "", anchor: section.anchor || "" },
        window
      };
    });
    return best;
  }

  function bestArticleSection(preparedArticle, parsed, interpretation) {
    const article = preparedArticle.article;
    const blocks = toArray(article.content_blocks);
    const naturalTerms = interpretation.naturalTerms || interpretation.terms;
    const normalizedTerms = interpretation.terms.map(normalizeText).filter(Boolean);
    const quotedTerms = toArray(parsed.quotedPhrases).map(normalizeText).filter(Boolean);
    const normalizedWhole = normalizeText(parsed.normalizedQuery.replace(/[“”"]/gu, ""));
    let best = null;

    toArray(article.sections).forEach((section, sectionIndex) => {
      const start = Math.max(0, Number(section.block_start) || 0);
      const end = Math.max(start, Math.min(blocks.length, Number(section.block_end) || start));
      const sectionText = blocks.slice(start, end).join(" ").replace(/\s+/g, " ").trim();
      const heading = String(section.heading || "").trim();
      const normalizedHeading = normalizeText(heading);
      const headingHits = normalizedTerms.filter(term => normalizedHeading.includes(term));
      const allTermsInHeading = normalizedTerms.length > 0 && headingHits.length === normalizedTerms.length;
      const quotedPhraseInHeading = quotedTerms.some(term => normalizedHeading.includes(term));
      const fullQueryInHeading = interpretation.kind === "full"
        && normalizedWhole
        && normalizedHeading.includes(normalizedWhole);
      const contentWindow = SearchQuery.findShortestWindow(sectionText, naturalTerms, SEARCH_PROXIMITY_WINDOW);
      const combinedWindow = SearchQuery.findShortestWindow(
        [heading, sectionText].filter(Boolean).join(" "),
        naturalTerms,
        SEARCH_PROXIMITY_WINDOW
      );

      let score = 0;
      let matchKind = "";
      if (quotedPhraseInHeading) {
        score = 60000;
        matchKind = "quoted-heading";
      } else if (fullQueryInHeading && normalizedWhole.length >= 4) {
        score = 55000;
        matchKind = "compound-heading";
      } else if (allTermsInHeading) {
        score = 50000;
        matchKind = "all-terms-heading";
      } else if (headingHits.length && combinedWindow) {
        score = 40000 + headingHits.length * 500;
        matchKind = "heading-and-content";
      } else if (contentWindow) {
        score = 30000;
        matchKind = "content-window";
      } else {
        return;
      }

      const navigationWindow = contentWindow || combinedWindow;
      const windowLength = navigationWindow?.length ?? 0;
      score += Math.max(0, SEARCH_PROXIMITY_WINDOW - windowLength);
      const contentTerms = naturalTerms.filter(term => !normalizedHeading.includes(normalizeText(term)));
      const snippetWindow = contentWindow || SearchQuery.findShortestWindow(
        sectionText,
        contentTerms,
        SEARCH_PROXIMITY_WINDOW
      );
      const candidate = {
        heading,
        anchor: String(section.anchor || ""),
        snippet: SearchQuery.createWindowSnippet(sectionText, snippetWindow),
        score,
        matchKind,
        windowLength,
        sectionIndex,
        blockStart: start,
        blockEnd: end,
        blockSpan: end - start,
        level: Number(section.level) || 2,
        headingMatchedTerms: headingHits
      };

      if (
        !best
        || candidate.score > best.score
        || (candidate.score === best.score && candidate.windowLength < best.windowLength)
        || (candidate.score === best.score && candidate.windowLength === best.windowLength && candidate.blockSpan < best.blockSpan)
        || (candidate.score === best.score && candidate.windowLength === best.windowLength && candidate.blockSpan === best.blockSpan && candidate.level > best.level)
        || (candidate.score === best.score && candidate.windowLength === best.windowLength && candidate.blockSpan === best.blockSpan && candidate.level === best.level && candidate.sectionIndex < best.sectionIndex)
      ) {
        best = candidate;
      }
    });

    return best;
  }

  function matchArticleStructured(preparedArticle, preparedPayload, terms) {
    const fields = new Map();
    for (const term of terms) {
      const direct = SearchQuery.matchStructured(preparedArticle.structuredFields, [term]);
      let registryMatched = false;
      toArray(preparedPayload.registryTerms.get(term)).forEach(match => {
        const directId = String(match.tag?.id || "");
        const expansionIds = toArray(match.tag?.search_policy?.article_expansion_tag_ids).map(String);
        if (preparedArticle.tagIds.has(directId) || expansionIds.some(id => preparedArticle.tagIds.has(id))) {
          registryMatched = true;
        }
      });
      if (!direct && !registryMatched) return null;
      toArray(direct?.matchedFields).forEach((field, index) => {
        fields.set(field, direct.matchedFieldLabels[index]);
      });
      if (registryMatched) fields.set("tags", "知识点");
    }
    return { matchedFields: [...fields.keys()], matchedFieldLabels: [...fields.values()] };
  }

  function interpretationMatch(preparedArticle, preparedPayload, parsed, interpretation) {
    const terms = interpretation.terms;
    const naturalTerms = interpretation.naturalTerms || terms;
    const structural = matchArticleStructured(preparedArticle, preparedPayload, terms);
    const descriptionWindow = SearchQuery.findShortestWindow(
      preparedArticle.article.description,
      naturalTerms,
      SEARCH_PROXIMITY_WINDOW
    );
    const blockContentMatch = bestNaturalBlock(preparedArticle.contentBlocks, naturalTerms);
    const sectionContentMatch = bestNaturalSectionWindow(preparedArticle, naturalTerms);
    const contentMatch = [blockContentMatch, sectionContentMatch]
      .filter(Boolean)
      .sort((left, right) => left.window.length - right.window.length)[0] || null;
    const title = normalizeText(preparedArticle.article.title);
    const titleLines = normalizeText([
      preparedArticle.article.title,
      preparedArticle.article.title_line1,
      preparedArticle.article.title_line2
    ].join(" "));
    const normalizedWhole = normalizeText(parsed.normalizedQuery.replace(/[“”"]/gu, ""));
    const allInTitle = terms.every(term => titleLines.includes(term));
    const exactTitle = normalizedWhole && title === normalizedWhole;
    const isQuoted = parsed.quotedPhrases.length > 0;
    const isSplit = interpretation.kind === "split";
    const candidates = [];

    if (structural) {
      const matchedFieldLabels = uniqueStrings(structural.matchedFieldLabels);
      let score = isSplit ? 8000 : 9500;
      if (allInTitle) score = isSplit ? 9800 : 10000;
      if (exactTitle) score = isQuoted ? 12000 : parsed.effectiveTerms.length === 1 ? 11500 : 11000;
      candidates.push({
        score,
        type: isSplit ? "split-structured" : "full-structured",
        location: matchedFieldLabels[0] || "结构化字段",
        matchedFields: structural.matchedFields,
        matchedFieldLabels,
        snippet: String(preparedArticle.article.description || "").trim()
          ? SearchQuery.createWindowSnippet(preparedArticle.article.description, null)
          : "",
        heading: "",
        anchor: "",
        windowLength: null
      });
    }
    if (descriptionWindow) {
      candidates.push({
        score: (isSplit ? 7000 : 9000) + Math.max(0, SEARCH_PROXIMITY_WINDOW - descriptionWindow.length),
        type: isSplit ? "split-description" : "full-description",
        location: "简介",
        matchedFields: ["description"],
        matchedFieldLabels: ["简介"],
        snippet: SearchQuery.createWindowSnippet(preparedArticle.article.description, descriptionWindow),
        heading: "",
        anchor: "",
        windowLength: descriptionWindow.length
      });
    }
    if (contentMatch) {
      candidates.push({
        score: (isSplit ? 6500 : 8500) + Math.max(0, SEARCH_PROXIMITY_WINDOW - contentMatch.window.length),
        type: isSplit ? "split-content" : "full-content",
        location: "正文",
        matchedFields: ["content"],
        matchedFieldLabels: ["正文"],
        snippet: SearchQuery.createWindowSnippet(contentMatch.block.text, contentMatch.window),
        heading: contentMatch.block.heading || "",
        anchor: contentMatch.block.anchor || "",
        windowLength: contentMatch.window.length
      });
    }
    candidates.sort((left, right) => right.score - left.score || (left.windowLength ?? Infinity) - (right.windowLength ?? Infinity));
    return candidates[0] ? { ...candidates[0], interpretation } : null;
  }

  function search(payload, query, options = {}) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const preparedPayload = preparePayload(payload);
    const parsed = SearchQuery.parseQuery(query, preparedPayload.vocabulary);
    if (parsed.isEmpty || parsed.needsMoreSpecific) {
      return { query: parsed.rawQuery, query_plan: parsed, results: [], elapsed_ms: 0 };
    }

    const results = preparedPayload.articles.flatMap(preparedArticle => {
      const article = preparedArticle.article;
      if (!matchesFilters(article, options.filters)) return [];
      const match = parsed.queryInterpretations
        .map(interpretation => interpretationMatch(preparedArticle, preparedPayload, parsed, interpretation))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || (left.windowLength ?? Infinity) - (right.windowLength ?? Infinity))[0];
      if (!match) return [];
      const navigation = bestArticleSection(preparedArticle, parsed, match.interpretation);
      const matchUrl = navigation?.anchor ? `${article.url}#${navigation.anchor}` : article.url;

      return [{
        article,
        score: Math.round(match.score * 100) / 100,
        matched_terms: match.interpretation.terms.length,
        matched_location: match.location,
        matched_type: match.type,
        matched_fields: match.matchedFields,
        matched_field_labels: match.matchedFieldLabels,
        match_window_length: match.windowLength,
        relevance_match: {
          type: match.type,
          location: match.location,
          fields: match.matchedFields,
          field_labels: match.matchedFieldLabels,
          window_length: match.windowLength
        },
        navigation_match: navigation ? {
          type: navigation.matchKind,
          heading: navigation.heading,
          anchor: navigation.anchor,
          score: navigation.score,
          window_length: navigation.windowLength,
          heading_level: navigation.level,
          block_start: navigation.blockStart,
          block_end: navigation.blockEnd,
          heading_matched_terms: navigation.headingMatchedTerms
        } : null,
        query_interpretation: match.interpretation,
        match_heading: navigation?.heading || "",
        match_url: matchUrl,
        snippet: navigation?.snippet || match.snippet,
        highlight_terms: match.interpretation.displayTerms
      }];
    });

    const sort = options.sort === "latest" ? "latest" : "relevance";
    results.sort((left, right) => {
      if (sort === "latest") {
        const dateOrder = String(right.article.date || "").localeCompare(String(left.article.date || ""));
        if (dateOrder) return dateOrder;
      }
      return right.score - left.score ||
        String(right.article.date || "").localeCompare(String(left.article.date || ""));
    });

    const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      query: parsed.rawQuery,
      query_plan: parsed,
      sort,
      results,
      elapsed_ms: Math.round((finishedAt - startedAt) * 10) / 10
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

  function highlightHtml(text, terms) {
    const escapedText = escapeHtml(text);
    const escapedTerms = uniqueStrings(terms)
      .sort((left, right) => right.length - left.length)
      .map(term => escapeRegExp(escapeHtml(term)));

    if (!escapedTerms.length) return escapedText;
    return escapedText.replace(
      new RegExp(`(${escapedTerms.join("|")})`, "giu"),
      '<mark class="article-search-highlight">$1</mark>'
    );
  }

  function buildCanonicalTagLookup(queryTags) {
    const lookup = new Map();
    toArray(queryTags).forEach(tag => {
      if (!tag?.id || !tag?.name) return;
      [tag.name, ...toArray(tag.aliases)].forEach(term => {
        const normalized = normalizeText(term);
        if (normalized && !lookup.has(normalized)) lookup.set(normalized, tag);
      });
    });
    return lookup;
  }

  function renderTags(article, tagByName, terms = []) {
    return toArray(article.tags).map(tagName => {
      const registryTag = tagByName.get(normalizeText(tagName));
      const label = highlightHtml(registryTag?.name || tagName, terms);
      return registryTag?.id
        ? `<a class="article-search-tag" href="/tags/${encodeURIComponent(registryTag.id)}/" target="_blank" rel="noopener">${label}</a>`
        : `<span class="article-search-tag">${label}</span>`;
    }).join("");
  }

  function renderResult(result, tagByName) {
    const article = result.article;
    const terms = result.highlight_terms;

    return `
      <article class="article-search-card">
        ${article.cover ? `
          <a class="article-search-cover-link" href="${escapeHtml(article.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
            <img class="article-search-cover" src="${escapeHtml(article.cover)}" alt="" loading="lazy">
          </a>
        ` : ""}
        <div class="article-search-card-body">
          <h2 class="article-search-result-title">
            <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener">${highlightHtml(article.title, terms)}</a>
          </h2>
          ${article.date ? `<p class="article-search-meta">${escapeHtml(article.date)}</p>` : ""}
          ${result.match_heading ? `
            <p class="article-search-section">
              <a href="${escapeHtml(result.match_url)}" target="_blank" rel="noopener">${highlightHtml(result.match_heading, terms)}</a>
            </p>
          ` : ""}
          ${result.snippet ? `<p class="article-search-snippet">${highlightHtml(result.snippet, terms)}</p>` : ""}
          ${article.tags?.length ? `<div class="article-search-tags" aria-label="相关知识点">${renderTags(article, tagByName, terms)}</div>` : ""}
          <a class="article-search-read" href="${escapeHtml(article.url)}" target="_blank" rel="noopener">阅读全文 <span aria-hidden="true">→</span></a>
        </div>
      </article>
    `;
  }

  function initArticleSearchPage() {
    if (typeof document === "undefined") return;
    const rootElement = document.querySelector("[data-article-search]");
    if (!rootElement) return;

    const form = rootElement.querySelector("[data-search-form]");
    const input = rootElement.querySelector("[data-search-input]");
    const clearButton = rootElement.querySelector("[data-search-clear]");
    const categorySelect = rootElement.querySelector("[data-search-category]");
    const tagSelect = rootElement.querySelector("[data-search-tag]");
    const sortSelect = rootElement.querySelector("[data-search-sort]");
    const status = rootElement.querySelector("[data-search-status]");
    const resultsElement = rootElement.querySelector("[data-search-results]");
    const paginationElement = rootElement.querySelector("[data-search-pagination]");
    const emptyElement = rootElement.querySelector("[data-search-empty]");
    const pageSize = 20;
    let payload = null;
    let loadingPromise = null;
    let currentRawResults = [];
    let currentResults = [];
    let currentTagByName = new Map();
    let currentElapsedMs = 0;
    let currentPage = 1;

    const loadIndex = () => {
      if (payload) return Promise.resolve(payload);
      if (loadingPromise) return loadingPromise;

      status.textContent = "正在载入文章索引…";
      loadingPromise = fetch("/search/articles-index.json")
        .then(response => {
          if (!response.ok) throw new Error(`索引载入失败：${response.status}`);
          return response.json();
        })
        .then(data => {
          payload = data;
          status.textContent = `已载入 ${data.stats?.indexed_articles || data.articles?.length || 0} 篇文章`;
          return data;
        })
        .catch(error => {
          status.textContent = "文章索引暂时无法载入，请稍后重试。";
          throw error;
        });

      return loadingPromise;
    };

    const readUrlState = () => readSearchUrlState(window.location.href);

    const updateUrl = (query, historyMode = "replace") => {
      if (historyMode === "none") return;
      const url = writeSearchUrlState(window.location.href, {
        query,
        category: categorySelect.value,
        tag: tagSelect.value,
        sort: sortSelect.value,
        page: currentPage
      });

      const method = historyMode === "push" ? "pushState" : "replaceState";
      history[method]({}, "", url);
    };

    const makePaginationButton = (text, targetPage, disabled, isCurrent, accessibleLabel) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "site-pagination__button";
      button.textContent = text;
      button.disabled = disabled;
      button.setAttribute("aria-label", accessibleLabel || `搜索结果第 ${text} 页`);
      if (isCurrent) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => {
        currentPage = targetPage;
        renderCurrentPage(true, "push");
      });
      return button;
    };

    const renderPagination = () => {
      const pageCount = Math.ceil(currentResults.length / pageSize);
      paginationElement.innerHTML = "";

      if (pageCount <= 1) {
        paginationElement.hidden = true;
        return;
      }

      paginationElement.hidden = false;
      paginationElement.appendChild(
        makePaginationButton("‹", currentPage - 1, currentPage === 1, false, "搜索结果上一页")
      );

      let firstVisiblePage = Math.max(1, currentPage - 2);
      let lastVisiblePage = Math.min(pageCount, firstVisiblePage + 4);
      firstVisiblePage = Math.max(1, lastVisiblePage - 4);

      for (let pageNumber = firstVisiblePage; pageNumber <= lastVisiblePage; pageNumber += 1) {
        paginationElement.appendChild(
          makePaginationButton(String(pageNumber), pageNumber, false, pageNumber === currentPage)
        );
      }

      paginationElement.appendChild(
        makePaginationButton("›", currentPage + 1, currentPage === pageCount, false, "搜索结果下一页")
      );

      const paginationStatus = document.createElement("span");
      paginationStatus.className = "site-pagination__status";
      paginationStatus.setAttribute("aria-live", "polite");
      paginationStatus.textContent = `第 ${currentPage} / ${pageCount} 页，共 ${currentResults.length} 个文章`;
      paginationElement.appendChild(paginationStatus);
    };

    const renderCurrentPage = (shouldScroll, historyMode = "replace") => {
      const pageCount = Math.ceil(currentResults.length / pageSize);
      currentPage = Math.min(Math.max(currentPage, 1), pageCount || 1);
      const firstIndex = (currentPage - 1) * pageSize;
      const pageResults = currentResults.slice(firstIndex, firstIndex + pageSize);

      resultsElement.innerHTML = pageResults
        .map(item => renderResult(item, currentTagByName))
        .join("");
      renderPagination();
      updateUrl(input.value.trim(), historyMode);

      if (shouldScroll) {
        resultsElement.scrollIntoView({
          behavior: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start"
        });
      }
    };

    const resetFacetControls = () => {
      populateFacetSelect(categorySelect, "全部栏目", 0, [], "");
      populateFacetSelect(tagSelect, "全部知识点", 0, [], "");
    };

    const renderEmptyInput = () => {
      currentRawResults = [];
      currentResults = [];
      currentElapsedMs = 0;
      currentPage = 1;
      resultsElement.innerHTML = "";
      paginationElement.innerHTML = "";
      paginationElement.hidden = true;
      status.textContent = "";
      resetFacetControls();
      emptyElement.hidden = false;
      emptyElement.innerHTML = "<p>输入关键词，搜索生命之书中的全部文章。</p>";
    };

    const renderNoResults = rawResultCount => {
      paginationElement.hidden = true;
      emptyElement.hidden = false;

      if (!rawResultCount) {
        emptyElement.innerHTML = `
          <p><strong>没有找到完全匹配的文章。</strong></p>
          <p>你可以尝试：缩短关键词、使用相近词语，或从相关知识节点继续探索。</p>
        `;
        return;
      }

      const actions = [];
      if (categorySelect.value) {
        actions.push('<button type="button" data-search-clear-filter="category">清除栏目筛选</button>');
      }
      if (tagSelect.value) {
        actions.push('<button type="button" data-search-clear-filter="tag">清除知识点筛选</button>');
      }
      actions.push('<button type="button" data-search-clear-filter="all">清除全部筛选</button>');

      emptyElement.innerHTML = `
        <p><strong>当前筛选条件下没有找到文章。</strong></p>
        <div class="article-search-empty-actions">${actions.join("")}</div>
      `;
    };

    const applyFacetsAndRender = (options = {}) => {
      const requestedCategory = options.requestedCategory == null
        ? categorySelect.value
        : String(options.requestedCategory);
      const requestedTag = options.requestedTag == null
        ? tagSelect.value
        : String(options.requestedTag);

      const categoryFacets = buildCategoryFacets(currentRawResults);
      const selectedCategory = populateFacetSelect(
        categorySelect,
        "全部栏目",
        currentRawResults.length,
        categoryFacets.options,
        requestedCategory
      );
      const categoryResults = filterResultsByCategory(
        currentRawResults,
        selectedCategory,
        categoryFacets.registry
      );
      const tagFacets = buildTagFacets(
        currentRawResults,
        payload?.query_tags,
        categoryResults
      );
      const visibleTagFacets = buildVisibleTagFacets(tagFacets, requestedTag);
      const selectedTag = populateFacetSelect(
        tagSelect,
        "全部知识点",
        categoryResults.length,
        visibleTagFacets,
        requestedTag
      );
      const filteredResults = filterResultsByTag(categoryResults, selectedTag);

      currentResults = sortFacetedResults(filteredResults, sortSelect.value);
      if (!options.preservePage) currentPage = 1;
      status.textContent = `找到 ${currentResults.length} 篇文章，用时 ${currentElapsedMs} 毫秒`;
      emptyElement.hidden = currentResults.length > 0;
      if (currentResults.length) emptyElement.innerHTML = "";
      else renderNoResults(currentRawResults.length);

      renderCurrentPage(Boolean(options.shouldScroll), options.historyMode || "replace");
    };

    const runSearch = async (options = {}) => {
      const query = input.value;
      if (!options.preservePage) currentPage = 1;

      if (!query.trim()) {
        renderEmptyInput();
        updateUrl("", options.historyMode || "replace");
        return;
      }

      emptyElement.hidden = true;
      status.textContent = "正在搜索…";

      try {
        const data = await loadIndex();
        const result = search(data, query, { sort: "relevance" });
        const tagByName = buildCanonicalTagLookup(data.query_tags);

        if (result.query_plan?.needsMoreSpecific) {
          currentRawResults = [];
          currentResults = [];
          currentPage = 1;
          resultsElement.innerHTML = "";
          paginationElement.hidden = true;
          status.textContent = "";
          resetFacetControls();
          emptyElement.hidden = false;
          emptyElement.innerHTML = "<p><strong>请输入更具体的关键词。</strong></p>";
          updateUrl(query, options.historyMode || "replace");
          return;
        }

        currentRawResults = result.results;
        currentElapsedMs = result.elapsed_ms;
        currentTagByName = tagByName;
        applyFacetsAndRender({
          requestedCategory: options.requestedCategory,
          requestedTag: options.requestedTag,
          preservePage: options.preservePage,
          historyMode: options.historyMode || "replace"
        });

        if (window.gtag && query.length >= 2) {
          window.gtag("event", "search", {
            search_term: query,
            search_type: "articles",
            has_results: currentResults.length > 0
          });
        }
      } catch (error) {
        currentRawResults = [];
        currentResults = [];
        resultsElement.innerHTML = "";
        paginationElement.innerHTML = "";
        paginationElement.hidden = true;
        resetFacetControls();
        emptyElement.hidden = false;
        emptyElement.innerHTML = "<p>搜索暂时不可用，请刷新页面后重试。</p>";
      }
    };

    form.addEventListener("submit", event => {
      event.preventDefault();
      runSearch({ historyMode: "push" });
    });

    clearButton.addEventListener("click", () => {
      input.value = "";
      sortSelect.value = "relevance";
      renderEmptyInput();
      updateUrl("", "push");
      input.focus();
    });

    categorySelect.addEventListener("change", () => {
      applyFacetsAndRender({
        requestedCategory: categorySelect.value,
        requestedTag: tagSelect.value,
        historyMode: "push"
      });
    });

    tagSelect.addEventListener("change", () => {
      applyFacetsAndRender({
        requestedCategory: categorySelect.value,
        requestedTag: tagSelect.value,
        historyMode: "push"
      });
    });

    sortSelect.addEventListener("change", () => {
      if (input.value.trim()) {
        if (payload && currentRawResults.length) {
          applyFacetsAndRender({
            requestedCategory: categorySelect.value,
            requestedTag: tagSelect.value,
            historyMode: "push"
          });
        } else {
          runSearch({ historyMode: "push" });
        }
      } else {
        updateUrl("", "replace");
      }
    });

    emptyElement.addEventListener("click", event => {
      const button = event.target.closest("[data-search-clear-filter]");
      if (!button) return;
      const action = button.getAttribute("data-search-clear-filter");
      if (action === "category" || action === "all") categorySelect.value = "";
      if (action === "tag" || action === "all") tagSelect.value = "";
      applyFacetsAndRender({
        requestedCategory: categorySelect.value,
        requestedTag: tagSelect.value,
        historyMode: "push"
      });
    });

    window.addEventListener("popstate", () => {
      const state = readUrlState();
      input.value = state.query;
      sortSelect.value = state.sort;
      currentPage = state.page;
      if (state.query.trim()) {
        runSearch({
          requestedCategory: state.category,
          requestedTag: state.tag,
          preservePage: true,
          historyMode: "replace"
        });
      } else {
        renderEmptyInput();
      }
    });

    const initialState = readUrlState();
    input.value = initialState.query;
    sortSelect.value = initialState.sort;
    currentPage = initialState.page;
    resetFacetControls();

    if (input.value.trim()) {
      runSearch({
        requestedCategory: initialState.category,
        requestedTag: initialState.tag,
        preservePage: true,
        historyMode: "replace"
      });
    }
    else renderEmptyInput();

    loadIndex().catch(() => {});
  }

  return {
    FIELD_WEIGHTS,
    SEARCH_PROXIMITY_WINDOW,
    articleCategoryIds,
    buildCanonicalTagLookup,
    buildCategoryFacets,
    buildCategoryRegistry,
    buildTagFacets,
    buildVisibleTagFacets,
    bestArticleSection,
    categoryDisplayName,
    filterResultsByCategory,
    filterResultsByTag,
    fuzzyIncludes,
    highlightHtml,
    initArticleSearchPage,
    normalizeText,
    populateFacetSelect,
    readSearchUrlState,
    renderResult,
    renderTags,
    search,
    sortFacetedResults,
    splitQuery,
    writeSearchUrlState
  };
});
