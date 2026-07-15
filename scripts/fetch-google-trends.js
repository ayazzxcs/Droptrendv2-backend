// Quvirl Google Trends 3-month network capture
// Hybrid + IDF-weighted overlap using full product titles.
// Reliability update: chunk checkpointing, chunk-safe output files, and per-keyword timeout.
// No Jaro-Winkler fallback.

import { chromium } from "playwright";
import fs from "fs";
import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);

// =============================================
// Environment & chunk setup
// =============================================
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
  : (
      explicitStartProvided
        ? Math.max(1500, EXPLICIT_CHUNK_START + EXPLICIT_CHUNK_SIZE)
        : intEnv(["GOOGLE_TRENDS_LIMIT"], 1500)
    );

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

const CHUNK_INDEX_BASE = intEnv(
  ["GOOGLE_TRENDS_CHUNK_INDEX_BASE", "CHUNK_INDEX_BASE"],
  0
);

const NORMALIZED_CHUNK_INDEX = Math.max(0, RAW_CHUNK_INDEX - CHUNK_INDEX_BASE);

const GEO = process.env.GOOGLE_TRENDS_GEO ?? "";
const DATE_RANGE = process.env.GOOGLE_TRENDS_DATE || "today 3-m";
const MIN_POINTS = intEnv(["GOOGLE_TRENDS_MIN_POINTS"], 3);

const RAW_MAX_VARIANTS = intEnv(["GOOGLE_TRENDS_MAX_VARIANTS"], 0);
const MAX_VARIANTS = RAW_MAX_VARIANTS > 0 ? RAW_MAX_VARIANTS : Infinity;

const VARIANT_CONCURRENCY = Math.max(
  1,
  intEnv(["GOOGLE_TRENDS_VARIANT_CONCURRENCY"], 6)
);

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

// =============================================
// Reliability hardening
// =============================================
const CHUNK_OUTPUT_INDEX = TOTAL_CHUNKS > 1 ? NORMALIZED_CHUNK_INDEX : 0;
const IS_CHUNKED_GOOGLE_TRENDS_RUN = TOTAL_CHUNKS > 1 || CHUNK_SIZE > 0;

const CHUNK_SIGNAL_FILE = `google-trends-chunk-${CHUNK_OUTPUT_INDEX}.json`;
const CHUNK_FAILED_FILE = `google-trends-failed-chunk-${CHUNK_OUTPUT_INDEX}.json`;
const CHUNK_CHECKPOINT_FILE = `google-trends-checkpoint-chunk-${CHUNK_OUTPUT_INDEX}.json`;
const CHUNK_META_FILE = `google-trends-meta-chunk-${CHUNK_OUTPUT_INDEX}.json`;

const KEYWORD_TIMEOUT_MS = intEnv(
  ["GOOGLE_TRENDS_KEYWORD_TIMEOUT_MS"],
  180000
);

function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path);
}

async function withTimeout(promise, ms, label) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

writeJson("trend-keywords.json", keywords);
writeJson("trend-keywords-all.json", allKeywords);

console.log("Google Trends env debug:", {
  GOOGLE_TRENDS_START_INDEX: process.env.GOOGLE_TRENDS_START_INDEX || null,
  GOOGLE_TRENDS_CHUNK_START: process.env.GOOGLE_TRENDS_CHUNK_START || null,
  GOOGLE_TRENDS_LIMIT: process.env.GOOGLE_TRENDS_LIMIT || null,
  GOOGLE_TRENDS_CHUNK_SIZE: process.env.GOOGLE_TRENDS_CHUNK_SIZE || null,
  GOOGLE_TRENDS_KEYWORD_POOL_LIMIT: process.env.GOOGLE_TRENDS_KEYWORD_POOL_LIMIT || null,
  GOOGLE_TRENDS_CHUNK_INDEX: process.env.GOOGLE_TRENDS_CHUNK_INDEX || null,
  GOOGLE_TRENDS_CHUNK_TOTAL: process.env.GOOGLE_TRENDS_CHUNK_TOTAL || null,
  GOOGLE_TRENDS_MAX_VARIANTS: process.env.GOOGLE_TRENDS_MAX_VARIANTS || null,
  GOOGLE_TRENDS_KEYWORD_TIMEOUT_MS: process.env.GOOGLE_TRENDS_KEYWORD_TIMEOUT_MS || null,
  GOOGLE_TRENDS_VARIANT_CONCURRENCY: process.env.GOOGLE_TRENDS_VARIANT_CONCURRENCY || null
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
  console.log(
    "No keywords assigned to this Google Trends chunk. Check GOOGLE_TRENDS_CHUNK_INDEX / GOOGLE_TRENDS_CHUNK_TOTAL."
  );
}

// =============================================
// Stop words, product terms, ignore list
// =============================================
const STOP_WORDS = new Set([
  "new", "hot", "sale", "fashion", "style", "quality", "good", "latest",
  "product", "products", "dropshipping", "wholesale", "supplier",
  "aliexpress", "ali", "express", "cj", "cjdropshipping", "zendrop", "ebay",
  "amazon", "temu", "shein", "dhgate", "doba", "autods", "dsers",
  "solid", "color", "colors", "mini", "large", "small", "piece", "pieces",
  "set", "sets", "with", "for", "and", "the", "this", "that",
  "2024", "2025", "2026", "plus", "size", "best", "high",
  "other", "replacement", "parts", "front", "only", "self", "pickup",
  "support", "supports", "supported", "compatible", "compatibility",
  "official", "certified", "brand"
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
  "lamp", "light", "decor", "mirror",

  "shirt", "shirts", "tshirt", "blouse", "top", "dress", "skirt",
  "pants", "trousers", "jeans", "shorts", "jacket", "coat", "hoodie", "sweater", "cardigan",
  "vest", "bra", "underwear", "sock", "shoes", "sandals", "slippers", "boots", "cap", "hat",
  "belt", "wallet", "purse", "backpack", "handbag", "bag", "bracelet", "necklace", "earrings",
  "ring", "watch", "blazer",

  "makeup", "skincare", "serum", "cream", "cleanser", "mask", "comb",
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
  "zircon", "drop", "earrings", "kitty", "pets", "tempered",

  "shirt", "shirts", "tshirt", "tshirts", "tee", "tees", "top", "tops",
  "blouse", "blouses", "dress", "dresses", "skirt", "skirts",
  "jacket", "jackets", "coat", "coats", "hoodie", "hoodies",
  "pants", "trousers", "jeans", "shorts", "sweater", "sweaters",
  "cardigan", "cardigans", "vest", "vests", "bra", "bras",
  "sock", "socks", "shoe", "shoes", "sandal", "sandals", "slipper", "slippers",
  "boot", "boots", "cap", "caps", "hat", "hats"
]);

function productTermBase(word) {
  if (PRODUCT_TERMS.has(word)) return word;

  const candidates = [];

  if (word.endsWith("ies") && word.length > 4) {
    candidates.push(`${word.slice(0, -3)}y`);
  }

  if (word.endsWith("es") && word.length > 4) {
    candidates.push(word.slice(0, -2));
  }

  if (word.endsWith("s") && word.length > 3) {
    candidates.push(word.slice(0, -1));
  }

  return candidates.find(candidate => PRODUCT_TERMS.has(candidate)) || "";
}

function isProductTerm(word) {
  return Boolean(productTermBase(word));
}

function isSafeSingleWordVariant(word) {
  if (!word || word.length < 4) return false;
  if (WEAK_SINGLE_WORDS.has(word)) return false;

  if (OVERLAP_IGNORE_WORDS.has(word)) return false;

  return true;
}

function isMeaningfulSingleWordFallback(word, words) {
  if (!isSafeSingleWordVariant(word)) return false;
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
    .replace(/\b(aliexpress|cj|zendrop|*bay|amazon|temu|shein|dhgate|doba|*utods|dsers)\b/g, " ");
}

functio* cleanKeyword(text) {
  return str*pMarketplaceWords(text)
    .repla*e(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b\*+(?:w|v|a|mah|wh|gb|tb|hz|khz|mhz|*hz|mm|cm|ft|inch|mp)\b/g, " ")
   *.replace(/\b\d+\b/g, " ")
    .spl*t(/\s+/)
    .filter(w => w.length*> 2 && !STOP_WORDS.has(w))
    .jo*n(" ")
    .replace(/\s+/g, " ")
 *  .trim();
}

function uniq(arr) {*  return [...new Set(arr.filter(Boolean))];
}

function keywordVarian*s(keywordOrItem) {
  const item = *eywordOrItem && typeof keywordOrIt*m === "object"
    ? keywordOrItem*    : { keyword: keywordOrItem };
*  const keyword = String(item.keyw*rd || "");
  const suppliedVariant* = Array.isArray(item.variants) ? *tem.variants : [];

  const clean * cleanKeyword(keyword);
  const wo*ds = clean.split(/\s+/).filter(Boo*ean);

  const variants = [];

  f*r (const supplied of suppliedVaria*ts) {
    const normalized = clean*eyword(supplied);
    if (normaliz*d) variants.push(normalized);
  }
*  if (words.length) {
    variants*push(clean);

    const upper = Ma*h.min(4, words.length);

    for (*et size = upper; size >= 2; size -* 1) {
      for (let start = 0; st*rt + size <= words.length; start +* 1) {
        variants.push(words.*lice(start, start + size).join(" "*);
      }
    }

    const produc*Words = uniq(words.filter(isProduc*Term));

    if (productWords.leng*h) {
      variants.push(productWo*ds.join(" "));

      for (const w*rd of productWords) {
        if (*isSafeSingleWordVariant(word)) con*inue;

        variants.push(word)*

        const base = productTerm*ase(word);

        if (base && ba*e !== word && isSafeSingleWordVari*nt(base)) {
          variants.pus*(base);
        }
      }
    }

 *  const lastWord = words[words.length - 1];

    if (!productWords.le*gth && isMeaningfulSingleWordFallb*ck(lastWord, words)) {
      varia*ts.push(lastWord);
    }
  }

  co*st finalVariants = uniq(variants).*ilter(v => v.length >= 3);

  retu*n Number.isFinite(MAX_VARIANTS)
  * ? finalVariants.slice(0, MAX_VARI*NTS)
    : finalVariants;
}

// ==*==================================*=======
// Timeline extraction
// *==================================*=========
function extractTimeline*aluesFromAnyJson(obj) {
  const va*ues = [];

  function walk(node) {*    if (!node || typeof node !== "*bject") return;

    if (Array.isA*ray(node.timelineData)) {
      fo* (const row of node.timelineData) *
        const raw = row?.value?.[0] ?? row?.formattedValue?.[0] ?? r*w?.extractedValue?.[0];
        co*st n = Number(String(raw).replace(*[^0-9.\-]/g, ""));
        if (Num*er.isFinite(n)) values.push(n);
  *   }
    }

    if (Array.isArray(*ode.timeline_data)) {
      for (c*nst row of node.timeline_data) {
 *      const raw = row?.values?.[0]*.extracted_value ?? row?.values?.[0]?.value ?? row?.value?.[0];
     *  const n = Number(String(raw).rep*ace(/[^0-9.\-]/g, ""));
        if*(Number.isFinite(n)) values.push(n*;
      }
    }

    if (Array.isA*ray(node.default?.timelineData)) {*      for (const row of node.defau*t.timelineData) {
        const ra* = row?.value?.[0] ?? row?.formatt*dValue?.[0] ?? row?.extractedValue*.[0];
        const n = Number(Str*ng(raw).replace(/[^0-9.\-]/g, ""))*
        if (Number.isFinite(n)) v*lues.push(n);
      }
    }

    f*r (const v of Object.values(node))*{
      if (v && typeof v === "obj*ct") walk(v);
    }
  }

  walk(ob*);
  return values;
}

function ex*ractTimelinePointsFromAnyJson(obj)*{
  const points = [];

  function*valueFromRow(row) {
    const raw *
      row?.value?.[0] ??
      ro*?.formattedValue?.[0] ??
      row*.extractedValue?.[0] ??
      row?*values?.[0]?.extracted_value ??
  *   row?.values?.[0]?.value ??
    * row?.value;

    const n = Number*String(raw).replace(/[^0-9.\-]/g, *"));
    return Number.isFinite(n)*? n : null;
  }

  function labelF*omRow(row, fallbackIndex) {
    if*(row?.formattedTime) return String*row.formattedTime);
    if (row?.f*rmattedAxisTime) return String(row*formattedAxisTime);

    if (row?.*ime) {
      const d = new Date(Nu*ber(row.time) * 1000);
      if (!*umber.isNaN(d.getTime())) {
      * return d.toISOString().slice(0, 1*);
      }
    }

    return `P${f*llbackIndex + 1}`;
  }

  function*addRows(rows) {
    for (const row*of rows) {
      const value = val*eFromRow(row);
      if (value ===*null || value < 0) continue;

    * points.push({
        label: labe*FromRow(row, points.length),
     *  value
      });
    }
  }

  fun*tion walk(node) {
    if (!node ||*typeof node !== "object") return;
*    if (Array.isArray(node.timelineData)) addRows(node.timelineData);
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
  const nums = values
    .map(Number)
    .filter(n => Number.isFinite(n) && n >= 0);

  if (nums.length < MIN_POINTS || Math.max(...nums) <= 0) return null;

  const half = Math.max(1, Math.floor(nums.length / 2));
  const firstHalf = nums.slice(0, half);
  const secondHalf = nums.slice(half);

  const avg = arr => arr.length
    ? arr.reduce((a, b) => a + b, 0) / arr.length
    : 0;

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

  const googleTrendScore = Math.round(
    Math.max(1, Math.min(100, growthScore + volumeScore + momentumScore))
  );

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

// =============================================
// Fetch one variant
// =============================================
async function fetchTrendForVariant(page, variant, originalKeyword) {
  const jsonBodies = [];

  let resolveTimelineReady = null;

  const timelineReady = new Promise(resolve => {
    resolveTimelineReady = resolve;
  });

  const responseHandler = async (res) => {
    try {
      const url = res.url();

      if (!/trends\/api|widgetdata|TIMESERIES|multiline|explore/i.test(url)) {
        return;
      }

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
    const url =
      "https://trends.google.com/trends/explore?date=" +
      encodeURIComponent(DATE_RANGE) +
      "&geo=" +
      encodeURIComponent(GEO) +
      "&q=" +
      encodeURIComponent(variant);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

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
        bestTimeline = values.map((value, index) => ({
          label: `P${index + 1}`,
          value
        }));
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

// =============================================
// Build IDF from product titles
// =============================================
function buildTitleIDF(products) {
  const df = new Map();
  const N = products.length;

  for (const p of products) {
    const title = cleanKeyword(
      p.raw?.productNameEn ||
      p.productNameEn ||
      p.name ||
      p.productName ||
      ""
    );

    const words = new Set(title.split(/\s+/).filter(Boolean));

    for (const w of words) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  }

  const idf = new Map();

  for (const [word, freq] of df.entries()) {
    idf.set(word, Math.log((N + 1) / (freq + 1)) + 1);
  }

  console.log(`[IDF] Built IDF from ${N} products, ${idf.size} unique tokens.`);

  return idf;
}

const TITLE_IDF = buildTitleIDF(products);

function weightedOverlap(variantWords, titleWords) {
  let score = 0;
  let maxScore = 0;

  for (const w of variantWords) {
    const weight = TITLE_IDF.get(w) || 0.1;
    maxScore += weight;

    if (titleWords.has(w)) {
      score += weight;
    }
  }

  return maxScore > 0 ? score / maxScore : 0;
}

// =============================================
// Acceptance logic
// =============================================
function variantMatchesTitle(variant, fullTitle) {
  const variantWordList = cleanKeyword(variant)
    .split(/\s+/)
    .filter(Boolean);

  const titleWordList = cleanKeyword(fullTitle)
    .split(/\s+/)
    .filter(Boolean);

  const variantWords = new Set(variantWordList);
  const titleWords = new Set(titleWordList);

  const overlappingWords = [...variantWords].filter(w => titleWords.has(w));
  const meaningfulVariantWords = [...variantWords].filter(w => !OVERLAP_IGNORE_WORDS.has(w));
  const meaningfulOverlappingWords = overlappingWords.filter(w => !OVERLAP_IGNORE_WORDS.has(w));

  const totalOverlap = overlappingWords.length;
  const meaningfulOverlap = meaningfulOverlappingWords.length;

  const variantWordCount = Math.max(1, variantWords.size);
  const meaningfulVariantCount = Math.max(1, meaningfulVariantWords.length);

  const totalOverlapRatio = totalOverlap / variantWordCount;
  const meaningfulOverlapRatio = meaningfulOverlap / meaningfulVariantCount;

  const wOverlap = weightedOverlap(variantWords, titleWords);

  if (variantWords.size === 1) {
    const onlyWord = [...variantWords][0];

    const accepted =
      titleWords.has(onlyWord) &&
      isSafeSingleWordVariant(onlyWord) &&
      (TITLE_IDF.get(onlyWord) || 0) >= 1.5;

    console.log(
      `${accepted ? "[ACCEPT]" : "[REJECT]"} Single-word variant "${variant}" vs "${fullTitle}"` +
      ` - safe=${isSafeSingleWordVariant(onlyWord)}, idf=${(TITLE_IDF.get(onlyWord) || 0).toFixed(3)}`
    );

    return accepted;
  }

  if (meaningfulOverlap >= 1 && totalOverlapRatio >= 0.75 && wOverlap >= 0.6) {
    console.log(
      `[ACCEPT] Strong phrase match for "${variant}" - total=${totalOverlap}, ` +
      `meaningful=${meaningfulOverlap}, totalRatio=${totalOverlapRatio.toFixed(3)}, weighted=${wOverlap.toFixed(3)}`
    );

    return true;
  }

  if (meaningfulOverlap >= 2 && meaningfulOverlapRatio >= 0.5 && wOverlap >= 0.45) {
    console.log(
      `[ACCEPT] Meaningful multi-word overlap for "${variant}" - meaningful=${meaningfulOverlap}, ` +
      `meaningfulRatio=${meaningfulOverlapRatio.toFixed(3)}, weighted=${wOverlap.toFixed(3)}`
    );

    return true;
  }

  if (totalOverlap >= 3 && meaningfulOverlap >= 1 && totalOverlapRatio >= 0.6) {
    const overlapHighIdf = meaningfulOverlappingWords.some(
      w => (TITLE_IDF.get(w) || 0) > 1.5
    );

    if (overlapHighIdf && wOverlap >= 0.5) {
      console.log(
        `[ACCEPT] High-IDF overlap for "${variant}" - total=${totalOverlap}, ` +
        `meaningful=${meaningfulOverlap}, weighted=${wOverlap.toFixed(3)}`
      );

      return true;
    }
  }

  console.log(
    `[REJECT] "${variant}" vs "${fullTitle}" - total=${totalOverlap}, ` +
    `meaningful=${meaningfulOverlap}, totalRatio=${totalOverlapRatio.toFixed(3)}, ` +
    `meaningfulRatio=${meaningfulOverlapRatio.toFixed(3)}, weighted=${wOverlap.toFixed(3)}`
  );

  return false;
}

// =============================================
// Cached fetch with acceptance check
// =============================================
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

  if (baseSignal?.match) {
    const cleanVariant = variant;
    const cleanTitle = cleanKeyword(originalTitle);

    if (!variantMatchesTitle(cleanVariant, cleanTitle)) {
      console.log(`[CACHE] Invalidating cached variant "${variant}" for "${originalTitle}"`);

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

// =============================================
// Variant word count & score helpers
// =============================================
function trendVariantWordCount(signalOrKeyword) {
  const text = typeof signalOrKeyword === "string"
    ? signalOrKeyword
    : (signalOrKeyword?.usedKeyword || signalOrKeyword?.keyword || "");

  return cleanKeyword(text)
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function trendSignalScore(signal) {
  const score = Number(signal?.score || 0);
  return Number.isFinite(score) ? score : 0;
}

// =============================================
// Picker
// =============================================
function pickBestVariantSignal(signals, originalKeyword, originalTitle) {
  const matched = signals.filter(signal => signal?.match);

  if (!matched.length) return null;

  const cleanTitle = cleanKeyword(originalTitle);

  const validSignals = matched.filter(signal => {
    const cleanVariant = cleanKeyword(signal.usedKeyword);
    return variantMatchesTitle(cleanVariant, cleanTitle);
  });

  if (validSignals.length === 0) {
    console.log(`[PICKER] No valid signals for "${originalTitle}"`);
    return null;
  }

  const titleWords = new Set(cleanTitle.split(/\s+/).filter(Boolean));

  const scored = validSignals.map(signal => {
    const variantWords = cleanKeyword(signal.usedKeyword)
      .split(/\s+/)
      .filter(Boolean);

    const variantWordSet = new Set(variantWords);

    const totalOverlap = variantWords.filter(w => titleWords.has(w)).length;

    const meaningfulOverlap = variantWords.filter(
      w => titleWords.has(w) && !OVERLAP_IGNORE_WORDS.has(w)
    ).length;

    const totalOverlapRatio = totalOverlap / Math.max(1, variantWordSet.size);
    const wOverlap = weightedOverlap(variantWordSet, titleWords);
    const score = trendSignalScore(signal);

    const matchScore =
      meaningfulOverlap * 100 +
      totalOverlap * 25 +
      totalOverlapRatio * 20 +
      wOverlap * 20 +
      Math.min(score, 100) / 10;

    return {
      signal,
      meaningfulOverlap,
      totalOverlap,
      totalOverlapRatio,
      wOverlap,
      score,
      matchScore
    };
  });

  scored.sort((a, b) =>
    b.matchScore - a.matchScore ||
    b.meaningfulOverlap - a.meaningfulOverlap ||
    b.totalOverlap - a.totalOverlap ||
    b.score - a.score
  );

  return scored[0].signal;
}

// =============================================
// Run a group of variants
// =============================================
async function runVariantGroup(
  pages,
  keyword,
  variants,
  checkedSignals,
  failedVariants,
  originalTitle
) {
  for (let offset = 0; offset < variants.length; offset += pages.length) {
    const wave = variants.slice(offset, offset + pages.length);

    const results = await Promise.all(
      wave.map(async (variant, index) => {
        try {
          console.log(`Google Trends network: ${keyword} -> ${variant}`);

          return await fetchTrendForVariantCached(
            pages[index],
            variant,
            keyword,
            originalTitle
          );
        } catch (err) {
          failedVariants.push({
            variant,
            error: err.message
          });

          console.log(
            `Google Trends variant failed for ${keyword} -> ${variant}: ${err.message}`
          );

          return null;
        }
      })
    );

    for (const signal of results) {
      if (signal) checkedSignals.push(signal);
    }

    if (offset + pages.length < variants.length) {
      await sleep(500);
    }
  }
}

// =============================================
// Product identity helpers
// =============================================
function productIdentityFromKeywordItem(item, fallbackKeyword) {
  const productIds = Array.isArray(item?.productIds)
    ? item.productIds.map(id => String(id)).filter(Boolean)
    : [];

  const sourceTitles = Array.isArray(item?.sourceTitles)
    ? item.sourceTitles.map(title => String(title || "")).filter(Boolean)
    : [];

  const titleCandidates = [
    item?.productTitle,
    item?.title,
    ...sourceTitles,
    fallbackKeyword
  ]
    .map(title => String(title || ""))
    .filter(Boolean);

  return {
    productIds: uniq(productIds),
    sourceTitles: uniq(titleCandidates),
    primaryTitle: titleCandidates[0] || String(fallbackKeyword || "")
  };
}

// =============================================
// Main per-keyword fetch
// =============================================
async function fetchWithVariants(pages, item) {
  const keyword = String(item?.keyword || item || "");

  const identity = productIdentityFromKeywordItem(item, keyword);
  const fullTitle = identity.primaryTitle;
  const cleanTitle = cleanKeyword(fullTitle);

  const generatedVariants = keywordVariants(item);

  const specificVariants = generatedVariants.filter(
    variant => trendVariantWordCount(variant) >= 2
  );

  const fallbackVariants = generatedVariants.filter(
    variant => trendVariantWordCount(variant) === 1
  );

  const checkedSignals = [];
  const failedVariants = [];

  console.log(
    `Google Trends variants generated for ${keyword}: ${generatedVariants.length} ` +
    `(${specificVariants.length} specific, ${fallbackVariants.length} single-word fallback)` +
    (item?.sourceTitles?.length
      ? ` from ${item.sourceTitles.length} full product title(s)`
      : "")
  );

  await runVariantGroup(
    pages,
    keyword,
    specificVariants,
    checkedSignals,
    failedVariants,
    cleanTitle
  );

  const matchedSpecific = checkedSignals.filter(
    signal => signal?.match && trendVariantWordCount(signal) >= 2
  );

  let fallbackUsed = false;

  if (!matchedSpecific.length && fallbackVariants.length) {
    fallbackUsed = true;

    console.log(
      `Google Trends specific variants had no usable data for ${keyword}; ` +
      `trying ${fallbackVariants.length} single-word fallback(s): ${fallbackVariants.join(", ")}`
    );

    await runVariantGroup(
      pages,
      keyword,
      fallbackVariants,
      checkedSignals,
      failedVariants,
      cleanTitle
    );
  }

  let bestSignal = null;

  for (const candidateTitle of identity.sourceTitles) {
    bestSignal = pickBestVariantSignal(
      checkedSignals,
      keyword,
      cleanKeyword(candidateTitle)
    );

    if (bestSignal) break;
  }

  if (!bestSignal) return null;

  const checkedVariants = fallbackUsed
    ? [...specificVariants, ...fallbackVariants]
    : specificVariants;

  bestSignal.checkedVariants = checkedVariants;
  bestSignal.generatedVariants = generatedVariants;
  bestSignal.specificVariants = specificVariants;
  bestSignal.fallbackVariants = fallbackVariants;
  bestSignal.singleWordFallbackUsed = fallbackUsed;

  bestSignal.sourceTitles = identity.sourceTitles;
  bestSignal.productIds = identity.productIds;
  bestSignal.primaryProductTitle = identity.primaryTitle;
  bestSignal.productKey = identity.productIds.length
    ? identity.productIds.join("|")
    : cleanKeyword(identity.primaryTitle);

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

// =============================================
// Main execution
// =============================================
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
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
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

console.log(
  `Google Trends keyword pool: ${allKeywords.length}; running ${keywords.length} keywords from offset ${CHUNK_START}.`
);

for (const item of keywords) {
  const keyword = item.keyword;

  try {
    const signal = await withTimeout(
      fetchWithVariants(pages, item),
      KEYWORD_TIMEOUT_MS,
      `Google Trends keyword ${keyword}`
    );

    if (signal?.match) {
      signals.push(signal);
      console.log(
        `Saved Google trend: ${keyword} -> ${signal.usedKeyword}, score ${signal.score}, growth ${signal.growthPercent}%`
      );
    } else {
      failed.push(keyword);
      console.log(`No 3-month Google Trends timeline data: ${keyword}`);
    }

    saveChunkProgress({
      status: "running",
      lastKeyword: keyword
    });

    await sleep(1200 + Math.floor(Math.random() * 1200));
  } catch (err) {
    failed.push(keyword);

    console.log("Google Trends network failed for", keyword, "-", err.message);

    saveChunkProgress({
      status: "running",
      lastKeyword: keyword,
      error: err.message
    });

    await sleep(2500);
  }
}

await browser.close();

const rankedSignals = [...signals].sort((a, b) => b.score - a.score);

const signalsByProduct = {};

for (const signal of signals) {
  const ids = Array.isArray(signal.productIds)
    ? signal.productIds.map(String).filter(Boolean)
    : [];

  for (const id of ids) {
    if (
      !signalsByProduct[id] ||
      Number(signal.score || 0) > Number(signalsByProduct[id].score || 0)
    ) {
      signalsByProduct[id] = signal;
    }
  }
}

atomicWriteJson(CHUNK_SIGNAL_FILE, signals);

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
  note:
    "Chunk-level Google Trends output. Final google-trends.json should be produced by scripts/merge-google-trends-chunks.js in matrix runs.",
  failed: failed.slice(0, 150)
});

saveChunkProgress({
  status: "complete",
  lastKeyword: keywords[keywords.length - 1]?.keyword || ""
});

// Backward compatibility: local/single-chunk runs still write final files directly.
// Matrix workflow runs also write these files inside each job, but the merge job rebuilds them from chunk artifacts.
writeJson("google-trends.json", signals);
writeJson("google-trends-ranked.json", rankedSignals);
writeJson("google-trends-by-product.json", signalsByProduct);
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
  productMappedSignalCount: Object.keys(signalsByProduct).length,
  failedCount: failed.length,
  uniqueVariantsFetched: variantCacheMisses,
  reusedVariantChecks: variantCacheHits,
  variantCacheSize: VARIANT_RESULT_CACHE.size,
  variantConcurrency: VARIANT_CONCURRENCY,
  keywordTimeoutMs: KEYWORD_TIMEOUT_MS,
  note:
    "V2 reliability: writes chunk files/checkpoints for matrix runs, keeps google-trends.json unsorted, writes ranked and by-product outputs.",
  failed: failed.slice(0, 150)
});

console.log(
  `Saved ${signals.length} Google Trends network signals from ${keywords.length} attempted keywords.`
);
