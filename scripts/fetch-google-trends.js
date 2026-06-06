import { chromium } from "playwright";
import { readJson, writeJson, extractKeywords, sleep } from "./utils.js";

const products = readJson("products.json", []);
const limit = Number(process.env.GOOGLE_TRENDS_LIMIT || 120);
const keywords = extractKeywords(products, limit);
writeJson("trend-keywords.json", keywords);

const STOP_WORDS = new Set([
  "new", "hot", "sale", "fashion", "style", "quality", "good", "latest",
  "product", "products", "dropshipping", "wholesale", "supplier",
  "solid", "color", "colors", "mini", "large", "small", "piece", "pieces",
  "set", "sets", "with", "for", "and", "the", "this", "that",
  "2024", "2025", "2026", "plus", "size"
]);

function cleanTrendKeyword(keyword) {
  return String(keyword || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\b\d+\b/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function keywordVariants(keyword) {
  const clean = cleanTrendKeyword(keyword);
  const words = clean.split(/\s+/).filter(Boolean);

  if (!words.length) return [];

  const variants = [
    clean,
    words.slice(0, 3).join(" "),
    words.slice(0, 2).join(" "),
    words.slice(-2).join(" "),
    words[0],
    words[words.length - 1]
  ];

  // Prefer useful 1-word fallback terms over weird product fragments.
  const important = words.find(w =>
    /sofa|chair|table|storage|dress|pants|jeans|sandals|slippers|shoes|pet|dog|cat|kitchen|bracelet|ring|necklace|watch|bag|lamp|toy|makeup|skincare|phone|car|baby|fitness|bottle|organizer|shower|mat|blanket|jacket|hoodie|cap|hat|shelf|rack/.test(w)
  );

  if (important) variants.push(important);

  return unique(variants)
    .filter(v => v.length >= 3)
    .slice(0, 5);
}

async function fetchTrendForKeyword(page, keyword, originalKeyword = keyword) {
  const url = "https://trends.google.com/trends/explore?date=today%203-m&q=" + encodeURIComponent(keyword);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  const bodyText = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");

  const noData = /not enough data|doesn'?t have enough data|hmm, your search/i.test(bodyText);
  const blocked = /unusual traffic|captcha|verify you are human/i.test(bodyText);

  if (blocked) {
    throw new Error("Google Trends blocked/CAPTCHA page detected");
  }

  if (noData) {
    return {
      keyword: originalKeyword,
      usedKeyword: keyword,
      score: 0,
      rawScore: 0,
      growthPercent: 0,
      match: 0,
      source: "google-trends-playwright",
      noData: true,
      fetchedAt: new Date().toISOString()
    };
  }

  let growthPercent = 0;

  // Google Trends UI text is not a formal API.
  // Try to catch percentage growth if present, otherwise treat as valid trend presence.
  const percentMatch = bodyText.match(/(\+?\-?\d{1,4})%/);
  if (percentMatch) {
    growthPercent = Number(percentMatch[1].replace("+", ""));
  }

  const positiveGrowth = Math.max(0, growthPercent);
  const score = Math.min(100, Math.max(35, 55 + Math.round(positiveGrowth / 4)));

  return {
    keyword: originalKeyword,
    usedKeyword: keyword,
    score,
    rawScore: score,
    growthPercent,
    match: 1,
    source: "google-trends-playwright",
    fetchedAt: new Date().toISOString()
  };
}

async function fetchWithVariants(page, keyword) {
  const variants = keywordVariants(keyword);

  for (const variant of variants) {
    try {
      console.log(`Google Trends: ${keyword} -> ${variant}`);
      const signal = await fetchTrendForKeyword(page, variant, keyword);
      if (signal.match) return signal;
      await sleep(500);
    } catch (err) {
      console.log(`Google Trends variant failed for ${variant}: ${err.message}`);
    }
  }

  // Save a low-confidence fallback so merge can still know the keyword was attempted,
  // but it will not boost the score much.
  return {
    keyword,
    usedKeyword: variants[0] || keyword,
    score: 0,
    rawScore: 0,
    growthPercent: 0,
    match: 0,
    source: "google-trends-playwright",
    noData: true,
    fetchedAt: new Date().toISOString()
  };
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
const attempted = [];

for (const item of keywords) {
  const keyword = item.keyword;
  attempted.push(keyword);

  try {
    const signal = await fetchWithVariants(page, keyword);

    // Save matched signals only. This avoids fake Google scores.
    if (signal.match) {
      signals.push(signal);
      console.log(`Saved Google Trends signal: ${keyword} -> ${signal.usedKeyword} score ${signal.score}`);
    } else {
      console.log(`No Google Trends data: ${keyword}`);
    }

    await sleep(1200 + Math.floor(Math.random() * 1800));
  } catch (err) {
    console.log("Google Trends failed for", keyword, "-", err.message);
    await sleep(3000);
  }
}

await browser.close();

writeJson("google-trends.json", signals);
writeJson("google-trends-meta.json", {
  updatedAt: new Date().toISOString(),
  attemptedCount: keywords.length,
  savedCount: signals.length,
  source: "google-trends-playwright",
  note: "Uses simplified keyword variants because Google Trends often has no data for long CJ product titles.",
  attempted: attempted.slice(0, 200)
});

console.log(`Saved ${signals.length} Google Trends signals from ${keywords.length} attempted keywords.`);
