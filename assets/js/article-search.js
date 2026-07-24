(function articleSearchModule(root, factory) {
  const api = factory();

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
})(typeof globalThis !== "undefined" ? globalThis : this, function createArticleSearchApi() {
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

  function toArray(value) {
    return Array.isArray(value) ? value : value == null ? [] : [value];
  }

  function uniqueStrings(values) {
    return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\u00b7·・•,，、。.!！?？;；:'’"“”《》〈〉【】[\]()（）{}—–_\-/\\|｜]+/g, "");
  }

  function splitQuery(query) {
    return uniqueStrings(
      String(query || "")
        .trim()
        .split(/[\s,，、;；|｜]+/)
        .map(value => value.trim())
        .filter(Boolean)
    );
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

    return {
      article,
      normalized: {
        title: normalizeText(article.title),
        titleLines: normalizeText(titleLines.join(" ")),
        headings: normalizeText(headings.map(heading => heading.text).join(" ")),
        tags: normalizeText(tags.join(" ")),
        keywords: normalizeText(keywords.join(" ")),
        description: normalizeText(article.description),
        category: normalizeText(categoryParts.join(" ")),
        content: normalizeText(article.content)
      },
      values: {
        title: [article.title],
        titleLines,
        headings: headings.map(heading => heading.text),
        tags,
        keywords,
        description: [article.description],
        category: categoryParts,
        content: [article.content]
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

    queryTags.forEach(tag => {
      registryByName.set(normalizeText(tag.name), tag);

      const add = (value, kind, factor) => {
        const key = normalizeText(value);
        if (!key) return;
        const entries = registryTerms.get(key) || [];
        entries.push({ tag, kind, factor });
        registryTerms.set(key, entries);
      };

      add(tag.name, "name", 1);
      toArray(tag.aliases).forEach(value => add(value, "alias", 1));
      toArray(tag.keywords).forEach(value => add(value, "keyword", 0.25));
    });

    const prepared = {
      articles: toArray(source.articles).map(prepareArticle),
      queryTags,
      registryTerms,
      registryByName
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
      const { tag, factor, kind } = match;
      expandedTerms.push(tag.name, ...toArray(tag.aliases));

      if (preparedArticle.tagIds.has(String(tag.id))) {
        score += kind === "keyword" ? 110 : 1500 * factor;
        matched = true;
        matchedLookupTerms.push(match.lookupTerm);
      } else {
        const canonical = normalizeText(tag.name);
        if (
          preparedArticle.normalized.title.includes(canonical) ||
          preparedArticle.normalized.headings.includes(canonical) ||
          preparedArticle.normalized.keywords.includes(canonical) ||
          preparedArticle.normalized.content.includes(canonical)
        ) {
          score += kind === "keyword" ? 45 : 220 * factor;
          matched = true;
          matchedLookupTerms.push(match.lookupTerm);
        }
      }

      if (kind !== "keyword") {
        toArray(tag.related).forEach(relatedName => {
          const relatedTag = preparedPayload.registryByName.get(normalizeText(relatedName));
          if (relatedTag && preparedArticle.tagIds.has(String(relatedTag.id))) {
            score += 45;
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

  function buildTagFacets(results, queryTags) {
    const activeTags = new Map(
      toArray(queryTags)
        .filter(tag => tag?.id && tag?.name && String(tag.id) !== "articles")
        .map(tag => [String(tag.id), tag])
    );
    const counts = new Map();

    toArray(results).forEach(result => {
      const tagIds = new Set(
        toArray(resultArticle(result).tag_ids)
          .map(String)
          .filter(tagId => activeTags.has(tagId))
      );
      tagIds.forEach(tagId => counts.set(tagId, (counts.get(tagId) || 0) + 1));
    });

    return [...counts.entries()]
      .map(([id, count]) => ({
        id,
        name: activeTags.get(id).name,
        count
      }))
      .sort((left, right) =>
        right.count - left.count || left.name.localeCompare(right.name, "zh-CN")
      );
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

  function search(payload, query, options = {}) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const rawQuery = String(query || "").trim();
    if (!rawQuery) return { query: "", results: [], elapsed_ms: 0 };

    const preparedPayload = preparePayload(payload);
    const rawTerms = splitQuery(rawQuery);
    const normalizedTerms = rawTerms.map(normalizeText).filter(Boolean);
    const normalizedQuery = normalizeText(rawQuery);
    const registryLookupTerms = uniqueStrings([...normalizedTerms, normalizedQuery]);
    const registryMatches = resolveRegistryMatches(preparedPayload, registryLookupTerms);

    const results = preparedPayload.articles.flatMap(preparedArticle => {
      const article = preparedArticle.article;
      if (!matchesFilters(article, options.filters)) return [];

      const phrase = exactPhraseScore(preparedArticle, normalizedQuery);
      let score = phrase.score;
      let matchedTerms = 0;
      let bestLocation = phrase.location;
      let expandedTerms = [];

      normalizedTerms.forEach((term, index) => {
        const direct = scoreTerm(preparedArticle, term);
        score += direct.score;

        if (direct.matched) {
          matchedTerms += 1;
          if (!bestLocation) bestLocation = direct.location;
          return;
        }

        const fuzzy = scoreFuzzyTerm(preparedArticle, rawTerms[index]);
        if (fuzzy.score) {
          score += fuzzy.score;
          matchedTerms += 1;
          if (!bestLocation) bestLocation = fuzzy.location;
        }
      });

      const registry = scoreRegistryMatches(preparedArticle, registryMatches, preparedPayload);
      score += registry.score;
      expandedTerms = registry.expandedTerms;
      if (registry.matchedLookupTerms.includes(normalizedQuery)) {
        matchedTerms = normalizedTerms.length;
        if (!bestLocation) bestLocation = "知识点";
      } else if (registry.matched && matchedTerms === 0) {
        matchedTerms = Math.min(1, normalizedTerms.length);
        if (!bestLocation) bestLocation = "知识点";
      }

      if (!score || !matchedTerms) return [];

      const coverage = matchedTerms / Math.max(1, normalizedTerms.length);
      if (coverage === 1) {
        score = score * 1.35 + (normalizedTerms.length > 1 ? 400 : 0);
      } else if (coverage >= 0.5) {
        score *= 0.78;
      } else {
        score *= 0.42;
      }

      const snippet = chooseSnippet(article, rawTerms, expandedTerms);
      const matchUrl = snippet.anchor ? `${article.url}#${snippet.anchor}` : article.url;

      return [{
        article,
        score: Math.round(score * 100) / 100,
        matched_terms: matchedTerms,
        matched_location: bestLocation || snippet.location || "正文",
        match_heading: snippet.heading,
        match_url: matchUrl,
        snippet: snippet.snippet,
        highlight_terms: rawTerms
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
      query: rawQuery,
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

  function renderTags(article, tagByName) {
    return toArray(article.tags).map(tagName => {
      const registryTag = tagByName.get(tagName);
      const label = escapeHtml(tagName);
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
          <a class="article-search-cover-link" href="${escapeHtml(result.match_url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
            <img class="article-search-cover" src="${escapeHtml(article.cover)}" alt="" loading="lazy">
          </a>
        ` : ""}
        <div class="article-search-card-body">
          <h2 class="article-search-result-title">
            <a href="${escapeHtml(result.match_url)}" target="_blank" rel="noopener">${highlightHtml(article.title, terms)}</a>
          </h2>
          ${article.date ? `<p class="article-search-meta">${escapeHtml(article.date)}</p>` : ""}
          ${result.match_heading ? `
            <p class="article-search-section">
              <a href="${escapeHtml(result.match_url)}" target="_blank" rel="noopener">${highlightHtml(result.match_heading, terms)}</a>
            </p>
          ` : ""}
          ${result.snippet ? `<p class="article-search-snippet">${highlightHtml(result.snippet, terms)}</p>` : ""}
          ${article.tags?.length ? `<div class="article-search-tags" aria-label="相关知识点">${renderTags(article, tagByName)}</div>` : ""}
          <a class="article-search-read" href="${escapeHtml(result.match_url)}" target="_blank" rel="noopener">阅读全文 <span aria-hidden="true">→</span></a>
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

    const readUrlState = () => {
      const url = new URL(window.location.href);
      return {
        query: url.searchParams.get("q") || "",
        category: url.searchParams.get("category") || "",
        tag: url.searchParams.get("tag") || "",
        sort: url.searchParams.get("sort") === "latest" ? "latest" : "relevance",
        page: Math.max(parseInt(url.searchParams.get("page"), 10) || 1, 1)
      };
    };

    const updateUrl = (query, historyMode = "replace") => {
      if (historyMode === "none") return;
      const url = new URL(window.location.href);
      const cleanQuery = String(query || "").trim();

      if (cleanQuery) {
        url.searchParams.set("q", cleanQuery);
        if (categorySelect.value) url.searchParams.set("category", categorySelect.value);
        else url.searchParams.delete("category");
        if (tagSelect.value) url.searchParams.set("tag", tagSelect.value);
        else url.searchParams.delete("tag");
        url.searchParams.set("sort", sortSelect.value === "latest" ? "latest" : "relevance");
        if (currentPage > 1) url.searchParams.set("page", String(currentPage));
        else url.searchParams.delete("page");
      } else {
        ["q", "category", "tag", "sort", "page"].forEach(parameter =>
          url.searchParams.delete(parameter)
        );
      }

      const method = historyMode === "push" ? "pushState" : "replaceState";
      history[method]({}, "", url);
    };

    const populateFacetSelect = (select, allLabel, total, options, requestedValue) => {
      select.innerHTML = "";
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = `${allLabel}（${total}）`;
      select.appendChild(allOption);

      options.forEach(option => {
        const element = document.createElement("option");
        element.value = option.id;
        element.textContent = `${option.name}（${option.count}）`;
        select.appendChild(element);
      });

      const validValue = options.some(option => option.id === requestedValue)
        ? requestedValue
        : "";
      select.value = validValue;
      select.disabled = total === 0 || options.length === 0;
      return validValue;
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
      const tagFacets = buildTagFacets(categoryResults, payload?.query_tags);
      const selectedTag = populateFacetSelect(
        tagSelect,
        "全部知识点",
        categoryResults.length,
        tagFacets,
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
      const query = input.value.trim();
      if (!options.preservePage) currentPage = 1;

      if (!query) {
        renderEmptyInput();
        updateUrl("", options.historyMode || "replace");
        return;
      }

      emptyElement.hidden = true;
      status.textContent = "正在搜索…";

      try {
        const data = await loadIndex();
        const result = search(data, query, { sort: "relevance" });
        const tagByName = new Map(toArray(data.query_tags).map(tag => [tag.name, tag]));

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
    articleCategoryIds,
    buildCategoryFacets,
    buildCategoryRegistry,
    buildTagFacets,
    categoryDisplayName,
    filterResultsByCategory,
    filterResultsByTag,
    fuzzyIncludes,
    highlightHtml,
    initArticleSearchPage,
    normalizeText,
    search,
    sortFacetedResults,
    splitQuery
  };
});
