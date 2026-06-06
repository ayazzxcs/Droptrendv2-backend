import { chromium } from "playwright";
import { readJson, writeJson, sleep, num } from "./utils.js";

const PRODUCTS_PATH = process.env.PRODUCTS_PATH || "products.json";
const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || "amazon.com";
const MAX_PRODUCTS = Number(process.env.LENS_MAX_PRODUCTS || 1500);
const START_INDEX = Number(process.env.LENS_START_INDEX || 0);
const MIN_DELAY_MS = Number(process.env.LENS_MIN_DELAY_MS || 15000);
const MAX_DELAY_MS = Number(process.env.LENS_MAX_DELAY_MS || 45000);
const MAX_AMAZON_MATCHES = Number(process.env.LENS_MAX_AMAZON_MATCHES || 3);
const MIN_TITLE_MATCH = Number(process.env.LENS_MIN_TITLE_MATCH || 25);

const products = readJson(PRODUCTS_PATH, []);

function delayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS));
}

function safeUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}

function productName(p) {
  return String(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "").trim();
}

function productImage(p) {
  const img = p.image || p.productImage || p.bigImage || p.raw?.productImage || p.raw?.bigImage;
  return Array.isArray(img) ? safeUrl(img[0]) : safeUrl(img);
}

function norm(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set(["the","and","for","with","from","new","hot","sale","best","top","high","quality","product","products","dropshipping","wholesale","supplier"]);

function words(text) {
  return norm(text).split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

function titleSimilarity(a, b) {
  const aw = words(a);
  const bw = new Set(words(b));
  if (!aw.length || !bw.size) return 0;
  const hits = aw.filter(w => bw.has(w)).length;
  return Math.round(Math.min(100, (hits / aw.length) * 100));
}

function reviewCount(text) {
  const m = String(text || "").replace(/,/g, "").match(/(\d+(\.\d+)?)(k|m)?/i);
  if (!m) return 0;
  let n = Number(m[1]);
  if ((m[3] || "").toLowerCase() === "k") n *= 1000;
  if ((m[3] || "").toLowerCase() === "m") n *= 1000000;
  return Math.round(n);
}

function demandScore({ rating, ratingsTotal, isBestSeller, matchScore }) {
  const ratingScore = Math.min(35, Math.max(0, num(rating) * 7));
  const reviewScore = Math.min(45, Math.log10(num(ratingsTotal) + 1) * 11);
  const badgeScore = isBestSeller ? 10 : 0;
  const matchBonus = Math.min(10, Math.max(0, matchScore - 50) / 5);
  return Math.round(Math.min(100, ratingScore + reviewScore + badgeScore + matchBonus));
}

async function blockAssets(page) {
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    return route.continue();
  });
}

async function safeText(locator, timeout = 2000) {
  try { return (await locator.first().innerText({ timeout })).trim(); } catch { return ""; }
}

async function isBlocked(page, label) {
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (/captcha|unusual traffic|verify you are human|enter the characters you see below|sorry, we just need to make sure/i.test(text)) {
    throw new Error(`${label} CAPTCHA/bot check detected`);
  }
}

function isAmazon(url) {
  try {
    const u = new URL(url);
    return /(^|\.)amazon\./i.test(u.hostname) || /amazon\./i.test(u.hostname);
  } catch {
    return false;
  }
}

function cleanAmazon(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

async function googleLensAmazonLinks(page, imageUrl) {
  const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  await page.goto(lensUrl, { waitUntil: "domcontentloaded", timeout: 70000 });
  await page.waitForTimeout(9000);
  await isBlocked(page, "Google Lens");

  for (const label of ["Find image source", "Visual matches", "Exact matches", "Products"]) {
    try {
      const loc = page.getByText(label, { exact: false }).first();
      await loc.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch {}
  }

  const links = await page.locator("a").evaluateAll(els =>
    els.map(a => ({ href: a.href || "", text: (a.innerText || a.textContent || "").trim() }))
  ).catch(() => []);

  const out = [];
  const seen = new Set();

  for (const link of links) {
    let href = link.href || "";
    try {
      const u = new URL(href);
      const q = u.searchParams.get("url") || u.searchParams.get("q");
      if (q && /^https?:\/\//i.test(q)) href = q;
    } catch {}

    if (!isAmazon(href)) continue;

    const clean = cleanAmazon(href);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, lensText: link.text });

    if (out.length >= MAX_AMAZON_MATCHES) break;
  }

  return out;
}

async function scrapeAmazon(context, url, cjName) {
  const page = await context.newPage();
  await blockAssets(page);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.waitForTimeout(4000);
    await isBlocked(page, "Amazon");

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

    const ratingsTotal = reviewCount(reviewsText);

    const badgeText =
      await safeText(page.locator("#zeitgeistBadge_feature_div"), 1000) ||
      await safeText(page.locator(".ac-badge-text-primary"), 1000) ||
      await safeText(page.locator("span:has-text('Best Seller')"), 1000);

    const isBestSeller = /best seller|amazon'?s choice/i.test(badgeText);
    const matchScore = titleSimilarity(cjName, title);
    const score = demandScore({ rating, ratingsTotal, isBestSeller, matchScore });

    return {
      title,
      url: cleanAmazon(url),
      rating: rating || "",
      ratingsTotal: ratingsTotal || 0,
      isBestSeller,
      badgeText,
      matchScore,
      score,
      source: "google-lens-amazon",
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function updateProduct(product, match) {
  const oldProof = product.trendProof || {};
  const oldAmazon = oldProof.amazon || null;

  const lensAmazon = {
    keyword: "google-lens-image-match",
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
    source: "google-lens-amazon",
    match: 1
  };

  const finalAmazon = !oldAmazon || num(lensAmazon.score) >= num(oldAmazon.score) ? lensAmazon : oldAmazon;
  const cjScore = num(oldProof.cjSupplier?.score || product.cjScore || 0);
  const googleScore = num(oldProof.googleTrends?.score || 0);
  const amazonScore = num(finalAmazon.score || 0);
  const dropTrendScore = Math.round((googleScore * 0.4) + (amazonScore * 0.4) + (cjScore * 0.2));

  return {
    ...product,
    dropTrendScore: dropTrendScore || product.dropTrendScore,
    trend: dropTrendScore || product.trend,
    amazonLens: lensAmazon,
    trendProof: {
      ...oldProof,
      confidence: googleScore && amazonScore ? "High" : (googleScore || amazonScore ? "Medium" : "Low"),
      amazon: finalAmazon,
      amazonLens: lensAmazon
    }
  };
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
});

const context = await browser.newContext({
  viewport: { width: 1365, height: 768 },
  locale: "en-US",
  timezoneId: "America/New_York",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }
});

const lensPage = await context.newPage();

const matches = [];
const failures = [];
const endIndex = Math.min(products.length, START_INDEX + MAX_PRODUCTS);

for (let i = START_INDEX; i < endIndex; i++) {
  const p = products[i];
  const name = productName(p);
  const image = productImage(p);

  if (p?.trendProof?.amazonLens?.productUrl || p?.amazonLens?.productUrl) {
    console.log(`Lens skip ${i + 1}/${products.length}: already matched`);
    continue;
  }

  if (!name || !image) {
    failures.push({ index: i, name, reason: "missing name or image" });
    continue;
  }

  try {
    console.log(`Lens ${i + 1}/${products.length}: ${name}`);
    const amazonLinks = await googleLensAmazonLinks(lensPage, image);

    if (!amazonLinks.length) {
      failures.push({ index: i, name, image, reason: "no amazon lens link" });
      console.log(`No Amazon Lens link: ${name}`);
      await sleep(delayMs());
      continue;
    }

    let best = null;

    for (const link of amazonLinks) {
      try {
        const data = await scrapeAmazon(context, link.url, name);
        if (!data.title || !data.rating || !data.ratingsTotal) continue;
        if (data.matchScore < MIN_TITLE_MATCH) {
          console.log(`Rejected: ${data.title} | match ${data.matchScore}`);
          continue;
        }
        if (!best || data.matchScore > best.matchScore || data.score > best.score) best = data;
        await sleep(2500 + Math.floor(Math.random() * 2500));
      } catch (err) {
        console.log(`Amazon product failed: ${link.url} - ${err.message}`);
      }
    }

    if (!best) {
      failures.push({ index: i, name, image, reason: "amazon links found but no usable rating/reviews" });
      await sleep(delayMs());
      continue;
    }

    products[i] = updateProduct(p, best);
    matches.push({ productId: p.id, productName: name, productImage: image, amazon: best });

    console.log(`Matched: ${name} -> ${best.title} | rating ${best.rating} | reviews ${best.ratingsTotal} | score ${best.score} | match ${best.matchScore}`);

    if (matches.length % 5 === 0) {
      writeJson(PRODUCTS_PATH, products);
      writeJson("lens-amazon-matches.json", matches);
      writeJson("lens-amazon-failures.json", failures);
      console.log(`Saved progress: ${matches.length} Lens matches`);
    }

    await sleep(delayMs());
  } catch (err) {
    failures.push({ index: i, name, image, reason: err.message });
    console.log(`Lens failed: ${name} - ${err.message}`);

    if (/captcha|bot check|unusual traffic/i.test(err.message)) {
      console.log("Stopping Lens step early because a CAPTCHA/bot check was detected.");
      break;
    }

    await sleep(delayMs());
  }
}

await browser.close().catch(() => {});

writeJson(PRODUCTS_PATH, products);
writeJson("lens-amazon-matches.json", matches);
writeJson("lens-amazon-failures.json", failures);
writeJson("lens-amazon-meta.json", {
  updatedAt: new Date().toISOString(),
  startIndex: START_INDEX,
  maxProducts: MAX_PRODUCTS,
  attemptedRange: [START_INDEX, endIndex],
  matches: matches.length,
  failures: failures.length,
  note: "Google Lens image matching to Amazon. Amazon price is ignored; CJ price remains source of truth."
});

console.log(`Lens Amazon complete. Matches: ${matches.length}, failures: ${failures.length}`);
