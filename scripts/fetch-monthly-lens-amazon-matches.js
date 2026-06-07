import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readJson, writeJson, sleep, num } from "./utils.js";

puppeteer.use(StealthPlugin());

// Monthly sequential quota Lens provider + Puppeteer Amazon enrichment.
// Rule:
// - Use provider #1 until its monthly limit is reached.
// - Only then move to provider #2.
// - One Lens API request per product.
// - One Amazon result per product.
// - If no Amazon result/match for that product, move to next product.
// - Save whatever data is collected and continue.

const PRODUCTS_PATH = process.env.PRODUCTS_PATH || "products.json";
const AMAZON_PRODUCTS_PATH = process.env.AMAZON_PRODUCTS_PATH || "amazon-products.json";
const USAGE_PATH = process.env.LENS_USAGE_PATH || "lens-provider-usage.json";

const products = readJson(PRODUCTS_PATH, []);
const existingAmazon = readJson(AMAZON_PRODUCTS_PATH, []);
const usage = readJson(USAGE_PATH, {});
const month = new Date().toISOString().slice(0, 7);
usage[month] ||= {};

const MAX_PRODUCTS = Number(process.env.MONTHLY_LENS_MAX_PRODUCTS || 1500);
const START_INDEX = Number(process.env.MONTHLY_LENS_START_INDEX || 0);
const DELAY_MS = Number(process.env.MONTHLY_LENS_DELAY_MS || 1200);
const AMAZON_DELAY_MS = Number(process.env.AMAZON_PAGE_DELAY_MS || 3500);
const MIN_TITLE_MATCH = Number(process.env.AMAZON_MIN_TITLE_MATCH || 15);

const BUDGETS = {
  serpapi_1: Number(process.env.SERPAPI_1_MONTHLY_LIMIT || 250),
  serpapi_2: Number(process.env.SERPAPI_2_MONTHLY_LIMIT || 250),
  searchapi: Number(process.env.SEARCHAPI_MONTHLY_LIMIT || 100),
  hasdata: Number(process.env.HASDATA_MONTHLY_LIMIT || 100),
  scrapingdog: Number(process.env.SCRAPINGDOG_MONTHLY_LIMIT || 200),
  decodo: Number(process.env.DECODO_MONTHLY_LIMIT || 700),
  apify: Number(process.env.APIFY_MONTHLY_LIMIT || 150),
  openwebninja: Number(process.env.OPENWEBNINJA_MONTHLY_LIMIT || 50),
  zenserp: Number(process.env.ZENSERP_MONTHLY_LIMIT || 50)
};

function used(provider) {
  return Number(usage[month][provider] || 0);
}

function canUse(provider) {
  return used(provider) < Number(BUDGETS[provider] || 0);
}

function markUsed(provider) {
  usage[month][provider] = used(provider) + 1;
  writeJson(USAGE_PATH, usage);
}

function safeUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}

function productName(p) {
  return String(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "").trim();
}

function productImage(p) {
  const img =
    p.image ||
    p.productImage ||
    p.bigImage ||
    p.raw?.productImage ||
    p.raw?.bigImage ||
    p.raw?.image;

  return Array.isArray(img) ? safeUrl(img[0]) : safeUrl(img);
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
  return normalizeText(text).split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
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

function demandScore({ rating, ratingsTotal, isBestSeller, matchScore }) {
  const ratingScore = Math.min(35, Math.max(0, num(rating) * 7));
  const reviewScore = Math.min(45, Math.log10(num(ratingsTotal) + 1) * 11);
  const badgeScore = isBestSeller ? 10 : 0;
  const matchBonus = Math.min(10, Math.max(0, matchScore - 50) / 5);
  return Math.round(Math.min(100, ratingScore + reviewScore + badgeScore + matchBonus));
}

function isAmazonUrl(url) {
  try {
    return /(^|\.)amazon\./i.test(new URL(url).hostname);
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

function extractAmazonLinks(data) {
  const out = [];
  const seen = new Set();

  function walk(node) {
    if (!node) return;

    if (typeof node === "string") {
      let s = node;
      try {
        const u = new URL(s);
        const q = u.searchParams.get("url") || u.searchParams.get("q");
        if (q && /^https?:\/\//i.test(q)) s = q;
      } catch {}

      if (isAmazonUrl(s)) {
        const clean = cleanAmazonUrl(s);
        if (!seen.has(clean)) {
          seen.add(clean);
          out.push({ url: clean, title: "" });
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (typeof node === "object") {
      const possibleUrl =
        node.link || node.url || node.source_url || node.result_url ||
        node.sourceUrl || node.page_url || node.href;

      const possibleTitle =
        node.title || node.name || node.source || node.domain || node.text || "";

      if (possibleUrl && isAmazonUrl(possibleUrl)) {
        const clean = cleanAmazonUrl(possibleUrl);
        if (!seen.has(clean)) {
          seen.add(clean);
          out.push({ url: clean, title: String(possibleTitle || "") });
        }
      }

      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(data);
  return out;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { rawText: text };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  return data;
}

async function serpapiLens(imageUrl, apiKey) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_lens");
  url.searchParams.set("url", imageUrl);
  url.searchParams.set("type", "products");
  url.searchParams.set("api_key", apiKey);
  return extractAmazonLinks(await fetchJson(url.toString()));
}

async function searchapiLens(imageUrl) {
  const url = new URL("https://www.searchapi.io/api/v1/search");
  url.searchParams.set("engine", "google_lens");
  url.searchParams.set("url", imageUrl);
  url.searchParams.set("search_type", "products");
  url.searchParams.set("country", process.env.SEARCHAPI_COUNTRY || "US");
  url.searchParams.set("api_key", process.env.SEARCHAPI_KEY);
  return extractAmazonLinks(await fetchJson(url.toString()));
}

async function decodoLens(imageUrl) {
  if (!process.env.DECODO_AUTH_BASE64) throw new Error("Missing DECODO_AUTH_BASE64");

  return extractAmazonLinks(await fetchJson("https://scraper-api.decodo.com/v2/scrape", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Basic ${process.env.DECODO_AUTH_BASE64}`
    },
    body: JSON.stringify({
      target: "google_lens",
      query: imageUrl,
      headless: "html",
      parse: true
    })
  }));
}

async function scrapingdogLens(imageUrl) {
  if (!process.env.SCRAPINGDOG_API_KEY) throw new Error("Missing SCRAPINGDOG_API_KEY");
  const endpoint = process.env.SCRAPINGDOG_LENS_ENDPOINT || "https://api.scrapingdog.com/google_lens";
  const url = new URL(endpoint);
  url.searchParams.set("api_key", process.env.SCRAPINGDOG_API_KEY);
  url.searchParams.set("url", imageUrl);
  return extractAmazonLinks(await fetchJson(url.toString()));
}

async function genericLens(imageUrl, provider) {
  const envPrefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const endpoint = process.env[`${envPrefix}_LENS_ENDPOINT`];
  const apiKey = process.env[`${envPrefix}_API_KEY`];

  if (!endpoint) throw new Error(`Missing ${envPrefix}_LENS_ENDPOINT`);

  const url = new URL(endpoint);
  url.searchParams.set("url", imageUrl);
  if (apiKey) url.searchParams.set("api_key", apiKey);

  return extractAmazonLinks(await fetchJson(url.toString(), {
    headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}
  }));
}

function providerQueue() {
  // IMPORTANT:
  // Sequential quota order. It does NOT try another provider just because a product has no match.
  // It uses the first available provider until its monthly limit is exhausted, then moves to next.
  const q = [];

  if (process.env.SERPAPI_KEY_1) q.push(["serpapi_1", img => serpapiLens(img, process.env.SERPAPI_KEY_1)]);
  if (process.env.SERPAPI_KEY_2) q.push(["serpapi_2", img => serpapiLens(img, process.env.SERPAPI_KEY_2)]);
  if (process.env.SEARCHAPI_KEY) q.push(["searchapi", searchapiLens]);
  if (process.env.HASDATA_API_KEY || process.env.HASDATA_LENS_ENDPOINT) q.push(["hasdata", img => genericLens(img, "hasdata")]);
  if (process.env.SCRAPINGDOG_API_KEY) q.push(["scrapingdog", scrapingdogLens]);
  if (process.env.DECODO_AUTH_BASE64) q.push(["decodo", decodoLens]);
  if (process.env.APIFY_API_KEY || process.env.APIFY_LENS_ENDPOINT) q.push(["apify", img => genericLens(img, "apify")]);
  if (process.env.OPENWEBNINJA_API_KEY || process.env.OPENWEBNINJA_LENS_ENDPOINT) q.push(["openwebninja", img => genericLens(img, "openwebninja")]);
  if (process.env.ZENSERP_API_KEY || process.env.ZENSERP_LENS_ENDPOINT) q.push(["zenserp", img => genericLens(img, "zenserp")]);

  return q;
}

function currentProvider() {
  return providerQueue().find(([name]) => canUse(name)) || null;
}

async function findOneAmazonByLens(imageUrl) {
  const provider = currentProvider();

  if (!provider) {
    return {
      exhausted: true,
      provider: null,
      link: null
    };
  }

  const [name, call] = provider;

  try {
    console.log(`Lens provider: ${name} (${used(name) + 1}/${BUDGETS[name]})`);
    const links = await call(imageUrl);
    markUsed(name);
    await sleep(DELAY_MS);

    const amazon = links.filter(x => isAmazonUrl(x.url));
    return {
      exhausted: false,
      provider: name,
      link: amazon[0] || null
    };
  } catch (err) {
    // Count API errors as usage because many APIs bill attempts.
    markUsed(name);
    console.log(`${name} failed for this product: ${err.message}`);
    await sleep(DELAY_MS);
    return {
      exhausted: false,
      provider: name,
      link: null,
      error: err.message
    };
  }
}

function randomViewport() {
  const widths = [1280, 1365, 1440, 1536];
  const heights = [720, 768, 800, 864, 900];
  return {
    width: widths[Math.floor(Math.random() * widths.length)],
    height: heights[Math.floor(Math.random() * heights.length)]
  };
}

async function setupAmazonPage(page) {
  await page.setViewport(randomViewport());
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  await page.setRequestInterception(true);
  page.on("request", req => {
    const type = req.resourceType();
    if (["media", "font"].includes(type)) return req.abort();
    return req.continue();
  });
}

async function safeText(page, selector) {
  try {
    return await page.$eval(selector, el => (el.innerText || el.textContent || "").trim());
  } catch {
    return "";
  }
}

async function bodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || "");
  } catch {
    return "";
  }
}

async function checkAmazonBlocked(page) {
  const text = await bodyText(page);
  if (/captcha|enter the characters you see below|sorry, we just need to make sure|verify you are human/i.test(text)) {
    throw new Error("Amazon CAPTCHA/bot check detected");
  }
}

async function humanPause(page) {
  try {
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 2200));
    await page.mouse.move(
      200 + Math.floor(Math.random() * 700),
      150 + Math.floor(Math.random() * 450),
      { steps: 8 + Math.floor(Math.random() * 10) }
    );
    await page.evaluate(() => window.scrollBy(0, Math.floor(150 + Math.random() * 500)));
    await page.waitForTimeout(800 + Math.floor(Math.random() * 1600));
  } catch {}
}

async function scrapeAmazonWithPuppeteer(browser, amazonUrl, cjName) {
  const page = await browser.newPage();
  await setupAmazonPage(page);

  try {
    await page.goto(amazonUrl, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.waitForTimeout(AMAZON_DELAY_MS + Math.floor(Math.random() * 2500));
    await checkAmazonBlocked(page);
    await humanPause(page);

    const title =
      await safeText(page, "#productTitle") ||
      await safeText(page, "h1");

    const ratingText =
      await safeText(page, "#acrPopover span.a-icon-alt") ||
      await safeText(page, "span.a-icon-alt") ||
      await safeText(page, "[data-hook='rating-out-of-text']");

    const ratingMatch = ratingText.match(/(\d+(\.\d+)?)/);
    const rating = ratingMatch ? Number(ratingMatch[1]) : 0;

    const reviewsText =
      await safeText(page, "#acrCustomerReviewText") ||
      await safeText(page, "[data-hook='total-review-count']") ||
      await safeText(page, "a[href*='customerReviews'] span");

    const ratingsTotal = normalizeReviewCount(reviewsText);

    const badgeText =
      await safeText(page, "#zeitgeistBadge_feature_div") ||
      await safeText(page, ".ac-badge-text-primary") ||
      await safeText(page, ".badge-wrapper") ||
      await safeText(page, "span:has-text('Best Seller')");

    const isBestSeller = /best seller|amazon'?s choice/i.test(badgeText);
    const matchScore = titleSimilarity(cjName, title);
    const score = demandScore({ rating, ratingsTotal, isBestSeller, matchScore });

    return {
      title,
      url: cleanAmazonUrl(amazonUrl),
      rating: rating || "",
      ratingsTotal: ratingsTotal || 0,
      isBestSeller,
      badgeText,
      matchScore,
      score,
      source: "lens-provider-amazon-puppeteer",
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function alreadyHasAmazon(product) {
  const pid = String(product.id || "");
  const name = productName(product).toLowerCase();

  return existingAmazon.some(a => {
    const aid = String(a.productId || "");
    const aname = String(a.productName || "").toLowerCase();
    return (pid && aid && pid === aid) || (name && aname && name === aname);
  });
}

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-setuid-sandbox"
  ]
});

const matches = [];
const failures = [];
const amazonSignals = [...existingAmazon];
const endIndex = Math.min(products.length, START_INDEX + MAX_PRODUCTS);

for (let i = START_INDEX; i < endIndex; i++) {
  const p = products[i];
  const name = productName(p);
  const image = productImage(p);

  if (!name || !image) {
    failures.push({ index: i, name, reason: "missing product name or image" });
    continue;
  }

  if (alreadyHasAmazon(p)) {
    console.log(`Skip existing Amazon data: ${name}`);
    continue;
  }

  try {
    const provider = currentProvider();
    if (!provider) {
      console.log("All monthly provider limits exhausted. Stopping Lens enrichment.");
      break;
    }

    console.log(`Monthly Lens ${i + 1}/${products.length}: ${name}`);

    const found = await findOneAmazonByLens(image);

    if (found.exhausted) {
      console.log("All monthly provider limits exhausted. Stopping Lens enrichment.");
      break;
    }

    if (!found.link) {
      failures.push({
        index: i,
        name,
        image,
        provider: found.provider,
        reason: found.error || "no amazon link from current provider"
      });
      continue;
    }

    let data = null;

    try {
      data = await scrapeAmazonWithPuppeteer(browser, found.link.url, name);
    } catch (err) {
      failures.push({
        index: i,
        name,
        image,
        provider: found.provider,
        amazonUrl: found.link.url,
        reason: `amazon puppeteer failed: ${err.message}`
      });
      continue;
    }

    if (!data.title || !data.rating || !data.ratingsTotal) {
      failures.push({
        index: i,
        name,
        image,
        provider: found.provider,
        amazonUrl: found.link.url,
        reason: "amazon page missing title/rating/review data"
      });
      continue;
    }

    if (data.matchScore < MIN_TITLE_MATCH) {
      failures.push({
        index: i,
        name,
        image,
        provider: found.provider,
        amazonUrl: found.link.url,
        reason: `weak amazon title match: ${data.matchScore}`
      });
      continue;
    }

    const signal = {
      productId: p.id,
      keyword: p.id || name,
      productName: name,
      image,
      title: data.title,
      asin: "",
      score: data.score,
      bestRating: data.rating,
      bestRatingsTotal: data.ratingsTotal,
      bestPrice: "",
      position: 1,
      isBestSeller: data.isBestSeller,
      badgeText: data.badgeText,
      productUrl: data.url,
      matchScore: data.matchScore,
      matchType: "image",
      lensProvider: found.provider,
      source: data.source,
      fetchedAt: data.fetchedAt
    };

    amazonSignals.push(signal);
    matches.push({
      productId: p.id,
      productName: name,
      productImage: image,
      provider: found.provider,
      amazon: data
    });

    console.log(`Matched via ${found.provider}: ${name} -> ${data.title} | rating ${data.rating} | reviews ${data.ratingsTotal} | score ${data.score}`);

    if (matches.length % 10 === 0) {
      writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
      writeJson("lens-amazon-matches.json", matches);
      writeJson("lens-amazon-failures.json", failures);
      writeJson(USAGE_PATH, usage);
    }

    await sleep(AMAZON_DELAY_MS + Math.floor(Math.random() * 2000));
  } catch (err) {
    console.log(`Monthly Lens failed for ${name}: ${err.message}`);
    failures.push({ index: i, name, image, reason: err.message });
  }
}

await browser.close().catch(() => {});

writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
writeJson("lens-amazon-matches.json", matches);
writeJson("lens-amazon-failures.json", failures);
writeJson(USAGE_PATH, usage);
writeJson("lens-amazon-meta.json", {
  updatedAt: new Date().toISOString(),
  month,
  mode: "sequential quota provider pool + one amazon result per product",
  startIndex: START_INDEX,
  maxProducts: MAX_PRODUCTS,
  providerUsage: usage[month],
  providerBudgets: BUDGETS,
  matches: matches.length,
  failures: failures.length,
  note: "Uses one provider until its limit is reached, then moves to the next. One Lens request and one Amazon result per product."
});

console.log(`Monthly Lens complete. Matches: ${matches.length}, failures: ${failures.length}`);
console.log("Provider usage:", usage[month]);
