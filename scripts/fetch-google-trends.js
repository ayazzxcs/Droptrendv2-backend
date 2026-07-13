// Quvirl Google Trends 3-month network capture
// Hybrid strict mode: accept if meaningful overlap > 0 OR total overlap >= 3.
// Products with no relevant variant get no Google score.

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
const MAX_VARIANTS = RAW_MAX_VARIANTS > 0 ? RAW_MAX_VARIANTS : Infinity;
const VARIANT_CONCURRENCY = Math.max(1, intEnv(["GOOGLE_TRENDS_VARIANT_CONCURRENCY"], 6));

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

const OVERLAP_IGNORE_WORDS = new Set([
  "toy", "toys", "case", "cover", "bag", "box", "holder", "stand", "mount",
  "strap", "band", "cable", "cord", "adapter", "charger", "phone", "car",
  "home", "travel", "office", "beauty", "care", "body", "party", "supplies",
  "mini", "large", "small", "set", "pack", "piece", "pieces", "size",
  "color", "colors", "new", "hot", "sale", "best", "high", "quality",
  "fashion", "style", "good", "latest", "premium", "professional", "original",
  "with", "for", "and", "the", "this", "that", "plus", "pro", "max", "ultra",
  "light", "led", "usb", "type", "fast", "charging", "wireless", "magnetic",
  "smart", "digital", "electric", "electronic", "rechargeable", "foldable",
  "waterproof", "lightweight", "universal", "compatible", "support", "supported",
  "official", "certified", "brand", "version", "model",
  "storage", "organizer", "shelf", "bin", "basket", "rack",
  "casual", "versatile", "hand", "held", "durable", "cool", "stylish",
  "classic", "modern", "trendy", "vintage", "unique", "creative", "elegant",
  "slim", "thin", "thick", "heavy", "light", "soft", "hard", "solid",
  "comfortable", "breathable", "adjustable", "removable", "portable",
  "foldable", "collapsible", "expandable", "retractable", "flexible",
  "gift", "present", "holiday", "seasonal", "summer", "winter", "spring", "autumn",
  "luxury", "sense", "retro", "geometric", "studs", "mid", "century",
  "zircon", "drop", "earrings", "kitty", "pets", "tempered"
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

  for (const supplied of suppliedVariants) {
    const normalized = cleanKeyword(supplied);
    if (normalized) variants.push(normalized);
  }

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

async function fetchTrendForVariantCached(page, variant, originalKeyword, originalTitle) {
  let cachedPromise = VARIANT_RESULT_CACHE.get(variant);
  const cacheHit = Boolean(cachedPromise);

  if (!cachedPromise) {
    variantCacheMisses += 1;
    cachedPromise = fetchTrendForVariant(page, variant, variant).catch(err => {
      VARIANT_RESULT_CACHE.delete(variant);
      throw err;
    });
    VARIANT_RESULT_CACHE.set(variant, cachedPromise);
  } else {
    variantCacheHits += 1;
  }

  const baseSignal = await cachedPromise;

  // Hybrid cache-level check: accept if meaningful overlap > 0 OR total overlap >= 3
  const cleanTitle = cleanKeyword(originalTitle);
  const titleWords = cleanTitle.split(/\s+/).filter(Boolean);
  const meaningfulTitleWords = new Set(titleWords.filter(w => !OVERLAP_IGNORE_WORDS.has(w)));

  if (meaningfulTitleWords.size > 0) {
    const cleanVariant = cleanKeyword(variant);
    const variantWords = cleanVariant.split(/\s+/).filter(Boolean);
    
    const totalOverlap = variantWords.filter(w => titleWords.includes(w)).length;
    let meaningfulOverlap = 0;
    for (const w of variantWords) {
      if (meaningfulTitleWords.has(w)) meaningfulOverlap += 1;
    }
    
    // Reject only if meaningfulOverlap === 0 AND totalOverlap < 3
    if (meaningfulOverlap === 0 && totalOverlap < 3) {
      console.log(`Cache-level reject: variant "${variant}" has no meaningful overlap and total overlap < 3 with title "${originalTitle}". Fetching fresh.`);
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

function pickBestVariantSignal(signals, originalKeyword, originalTitle) {
  const matched = signals.filter(signal => signal?.match);
  if (!matched.length) return null;

  const cleanTitle = cleanKeyword(originalTitle);
  const titleWords = cleanTitle.split(/\s+/).filter(Boolean);
  const meaningfulTitleWords = new Set(titleWords.filter(w => !OVERLAP_IGNORE_WORDS.has(w)));

  // If title has no meaningful words, fallback to highest score (rare case).
  if (meaningfulTitleWords.size === 0) {
    matched.sort((a, b) => trendSignalScore(b) - trendSignalScore(a));
    return matched[0];
  }

  const scored = matched.map(signal => {
    const cleanVariant = cleanKeyword(signal.usedKeyword);
    const variantWords = cleanVariant.split(/\s+/).filter(Boolean);
    
    const totalOverlap = variantWords.filter(w => titleWords.includes(w)).length;
    let meaningfulOverlap = 0;
    for (const w of variantWords) {
      if (meaningfulTitleWords.has(w)) meaningfulOverlap += 1;
    }
    
    return { signal, meaningfulOverlap, totalOverlap, score: trendSignalScore(signal) };
  });

  // Accept if meaningfulOverlap > 0 OR totalOverlap >= 3
  const candidates = scored.filter(s => s.meaningfulOverlap > 0 || s.totalOverlap >= 3);

  if (candidates.length === 0) {
    console.log(`Google Trends rejecting all variants for "${originalTitle}" – no meaningful overlap and total overlap < 3.`);
    return null;
  }

  candidates.sort((a, b) => b.meaningfulOverlap - a.meaningfulOverlap || b.totalOverlap - a.totalOverlap || b.score - a.score);
  return candidates[0].signal;
}

async function runVariantGroup(pages, keyword, variants, checkedSignals, failedVariants, originalTitle) {
  for (let offset = 0; offset < variants.length; offset += pages.length) {
    const wave = variants.slice(offset, offset + pages.length);

    const results = await Promise.all(
      wave.map(async (variant, index) => {
        try {
          console.log(`Google Trends network: ${keyword} -> ${variant}`);
          return await fetchTrendForVariantCached(pages[index], variant, keyword, originalTitle);
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
  const fullTitle = item?.productTitle || item?.sourceTitles?.[0] || item?.title || keyword;
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

  await runVariantGroup(pages, keyword, specificVariants, checkedSignals, failedVariants, fullTitle);

  let matchedSpecific = checkedSignals.filter(signal => signal?.match && trendVariantWordCount(signal) >= 2);
  let fallbackUsed = false;

  if (!matchedSpecific.length && fallbackVariants.length) {
    fallbackUsed = true;
    console.log(
      `Google Trends specific variants had no usable data for ${keyword}; ` +
      `trying ${fallbackVariants.length} single-word fallback(s): ${fallbackVariants.join(", ")}`
    );
    await runVariantGroup(pages, keyword, fallbackVariants, checkedSignals, failedVariants, fullTitle);
  }

  const bestSignal = pickBestVariantSignal(checkedSignals, keyword, fullTitle);
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
  note: "Hybrid strict mode: accept if meaningful overlap > 0 or total overlap >= 3. Uses product-specific title. Expanded ignore list.",
  failed: failed.slice(0, 150)
});

console.log(`Saved ${signals.length} Google Trends network signals from ${keywords.length} attempted keywords.`);
// ===============================================
// CHUNK 4 — IDF + JARO–WINKLER + MATCHING LOGIC
// ===============================================

// Debug: initializing IDF + JW improvements
console.log("[DEBUG] Initializing IDF weighting + Jaro–Winkler fallback...");

// -----------------------------------------------
// Build Local IDF Corpus
// -----------------------------------------------
function buildLocalIDF(keywords) {
  const df = new Map();
  const N = keywords.length;

  for (const item of keywords) {
    const clean = cleanKeyword(item.keyword || "");
    const words = new Set(clean.split(/\s+/).filter(Boolean));

    for (const w of words) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [word, freq] of df.entries()) {
    const value = Math.log((N + 1) / (freq + 1)) + 1;
    idf.set(word, value);
  }

  console.log("[DEBUG] Local IDF built for", idf.size, "tokens");
  return idf;
}

const LOCAL_IDF = buildLocalIDF(allKeywords);

// -----------------------------------------------
// Weighted Overlap (IDF-based)
// -----------------------------------------------
function weightedOverlapLocal(variantWords, titleWords) {
  let score = 0;
  let maxScore = 0;

  for (const w of variantWords) {
    const weight = LOCAL_IDF.get(w) || 0.1;
    maxScore += weight;
    if (titleWords.has(w)) score += weight;
  }

  const normalized = maxScore > 0 ? score / maxScore : 0;

  console.log("[DEBUG] weightedOverlapLocal:", {
    variantWords: [...variantWords],
    titleWords: [...titleWords],
    score: normalized
  });

  return normalized;
}

// -----------------------------------------------
// Jaro–Winkler Similarity (local)
// -----------------------------------------------
function jaroWinklerLocal(s1, s2) {
  if (!s1 || !s2) return 0;

  const m = jaroMatches(s1, s2);
  if (m === 0) return 0;

  const jaro = (m / s1.length + m / s2.length + (m - jaroTranspositions(s1, s2)) / m) / 3;
  const prefix = jaroPrefixLength(s1, s2);
  const jw = jaro + prefix * 0.1 * (1 - jaro);

  console.log("[DEBUG] jaroWinklerLocal:", { s1, s2, jw });
  return jw;
}

function jaroMatches(s1, s2) {
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  return matches;
}

function jaroTranspositions(s1, s2) {
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = [];
  const s2Matches = [];

  const s1Matched = new Array(s1.length).fill(false);
  const s2Matched = new Array(s2.length).fill(false);

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (!s2Matched[j] && s1[i] === s2[j]) {
        s1Matched[i] = true;
        s2Matched[j] = true;
        s1Matches.push(s1[i]);
        s2Matches.push(s2[j]);
        break;
      }
    }
  }

  let transpositions = 0;
  for (let i = 0; i < s1Matches.length; i++) {
    if (s1Matches[i] !== s2Matches[i]) transpositions++;
  }

  return transpositions / 2;
}

function jaroPrefixLength(s1, s2) {
  const maxPrefix = 4;
  let prefix = 0;

  for (let i = 0; i < Math.min(maxPrefix, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return prefix;
}

// -----------------------------------------------
// Combined Acceptance Logic
// -----------------------------------------------
function variantMatchesTitleLocal(variant, title) {
  const variantWords = new Set(variant.split(/\s+/).filter(Boolean));
  const titleWords = new Set(title.split(/\s+/).filter(Boolean));

  // Original lexical rule
  const totalOverlap = [...variantWords].filter(w => titleWords.has(w)).length;
  const meaningfulOverlap = [...variantWords].filter(
    w => titleWords.has(w) && !OVERLAP_IGNORE_WORDS.has(w)
  ).length;

  const lexicalAccept = meaningfulOverlap > 0 || totalOverlap >= 3;

  // IDF weighted overlap
  const wOverlap = weightedOverlapLocal(variantWords, titleWords);
  const idfAccept = wOverlap >= 0.35;

  // Jaro–Winkler fallback
  const jwScore = jaroWinklerLocal(variant, title);
  const jwAccept = jwScore >= 0.82;

  const finalAccept = lexicalAccept || idfAccept || jwAccept;

  console.log("[DEBUG] variantMatchesTitleLocal:", {
    variant,
    title,
    totalOverlap,
    meaningfulOverlap,
    wOverlap,
    jwScore,
    lexicalAccept,
    idfAccept,
    jwAccept,
    finalAccept
  });

  return {
    accept: finalAccept,
    wOverlap,
    jwScore,
    totalOverlap,
    meaningfulOverlap
  };
}
// =====================================================
// CHUNK 5 — VARIANT FETCHING + CACHE + BROWSER LOGIC
// =====================================================

// Debug: initializing browser + fetch logic
console.log("[DEBUG] Initializing browser + variant fetch system...");

// Cache for variant results
const variantCache = new Map();

// Cache stats
let uniqueVariantsFetched = 0;
let reusedVariantChecks = 0;

// -----------------------------------------------
// Fetch Google Trends JSON for a single variant
// -----------------------------------------------
async function fetchVariantTrend(page, variant) {
  console.log("[DEBUG] Fetching variant:", variant);

  const url = `https://trends.google.com/trends/explore?geo=${GEO}&date=${DATE_RANGE}&q=${encodeURIComponent(variant)}`;

  const jsonBodies = [];
  let timelineReady = false;

  page.on("response", async (response) => {
    try {
      const reqUrl = response.url();
      if (!reqUrl.includes("widgetdata") && !reqUrl.includes("timeseries")) return;

      const body = await response.json().catch(() => null);
      if (!body) return;

      jsonBodies.push(body);

      const values = extractTimelineValuesFromAnyJson([body]);
      if (values.length >= MIN_POINTS) {
        timelineReady = true;
      }
    } catch (err) {
      console.log("[DEBUG] Error parsing response JSON:", err);
    }
  });

  try {
    await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
  } catch (err) {
    console.log("[DEBUG] Navigation error for variant:", variant, err);
    return null;
  }

  // Wait for timeline JSON
  const start = Date.now();
  while (!timelineReady && Date.now() - start < 8000) {
    await sleep(200);
  }

  if (!timelineReady) {
    console.log("[DEBUG] No timeline found for variant:", variant);
    return null;
  }

  const labeled = extractTimelinePointsFromAnyJson(jsonBodies);
  const numeric = extractTimelineValuesFromAnyJson(jsonBodies);

  const scoreObj = scoreFromValues(numeric);
  if (!scoreObj) {
    console.log("[DEBUG] scoreObj null for variant:", variant);
    return null;
  }

  console.log("[DEBUG] Final score for variant:", variant, scoreObj.score);

  return {
    variant,
    score: scoreObj.score,
    timeline: scoreObj.timelinePoints,
    growthPercent: scoreObj.growthPercent,
    firstAvg: scoreObj.firstAvg,
    lastAvg: scoreObj.lastAvg,
    latest: scoreObj.latest,
    max: scoreObj.max,
    labeledPoints: labeled
  };
}

// -----------------------------------------------
// Fetch variant with cache + acceptance logic
// -----------------------------------------------
async function fetchVariantWithCache(pages, variant, title) {
  const cached = variantCache.get(variant);

  if (cached) {
    reusedVariantChecks++;
    console.log("[DEBUG] Cache hit for variant:", variant);

    const match = variantMatchesTitleLocal(variant, title);
    if (match.accept) {
      console.log("[DEBUG] Cache accepted for variant:", variant);
      return { ...cached, fromCache: true, wOverlap: match.wOverlap, jwScore: match.jwScore };
    }

    console.log("[DEBUG] Cache rejected for variant:", variant, "=> refetching");
    variantCache.delete(variant);
  }

  const page = pages.shift();
  const result = await fetchVariantTrend(page, variant);
  pages.push(page);

  if (result) {
    uniqueVariantsFetched++;
    variantCache.set(variant, result);

    const match = variantMatchesTitleLocal(variant, title);
    return {
      ...result,
      fromCache: false,
      wOverlap: match.wOverlap,
      jwScore: match.jwScore
    };
  }

  return null;
}

// -----------------------------------------------
// Run variants in waves (concurrency)
// -----------------------------------------------
async function runVariantWave(pages, variants, title) {
  const results = [];
  const failures = [];

  for (const variant of variants) {
    try {
      const res = await fetchVariantWithCache(pages, variant, title);
      if (res) results.push(res);
      else failures.push(variant);
    } catch (err) {
      console.log("[DEBUG] Variant fetch error:", variant, err);
      failures.push(variant);
    }
  }

  return { results, failures };
}

// -----------------------------------------------
// Pick best variant signal
// -----------------------------------------------
function pickBestVariantSignal(signals, title) {
  if (!signals.length) return null;

  const titleWords = new Set(title.split(/\s+/).filter(Boolean));

  const enriched = signals.map(sig => {
    const variantWords = new Set(sig.variant.split(/\s+/).filter(Boolean));
    const wOverlap = weightedOverlapLocal(variantWords, titleWords);
    return { ...sig, wOverlap };
  });

  enriched.sort((a, b) => {
    if (b.wOverlap !== a.wOverlap) return b.wOverlap - a.wOverlap;
    return b.score - a.score;
  });

  const best = enriched[0];
  console.log("[DEBUG] Best variant selected:", best.variant, "score:", best.score, "wOverlap:", best.wOverlap);

  return best;
}
// =====================================================
// CHUNK 6 — MAIN LOOP + OUTPUT + META STATS
// =====================================================

// Debug: starting main execution
console.log("[DEBUG] Starting main execution loop...");

async function main() {
  console.log("[DEBUG] Launching browser...");

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext();
  const pages = [];

  for (let i = 0; i < VARIANT_CONCURRENCY; i++) {
    const page = await context.newPage();
    pages.push(page);
  }

  console.log("[DEBUG] Created", pages.length, "pages for concurrency");

  const results = [];

  for (const item of keywords) {
    const keyword = item.keyword;
    const title = cleanKeyword(keyword);

    console.log("\n[DEBUG] Processing keyword:", keyword);

    const variants = keywordVariants(item);
    console.log("[DEBUG] Total variants:", variants.length);

    const { results: signals } = await runVariantWave(pages, variants, title);

    console.log("[DEBUG] Signals fetched:", signals.length);

    const best = pickBestVariantSignal(signals, title);

    if (best) {
      console.log("[DEBUG] Best signal chosen:", best.variant, "score:", best.score);

      results.push({
        keyword,
        variant: best.variant,
        score: best.score,
        timeline: best.timeline,
        growthPercent: best.growthPercent,
        firstAvg: best.firstAvg,
        lastAvg: best.lastAvg,
        latest: best.latest,
        max: best.max,
        labeledPoints: best.labeledPoints,
        wOverlap: best.wOverlap,
        jwScore: best.jwScore,
        fromCache: best.fromCache
      });
    } else {
      console.log("[DEBUG] No valid signal for keyword:", keyword);
      results.push({
        keyword,
        variant: null,
        score: null,
        timeline: [],
        growthPercent: null,
        firstAvg: null,
        lastAvg: null,
        latest: null,
        max: null,
        labeledPoints: [],
        wOverlap: 0,
        jwScore: 0,
        fromCache: false
      });
    }
  }

  console.log("[DEBUG] Writing final results...");
  writeJson("google-trends.json", results);

  console.log("[DEBUG] Writing meta stats...");
  writeJson("google-trends-meta.json", {
    POOL_LIMIT,
    CHUNK_START,
    CHUNK_SIZE,
    TOTAL_CHUNKS,
    RAW_CHUNK_INDEX,
    NORMALIZED_CHUNK_INDEX,
    GEO,
    DATE_RANGE,
    MIN_POINTS,
    VARIANT_CONCURRENCY,
    MAX_VARIANTS,
    totalKeywords: keywords.length,
    uniqueVariantsFetched,
    reusedVariantChecks,
    cacheSize: variantCache.size
  });

  console.log("[DEBUG] Closing browser...");
  await browser.close();

  console.log("[DEBUG] Script completed successfully.");
}

main().catch(err => {
  console.error("[DEBUG] Fatal error:", err);
});
