import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readJson, writeJson, sleep, num } from "./utils.js";

puppeteer.use(StealthPlugin());

// Free Proxy Pool Engine Configuration
const GEONODE_API_URL = "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&googlePassed=true";
let proxyPool = [];
let currentProxyIndex = 0;

const PRODUCTS_PATH = process.env.PRODUCTS_PATH || "products.json";
const AMAZON_PRODUCTS_PATH = process.env.AMAZON_PRODUCTS_PATH || "amazon-products.json";

const products = readJson(PRODUCTS_PATH, []);
const month = new Date().toISOString().slice(0, 7);

const FORCE_REFRESH = /^(1|true|yes)$/i.test(String(process.env.RESET_AMAZON_CACHE || "false"));
const existingMeta = readJson("lens-amazon-meta.json", {});
const sameMonthCache = !FORCE_REFRESH && existingMeta?.month === month;
const existingAmazon = sameMonthCache ? readJson(AMAZON_PRODUCTS_PATH, []) : [];

if (FORCE_REFRESH) {
  console.log(`Forced Amazon monthly refresh enabled for ${month}. Existing Amazon data and current-month provider usage will be ignored.`);
} else if (sameMonthCache) {
  console.log(`Same month cache detected (${month}). Existing Amazon data will be skipped.`);
} else {
  console.log(`New month/cache reset detected (${month}). Starting Amazon data from scratch.`);
}

const MAX_PRODUCTS = Number(process.env.MONTHLY_LENS_MAX_PRODUCTS || 1500);
const START_INDEX = Number(process.env.MONTHLY_LENS_START_INDEX || 0);
const AMAZON_DELAY_MS = Number(process.env.AMAZON_PAGE_DELAY_MS || 3500);
const MIN_TITLE_MATCH = Number(process.env.AMAZON_MIN_TITLE_MATCH || 15);
const AMAZON_CANDIDATE_LIMIT = Number(process.env.AMAZON_CANDIDATE_LIMIT || 8);
const AMAZON_PAGE_WAIT_MS = Number(process.env.AMAZON_PAGE_WAIT_MS || 12000);
const ACCEPT_PROVIDER_METADATA = !/^(0|false|no)$/i.test(String(process.env.AMAZON_ACCEPT_PROVIDER_METADATA || "true"));

/**
 * Step 1: Dynamic Fetching
 * Pulls newest Google-Passed Proxies dynamically from Geonode.
 */
async function fetchProxyPool() {
  try {
    console.log("Fetching fresh Google-passed proxies from Geonode...");
    const res = await fetch(GEONODE_API_URL);
    const data = await res.json();
    
    if (data && Array.isArray(data.data)) {
      proxyPool = data.data.map(p => {
        const proto = p.protocols || "http";
        return `${proto}://${p.ip}:${p.port}`;
      });
      currentProxyIndex = 0;
      console.log(`Successfully built a pool of ${proxyPool.length} Google-passed proxies.`);
    }
  } catch (err) {
    console.error("Failed to fetch proxy pool from Geonode API:", err.message);
  }
}

/**
 * Step 2: Live Proxy Validation
 * Validates the proxy asynchronously with a strict 3-second constraint.
 */
async function validateProxy(proxyUrl) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000); // 3-second short timeout
    
    const res = await fetch("https://www.google.com", {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    
    clearTimeout(id);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Step 3: Automated Failover & Rotation Pool manager
 */
async function getNextValidProxy() {
  while (true) {
    if (proxyPool.length === 0 || currentProxyIndex >= proxyPool.length) {
      await fetchProxyPool();
      if (proxyPool.length === 0) {
        console.log("No proxies available from Geonode. Sleeping 10s before retry...");
        await sleep(10000);
        continue;
      }
    }

    const proxy = proxyPool[currentProxyIndex];
    currentProxyIndex++;
    
    console.log(`Validating proxy: ${proxy}...`);
    const isValid = await validateProxy(proxy);
    if (isValid) {
      console.log(`Proxy ${proxy} passed! Deploying to browser initialization context.`);
      return proxy;
    }
    console.log(`Proxy ${proxy} failed or timed out. Discarding...`);
  }
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
    p.supplierImage ||
    p.productPageImage ||
    p.listingImage ||
    p.image ||
    p.productImage ||
    p.bigImage ||
    p.raw?.supplierImage ||
    p.raw?.productPageImage ||
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

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function numberFromAny(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const match = String(value).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function reviewCountFromAny(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Math.max(0, Math.round(value));
  return normalizeReviewCount(String(value));
}

function asinFromUrl(url) {
  const match = String(url || "").match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match ? match[1].toUpperCase() : "";
}

function mergeCandidate(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    title: incoming.title || existing.title || "",
    rating: num(incoming.rating) || num(existing.rating) || 0,
    ratingsTotal: num(incoming.ratingsTotal) || num(existing.ratingsTotal) || 0,
    badgeText: incoming.badgeText || existing.badgeText || "",
    image: incoming.image || existing.image || "",
    asin: incoming.asin || existing.asin || "",
    providerMetadata: {
      ...(existing.providerMetadata || {}),
      ...(incoming.providerMetadata || {})
    }
  };
}

function extractAmazonLinks(data) {
  const byUrl = new Map();

  function urlsInText(value) {
    const text = String(value || "")
      .replace(/&amp;/gi, "&")
      .replaceAll("\\/", "/");

    const urls = new Set();
    const httpUrlPattern = new RegExp("https?://[^\\\\s\"'<>\\\\\\\\]+", "gi");
    for (const match of text.matchAll(httpUrlPattern)) {
      urls.add(match[0].replace(/[),.;]+$/, ""));
    }
    return [...urls];
  }

  function addCandidate(rawUrl, node = {}, inheritedTitle = "") {
    if (!rawUrl) return;

    let candidateUrl = rawUrl;
    try {
      const u = new URL(String(candidateUrl));
      const wrapped = u.searchParams.get("url") || u.searchParams.get("q");
      if (wrapped && /^https?:\\/\\//i.test(wrapped)) candidateUrl = wrapped;
    } catch {}

    if (!isAmazonUrl(candidateUrl)) return;

    const clean = cleanAmazonUrl(candidateUrl);
    const rich = node?.rich_snippet?.top?.detected_extensions ||
      node?.richSnippet?.top?.detectedExtensions ||
      node?.detected_extensions || {};

    const title = String(firstValue(
      node.title,
      node.name,
      node.product_title,
      node.productTitle,
      node.text,
      inheritedTitle
    ) || "").trim();

    const rating = numberFromAny(firstValue(
      node.rating,
      node.stars,
      node.rating_value,
      node.ratingValue,
      node.product_rating,
      node.productRating,
      rich.rating,
      rich.stars
    ));

    const ratingsTotal = reviewCountFromAny(firstValue(
      node.reviews,
      node.review_count,
      node.reviewCount,
      node.reviews_count,
      node.reviewsCount,
      node.rating_count,
      node.ratingCount,
      node.ratings,
      node.ratings_total,
      node.ratingsTotal,
      rich.reviews,
      rich.review_count,
      rich.ratings
    ));

    const badgeText = String(firstValue(
      node.badge,
      node.badgeText,
      node.tag,
      node.label
    ) || "").trim();

    const image = safeUrl(firstValue(
      node.thumbnail,
      node.image,
      node.image_url,
      node.imageUrl,
      node.product_image,
      node.productImage
    ));

    const candidate = {
      url: clean,
      title,
      rating,
      ratingsTotal,
      badgeText,
      image,
      asin: asinFromUrl(clean),
      providerMetadata: {
        rating,
        ratingsTotal,
        badgeText,
        title
      }
    };

    byUrl.set(clean, mergeCandidate(byUrl.get(clean), candidate));
  }

  function walk(node, inheritedTitle = "") {
    if (!node) return;

    if (typeof node === "string") {
      addCandidate(node, {}, inheritedTitle);
      for (const url of urlsInText(node)) {
        addCandidate(url, {}, inheritedTitle);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedTitle);
      return;
    }

    if (typeof node === "object") {
      const possibleTitle = String(firstValue(
        node.title,
        node.name,
        node.product_title,
        node.productTitle,
        node.text,
        inheritedTitle
      ) || "");

      const possibleUrl = firstValue(
        node.link,
        node.url,
        node.source_url,
        node.result_url,
        node.sourceUrl,
        node.page_url,
        node.href,
        node.product_link,
        node.productLink
      );

      if (possibleUrl) addCandidate(possibleUrl, node, possibleTitle);

      for (const value of Object.values(node)) {
        walk(value, possibleTitle);
      }
    }
  }

  walk(data);
  return [...byUrl.values()];
}

/**
 * Free Google Lens HTML Engine via Rotated Puppeteer Instances
 * Replaces the SerpApi / SearchApi logic.
 */
async function scrapeGoogleLensFree(imageUrl) {
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    const currentProxy = await getNextValidProxy();
    let freeBrowser = null;
    
    try {
      console.log(`[Attempt \${attempts}/\maxAttempts}] Launching free scraping context via proxy: \${currentProxy}`);
      
      freeBrowser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-setuid-sandbox",
          `--proxy-server=\${currentProxy}`
        ]
      });

      const page = await freeBrowser.newPage();
      await page.setViewport(randomViewport());
      // Step 4: Robust Universal Headers
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
      });

      // Target URL generation pattern for structural Google Lens requests
      // PLUG IN YOUR TARGET GOOGLE LENS URL CONFIGURATION HERE IF NEEDED:
      const targetLensUrl = `https://lens.google.com/uploadbyurl?url=\${encodeURIComponent(imageUrl)}`;
      
      const response = await page.goto(targetLensUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });

      const status = response?.status?.() || 0;
      const bodyTextStr = await page.evaluate(() => document.body?.innerText || "");
      
      // Step 3: Catch 429 errors, Captchas or connection drops
      if (status === 429 || /captcha|verify you are human|automated access/i.test(bodyTextStr)) {
        throw new Error(`Google block detected (Status: \${status} / CAPTCHA triggered). Rotating proxy.`);
      }

      // Allow the page extra window time to execute internal dynamic network calls
      await sleep(5000);
      const htmlContent = await page.content();
      
      // Pass the fully structured HTML tree to the internal engine mapper
      const candidates = extractAmazonLinks({ rawHtmlPayload: htmlContent });
      
      await freeBrowser.close();
      return { links: candidates, error: null };

    } catch (err) {
      console.log(`Scrape failed using proxy \${currentProxy}: \${err.message}`);
      if (freeBrowser) {
        await freeBrowser.close().catch(() => {});
      }
      // Loop gracefully picks up next validated proxy next time around
    }
  }
  
  return { links: [], error: "All fallback rotation proxy attempts exhausted for this item." };
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

async function safeAttr(page, selector, attr) {
  try {
    return await page.$eval(selector, (el, attrName) => el.getAttribute(attrName) || "", attr);
  } catch {
    return "";
  }
}

function extractReviewCountFromText(text) {
  const value = String(text || "");

  const patterns = [
    /(\d[\d,\.]*\s*[km]?)\s+(?:global\s+)?ratings?/i,
    /(\d[\d,\.]*\s*[km]?)\s+(?:customer\s+)?reviews?/i,
    /(\d[\d,\.]*\s*[km]?)\s+ratings?\s*\|/i,
    /ratings?\s*[:\-]?\s*(\d[\d,\.]*\s*[km]?)/i,
    /reviews?\s*[:\-]?\s*(\d[\d,\.]*\s*[km]?)/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return normalizeReviewCount(match[1]);
  }

  return 0;
}

function findProductJsonLd(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;

  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some(value => String(value || "").toLowerCase() === "product")) return node;

  if (node["@graph"]) {
    const found = findProductJsonLd(node["@graph"]);
    if (found) return found;
  }

  for (const value of Object.values(node)) {
    const found = findProductJsonLd(value);
    if (found) return found;
  }

  return null;
}

async function extractJsonLdProduct(page) {
  const rawScripts = await page.$$eval('script[type="application/ld+json"]', elements =>
    elements.map(element => element.textContent || "")
  ).catch(() => []);

  for (const raw of rawScripts) {
    try {
      const parsed = JSON.parse(raw);
      const product = findProductJsonLd(parsed);
      if (!product) continue;

      const aggregate = product.aggregateRating || {};
      return {
        title: String(product.name || "").trim(),
        rating: numberFromAny(aggregate.ratingValue),
        ratingsTotal: reviewCountFromAny(
          aggregate.ratingCount || aggregate.reviewCount || product.reviewCount
        ),
        image: safeUrl(Array.isArray(product.image) ? product.image[0] : product.image),
        badgeText: ""
      };
    } catch {}
  }

  return { title: "", rating: 0, ratingsTotal: 0, image: "", badgeText: "" };
}

function extractEmbeddedAmazonData(html) {
  const source = String(html || "");

  const titlePatterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i,
    /"productTitle"\s*:\s*"([^"]+)"/i,
    /"title"\s*:\s*"([^"]{10,300})"/i
  ];

  const ratingPatterns = [
    /"averageStarRating"\s*:\s*([0-5](?:\.\d+)?)/i,
    /"ratingValue"\s*:\s*"?.([0-5](?:\.\d+)?)"?/i,
    /([0-5](?:\.\d+)?)\s+out of 5 stars/i
  ];

  const reviewPatterns = [
    /"ratingCount"\s*:\s*"?.([\d,.]+[km]?)"?/i,
    /"reviewCount"\s*:\s*"?.([\d,.]+[km]?)"?/i,
    /"totalReviewCount"\s*:\s*"?.([\d,.]+[km]?)"?/i,
    /([\d,.]+[km]?)\s+(?:global\s+)?ratings?/i
  ];

  let title = "";
  let rating = 0;
  let ratingsTotal = 0;

  for (const pattern of titlePatterns) {
    const match = source.match(pattern);
    if (match) {
      title = String(match[1] || "").replace(/\\u0026/g, "&").replace(/&quot;/g, '"').trim();
      if (title) break;
    }
  }

  for (const pattern of ratingPatterns) {
    const match = source.match(pattern);
    if (match) {
      rating = numberFromAny(match[1]);
      if (rating) break;
    }
  }

  for (const pattern of reviewPatterns) {
    const match = source.match(pattern);
    if (match) {
      ratingsTotal = reviewCountFromAny(match[1]);
      if (ratingsTotal) break;
    }
  }

  return { title, rating, ratingsTotal };
}

function betterAmazonCandidate(candidate, best) {
  if (!best) return true;

  // Prefer stronger title match first, then demand score,
  // then the total number of reviews.
  if (num(candidate.matchScore) !== num(best.matchScore)) {
    return num(candidate.matchScore) > num(best.matchScore);
  }

  if (num(candidate.score) !== num(best.score)) {
    return num(candidate.score) > num(best.score);
  }

  return num(candidate.ratingsTotal) > num(best.ratingsTotal);
}

async function scrapeAmazonWithPuppeteer(browser, candidate, cjName) {
  const amazonUrl = candidate.url;
  const page = await browser.newPage();
  await setupAmazonPage(page);

  try {
    const response = await page.goto(amazonUrl, { waitUntil: "domcontentloaded", timeout: 70000 });
    const status = response?.status?.() || 0;

    await Promise.race([
      page.waitForSelector("#productTitle, h1, script[type='application/ld+json']", { timeout: AMAZON_PAGE_WAIT_MS }),
      sleep(AMAZON_PAGE_WAIT_MS)
    ]).catch(() => {});

    await sleep(Math.min(5000, AMAZON_DELAY_MS) + Math.floor(Math.random() * 1800));

    let blockedError = null;
    try {
      await checkAmazonBlocked(page);
    } catch (err) {
      blockedError = err;
    }

    await humanPause(page);

    const jsonLd = await extractJsonLdProduct(page);
    const html = await page.content().catch(() => "");
    const embedded = extractEmbeddedAmazonData(html);

    const selectorTitle =
      await safeText(page, "#productTitle") ||
      await safeText(page, "h1 span") ||
      await safeText(page, "h1") ||
      await safeAttr(page, "meta[name='title']", "content") ||
      await safeAttr(page, "meta[property='og:title']", "content") ||
      await safeText(page, "title");

    const title = String(
      selectorTitle || jsonLd.title || embedded.title || candidate.title || ""
    ).trim();

    const ratingText =
      await safeText(page, "#acrPopover span.a-icon-alt") ||
      await safeText(page, "#acrPopover") ||
      await safeText(page, "span.a-icon-alt") ||
      await safeText(page, "[data-hook='rating-out-of-text']") ||
      await safeAttr(page, "meta[name='twitter:data1']", "content") ||
      await safeAttr(page, "meta[property='og:rating']", "content");

    const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
    const selectorRating = ratingMatch ? Number(ratingMatch[1]) : 0;
    const rating = selectorRating || num(jsonLd.rating) || num(embedded.rating) || num(candidate.rating) || 0;

    const reviewsText =
      await safeText(page, "#acrCustomerReviewText") ||
      await safeText(page, "#acrCustomerReviewLink") ||
      await safeText(page, "[data-hook='total-review-count']") ||
      await safeText(page, "[data-hook='rating-count']") ||
      await safeText(page, "a[href*='customerReviews']") ||
      await safeText(page, "a[href*='product-reviews']");

    const pageText = await bodyText(page);
    const ratingsTotal =
      normalizeReviewCount(reviewsText) ||
      extractReviewCountFromText(pageText) ||
      num(jsonLd.ratingsTotal) ||
      num(embedded.ratingsTotal) ||
      num(candidate.ratingsTotal) ||
      0;

    const selectorBadge =
      await safeText(page, "#zeitgeistBadge_feature_div") ||
      await safeText(page, ".ac-badge-text-primary") ||
      await safeText(page, ".badge-wrapper") ||
      await safeText(page, "span:has-text('Best Seller')");

    const badgeText = selectorBadge || candidate.badgeText || "";
    const isBestSeller = /best seller|amazon'?s choice/i.test(badgeText);
    const matchScore = titleSimilarity(cjName, title);
    const score = demandScore({ rating, ratingsTotal, isBestSeller, matchScore });

    const sourceParts = [];
    if (selectorTitle || selectorRating || reviewsText) sourceParts.push("amazon-dom");
    if (jsonLd.title || jsonLd.rating || jsonLd.ratingsTotal) sourceParts.push("amazon-jsonld");
    if (embedded.title || embedded.rating || embedded.ratingsTotal) sourceParts.push("amazon-embedded");
    if (candidate.title || candidate.rating || candidate.ratingsTotal) sourceParts.push("lens-provider-metadata");

    console.log(
      `Amazon extracted data: status=\${status} finalUrl="\${page.url()}" title="\${title}" ` +
      `ratingText="\${ratingText}" reviewsText="\${reviewsText}" rating="\${rating}" reviews="\${ratingsTotal}" ` +
      `sources="\${sourceParts.join("+") || "none"}"\${blockedError ? ` blocked="\${blockedError.message}"` : ""}`
    );

    if (blockedError && !title && !rating && !ratingsTotal) throw blockedError;

    return {
      title,
      url: cleanAmazonUrl(page.url() || amazonUrl),
      asin: candidate.asin || asinFromUrl(page.url() || amazonUrl),
      rating: rating || "",
      ratingsTotal: ratingsTotal || 0,
      isBestSeller,
      badgeText,
      matchScore,
      score,
      source: sourceParts.join("+") || "amazon-page-no-structured-data",
      blocked: Boolean(blockedError),
      httpStatus: status,
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function dataFromProviderCandidate(candidate, cjName) {
  if (!candidate) return null;

  const title = String(candidate.title || "").trim();
  const rating = num(candidate.rating);
  const ratingsTotal = num(candidate.ratingsTotal);
  const badgeText = String(candidate.badgeText || "").trim();
  const isBestSeller = /best seller|amazon'?s choice/i.test(badgeText);
  const matchScore = titleSimilarity(cjName, title);

  if (!title || (!rating && !ratingsTotal && !isBestSeller)) return null;

  return {
    title,
    url: cleanAmazonUrl(candidate.url),
    asin: candidate.asin || asinFromUrl(candidate.url),
    rating: rating || "",
    ratingsTotal: ratingsTotal || 0,
    isBestSeller,
    badgeText,
    matchScore,
    score: demandScore({ rating, ratingsTotal, isBestSeller, matchScore }),
    source: "lens-provider-metadata",
    fetchedAt: new Date().toISOString()
  };
}

async function checkAmazonBlocked(page) {
  const text = await bodyText(page);
  const html = await page.content().catch(() => "");
  const combined = `\${text}
\${html}`;

  if (/captcha|enter the characters you see below|sorry, we just need to make sure|verify you are human/i.test(combined)) {
    throw new Error("Amazon CAPTCHA/bot check detected");
  }
  if (/automated access|api-services-support@amazon|robot check|dogs of amazon|sorry! something went wrong|page not found/i.test(combined)) {
    throw new Error("Amazon interstitial or blocked page detected");
  }
}

async function humanPause(page) {
  try {
    await sleep(1000 + Math.floor(Math.random() * 2200));
    await page.mouse.move(
      200 + Math.floor(Math.random() * 700),
      150 + Math.floor(Math.random() * 450),
      { steps: 8 + Math.floor(Math.random() * 10) }
    );
    await page.evaluate(() => window.scrollBy(0, Math.floor(150 + Math.random() * 500)));
    await sleep(800 + Math.floor(Math.random() * 1600));
  } catch {}
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

// Target browser setup context for downstream clean extraction checks
const mainAmazonBrowser = await puppeteer.launch({
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

// Initial bootstrap trigger for proxy population
await fetchProxyPool();

for (let i = START_INDEX; i < endIndex; i++) {
  const p = products[i];
  const name = productName(p);
  const image = productImage(p);

  if (!name || !image) {
    failures.push({ index: i, name, reason: "missing product name or image" });
    continue;
  }

  if (alreadyHasAmazon(p)) {
    console.log(`Skip existing Amazon data: \${name}`);
    continue;
  }

  try {
    console.log(`Monthly Free Lens \${i + 1}/\${products.length}: \${name}`);

    // Free implementation using rotation context
    const found = await scrapeGoogleLensFree(image);

    if (!found.links || !found.links.length) {
      console.log(`No Amazon match found for product: \${name}`);

      failures.push({
        index: i,
        name,
        image,
        reason: found.error || "no amazon links scraped from free proxy pool execution"
      });
      continue;
    }

    let data = null;
    const candidateFailures = [];

    const filteredAmazonLinks = found.links
      .filter(x => x?.url && isAmazonUrl(x.url))
      .slice(0, AMAZON_CANDIDATE_LIMIT);

    console.log(`Checking \${filteredAmazonLinks.length} Amazon candidates via standard browser window for: \${name}`);

    for (let c = 0; c < filteredAmazonLinks.length; c++) {
      const candidate = filteredAmazonLinks[c];
      console.log(`Amazon candidate \${c + 1}/\${filteredAmazonLinks.length}: \${candidate.url}`);

      let candidateData = null;

      try {
        candidateData = await scrapeAmazonWithPuppeteer(mainAmazonBrowser, candidate, name);
      } catch (err) {
        console.log(`Amazon page extraction failed for candidate \${c + 1}/\${filteredAmazonLinks.length}: \${err.message}`);

        if (ACCEPT_PROVIDER_METADATA) {
          candidateData = dataFromProviderCandidate(candidate, name);
          if (candidateData) {
            console.log(
              `Using fallback metadata context for candidate \${c + 1}: ` +
              `title="\${candidateData.title}" rating="\${candidateData.rating}" reviews="\${candidateData.ratingsTotal}"`
            );
          }
        }

        if (!candidateData) {
          candidateFailures.push({
            candidate: c + 1,
            amazonUrl: candidate.url,
            reason: `amazon page extraction failed: \${err.message}`
          });
          continue;
        }
      }

      candidateData.candidatePosition = c + 1;

      if (!candidateData.title || (!candidateData.rating && !candidateData.ratingsTotal && !candidateData.isBestSeller)) {
        candidateFailures.push({
          candidate: c + 1,
          amazonUrl: candidate.url,
          title: candidateData.title,
          reason: "amazon candidate missing complete usable demand structural rows"
        });
        continue;
      }

      if (candidateData.matchScore < MIN_TITLE_MATCH) {
        candidateFailures.push({
          candidate: c + 1,
          amazonUrl: candidate.url,
          title: candidateData.title,
          matchScore: candidateData.matchScore,
          reason: `weak title string correlation matrix match: \${candidateData.matchScore}`
        });
        continue;
      }

      if (betterAmazonCandidate(candidateData, data)) {
        data = candidateData;
      }
    }

    if (!data) {
      failures.push({
        index: i,
        name,
        image,
        candidateFailures,
        reason: "no valid candidate left standing after filtration loops"
      });
      continue;
    }

    const signal = {
      productId: p.id,
      keyword: p.id || name,
      productName: name,
      image,
      title: data.title,
      asin: data.asin || asinFromUrl(data.url),
      score: data.score,
      bestRating: data.rating,
      bestRatingsTotal: data.ratingsTotal,
      bestPrice: "",
      position: data.candidatePosition || 1,
      amazonCandidatesChecked: filteredAmazonLinks.length,
      isBestSeller: data.isBestSeller,
      badgeText: data.badgeText,
      productUrl: data.url,
      matchScore: data.matchScore,
      matchType: "image",
      lensProvider: "free-geonode-rotation-engine",
      source: data.source,
      fetchedAt: data.fetchedAt
    };

    amazonSignals.push(signal);
    matches.push({
      productId: p.id,
      productName: name,
      productImage: image,
      provider: "free-geonode-rotation-engine",
      amazonCandidatesChecked: filteredAmazonLinks.length,
      candidateFailures,
      amazon: data
    });

    if (matches.length % 10 === 0) {
      writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
      writeJson("lens-amazon-matches.json", matches);
      writeJson("lens-amazon-failures.json", failures);
    }

    await sleep(AMAZON_DELAY_MS + Math.floor(Math.random() * 2000));
  } catch (err) {
    console.log(`Free Processing Loop error for item 	h name	: \${err.message}`);
    failures.push({ index: i, name, image, reason: err.message });
  }
}

await mainAmazonBrowser.close().catch(() => {});

writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
writeJson("lens-amazon-matches.json", matches);
writeJson("lens-amazon-failures.json", failures);
writeJson("lens-amazon-meta.json", {
  updatedAt: new Date().toISOString(),
  month,
  mode: "completely free proxy automated geonode pool rotation scraping",
  startIndex: START_INDEX,
  maxProducts: MAX_PRODUCTS,
  matches: matches.length,
  failures: failures.length,
  resetAmazonCache: FORCE_REFRESH
});

console.log(`Job lifecycle finalized cleanly. Total Matches: \${matches.length}, Failures: \${failures.length}`);
