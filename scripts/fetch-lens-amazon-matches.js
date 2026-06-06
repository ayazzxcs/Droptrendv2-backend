import { chromium } from "playwright";
import { readJson, writeJson, sleep, num } from "./utils.js";

// FIXED VERSION:
// - Fresh isolated Playwright context/page for EVERY CJ product image.
// - Does NOT reuse the same Google Lens page.
// - Prevents Google Lens state/cache/session from causing only first image to work.
// - Amazon is image-match only. No Amazon keyword search.

const PRODUCTS_PATH = process.env.PRODUCTS_PATH || "products.json";
const MAX_PRODUCTS = Number(process.env.LENS_MAX_PRODUCTS || 50);
const START_INDEX = Number(process.env.LENS_START_INDEX || 0);
const MIN_DELAY_MS = Number(process.env.LENS_MIN_DELAY_MS || 15000);
const MAX_DELAY_MS = Number(process.env.LENS_MAX_DELAY_MS || 45000);
const MAX_AMAZON_MATCHES = Number(process.env.LENS_MAX_AMAZON_MATCHES || 3);
const MIN_TITLE_MATCH = Number(process.env.LENS_MIN_TITLE_MATCH || 20);

const products = readJson(PRODUCTS_PATH, []);

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS));
}

function safeUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}

function getProductName(p) {
  return String(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "").trim();
}

function getProductImage(p) {
  const img =
    p.image ||
    p.productImage ||
    p.bigImage ||
    p.raw?.productImage ||
    p.raw?.bigImage ||
    p.raw?.image;

  if (Array.isArray(img)) return safeUrl(img[0]);
  return safeUrl(img);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "the","and","for","with","from","new","hot","sale","best","top",
  "high","quality","product","products","dropshipping","wholesale","supplier"
]);

function tokens(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

function titleSimilarity(a, b) {
  const aTokens = tokens(a);
  const bTokens = new Set(tokens(b));
  if (!aTokens.length || !bTokens.size) return 0;

  const hits = aTokens.filter(t => bTokens.has(t)).length;
  return Math.round(Math.min(100, (hits / aTokens.length) * 100));
}

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

function amazonDemandScore({ rating, ratingsTotal, isBestSeller, matchScore }) {
  const ratingScore = Math.min(35, Math.max(0, num(rating) * 7));
  const reviewScore = Math.min(45, Math.log10(num(ratingsTotal) + 1) * 11);
  const badgeScore = isBestSeller ? 10 : 0;
  const matchBonus = Math.min(10, Math.max(0, matchScore - 50) / 5);
  return Math.round(Math.min(100, ratingScore + reviewScore + badgeScore + matchBonus));
}

async function safeText(locator, timeout = 2000) {
  try {
    return (await locator.first().innerText({ timeout })).trim();
  } catch {
    return "";
  }
}

async function blockHeavyAssets(page) {
  await page.route("**/*", route => {
    const type = route.request().resourceType();

    // Do NOT block images on Google Lens pages because Lens needs image UI/results.
    const url = route.request().url();
    if (url.includes("lens.google.com")) return route.continue();

    if (["media", "font"].includes(type)) return route.abort();
    return route.continue();
  });
}

async function checkBlocked(page, source) {
  const text = await page.locator("body").innerText({ timeout: 6000 }).catch(() => "");
  if (/captcha|unusual traffic|verify you are human|enter the characters you see below|sorry, we just need to make sure/i.test(text)) {
    throw new Error(`${source} CAPTCHA/bot check detected`);
  }
}

function isAmazonUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)amazon\./i.test(u.hostname);
  } catch {
    return false;
  }
}

function cleanAmazonUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

async function createFreshContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    locale: "en-US",
    timezoneId: "America/New_York",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  await context.clearCookies().catch(() => {});
  return context;
}

async function googleLensSearchByImage(browser, imageUrl) {
  // CRITICAL FIX: fresh context and fresh page per image.
  const context = await createFreshContext(browser);
  const page = await context.newPage();
  await blockHeavyAssets(page);

  try {
    const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}&t=${Date.now()}`;

    await page.goto(lensUrl, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.waitForTimeout(10000);
    await checkBlocked(page, "Google Lens");

    // Optional Lens tab clicks. If unavailable, continue.
    for (const label of ["Visual matches", "Exact matches", "Products", "Find image source"]) {
      try {
        await page.getByText(label, { exact: false }).first().click({ timeout: 1500 });
        await page.waitForTimeout(1500);
      } catch {}
    }

    const links = await page.locator("a").evaluateAll(els =>
      els.map(a => ({
        href: a.href || "",
        text: (a.innerText || a.textContent || "").trim()
      }))
    ).catch(() => []);

    const amazon = [];
    const seen = new Set();

    for (const link of links) {
      let href = link.href || "";

      // unwrap possible Google redirect URLs
      try {
        const u = new URL(href);
        const q = u.searchParams.get("url") || u.searchParams.get("q");
        if (q && /^https?:\/\//i.test(q)) href = q;
      } catch {}

      if (!isAmazonUrl(href)) continue;

      const cleaned = cleanAmazonUrl(href);
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);

      amazon.push({
        url: cleaned,
        lensText: link.text || ""
      });

      if (amazon.length >= MAX_AMAZON_MATCHES) break;
    }

    return amazon;
  } finally {
    await context.close().catch(() => {});
  }
}

async function scrapeAmazonProduct(browser, url, cjProductName) {
  // Fresh context for Amazon too, so Amazon state doesn't poison later attempts.
  const context = await createFreshContext(browser);
  const page = await context.newPage();
  await blockHeavyAssets(page);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.waitForTimeout(5000);
    await checkBlocked(page, "Amazon");

    const title =
      await safeText(page.locator("#productTitle"), 3000) ||
      await safeText(page.locator("h1"), 2000);

    const ratingText =
      await safeText(page.locator("#acrPopover span.a-icon-alt"), 2000) ||
      await safeText(page.locator("span.a-icon-alt"), 2000) ||
      await safeText(page.locator("[data-hook='rating-out-of-text']"), 2000);

    const ratingMatch = ratingText.match(/(\d+(\.\d+)?)/);
    const rating = ratingMatch ? Number(ratingMatch[1]) : 0;

    const reviewsText =
      await safeText(page.locator("#acrCustomerReviewText"), 2000) ||
      await safeText(page.locator("[data-hook='total-review-count']"), 2000) ||
      await safeText(page.locator("a[href*='customerReviews'] span"), 2000);

    const ratingsTotal = normalizeReviewCount(reviewsText);

    const badgeText =
      await safeText(page.locator("#zeitgeistBadge_feature_div"), 1000) ||
      await safeText(page.locator(".ac-badge-text-primary"), 1000) ||
      await safeText(page.locator("span:has-text('Best Seller')"), 1000);

    const isBestSeller = /best seller|amazon'?s choice/i.test(badgeText);
    const matchScore = titleSimilarity(cjProductName, title);

    const score = amazonDemandScore({
      rating,
      ratingsTotal,
      isBestSeller,
      matchScore
    });

    return {
      title,
      url: cleanAmazonUrl(url),
      rating: rating || "",
      ratingsTotal: ratingsTotal || 0,
      isBestSeller,
      badgeText,
      matchScore,
      score,
      source: "google-lens-amazon-image",
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function updateProduct(product, match) {
  const oldProof = product.trendProof || {};

  const amazonLens = {
    keyword: "image-match",
    score: match.score,
    bestRating: match.rating,
    bestRatingsTotal: match.ratingsTotal,
    bestPrice: "",
    position: 1,
    isBestSeller: match.isBestSeller,
    productUrl: match.url,
    title: match.title,
    matchScore: match.matchScore,
    matchType: "image",
    source: "google-lens-amazon-image",
    match: 1
  };

  const googleScore = num(oldProof.googleTrends?.score || 0);
  const amazonScore = num(amazonLens.score || 0);
  const cjScore = num(oldProof.cjSupplier?.score || product.cjScore || 0);
  const dropTrendScore = Math.round((googleScore * 0.4) + (amazonScore * 0.4) + (cjScore * 0.2));

  return {
    ...product,
    dropTrendScore: dropTrendScore || product.dropTrendScore,
    trend: dropTrendScore || product.trend,
    amazonLens,
    trendProof: {
      ...oldProof,
      confidence: googleScore && amazonScore ? "High" : (googleScore || amazonScore ? "Medium" : "Low"),
      amazon: amazonLens,
      amazonLens
    }
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

const matches = [];
const failures = [];
const amazonSignals = [];
const endIndex = Math.min(products.length, START_INDEX + MAX_PRODUCTS);

for (let i = START_INDEX; i < endIndex; i++) {
  const product = products[i];
  const name = getProductName(product);
  const image = getProductImage(product);

  if (!name || !image) {
    failures.push({ index: i, name, reason: "missing product name or image" });
    continue;
  }

  try {
    console.log(`Lens ${i + 1}/${products.length}: ${name}`);
    console.log(`CJ image: ${image}`);

    const amazonLinks = await googleLensSearchByImage(browser, image);

    if (!amazonLinks.length) {
      console.log(`No Amazon Lens link: ${name}`);
      failures.push({ index: i, name, image, reason: "no amazon lens link" });
      await sleep(randomDelay());
      continue;
    }

    let best = null;

    for (const link of amazonLinks) {
      try {
        const result = await scrapeAmazonProduct(browser, link.url, name);

        if (!result.title || !result.rating || !result.ratingsTotal) continue;

        if (result.matchScore < MIN_TITLE_MATCH) {
          console.log(`Rejected weak Amazon title match: ${result.title} (${result.matchScore})`);
          continue;
        }

        if (!best || result.matchScore > best.matchScore || result.score > best.score) {
          best = result;
        }

        await sleep(2500 + Math.floor(Math.random() * 2500));
      } catch (err) {
        console.log(`Amazon result failed: ${link.url} - ${err.message}`);
      }
    }

    if (!best) {
      console.log(`Amazon links found but no usable rating/reviews: ${name}`);
      failures.push({ index: i, name, image, reason: "amazon links found but no usable rating/reviews" });
      await sleep(randomDelay());
      continue;
    }

    products[i] = updateProduct(product, best);

    const signal = {
      productId: product.id,
      keyword: product.id || name,
      productName: name,
      image,
      title: best.title,
      asin: "",
      score: best.score,
      bestRating: best.rating,
      bestRatingsTotal: best.ratingsTotal,
      bestPrice: "",
      position: 1,
      isBestSeller: best.isBestSeller,
      badgeText: best.badgeText,
      productUrl: best.url,
      matchScore: best.matchScore,
      matchType: "image",
      source: "google-lens-amazon-image",
      fetchedAt: best.fetchedAt
    };

    amazonSignals.push(signal);
    matches.push({
      productId: product.id,
      productName: name,
      productImage: image,
      amazon: best
    });

    console.log(`Matched: ${name} -> ${best.title} | rating ${best.rating} | reviews ${best.ratingsTotal} | score ${best.score} | match ${best.matchScore}`);

    if (matches.length % 5 === 0) {
      writeJson(PRODUCTS_PATH, products);
      writeJson("lens-amazon-matches.json", matches);
      writeJson("lens-amazon-failures.json", failures);
      writeJson("amazon-products.json", amazonSignals);
      console.log(`Saved Lens progress: ${matches.length} matches`);
    }

    await sleep(randomDelay());
  } catch (err) {
    console.log(`Lens failed for ${name}: ${err.message}`);
    failures.push({ index: i, name, image, reason: err.message });

    if (/captcha|bot check|unusual traffic/i.test(err.message)) {
      console.log("Stopping Lens step early due to CAPTCHA/bot check.");
      break;
    }

    await sleep(randomDelay());
  }
}

await browser.close().catch(() => {});

writeJson(PRODUCTS_PATH, products);
writeJson("lens-amazon-matches.json", matches);
writeJson("lens-amazon-failures.json", failures);
writeJson("amazon-products.json", amazonSignals);
writeJson("lens-amazon-meta.json", {
  updatedAt: new Date().toISOString(),
  mode: "fresh context per CJ image",
  startIndex: START_INDEX,
  maxProducts: MAX_PRODUCTS,
  attemptedRange: [START_INDEX, endIndex],
  matches: matches.length,
  failures: failures.length,
  note: "Each Google Lens image search uses a fresh browser context to avoid first-image-only Playwright state issues."
});

console.log(`Lens Amazon complete. Matches: ${matches.length}, failures: ${failures.length}`);
