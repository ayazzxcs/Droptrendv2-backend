// Quvirl Google Trends 3-month network capture
// Captures internal timeline JSON from Google Trends instead of trusting UI text.
// This avoids false "no data" results for common keywords like dress, bag, body care, etc.

import { chromium } from "playwright";
import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);

function intEnv(names, fallback = 0) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
  }
  return fallback;
}

function hasEnv(names) {
  return names.some(name => process.env[name] !== undefined && process.env[name] !== "");
}

const startEnvNames = [
  "GOOGLE_TRENDS_CHUNK_START",
  "GOOGLE_TRENDS_START_INDEX",
  "GOOGLE_TRENDS_OFFSET",
  "START_INDEX"
];

const sizeEnvNames = [
  "GOOGLE_TRENDS_CHUNK_SIZE",
  "GOOGLE_TRENDS_CHUNK_LIMIT",
  "GOOGLE_TRENDS_LIMIT",
  "GOOGLE_TRENDS_MAX_KEYWORDS",
  "CHUNK_SIZE",
  "CHUNK_LIMIT"
];

const totalPoolEnvNames = [
  "GOOGLE_TRENDS_KEYWORD_POOL_LIMIT",
  "GOOGLE_TRENDS_POOL_LIMIT",
  "GOOGLE_TRENDS_TOTAL_KEYWORDS",
  "GOOGLE_TRENDS_TOTAL_LIMIT",
  "KEYWORD_POOL_LIMIT"
];

const explicitStartProvided = hasEnv(startEnvNames);
const explicitSizeProvided = hasEnv(sizeEnvNames);
const explicitPoolProvided = hasEnv(totalPoolEnvNames);

// Backward-compatible behavior:
// Old workflow used:
//   GOOGLE_TRENDS_START_INDEX: matrix.start
//   GOOGLE_TRENDS_LIMIT: matrix.limit
// In that case GOOGLE_TRENDS_LIMIT must be treated as CHUNK SIZE, not pool size.
// New workflow can use:
//   GOOGLE_TRENDS_KEYWORD_POOL_LIMIT: 1500
//   GOOGLE_TRENDS_CHUNK_START: matrix.start
//   GOOGLE_TRENDS_CHUNK_SIZE: matrix.limit
const EXPLICIT_CHUNK_START = intEnv(startEnvNames, 0);
const EXPLICIT_CHUNK_SIZE = explicitSizeProvided ? intEnv(sizeEnvNames, 300) : 0;

const POOL_LIMIT = explicitPoolProvided
  ? intEnv(totalPoolEnvNames, 1500)
  : (explicitStartProvided ? Math.max(1500, EXPLICIT_CHUNK_START + EXPLICIT_CHUNK_SIZE) : intEnv(["GOOGLE_TRENDS_LIMIT"], 1500));

const TOTAL_CHUNKS = intEnv([
  "GOOGLE_TRENDS_CHUNK_TOTAL",
  "GOOGLE_TRENDS_TOTAL_CHUNKS",
  "TOTAL_CHUNKS"
], 0);

const RAW_CHUNK_INDEX = intEnv([
  "GOOGLE_TRENDS_CHUNK_INDEX",
  "GOOGLE_TRENDS_MATRIX_INDEX",
  "CHUNK_INDEX",
  "MATRIX_CHUNK"
], 0);

const CHUNK_INDEX_BASE = intEnv(["GOOGLE_TRENDS_CHUNK_INDEX_BASE", "CHUNK_INDEX_BASE"], 0);
const NORMALIZED_CHUNK_INDEX = Math.max(0, RAW_CHUNK_INDEX - CHUNK_INDEX_BASE);

const GEO = process.env.GOOGLE_TRENDS_GEO ?? "";
const DATE_RANGE = process.env.GOOGLE_TRENDS_DATE || "today 3-m";
const MIN_POINTS = intEnv(["GOOGLE_TRENDS_MIN_POINTS"], 3);
const RAW_MAX_VARIANTS = intEnv(["GOOGLE_TRENDS_MAX_VARIANTS"], 0);

// 0 or missing = no variant limit.
// Any positive number = limit variants.
const MAX_VARIANTS = RAW_MAX_VARIANTS > 0 ? RAW_MAX_VARIANTS : Infinity;
const VARIANT_CONCURRENCY = Math.max(
  1,
  intEnv(["GOOGLE_TRENDS_VARIANT_CONCURRENCY"], 6)
);

// Many product anchors deliberately share the same useful variant. Fetch each
// unique variant only once per matrix job, then reuse the real timeline for all
// relevant anchors. This preserves unlimited variant coverage without making
// tens of thousands of duplicate Google requests.
const VARIANT_RESULT_CACHE = new Map();
let variantCacheHits = 0;
let variantCacheMisses = 0;

const allKeywords = extractKeywords(products, POOL_LIMIT);

let CHUNK_START = 0;
let CHUNK_SIZE = 0;

if (explicitStartProvided && EXPLICIT_CHUNK_SIZE > 0) {
  CHUNK_START = EXPLICIT_CHUNK_START;
  CHUNK_SIZE = EXPLICIT_CHUNK_SIZE;
} else if (TOTAL_CHUNKS > 1) {
  CHUNK_SIZE = Math.ceil(allKeywords.length / TOTAL_CHUNKS);
  CHUNK_START = NORMALIZED_CHUNK_INDEX * CHUNK_SIZE;
}

const keywords = CHUNK_SIZE > 0
  ? allKeywords.slice(CHUNK_START, CHUNK_START + CHUNK_SIZE)
  : allKeywords;

writeJson("trend-keywords.json", keywords);
writeJson("trend-keywords-all.json", allKeywords);

console.log("Google Trends env debug:", {
  GOOGLE_TRENDS_START_INDEX: process.env.GOOGLE_TRENDS_START_INDEX || null,
  GOOGLE_TRENDS_CHUNK_START: process.env.GOOGLE_TRENDS_CHUNK_START || null,
  GOOGLE_TRENDS_LIMIT: process.env.GOOGLE_TRENDS_LIMIT || null,
  GOOGLE_TRENDS_CHUNK_SIZE: process.env.GOOGLE_TRENDS_CHUNK_SIZE || null,
  GOOGLE_TRENDS_KEYWORD_POOL_LIMIT: process.env.GOOGLE_TRENDS_KEYWORD_POOL_LIMIT || null,
  GOOGLE_TRENDS_CHUNK_INDEX: process.env.GOOGLE_TRENDS_CHUNK_INDEX || null,
  GOOGLE_TRENDS_CHUNK_TOTAL: process.env.GOOGLE_TRENDS_CHUNK_TOTAL || null
});

console.log(
  `Google Trends keyword pool: ${allKeywords.length}; ` +
  `chunk start ${CHUNK_START}; chunk size ${CHUNK_SIZE || keywords.length}; ` +
  `running ${keywords.length} keywords; first keyword: ${keywords[0]?.keyword || "none"}`
);

if (!keywords.length) {
  console.log("No keywords assigned to this Google Trends chunk. Check matrix start/limit env.");
}

console.log(
  `Google Trends keyword pool: ${allKeywords.length}; ` +
  `chunk index ${RAW_CHUNK_INDEX} base ${CHUNK_INDEX_BASE}; ` +
  `start ${CHUNK_START}; size ${CHUNK_SIZE || keywords.length}; ` +
  `running ${keywords.length} keywords.`
);

if (!keywords.length) {
  console.log("No keywords assigned to this Google Trends chunk. Check GOOGLE_TRENDS_CHUNK_INDEX / GOOGLE_TRENDS_CHUNK_TOTAL.");
}

const STOP_WORDS = new Set([
  "new", "hot", "sale", "fashion", "style", "quality", "good", "latest",
  "product", "products", "dropshipping", "wholesale", "supplier",
  // Marketplace/source words are removed before Google Trends checks.
  // We want real buyer demand keywords like "mosquito lamp", not "aliexpress mosquito lamp".
  "aliexpress", "ali", "express", "cj", "cjdropshipping", "zendrop", "ebay",
  "amazon", "temu", "shein", "dhgate", "doba", "autods", "dsers",
  "solid", "color", "colors", "mini", "large", "small", "piece", "pieces",
  "set", "sets", "with", "for", "and", "the", "this", "that",
  "2024", "2025", "2026", "plus", "size", "best", "high",
  "other", "replacement", "parts", "front", "only", "self", "pickup",
  "support", "supports", "supported", "compatible", "compatibility", "official", "certified", "brand"
]);

const PRODUCT_TERMS = new Set([
  "charger", "chargers", "cable", "cables", "adapter", "adapters", "powerbank", "powerbanks",
  "battery", "batteries", "speaker", "speakers", "earphone", "earphones", "earbud", "earbuds",
  "headphone", "headphones", "headset", "headsets", "microphone", "microphones", "camera", "cameras",
  "webcam", "projector", "monitor", "keyboard", "mouse", "router", "repeater", "hub", "dock",
  "controller", "gamepad", "console", "smartwatch", "tracker", "tablet", "laptop", "computer",
  "printer", "scanner", "flashlight", "torch", "bulb", "socket", "plug", "switch", "remote",
  "stylus", "tripod", "gimbal", "protector", "screen", "glass", "lens", "holder", "stand", "mount",
  "grip", "sofa", "chair", "table", "storage", "organizer", "vacuum", "cleaner", "mop", "brush",
  "broom", "dispenser", "humidifier", "diffuser", "fan", "heater", "cooler", "blender", "mixer",
  "grinder", "juicer", "kettle", "cooker", "toaster", "pan", "pot", "rack", "shelf", "box",
  "basket", "bin", "bottle", "cup", "mug", "mat", "pillow", "blanket", "sheet", "curtain",
  "lamp", "light", "decor", "mirror", "shirt", "tshirt", "blouse", "top", "dress", "skirt",
  "pants", "trousers", "jeans", "shorts", "jacket", "coat", "hoodie", "sweater", "cardigan",
  "vest", "bra", "underwear", "sock", "shoes", "sandals", "slippers", "boots", "cap", "hat",
  "belt", "wallet", "purse", "backpack", "handbag", "bag", "bracelet", "necklace", "earrings",
  "ring", "watch", "blazer", "makeup", "skincare", "serum", "cream", "cleanser", "mask", "comb",
  "dryer", "curler", "straightener", "shaver", "trimmer", "clipper", "razor", "massager", "spray",
  "tool", "screwdriver", "drill", "saw", "wrench", "pliers", "cutter", "knife", "meter", "tester",
  "sensor", "detector", "pump", "sprayer", "blower", "washer", "machine", "inflator", "compressor",
  "collar", "leash", "harness", "feeder", "bowl", "toy", "bed", "pet", "dog", "cat",
  "phone", "car", "baby", "fitness", "shower", "case", "cover"
]);

const WEAK_SINGLE_WORDS = new Set([
  "usb", "type", "fast", "charging", "charge", "wireless", "bluetooth", "magnetic",
  "smart", "digital", "electric", "electronic", "rechargeable", "adjustable", "foldable",
  "waterproof", "lightweight", "universal", "compatible", "support", "supported", "original",
  "official", "premium", "professional", "version", "model", "pro", "max", "ultra",
  "iphone", "ipad", "android", "samsung", "xiaomi", "huawei", "macbook",
  "home", "outdoor", "travel", "office", "beauty", "care", "body", "party", "supplies"
]);

function productTermBase(word) {
  if (PRODUCT_TERMS.has(word)) return word;
  const candidates = [];
  if (word.endsWith("ies") && word.length > 4) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es") && word.length > 4) candidates.push(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 3) candidates.push(word.slice(0, -1));
  return candidates.find(candidate => PRODUCT_TERMS.has(candidate)) || "";
}

function isProductTerm(word) {
  return Boolean(productTermBase(word));
}

function isMeaningfulSingleWordFallback(word, words) {
  if (!word || word.length < 4 || WEAK_SINGLE_WORDS.has(word)) return false;
  if (isProductTerm(word)) return true;
  return words.length >= 2 && words[words.length - 1] === word;
}

function stripMarketplaceWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\bali\s*[-_ ]?\s*express\b/g, " ")
    .replace(/\bcj\s*[-_ ]?\s*dropshipping\b/g, " ")
    .replace(/\bcjdropshipping\b/g, " ")
    .replace(/\bdrop\s*shipping\b/g, "dropshipping")
    .replace(/\b(aliexpress|cj|zendrop|ebay|amazon|temu|shein|dhgate|doba|autods|dsers)\b/g, " ");
}

function cleanKeyword(text) {
  return stripMarketplaceWords(text)
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b\d+(?:w|v|a|mah|wh|gb|tb|hz|khz|mhz|ghz|mm|cm|ft|inch|mp)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function keywordVariants(keywordOrItem) {
  const item = keywordOrItem && typeof keywordOrItem === "object"
    ? keywordOrItem
    : { keyword: keywordOrItem };

  const keyword = String(item.keyword || "");
  const suppliedVariants = Array.isArray(item.variants) ? item.variants : [];
  const clean = cleanKeyword(keyword);
  const words = clean.split(/\s+/).filter(Boolean);
  const variants = [];

  // Use the full product-derived candidate set first. This includes all useful
  // consecutive 2/3/4-word title phrases, full title, category, brand and
  // supplier keyword variants produced in utils.js.
  for (const supplied of suppliedVariants) {
    const normalized = cleanKeyword(supplied);
    if (normalized) variants.push(normalized);
  }

  // Backward-compatible fallback for old trend-keywords.json shapes.
  if (words.length) {
    variants.push(clean);

    const upper = Math.min(4, words.length);
    for (let size = upper; size >= 2; size -= 1) {
      for (let start = 0; start + size <= words.length; start += 1) {
        variants.push(words.slice(start, start + size).join(" "));
      }
    }

    const productWords = uniq(words.filter(isProductTerm));
    if (productWords.length) {
      variants.push(productWords.join(" "));
      for (const word of productWords) {
        variants.push(word);
        const base = productTermBase(word);
        if (base && base !== word) variants.push(base);
      }
    }

    const lastWord = words[words.length - 1];
    if (!productWords.length && isMeaningfulSingleWordFallback(lastWord, words)) variants.push(lastWord);
  }

  const finalVariants = uniq(variants).filter(v => v.length >= 3);

  return Number.isFinite(MAX_VARIANTS)
    ? finalVariants.slice(0, MAX_VARIANTS)
    : finalVariants;
}

function extractTimelineValuesFromAnyJson(obj) {
  const values = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node.timelineData)) {
      for (const row of node.timelineData) {
        const raw = row?.value?.[0] ?? row?.formattedValue?.[0] ?? row?.extractedValue?.[0];
        const n = Number(String(raw).replace(/[^0-9.\-]/g, ""));
        if (Number.isFinite(n)) values.push(n);
      }
    }

    if (Array.isArray(node.timeline_data)) {
      for (const row of node.timeline_data) {
        const raw = row?.values?.[0]?.extracted_value ?? row?.values?.[0]?.value ?? row?.value?.[0];
        const n = Number(String(raw).replace(/[^0-9.\-]/g, ""));
        if (Number.isFinite(n)) values.push(n);
      }
    }

    if (Array.isArray(node.default?.timelineData)) {
      for (const row of node.default.timelineData) {
        const raw = row?.value?.[0] ?? row?.formattedValue?.[0] ?? row?.extractedValue?.[0];
        const n = Number(String(raw).replace(/[^0-9.\-]/g, ""));
        if (Number.isFinite(n)) values.push(n);
      }
    }

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v);
    }
  }

  walk(obj);
  return values;
}

function extractTimelinePointsFromAnyJson(obj) {
  const points = [];

  function valueFromRow(row) {
    const raw =
      row?.value?.[0] ??
      row?.formattedValue?.[0] ??
      row?.extractedValue?.[0] ??
      row?.values?.[0]?.extracted_value ??
      row?.values?.[0]?.value ??
      row?.value;

    const n = Number(String(raw).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function labelFromRow(row, fallbackIndex) {
    if (row?.formattedTime) return String(row.formattedTime);
    if (row?.formattedAxisTime) return String(row.formattedAxisTime);
    if (row?.time) {
      const d = new Date(Number(row.time) * 1000);
      if (!Number.isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    }
    return `P${fallbackIndex + 1}`;
  }

  function addRows(rows) {
    for (const row of rows) {
      const value = valueFromRow(row);
      if (value === null || value < 0) continue;
      points.push({
        label: labelFromRow(row, points.length),
        value
      });
    }
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node.timelineData)) addRows(node.timelineData);
    if (Array.isArray(node.timeline_data)) addRows(node.timeline_data);
    if (Array.isArray(node.default?.timelineData)) addRows(node.default.timelineData);

    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v);
    }
  }

  walk(obj);

  const seen = new Set();
  const unique = [];
  for (const point of points) {
    const key = `${point.label}:${point.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }

  return unique;
}

function scoreFromValues(values) {
  const nums = values.map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (nums.length < MIN_POINTS || Math.max(...nums) <= 0) return null;

  const half = Math.max(1, Math.floor(nums.length / 2));
  const firstHalf = nums.slice(0, half);
  const secondHalf = nums.slice(half);

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const firstAvg = avg(firstHalf);
  const lastAvg = avg(secondHalf);
  const latestValue = nums[nums.length - 1];
  const maxValue = Math.max(...nums);

  const growthPercent = firstAvg > 0
    ? Math.round(((lastAvg - firstAvg) / firstAvg) * 100)
    : Math.round(lastAvg * 2);

  const positiveGrowth = Math.max(0, growthPercent);
  const growthScore = Math.max(0, Math.min(55, positiveGrowth * 0.45));
  const volumeScore = Math.max(0, Math.min(30, lastAvg * 0.35));
  const momentumScore = latestValue >= lastAvg ? 15 : 6;
  const googleTrendScore = Math.round(Math.max(1, Math.min(100, growthScore + volumeScore + momentumScore)));

  return {
    googleTrendScore,
    growthPercent,
    firstAvg: Math.round(firstAvg),
    lastAvg: Math.round(lastAvg),
    latestValue,
    maxValue,
    timelinePoints: nums.length
  };
}

async function fetchTrendForVariant(page, variant, originalKeyword) {
  const jsonBodies = [];
  let resolveTimelineReady = null;
  const timelineReady = new Promise(resolve => {
    resolveTimelineReady = resolve;
  });

  const responseHandler = async (res) => {
    try {
      const url = res.url();
      if (!/trends\/api|widgetdata|TIMESERIES|multiline|explore/i.test(url)) return;
      const text = await res.text();
      if (!text || text.length < 50) return;

      const cleaned = text.replace(/^\)\]\}',?\s*/, "").trim();
      if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) return;

      try {
        const parsed = JSON.parse(cleaned);
        jsonBodies.push(parsed);
        const points = extractTimelinePointsFromAnyJson(parsed);
        const values = points.length ? [] : extractTimelineValuesFromAnyJson(parsed);
        if (points.length >= MIN_POINTS || values.length >= MIN_POINTS) {
          resolveTimelineReady?.();
        }
      } catch {}
    } catch {}
  };

  page.on("response", responseHandler);

  try {
    const url = "https://trends.google.com/trends/explore?date=" +
      encodeURIComponent(DATE_RANGE) +
      "&geo=" + encodeURIComponent(GEO) +
      "&q=" + encodeURIComponent(variant);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // The old implementation waited 4.5 seconds before registering a response
    // waiter, which could miss the timeline response and then wait another eight
    // seconds. The response listener is now active before navigation, so we stop
    // as soon as usable timeline JSON arrives, with a bounded fallback wait.
    await Promise.race([
      timelineReady,
      page.waitForTimeout(7000)
    ]).catch(() => null);
    await page.waitForTimeout(600);
  } finally {
    page.off("response", responseHandler);
  }

  let bestTimeline = [];
  for (const json of jsonBodies) {
    const points = extractTimelinePointsFromAnyJson(json);
    if (points.length > bestTimeline.length) bestTimeline = points;
  }

  // Fallback for older JSON shapes: keep the original value-only extractor too.
  if (!bestTimeline.length) {
    for (const json of jsonBodies) {
      const values = extractTimelineValuesFromAnyJson(json);
      if (values.length > bestTimeline.length) {
        bestTimeline = values.map((value, index) => ({ label: `P${index + 1}`, value }));
      }
    }
  }

  const bestValues = bestTimeline.map(point => point.value);
  const cleanTimeline = bestTimeline
    .filter(point => Number.isFinite(Number(point.value)))
    .map((point, index) => ({
      label: point.label || `P${index + 1}`,
      value: Math.round(Number(point.value))
    }))
    .slice(-60);

  const scored = scoreFromValues(bestValues);
  if (!scored) {
    return {
      keyword: originalKeyword,
      usedKeyword: variant,
      match: 0,
      score: 0,
      rawScore: 0,
      growthPercent: 0,
      timeline: cleanTimeline,
      timelineValues: cleanTimeline.map(point => point.value),
      timelinePoints: cleanTimeline.length,
      source: "google-trends-network",
      fetchedAt: new Date().toISOString()
    };
  }

  return {
    keyword: originalKeyword,
    usedKeyword: variant,
    score: scored.googleTrendScore,
    rawScore: scored.googleTrendScore,
    growthPercent: scored.growthPercent,
    firstAvg: scored.firstAvg,
    lastAvg: scored.lastAvg,
    latestValue: scored.latestValue,
    maxValue: scored.maxValue,
    timeline: cleanTimeline,
    timelineValues: cleanTimeline.map(point => point.value),
    timelinePoints: cleanTimeline.length,
    match: 1,
    source: "google-trends-network",
    fetchedAt: new Date().toISOString()
  };
}


async function fetchTrendForVariantCached(page, variant, originalKeyword) {
  let cachedPromise = VARIANT_RESULT_CACHE.get(variant);
  const cacheHit = Boolean(cachedPromise);

  if (!cachedPromise) {
    variantCacheMisses += 1;
    cachedPromise = fetchTrendForVariant(page, variant, variant).catch(err => {
      // Network failures are retriable for another anchor; genuine match/no-match
      // results remain cached because the underlying Google timeline is identical.
      VARIANT_RESULT_CACHE.delete(variant);
      throw err;
    });
    VARIANT_RESULT_CACHE.set(variant, cachedPromise);
  } else {
    variantCacheHits += 1;
  }

  const baseSignal = await cachedPromise;

  // **CRITICAL FIX**: Check if the cached variant has any overlap with the current originalKeyword.
  // If not, treat it as a cache miss and fetch fresh.
  const originalWords = new Set(cleanKeyword(originalKeyword).split(/\s+/).filter(Boolean));
  const variantWords = new Set(cleanKeyword(variant).split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const word of variantWords) {
    if (originalWords.has(word)) {
      overlap += 1;
    }
  }
  if (overlap === 0 && originalWords.size > 0) {
    // This cached variant is completely unrelated to the current product.
    console.log(`Cache miss for variant "${variant}" (no overlap with "${originalKeyword}"), fetching fresh.`);
    VARIANT_RESULT_CACHE.delete(variant);
    const freshSignal = await fetchTrendForVariant(page, variant, variant);
    VARIANT_RESULT_CACHE.set(variant, Promise.resolve(freshSignal));
    return {
      ...freshSignal,
      keyword: originalKeyword,
      usedKeyword: variant,
      reusedVariantCache: false
    };
  }

  return {
    ...baseSignal,
    keyword: originalKeyword,
    usedKeyword: variant,
    reusedVariantCache: cacheHit
  };
}

function trendVariantWordCount(signalOrKeyword) {
  const text = typeof signalOrKeyword === "string"
    ? signalOrKeyword
    : (signalOrKeyword?.usedKeyword || signalOrKeyword?.keyword || "");

  return cleanKeyword(text).split(/\s+/).filter(Boolean).length;
}

function trendSignalScore(signal) {
  const score = Number(signal?.score || 0);
  return Number.isFinite(score) ? score : 0;
}

/**
 * Pick the best variant signal, but **reject** variants that share zero words
 * with the original product keyword. This is a second layer of defense after
 * the cache-level overlap check.
 */
function pickBestVariantSignal(signals, originalKeyword) {
  const matched = signals.filter(signal => signal?.match);
  if (!matched.length) return null;

  const originalWords = new Set(cleanKeyword(originalKeyword).split(/\s+/).filter(Boolean));

  // If the original keyword has no words after cleaning (e.g., it's a number or single character),
  // we can't enforce overlap – just pick the highest score.
  if (originalWords.size === 0) {
    matched.sort((a, b) => trendSignalScore(b) - trendSignalScore(a));
    return matched[0];
  }

  // Score each signal by overlap + trend score
  const scored = matched.map(signal => {
    const signalWords = new Set(cleanKeyword(signal.usedKeyword).split(/\s+/).filter(Boolean));
    let overlap = 0;
    for (const word of signalWords) {
      if (originalWords.has(word)) {
        overlap += 1;
      }
    }
    return { signal, overlap, score: trendSignalScore(signal) };
  });

  // Only keep candidates that have at least 1 overlapping word.
  const candidatesWithOverlap = scored.filter(s => s.overlap > 0);

  // If there are NO overlapping candidates, return NULL instead of picking a wrong one.
  if (candidatesWithOverlap.length === 0) {
    console.log(`Google Trends rejecting all variants for "${originalKeyword}" – no overlap with any matched signal.`);
    return null;
  }

  // Sort by overlap first, then by score.
  candidatesWithOverlap.sort((a, b) => b.overlap - a.overlap || b.score - a.score);
  return candidatesWithOverlap[0].signal;
}

async function runVariantGroup(pages, keyword, variants, checkedSignals, failedVariants) {
  for (let offset = 0; offset < variants.length; offset += pages.length) {
    const wave = variants.slice(offset, offset + pages.length);

    const results = await Promise.all(
      wave.map(async (variant, index) => {
        try {
          console.log(`Google Trends network: ${keyword} -> ${variant}`);
          return await fetchTrendForVariantCached(pages[index], variant, keyword);
        } catch (err) {
          failedVariants.push({ variant, error: err.message });
          console.log(`Google Trends variant failed for ${keyword} -> ${variant}: ${err.message}`);
          return null;
        }
      })
    );

    for (const signal of results) {
      if (signal) checkedSignals.push(signal);
    }

    if (offset + pages.length < variants.length) await sleep(500);
  }
}

async function fetchWithVariants(pages, item) {
  const keyword = String(item?.keyword || item || "");
  const generatedVariants = keywordVariants(item);
  const specificVariants = generatedVariants.filter(variant => trendVariantWordCount(variant) >= 2);
  const fallbackVariants = generatedVariants.filter(variant => trendVariantWordCount(variant) === 1);
  const checkedSignals = [];
  const failedVariants = [];

  console.log(
    `Google Trends variants generated for ${keyword}: ${generatedVariants.length} ` +
    `(${specificVariants.length} specific, ${fallbackVariants.length} single-word fallback)` +
    (item?.sourceTitles?.length ? ` from ${item.sourceTitles.length} full product title(s)` : "")
  );

  // Stage 1: test every specific multi-word phrase first. Single-word terms are
  // deliberately held back because they are broader and noisier.
  await runVariantGroup(pages, keyword, specificVariants, checkedSignals, failedVariants);

  let matchedSpecific = checkedSignals.filter(signal => signal?.match && trendVariantWordCount(signal) >= 2);
  let fallbackUsed = false;

  // Stage 2: only when every specific phrase has no usable 3-month timeline,
  // try meaningful product nouns such as "charger", "cable", "speaker", etc.
  if (!matchedSpecific.length && fallbackVariants.length) {
    fallbackUsed = true;
    console.log(
      `Google Trends specific variants had no usable data for ${keyword}; ` +
      `trying ${fallbackVariants.length} single-word fallback(s): ${fallbackVariants.join(", ")}`
    );
    await runVariantGroup(pages, keyword, fallbackVariants, checkedSignals, failedVariants);
  }

  // Pass the original keyword so the picker can penalize unrelated variants.
  const bestSignal = pickBestVariantSignal(checkedSignals, keyword);
  if (!bestSignal) return null;

  const checkedVariants = fallbackUsed
    ? [...specificVariants, ...fallbackVariants]
    : specificVariants;

  bestSignal.checkedVariants = checkedVariants;
  bestSignal.generatedVariants = generatedVariants;
  bestSignal.specificVariants = specificVariants;
  bestSignal.fallbackVariants = fallbackVariants;
  bestSignal.singleWordFallbackUsed = fallbackUsed;
  bestSignal.sourceTitles = Array.isArray(item?.sourceTitles) ? item.sourceTitles : [];
  bestSignal.productIds = Array.isArray(item?.productIds) ? item.productIds : [];
  bestSignal.variantSignals = checkedSignals
    .filter(signal => signal?.match)
    .map(signal => ({
      keyword: signal.keyword,
      usedKeyword: signal.usedKeyword,
      score: signal.score,
      growthPercent: signal.growthPercent,
      timelinePoints: signal.timelinePoints
    }));
  bestSignal.failedVariants = failedVariants;

  console.log(
    `Google Trends selected variant for ${keyword}: ${bestSignal.usedKeyword} ` +
    `score ${bestSignal.score} from ${bestSignal.variantSignals.length}/${checkedVariants.length} ` +
    `matched checked variants${fallbackUsed ? " (single-word fallback used)" : ""}`
  );

  return bestSignal;
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled"
  ]
});

const context = await browser.newContext({
  viewport: { width: 1365, height: 768 },
  locale: "en-US",
  timezoneId: "America/New_York",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  extraHTTPHeaders: {
    "Accept-Language": "en-US,en;q=0.9"
  }
});

const pages = await Promise.all(
  Array.from({ length: VARIANT_CONCURRENCY }, () => context.newPage())
);

console.log(`Google Trends variant concurrency per matrix job: ${pages.length}`);

const signals = [];
const failed = [];

console.log(`Google Trends keyword pool: ${allKeywords.length}; running ${keywords.length} keywords from offset ${CHUNK_START}.`);

for (const item of keywords) {
  const keyword = item.keyword;

  try {
    const signal = await fetchWithVariants(pages, item);
    if (signal?.match) {
      signals.push(signal);
      console.log(`Saved Google trend: ${keyword} -> ${signal.usedKeyword}, score ${signal.score}, growth ${signal.growthPercent}%`);
    } else {
      failed.push(keyword);
      console.log(`No 3-month Google Trends timeline data: ${keyword}`);
    }

    await sleep(1200 + Math.floor(Math.random() * 1200));
  } catch (err) {
    failed.push(keyword);
    console.log("Google Trends network failed for", keyword, "-", err.message);
    await sleep(2500);
  }
}

await browser.close();

signals.sort((a, b) => b.score - a.score);

writeJson("google-trends.json", signals);
writeJson("google-trends-meta.json", {
  updatedAt: new Date().toISOString(),
  source: "google-trends-network",
  geo: GEO,
  dateRange: DATE_RANGE,
  poolKeywordCount: allKeywords.length,
  chunkStart: CHUNK_START,
  chunkSize: CHUNK_SIZE || keywords.length,
  attemptedKeywordCount: keywords.length,
  savedSignalCount: signals.length,
  failedCount: failed.length,
  uniqueVariantsFetched: variantCacheMisses,
  reusedVariantChecks: variantCacheHits,
  variantCacheSize: VARIANT_RESULT_CACHE.size,
  variantConcurrency: VARIANT_CONCURRENCY,
  note: "Captures Google Trends internal timeline JSON from Explore page. Shared variants are fetched once per matrix job and reused across product anchors, preserving unlimited generated variant coverage while avoiding duplicate network requests. The picker now prefers variants that share words with the original product keyword, and rejects variants with zero overlap to prevent unrelated cache hits. Cache-level overlap check added to further prevent unrelated cached variants.",
  failed: failed.slice(0, 150)
});

console.log(`Saved ${signals.length} Google Trends network signals from ${keywords.length} attempted keywords.`);