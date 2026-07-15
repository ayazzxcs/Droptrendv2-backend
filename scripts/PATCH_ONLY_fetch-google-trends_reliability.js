#!/usr/bin/env node
// Patch ONLY scripts/fetch-google-trends.js with reliability hardening.
// Adds: per-keyword timeout, chunk checkpoint files, chunk output files, and chunk meta.
// Usage from repo root: node PATCH_ONLY_fetch-google-trends_reliability.js
import fs from "fs";

const target = "scripts/fetch-google-trends.js";
if (!fs.existsSync(target)) {
  console.error(`Missing ${target}. Run this from repo root.`);
  process.exit(1);
}
let text = fs.readFileSync(target, "utf8");
const backup = `${target}.backup-before-reliability-patch`;
if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);

function replaceOnce(find, repl, label) {
  if (!text.includes(find)) {
    console.error(`Patch anchor not found: ${label}`);
    process.exit(1);
  }
  text = text.replace(find, repl);
}

// 1) Add fs import if missing.
if (!text.includes('import fs from "fs";')) {
  replaceOnce('import { chromium } from "playwright";\n', 'import { chromium } from "playwright";\nimport fs from "fs";\n', 'playwright import');
}

// 2) Add reliability constants/helpers after keywords are computed.
if (!text.includes('const CHUNK_SIGNAL_FILE = `google-trends-chunk-${CHUNK_OUTPUT_INDEX}.json`;')) {
  const anchor = `const keywords = CHUNK_SIZE > 0
  ? allKeywords.slice(CHUNK_START, CHUNK_START + CHUNK_SIZE)
  : allKeywords;
`;
  const insert = anchor + `
// =============================================
// Reliability hardening: chunk-safe files, checkpointing and per-keyword timeout
// =============================================
const CHUNK_OUTPUT_INDEX = TOTAL_CHUNKS > 1 ? NORMALIZED_CHUNK_INDEX : 0;
const IS_CHUNKED_GOOGLE_TRENDS_RUN = TOTAL_CHUNKS > 1 || CHUNK_SIZE > 0;
const CHUNK_SIGNAL_FILE = \`google-trends-chunk-\${CHUNK_OUTPUT_INDEX}.json\`;
const CHUNK_FAILED_FILE = \`google-trends-failed-chunk-\${CHUNK_OUTPUT_INDEX}.json\`;
const CHUNK_CHECKPOINT_FILE = \`google-trends-checkpoint-chunk-\${CHUNK_OUTPUT_INDEX}.json\`;
const CHUNK_META_FILE = \`google-trends-meta-chunk-\${CHUNK_OUTPUT_INDEX}.json\`;
const KEYWORD_TIMEOUT_MS = intEnv(["GOOGLE_TRENDS_KEYWORD_TIMEOUT_MS"], 180000);

function atomicWriteJson(path, data) {
  const tmp = \`${path}.tmp\`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path);
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(\`${label} timed out after ${ms}ms\`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
`;
  replaceOnce(anchor, insert, 'keywords block');
}

// 3) Add saveChunkProgress after signals arrays.
if (!text.includes('function saveChunkProgress(extra = {})')) {
  const anchor = `const signals = [];
const failed = [];
`;
  const insert = anchor + `
function saveChunkProgress(extra = {}) {
  const now = new Date().toISOString();
  atomicWriteJson(CHUNK_SIGNAL_FILE, signals);
  atomicWriteJson(CHUNK_FAILED_FILE, failed);
  atomicWriteJson(CHUNK_CHECKPOINT_FILE, {
    updatedAt: now,
    chunkIndex: CHUNK_OUTPUT_INDEX,
    rawChunkIndex: RAW_CHUNK_INDEX,
    normalizedChunkIndex: NORMALIZED_CHUNK_INDEX,
    totalChunks: TOTAL_CHUNKS,
    chunkStart: CHUNK_START,
    chunkSize: CHUNK_SIZE || keywords.length,
    attemptedKeywordCount: keywords.length,
    processedKeywordCount: signals.length + failed.length,
    savedSignalCount: signals.length,
    failedCount: failed.length,
    lastKeyword: extra.lastKeyword || "",
    status: extra.status || "running",
    error: extra.error || "",
    uniqueVariantsFetched: variantCacheMisses,
    reusedVariantChecks: variantCacheHits,
    variantCacheSize: VARIANT_RESULT_CACHE.size,
    keywordTimeoutMs: KEYWORD_TIMEOUT_MS
  });
}
`;
  replaceOnce(anchor, insert, 'signals block');
}

// 4) Wrap fetchWithVariants in per-keyword timeout.
if (text.includes('const signal = await fetchWithVariants(pages, item);')) {
  text = text.replace('const signal = await fetchWithVariants(pages, item);', `const signal = await withTimeout(
      fetchWithVariants(pages, item),
      KEYWORD_TIMEOUT_MS,
      \`Google Trends keyword \${keyword}\`
    );`);
}

// 5) Save checkpoint after success and failure.
if (!text.includes('saveChunkProgress({ status: "running", lastKeyword: keyword });')) {
  text = text.replace('    await sleep(1200 + Math.floor(Math.random() * 1200));', `    saveChunkProgress({ status: "running", lastKeyword: keyword });
    await sleep(1200 + Math.floor(Math.random() * 1200));`);
}
if (!text.includes('saveChunkProgress({ status: "running", lastKeyword: keyword, error: err.message });')) {
  text = text.replace('    console.log("Google Trends network failed for", keyword, "-", err.message);\n    await sleep(2500);', `    console.log("Google Trends network failed for", keyword, "-", err.message);
    saveChunkProgress({ status: "running", lastKeyword: keyword, error: err.message });
    await sleep(2500);`);
}

// 6) Add final chunk file writes before final google-trends writes.
if (!text.includes('Chunk-level Google Trends output. Final google-trends.json should be produced by scripts/merge-google-trends-chunks.js')) {
  const anchor = `writeJson("google-trends.json", signals);
writeJson("google-trends-ranked.json", rankedSignals);
writeJson("google-trends-by-product.json", signalsByProduct);
writeJson("google-trends-meta.json", {`;
  const insert = `atomicWriteJson(CHUNK_SIGNAL_FILE, signals);
atomicWriteJson(CHUNK_META_FILE, {
  updatedAt: new Date().toISOString(),
  source: "google-trends-network",
  geo: GEO,
  dateRange: DATE_RANGE,
  chunkIndex: CHUNK_OUTPUT_INDEX,
  rawChunkIndex: RAW_CHUNK_INDEX,
  normalizedChunkIndex: NORMALIZED_CHUNK_INDEX,
  totalChunks: TOTAL_CHUNKS,
  poolKeywordCount: allKeywords.length,
  chunkStart: CHUNK_START,
  chunkSize: CHUNK_SIZE || keywords.length,
  attemptedKeywordCount: keywords.length,
  savedSignalCount: signals.length,
  productMappedSignalCount: Object.keys(signalsByProduct).length,
  failedCount: failed.length,
  uniqueVariantsFetched: variantCacheMisses,
  reusedVariantChecks: variantCacheHits,
  variantCacheSize: VARIANT_RESULT_CACHE.size,
  variantConcurrency: VARIANT_CONCURRENCY,
  keywordTimeoutMs: KEYWORD_TIMEOUT_MS,
  note: "Chunk-level Google Trends output. Final google-trends.json should be produced by scripts/merge-google-trends-chunks.js in matrix runs.",
  failed: failed.slice(0, 150)
});
saveChunkProgress({ status: "complete", lastKeyword: keywords[keywords.length - 1]?.keyword || "" });

// Backward compatibility: local/single-chunk runs still write final files directly.
writeJson("google-trends.json", signals);
writeJson("google-trends-ranked.json", rankedSignals);
writeJson("google-trends-by-product.json", signalsByProduct);
writeJson("google-trends-meta.json", {`;
  replaceOnce(anchor, insert, 'final write block');
}

fs.writeFileSync(target, text);
console.log(`Patched ${target}`);
console.log(`Backup saved at ${backup}`);
