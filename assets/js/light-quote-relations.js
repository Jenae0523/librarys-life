(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LightQuoteRelations = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RELATION_DIMENSIONS = Object.freeze(["theme", "book", "author", "concept", "tag", "life_issue", "state", "thought_tradition", "knowledge_node", "related_semantic"]);
  const ALL_DIMENSIONS = new Set([...RELATION_DIMENSIONS, "explicit"]);

  function values(value) {
    return [...new Set((Array.isArray(value) ? value : [value])
      .map(item => String(item || "").trim()).filter(Boolean))];
  }

  function buildRelationDirections(input) {
    const wrapped = input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "quote");
    const quote = wrapped ? input.quote : input;
    const semanticProfile = wrapped ? (input.semanticProfile || {}) : {};
    if (!quote || typeof quote !== "object") return [];
    const fields = [
      ["theme", quote.theme],
      ["book", quote.book_id],
      ["author", quote.author_ids],
      ["concept", semanticProfile.psychology_concepts ?? quote.psychology_concepts],
      ["tag", quote.tags],
      ["life_issue", semanticProfile.life_issues],
      ["state", semanticProfile.states],
      ["thought_tradition", semanticProfile.thought_traditions],
      ["knowledge_node", semanticProfile.direct_knowledge_node_ids],
      ["related_semantic", semanticProfile.related_semantic_node_ids]
    ];
    return fields.flatMap(([dimension, raw]) => values(raw).map(key => Object.freeze({ dimension, key })));
  }

  function resolveUrl(value, baseUrl) {
    if (!value) return "";
    try { return new URL(value, baseUrl || undefined).href; } catch (_) { return String(value); }
  }

  function validateMainManifest(manifest) {
    if (!manifest || manifest.schema_version !== 1 || typeof manifest.quote_dataset_version !== "string"
      || typeof manifest.relation_version !== "string" || !manifest.dimensions) {
      throw new Error("Invalid light quote relation manifest");
    }
    for (const dimension of ALL_DIMENSIONS) {
      if (!manifest.dimensions[dimension]) throw new Error(`Relation manifest is missing dimension: ${dimension}`);
    }
    return manifest;
  }

  function validateDimensionManifest(manifest, dimension, main) {
    if (!manifest || manifest.schema_version !== main.schema_version
      || manifest.quote_dataset_version !== main.quote_dataset_version
      || manifest.relation_version !== main.relation_version
      || manifest.dimension !== dimension || !manifest.buckets || typeof manifest.buckets !== "object") {
      throw new Error(`Invalid relation dimension manifest: ${dimension}`);
    }
    for (const [key, bucket] of Object.entries(manifest.buckets)) {
      if (!bucket || bucket.key !== key || !Number.isInteger(bucket.count) || bucket.count < 0 || !Array.isArray(bucket.chunks)) {
        throw new Error(`Invalid relation bucket metadata: ${dimension}/${key}`);
      }
      let start = 0;
      for (const chunk of bucket.chunks) {
        if (!chunk || chunk.start !== start || !Number.isInteger(chunk.count) || chunk.count <= 0 || !chunk.url) {
          throw new Error(`Invalid relation chunk coverage: ${dimension}/${key}`);
        }
        start += chunk.count;
      }
      if (start !== bucket.count) throw new Error(`Relation bucket count mismatch: ${dimension}/${key}`);
    }
    return manifest;
  }

  function createRelationStore(options = {}) {
    const documentObject = options.documentObject || (typeof document !== "undefined" ? document : null);
    const baseUrl = options.baseUrl || documentObject?.baseURI || (typeof location !== "undefined" ? location.href : undefined);
    const manifestUrl = resolveUrl(options.manifestUrl, baseUrl);
    const fetcher = options.fetcher || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!manifestUrl) throw new Error("Relation store requires manifestUrl");
    if (!fetcher) throw new Error("Relation store requires fetch");
    let manifestPromise = null;
    const dimensionPromises = new Map();
    const chunkPromises = new Map();

    async function fetchJson(url, label) {
      const response = await fetcher(url, { credentials: "same-origin" });
      if (!response?.ok) throw new Error(`${label} request failed (${response?.status || "network"})`);
      try { return await response.json(); } catch (error) {
        throw new Error(`${label} returned malformed JSON: ${error?.message || error}`);
      }
    }

    function getManifest() {
      if (!manifestPromise) {
        manifestPromise = fetchJson(manifestUrl, "Relation manifest").then(validateMainManifest).catch(error => {
          manifestPromise = null;
          throw error;
        });
      }
      return manifestPromise;
    }

    async function getDimension(dimension) {
      const normalized = String(dimension || "").trim();
      if (!ALL_DIMENSIONS.has(normalized)) throw new Error(`Unsupported relation dimension: ${normalized}`);
      const main = await getManifest();
      const url = resolveUrl(main.dimensions[normalized], manifestUrl);
      if (!dimensionPromises.has(url)) {
        const pending = fetchJson(url, `Relation dimension ${normalized}`)
          .then(value => validateDimensionManifest(value, normalized, main))
          .catch(error => {
            dimensionPromises.delete(url);
            throw error;
          });
        dimensionPromises.set(url, pending);
      }
      return { manifest: await dimensionPromises.get(url), url, main };
    }

    async function loadChunk(dimension, key, descriptor, context) {
      const url = resolveUrl(descriptor.url, context.url);
      if (!chunkPromises.has(url)) {
        const pending = fetchJson(url, `Relation chunk ${dimension}/${key}`)
          .then(chunk => {
            const field = dimension === "explicit" ? "edges" : "lq_ids";
            if (!chunk || chunk.schema_version !== context.main.schema_version
              || chunk.quote_dataset_version !== context.main.quote_dataset_version
              || chunk.relation_version !== context.main.relation_version
              || chunk.dimension !== dimension || chunk.key !== key
              || chunk.start !== descriptor.start || chunk.count !== descriptor.count
              || !Array.isArray(chunk[field]) || chunk[field].length !== descriptor.count) {
              throw new Error(`Malformed relation chunk: ${dimension}/${key}/${descriptor.url}`);
            }
            return chunk[field];
          })
          .catch(error => {
            chunkPromises.delete(url);
            throw error;
          });
        chunkPromises.set(url, pending);
      }
      return chunkPromises.get(url);
    }

    function pageRequest(options) {
      const numericOffset = options.offset === undefined || options.offset === null ? 0 : Number(options.offset);
      const numericLimit = options.limit === undefined || options.limit === null ? Infinity : Number(options.limit);
      if (!Number.isFinite(numericOffset) || numericOffset < 0) throw new RangeError("Relation offset must be a non-negative finite number");
      if (numericLimit !== Infinity && (!Number.isFinite(numericLimit) || numericLimit < 0)) {
        throw new RangeError("Relation limit must be a non-negative finite number");
      }
      return { offset: Math.floor(numericOffset), limit: numericLimit === Infinity ? Infinity : Math.floor(numericLimit) };
    }

    return Object.freeze({
      async getMetadata() {
        const manifest = await getManifest();
        return Object.freeze({
          quoteCount: manifest.quote_count,
          quoteDatasetVersion: manifest.quote_dataset_version,
          relationVersion: manifest.relation_version,
          dimensions: Object.freeze([...RELATION_DIMENSIONS]),
          reservedDimensions: Object.freeze([...(manifest.reserved_dimensions || [])])
        });
      },

      async getBucketMetadata({ dimension, key } = {}) {
        const normalizedKey = String(key || "").trim();
        if (!normalizedKey) return null;
        const context = await getDimension(dimension);
        const bucket = context.manifest.buckets[normalizedKey];
        return bucket ? Object.freeze({ dimension, key: normalizedKey, count: bucket.count, chunkCount: bucket.chunks.length }) : null;
      },

      async getCandidateIds(options = {}) {
        const dimension = String(options.dimension || "").trim();
        if (!RELATION_DIMENSIONS.includes(dimension)) throw new Error(`Unsupported relation dimension: ${dimension}`);
        const key = String(options.key || "").trim();
        if (!key) return [];
        const request = pageRequest(options);
        if (request.limit === 0) return [];
        const excluded = new Set(values(options.excludeIds ?? options.exclude_ids));
        const context = await getDimension(dimension);
        const bucket = context.manifest.buckets[key];
        if (!bucket) return [];
        const result = [];
        let remainingOffset = request.offset;
        for (const descriptor of bucket.chunks) {
          if (!excluded.size && descriptor.start + descriptor.count <= request.offset) continue;
          const ids = await loadChunk(dimension, key, descriptor, context);
          const localStart = excluded.size ? 0 : Math.max(0, request.offset - descriptor.start);
          for (let index = localStart; index < ids.length; index += 1) {
            const id = String(ids[index] || "").trim();
            if (!id || excluded.has(id)) continue;
            if (excluded.size && remainingOffset > 0) {
              remainingOffset -= 1;
              continue;
            }
            result.push(id);
            if (result.length >= request.limit) return result;
          }
        }
        return result;
      },

      async getExplicitRelations({ lqId, type } = {}) {
        const key = String(lqId || "").trim();
        if (!key) return [];
        const requestedType = String(type || "").trim();
        const context = await getDimension("explicit");
        const bucket = context.manifest.buckets[key];
        if (!bucket) return [];
        const edges = [];
        for (const descriptor of bucket.chunks) edges.push(...await loadChunk("explicit", key, descriptor, context));
        return requestedType ? edges.filter(edge => edge.type === requestedType) : edges;
      }
    });
  }

  return Object.freeze({ buildRelationDirections, createRelationStore });
});
