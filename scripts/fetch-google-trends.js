// DropTrend Google Trends 3-month network capture
// Uses Playwright to open Google Trends Explore and capture internal timeline JSON.
// Output: google-trends.json compatible with merge-trend-signals.js

import { chromium } from "playwright";
import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);
const LIMIT = Number(process.env.GOOGLE_TRENDS_LIMIT || 80);
const GEO = process.env.GOOGLE_TRENDS_GEO || "US";
const DATE_RANGE = process.env.GOOGLE_TRENDS_DATE || "today 3-m";
const MIN_POINTS = Number(process.env.GOOGLE_TRENDS_MIN_POINTS || 3);

const keywords = extractKeywords(products, LIMIT);
writeJson("trend-keywords.json", keywords);

const STOP_WORDS = new Set([
  "new", "hot", "sale", "fashion", "style", "quality", "good", "latest",
  "product", "products", "dropshipping", "wholesale", "supplier",
  "solid", "color", "colors", "mini", "large", "small", "piece", "pieces",
  "set", "sets", "with", "for", "and", "the", "this", "that",
  "2024", "2025", "2026", "plus", "size", "best", "high",
  "other", "replacement", "parts", "front", "only", "self", "pickup"
]);

const PRODUCT_TERMS = new Set([
  "sofa", "chair", "table", "storage", "organizer", "kitchen", "dress",
  "pants", "jeans", "sandals", "slippers", "shoes", "bracelet", "necklace",
  "watch", "bag", "lamp", "toy", "makeup", "skincare", "phone", "car",
  "baby", "fitness", "bottle", "shower", "mat", "blanket", "jacket",
  "hoodie", "cap", "hat", "shelf", "rack", "pet", "dog", "cat", "ring",
  "furniture", "home", "beauty", "bathroom", "bed", "garden", "outdoor"
]);

function cleanKeyword(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
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

function keywordVariants(keyword) {
  const clean = cleanKeyword(keyword);
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const variants = [];

  if (words.length >= 2) variants.push(words.slice(0, 3).join(" "));
  if (words.length >= 2) variants.push(words.slice(0, 2).join(" "));
  if (words.length >= 2) variants.push(words.slice(-2).join(" "));

  const productWords = words.filter(w => PRODUCT_TERMS.has(w));
  if (productWords.length >= 2) variants.push(productWords.slice(0, 2).join(" "));
  if (productWords.length === 1) variants.push(productWords[0]);

  // keep original cleaned phrase last, because long CJ phrases often have no data
  variants.push(clean);

  return uniq(variants)
    .filter(v => v.length >= 3)
    .slice(0, 5);
}

function extractTimelineValuesFromAnyJson(obj) {
  const values = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;

    // Common Google Trends shapes
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

  const responseHandler = async (res) => {
    try {
      const url = res.url();
      if (!/trends\/api|widgetdata|TIMESERIES|multiline|explore/i.test(url)) return;
      const text = await res.text();
      if (!text || text.length < 50) return;

      // Google sometimes prefixes JSON with )]}',
      const cleaned = text.replace(/^\)\]\}',?\s*/, "").trim();
      if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) return;

      try {
        jsonBodies.push(JSON.parse(cleaned));
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

    // Wait for network calls and chart rendering
    await page.waitForTimeout(7000);

    // Force extra wait for the widget request if possible
    await page.waitForResponse(
      res => /widgetdata|TIMESERIES|multiline/i.test(res.url()),
      { timeout: 12000 }
    ).catch(() => null);

    await page.waitForTimeout(2500);
  } finally {
    page.off("response", responseHandler);
  }

  let bestValues = [];
  for (const json of jsonBodies) {
    const values = extractTimelineValuesFromAnyJson(json);
    if (values.length > bestValues.length) bestValues = values;
  }

  const scored = scoreFromValues(bestValues);
  if (!scored) {
    return {
      keyword: originalKeyword,
      usedKeyword: variant,
      match: 0,
      score: 0,
      rawScore: 0,
      growthPercent: 0,
      timelinePoints: bestValues.length,
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
    timelinePoints: scored.timelinePoints,
    match: 1,
    source: "google-trends-network",
    fetchedAt: new Date().toISOString()
  };
}

async function fetchWithVariants(page, keyword) {
  const variants = keywordVariants(keyword);

  for (const variant of variants) {
    console.log(`Google Trends network: ${keyword} -> ${variant}`);
    const signal = await fetchTrendForVariant(page, variant, keyword);
    if (signal.match) return signal;
    await sleep(1000);
  }

  return null;
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

const page = await context.newPage();

const signals = [];
const failed = [];

for (const item of keywords) {
  const keyword = item.keyword;

  try {
    const signal = await fetchWithVariants(page, keyword);
    if (signal?.match) {
      signals.push(signal);
      console.log(`Saved Google trend: ${keyword} -> ${signal.usedKeyword}, score ${signal.score}, growth ${signal.growthPercent}%`);
    } else {
      failed.push(keyword);
      console.log(`No 3-month Google Trends timeline data: ${keyword}`);
    }

    await sleep(1800 + Math.floor(Math.random() * 1800));
  } catch (err) {
    failed.push(keyword);
    console.log("Google Trends network failed for", keyword, "-", err.message);
    await sleep(3500);
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
  attemptedKeywordCount: keywords.length,
  savedSignalCount: signals.length,
  failedCount: failed.length,
  note: "Captures Google Trends internal timeline JSON from the Explore page and calculates 3-month growth score.",
  failed: failed.slice(0, 100)
});

console.log(`Saved ${signals.length} Google Trends network signals from ${keywords.length} attempted keywords.`);
