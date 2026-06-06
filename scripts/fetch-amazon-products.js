import { chromium } from "playwright";
import { readJson, writeJson, sleep, num } from "./utils.js";

const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || "amazon.com";
const KEYWORD_LIMIT = Number(process.env.AMAZON_KEYWORD_LIMIT || 80);
const MAX_RESULTS_PER_KEYWORD = Number(process.env.AMAZON_RESULTS_PER_KEYWORD || 5);

const googleSignals = readJson("google-trends.json", []);
const trendKeywords = readJson("trend-keywords.json", []);

const keywords = [...new Set([
  ...googleSignals.map(s => s.keyword).filter(Boolean),
  ...trendKeywords.map(k => k.keyword).filter(Boolean)
])].slice(0, KEYWORD_LIMIT);

writeJson("amazon-keywords.json", keywords.map(keyword => ({ keyword })));

function normalizeReviewCount(text) {
  if (!text) return 0;
  const cleaned = String(text).replace(/,/g, "");
  const m = cleaned.match(/(\d+(\.\d+)?)(k|m)?/i);
  if (!m) return 0;
  let value = Number(m[1]);
  const suffix = (m[3] || "").toLowerCase();
  if (suffix === "k") value *= 1000;
  if (suffix === "m") value *= 1000000;
  return Math.round(value);
}

function demandScore({ rating, ratingsTotal, price, position, isBestSeller }) {
  const ratingScore = Math.min(35, Math.max(0, num(rating) * 7));
  const reviewScore = Math.min(40, Math.log10(num(ratingsTotal) + 1) * 10);
  const rankScore = Math.max(0, 20 - (num(position) - 1) * 2);
  const badgeScore = isBestSeller ? 10 : 0;
  const priceScore = num(price) > 0 ? 5 : 0;
  return Math.round(Math.min(100, ratingScore + reviewScore + rankScore + badgeScore + priceScore));
}

async function blockHeavyAssets(page) {
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    return route.continue();
  });
}

async function safeText(locator) {
  try {
    return (await locator.first().innerText({ timeout: 1500 })).trim();
  } catch {
    return "";
  }
}

async function safeAttr(locator, attr) {
  try {
    return await locator.first().getAttribute(attr, { timeout: 1500 });
  } catch {
    return "";
  }
}

async function extractProducts(page, keyword) {
  const cards = page.locator('[data-component-type="s-search-result"]');
  const count = Math.min(await cards.count().catch(() => 0), MAX_RESULTS_PER_KEYWORD);
  const results = [];

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);

    const title =
      await safeText(card.locator("h2 span")) ||
      await safeText(card.locator("span.a-text-normal"));

    if (!title || /sponsored video|advertisement/i.test(title)) continue;

    const asin = await safeAttr(card, "data-asin");

    const ratingText =
      await safeText(card.locator("span.a-icon-alt")) ||
      await safeAttr(card.locator("i.a-icon-star-small span.a-icon-alt"), "innerText");

    const ratingMatch = ratingText.match(/(\d+(\.\d+)?)/);
    const rating = ratingMatch ? Number(ratingMatch[1]) : 0;

    const reviewsText =
      await safeText(card.locator("span.a-size-base.s-underline-text")) ||
      await safeText(card.locator("a[href*='customerReviews'] span")) ||
      await safeText(card.locator("span[aria-label$='ratings']"));

    const ratingsTotal = normalizeReviewCount(reviewsText);

    const priceWhole = await safeText(card.locator(".a-price .a-price-whole"));
    const priceFraction = await safeText(card.locator(".a-price .a-price-fraction"));
    const rawPrice = priceWhole ? `${priceWhole}.${priceFraction || "00"}` : "";
    const price = num(rawPrice);

    const badgeText = await safeText(card.locator(".a-badge-text, .a-badge-label-inner"));
    const isBestSeller = /best seller|amazon'?s choice/i.test(badgeText);

    const urlPath = await safeAttr(card.locator("h2 a"), "href");
    const productUrl = urlPath ? `https://${AMAZON_DOMAIN}${urlPath.split("?")[0]}` : "";

    const score = demandScore({
      rating,
      ratingsTotal,
      price,
      position: i + 1,
      isBestSeller
    });

    results.push({
      keyword,
      title,
      asin,
      score,
      bestRating: rating || "",
      bestRatingsTotal: ratingsTotal || 0,
      bestPrice: price || "",
      position: i + 1,
      isBestSeller,
      badgeText,
      productUrl,
      source: "amazon-playwright",
      fetchedAt: new Date().toISOString()
    });
  }

  return results;
}

async function searchAmazon(page, keyword) {
  const searchUrl = `https://${AMAZON_DOMAIN}/s?k=${encodeURIComponent(keyword)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  if (/enter the characters you see below|captcha|sorry, we just need to make sure/i.test(text)) {
    throw new Error("Amazon CAPTCHA/bot check detected");
  }

  if (/no results for|try checking your spelling/i.test(text)) {
    return [];
  }

  return await extractProducts(page, keyword);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage"
  ]
});

const context = await browser.newContext({
  viewport: { width: 1365, height: 768 },
  locale: "en-US",
  timezoneId: "America/New_York",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  extraHTTPHeaders: {
    "Accept-Language": "en-US,en;q=0.9"
  }
});

const page = await context.newPage();
await blockHeavyAssets(page);

const allResults = [];

for (const keyword of keywords) {
  try {
    console.log("Amazon Search:", keyword);
    const products = await searchAmazon(page, keyword);
    allResults.push(...products);
    console.log(`Amazon saved ${products.length} for ${keyword}`);
    await sleep(2500 + Math.floor(Math.random() * 2500));
  } catch (err) {
    console.log("Amazon failed for", keyword, "-", err.message);
    await sleep(5000);
  }
}

await browser.close();

writeJson("amazon-products.json", allResults);
console.log(`Saved ${allResults.length} Amazon products for ${keywords.length} keywords.`);
