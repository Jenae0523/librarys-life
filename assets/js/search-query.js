(function searchQueryModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SearchQuery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSearchQueryApi() {
  "use strict";

  const SEARCH_PROXIMITY_WINDOW = 160;
  const STOP_TERMS = new Set([
    "的", "地", "得", "了", "着", "过",
    "吗", "呢", "啊", "吧", "呀",
    "一个", "一些", "这个", "那个",
    "和", "与", "及", "以及", "会"
  ]);
  const INTENT_TERMS = new Set([
    "如何", "怎么", "为什么", "什么", "什么是", "是否", "是不是"
  ]);
  const SEPARATOR_PATTERN = /[\s　,，;；、]+/u;
  const CJK_PATTERN = /^[\p{Script=Han}]+$/u;

  function toArray(value) {
    return Array.isArray(value) ? value : value == null ? [] : [value];
  }

  function uniqueStrings(values) {
    const seen = new Set();
    return toArray(values).flatMap(value => {
      const text = String(value || "").trim();
      const key = normalizeTerm(text);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [text];
    });
  }

  function normalizeWhitespace(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .replace(/[\s　]+/gu, " ")
      .trim();
  }

  function normalizeNaturalText(value) {
    return String(value == null ? "" : value)
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/(?:[a-z]:\\|\/)[^\s]+/gi, " ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\s　]+/gu, " ")
      .trim();
  }

  function normalizeTerm(value) {
    return normalizeNaturalText(value)
      .replace(/[\s　]+/gu, "")
      .replace(/[，,。.!！?？；;：:“”"'‘’（）()【】\[\]《》<>「」『』·・—–_\-/\\|]+/gu, "");
  }

  function extractQuoted(raw) {
    const source = String(raw == null ? "" : raw).normalize("NFKC");
    const phrases = [];
    let remainder = "";
    let index = 0;

    while (index < source.length) {
      const opener = source[index];
      if (opener !== '"' && opener !== "“") {
        remainder += opener;
        index += 1;
        continue;
      }
      const closer = opener === "“" ? "”" : '"';
      const end = source.indexOf(closer, index + 1);
      if (end === -1) {
        remainder += opener;
        index += 1;
        continue;
      }
      const phrase = normalizeWhitespace(source.slice(index + 1, end));
      if (phrase) phrases.push({ value: phrase, offset: index });
      remainder += " ";
      index = end + 1;
    }
    return { phrases, remainder };
  }

  function vocabularySupport(vocabulary, term) {
    const normalized = normalizeTerm(term);
    if (!normalized) return [];
    return toArray(vocabulary).filter(entry => {
      const value = normalizeTerm(entry?.value);
      return value && value.includes(normalized);
    }).slice(0, 5);
  }

  function trustedSplits(term, vocabulary) {
    const normalized = normalizeTerm(term);
    const codePoints = Array.from(normalized);
    if (!CJK_PATTERN.test(normalized) || codePoints.length < 4 || normalized.includes("之")) return [];

    const candidates = [];
    const addCandidate = parts => {
      const sources = parts.map(part => vocabularySupport(vocabulary, part));
      if (sources.some(items => !items.length)) return;
      const key = parts.join("|");
      if (candidates.some(candidate => candidate.key === key)) return;
      candidates.push({ key, terms: parts, sources });
    };

    for (let first = 2; first <= codePoints.length - 2; first += 1) {
      addCandidate([codePoints.slice(0, first).join(""), codePoints.slice(first).join("")]);
    }
    if (!candidates.length && codePoints.length >= 6) {
      for (let first = 2; first <= codePoints.length - 4; first += 1) {
        for (let second = first + 2; second <= codePoints.length - 2; second += 1) {
          addCandidate([
            codePoints.slice(0, first).join(""),
            codePoints.slice(first, second).join(""),
            codePoints.slice(second).join("")
          ]);
          if (candidates.length >= 6) break;
        }
        if (candidates.length >= 6) break;
      }
    }
    return candidates.slice(0, 6);
  }

  function parseQuery(rawQuery, vocabulary = []) {
    const raw = String(rawQuery == null ? "" : rawQuery);
    const normalizedQuery = normalizeWhitespace(raw);
    const quoted = extractQuoted(raw);
    const ignoredTerms = [];
    const units = [];

    quoted.phrases.forEach(phrase => {
      const normalized = normalizeTerm(phrase.value);
      if (normalized) units.push({ value: phrase.value, normalized, quoted: true, offset: phrase.offset });
    });

    quoted.remainder.split(SEPARATOR_PATTERN).filter(Boolean).forEach((value, index) => {
      const normalized = normalizeTerm(value);
      if (!normalized) return;
      if (STOP_TERMS.has(normalized) || INTENT_TERMS.has(normalized)) {
        ignoredTerms.push(value);
        return;
      }
      units.push({ value, normalized, quoted: false, offset: raw.length + index });
    });

    units.sort((left, right) => left.offset - right.offset);
    const deduplicated = [];
    const seen = new Set();
    units.forEach(unit => {
      if (seen.has(unit.normalized)) return;
      seen.add(unit.normalized);
      deduplicated.push(unit);
    });

    const interpretations = [];
    const addInterpretation = (terms, splitDetails = []) => {
      const normalizedTerms = [...new Set(terms.map(term => normalizeTerm(term)).filter(Boolean))];
      if (!normalizedTerms.length) return;
      const key = [...normalizedTerms].sort().join("|");
      if (interpretations.some(item => item.key === key)) return;
      interpretations.push({
        key,
        terms: normalizedTerms,
        naturalTerms: [...new Set(terms.map(normalizeNaturalText).filter(Boolean))],
        displayTerms: uniqueStrings(terms),
        kind: splitDetails.length ? "split" : "full",
        splitDetails
      });
    };

    addInterpretation(deduplicated.map(unit => unit.value));
    deduplicated.forEach((unit, unitIndex) => {
      if (unit.quoted) return;
      trustedSplits(unit.value, vocabulary).forEach(split => {
        const terms = deduplicated.flatMap((candidate, index) => index === unitIndex ? split.terms : [candidate.value]);
        addInterpretation(terms, [{ original: unit.value, terms: split.terms, sources: split.sources }]);
      });
    });

    return {
      rawQuery: raw,
      normalizedQuery,
      quotedPhrases: quoted.phrases.map(phrase => phrase.value),
      effectiveTerms: deduplicated.map(unit => unit.value),
      queryInterpretations: interpretations,
      ignoredTerms: uniqueStrings(ignoredTerms),
      isEmpty: !normalizedQuery,
      needsMoreSpecific: Boolean(normalizedQuery) && !interpretations.length
    };
  }

  function findOccurrences(textPoints, termPoints) {
    const found = [];
    if (!termPoints.length || termPoints.length > textPoints.length) return found;
    for (let start = 0; start <= textPoints.length - termPoints.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < termPoints.length; offset += 1) {
        if (textPoints[start + offset] !== termPoints[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) found.push({ start, end: start + termPoints.length });
    }
    return found;
  }

  function findShortestWindow(value, terms, maximum = SEARCH_PROXIMITY_WINDOW) {
    const text = normalizeNaturalText(value);
    const textPoints = Array.from(text);
    const normalizedTerms = [...new Set(toArray(terms).map(normalizeNaturalText).filter(Boolean))];
    if (!textPoints.length || !normalizedTerms.length) return null;

    const events = [];
    for (let termIndex = 0; termIndex < normalizedTerms.length; termIndex += 1) {
      const occurrences = findOccurrences(textPoints, Array.from(normalizedTerms[termIndex]));
      if (!occurrences.length) return null;
      occurrences.forEach(position => events.push({ ...position, termIndex }));
    }
    events.sort((left, right) => left.start - right.start || left.end - right.end);

    const counts = Array(normalizedTerms.length).fill(0);
    let covered = 0;
    let left = 0;
    let best = null;
    for (let right = 0; right < events.length; right += 1) {
      if (counts[events[right].termIndex]++ === 0) covered += 1;
      while (covered === normalizedTerms.length && left <= right) {
        let end = 0;
        for (let cursor = left; cursor <= right; cursor += 1) end = Math.max(end, events[cursor].end);
        const start = events[left].start;
        const length = end - start;
        if (!best || length < best.length) best = { start, end, length };
        if (--counts[events[left].termIndex] === 0) covered -= 1;
        left += 1;
      }
    }
    return best && best.length <= maximum ? { ...best, text, terms: normalizedTerms } : null;
  }

  function createWindowSnippet(value, window, length = 210) {
    const text = normalizeNaturalText(value);
    const points = Array.from(text);
    if (!points.length) return "";
    if (!window) return points.slice(0, length).join("") + (points.length > length ? "…" : "");
    const span = window.end - window.start;
    const context = Math.max(0, length - span);
    let start = Math.max(0, window.start - Math.floor(context / 2));
    let end = Math.min(points.length, Math.max(window.end, start + length));
    start = Math.max(0, Math.min(start, end - length));
    return `${start > 0 ? "…" : ""}${points.slice(start, end).join("").trim()}${end < points.length ? "…" : ""}`;
  }

  function matchStructured(fields, terms) {
    const normalizedFields = toArray(fields).map(field => ({
      name: field.name,
      label: field.label,
      values: toArray(field.values),
      normalizedValues: toArray(field.values).map(normalizeTerm).filter(Boolean)
    }));
    const matchedFields = new Map();
    for (const term of terms) {
      const matches = normalizedFields.filter(field => field.normalizedValues.some(value => value.includes(term)));
      if (!matches.length) return null;
      matches.forEach(field => matchedFields.set(field.name, field.label));
    }
    return { matchedFields: [...matchedFields.keys()], matchedFieldLabels: [...matchedFields.values()] };
  }

  return {
    INTENT_TERMS,
    SEARCH_PROXIMITY_WINDOW,
    STOP_TERMS,
    createWindowSnippet,
    findShortestWindow,
    matchStructured,
    normalizeNaturalText,
    normalizeTerm,
    normalizeWhitespace,
    parseQuery,
    trustedSplits,
    uniqueStrings,
    vocabularySupport
  };
});
