import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readJson, writeJson, sleep, num } from "./utils.js";

puppeteer.use(StealthPlugin());

// Monthly sequential quota Lens provider + Puppeteer Amazon enrichment.
// Rule:
// - Use provider #1 until its monthly limit is reached.
// - Only then move to provider #2.
// - One Lens API request per product.
// - Get multiple Amazon candidate links from the Lens provider.
// - Scrape candidates with Puppeteer and choose the best valid match.
// - If no Amazon result/match for that product, move to next product.
// - Save whatever data is collected and continue.

const PRODUCTS_PATH = process.env.PRODUCTS_PATH || "products.json";
const AMAZON_PRODUCTS_PATH = process.env.AMAZON_PRODUCTS_PATH || "amazon-products.json";
const USAGE_PATH = process.env.LENS_USAGE_PATH || "lens-provider-usage.json";

const products = readJson(PRODUCTS_PATH, []);
const month = new Date().toISOString().slice(0, 7);

// Monthly cache behavior:
// - First run of a new month ignores old amazon-products.json and starts fresh.
// - Later runs in the same month reuse amazon-products.json and skip already fetched products.
// - Next month automatically starts fresh again.
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

const usage = readJson(USAGE_PATH, {});
if (FORCE_REFRESH || existingMeta?.month !== month) usage[month] = {};
usage[month] ||= {};

const MAX_PRODUCTS = Number(process.env.MONTHLY_LENS_MAX_PRODUCTS || 1500);
const START_INDEX = Number(process.env.MONTHLY_LENS_START_INDEX || 0);
const DELAY_MS = Number(process.env.MONTHLY_LENS_DELAY_MS || 1200);
const AMAZON_DELAY_MS = Number(process.env.AMAZON_PAGE_DELAY_MS || 3500);
const MIN_TITLE_MATCH = Number(process.env.AMAZON_MIN_TITLE_MATCH || 15);
const AMAZON_CANDIDATE_LIMIT = Number(process.env.AMAZON_CANDIDATE_LIMIT || 8);
const AMAZON_PAGE_WAIT_MS = Number(process.env.AMAZON_PAGE_WAIT_MS || 12000);
const ACCEPT_PROVIDER_METADATA = !/^(0|false|no)$/i.test(String(process.env.AMAZON_ACCEPT_PROVIDER_METADATA || "true"));

function getApifyTokens() {
  const tokenList = [];
  const addToken = (t) => {
    if (!t) return;
    const clean = String(t).trim();
    if (clean && !tokenList.includes(clean)) tokenList.push(clean);
  };

  if (process.env.APIFY_TOKEN) {
    for (const t of process.env.APIFY_TOKEN.split(/[\s,;\n]+/)) addToken(t);
  }
  if (process.env.APIFY_TOKENS) {
    for (const t of process.env.APIFY_TOKENS.split(/[\s,;\n]+/)) addToken(t);
  }
  for (let i = 1; i <= 20; i++) {
    addToken(process.env[`APIFY_TOKEN_${i}`]);
  }

  return tokenList;
}

const apifyTokens = getApifyTokens();
const exhaustedApifyTokens = new Set();
let currentApifyIndex = apifyTokens.length > 0 ? Math.floor(START_INDEX / 200) % apifyTokens.length : 0;

function getCurrentApifyToken() {
  if (!apifyTokens.length) return null;
  for (let step = 0; step < apifyTokens.length; step++) {
    const idx = (currentApifyIndex + step) % apifyTokens.length;
    const tok = apifyTokens[idx];
    if (!exhaustedApifyTokens.has(tok)) {
      currentApifyIndex = idx;
      return tok;
    }
  }
  return null;
}

function markApifyTokenExhausted(tok, reason = "") {
  if (!tok) return;
  exhaustedApifyTokens.add(tok);
  const display = tok.slice(0, 14) + "..." + tok.slice(-4);
  console.log(`Apify token [${display}] exhausted (${reason || "quota/credits/429"}). Exhausted ${exhaustedApifyTokens.size}/${apifyTokens.length} tokens.`);
  currentApifyIndex = (currentApifyIndex + 1) % Math.max(1, apifyTokens.length);
}

const APIFY_BATCH_SIZE = Math.max(1, Math.min(25, Number(process.env.APIFY_BATCH_SIZE || process.env.LENS_BATCH_SIZE || 1)));

if (apifyTokens.length > 0) {
  console.log(`Loaded ${apifyTokens.length} Apify token(s). Active initial index: ${currentApifyIndex}. Batch size: ${APIFY_BATCH_SIZE}.`);
}

const BUDGETS = {
  apify: Number(process.env.APIFY_MONTHLY_LIMIT || 5000),
  serpapi_1: Number(process.env.SERPAPI_1_MONTHLY_LIMIT || 250),
  serpapi_2: Number(process.env.SERPAPI_2_MONTHLY_LIMIT || 250),
  searchapi: Number(process.env.SEARCHAPI_MONTHLY_LIMIT || 100),
  scrapingdog: Number(process.env.SCRAPINGDOG_MONTHLY_LIMIT || 200),
  brightdata: Number(process.env.BRIGHTDATA_MONTHLY_LIMIT || 5000),
  decodo: Number(process.env.DECODO_MONTHLY_LIMIT || 700),
  decodo_2: Number(process.env.DECODO_2_MONTHLY_LIMIT || 700),
  decodo_3: Number(process.env.DECODO_3_MONTHLY_LIMIT || 700)
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

function asinFromUrl(url) {
  const match = String(url || "").match(
    /(?:\/(?:dp|gp\/product|product|d|gp\/aw\/d|o\/ASIN|ASIN)\/|[?&](?:asin|pd_rd_i)=)([A-Z0-9]{10})(?:[/?&#]|$)/i
  );
  return match ? match[1].toUpperCase() : "";
}

function isAmazonProductUrl(url) {
  if (!isAmazonUrl(url)) return false;
  const asin = asinFromUrl(url);
  if (asin) return true;
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (
      !p ||
      p === "/" ||
      p === "/s" ||
      p.startsWith("/stores") ||
      p.startsWith("/gp/bestsellers") ||
      p.startsWith("/gp/new-releases") ||
      p.startsWith("/gp/movers-and-shakers") ||
      p.startsWith("/gp/most-wished-for") ||
      p.startsWith("/gp/gift-ideas") ||
      p.startsWith("/gp/help") ||
      p.startsWith("/cart")
    ) {
      return false;
    }
    return p.includes("/dp/") || p.includes("/product/") || p.includes("/gp/product/") || p.includes("/gp/aw/d/");
  } catch {
    return false;
  }
}

function cleanAmazonUrl(url) {
  try {
    const asin = asinFromUrl(url);
    const u = new URL(url);
    if (asin) {
      return `${u.origin}/dp/${asin}`;
    }
    if (u.hostname.includes("amazon.")) {
      return `${u.origin}${u.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

function decodeBingParam(param) {
  if (!param) return "";
  let raw = String(param).trim();
  try { raw = decodeURIComponent(raw); } catch {}
  if (/^https?:\/\//i.test(raw)) return raw;

  const httpIdx = raw.indexOf("aHR0");
  if (httpIdx !== -1) {
    raw = raw.slice(httpIdx);
  } else if (/^a\d+/i.test(raw)) {
    raw = raw.replace(/^a\d+/i, "");
  }

  let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";

  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {}

  return "";
}

function unwrapUrl(rawUrl) {
  if (!rawUrl) return "";
  let url = String(rawUrl).trim();
  while (url.includes("&amp;")) url = url.replaceAll("&amp;", "&");

  url = url
    .replace(/&quot;?$/i, "")
    .replace(/&lt;?$/i, "")
    .replace(/&gt;?$/i, "")
    .replace(/['"\\<>{}\[\]]+$/g, "")
    .replace(/[),.;]+$/, "");

  if (url.startsWith("/ck/a") || url.startsWith("/aclick") || url.startsWith("/images/")) {
    url = "https://www.bing.com" + url;
  }

  try {
    const u = new URL(url, "https://www.bing.com");

    const uParam = u.searchParams.get("u") || u.searchParams.get("amp;u");
    if (uParam) {
      const decoded = decodeBingParam(uParam);
      if (decoded) return unwrapUrl(decoded);
    }

    for (const key of ["url", "q", "r", "dest", "destination", "target", "redir", "targetUrl", "landingPageUrl"]) {
      const val = u.searchParams.get(key) || u.searchParams.get("amp;" + key);
      if (val) {
        let unwrapped = val;
        try { unwrapped = decodeURIComponent(val); } catch {}
        if (/^https?:\/\//i.test(unwrapped)) return unwrapUrl(unwrapped);
        const b64Decoded = decodeBingParam(val);
        if (b64Decoded) return unwrapUrl(b64Decoded);
      }
    }
  } catch {}

  return url;
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
  const match = String(value).replace(/,/g, ".").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function reviewCountFromAny(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Math.max(0, Math.round(value));
  return normalizeReviewCount(String(value));
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

  // Decodo may return parsed result objects, but it can also place the rendered
  // Lens page in a text/HTML field. The original extractor treated each text
  // field as one URL, so it missed every Amazon link embedded inside HTML.
  function urlsInText(value) {
    const text = String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replaceAll("\\/", "/");

    const urls = new Set();

    // 1. Absolute HTTP(S) URLs
    const httpUrlPattern = /https?:\/\/[^\s"'<>\\]+/gi;
    for (const match of text.matchAll(httpUrlPattern)) {
      urls.add(match[0].replace(/&quot;?$/i, "").replace(/[),.;]+$/, ""));
    }

    // 2. Relative Bing redirect/tracking URLs: /ck/a?... or /aclick?...
    const relPattern = /(?:\/ck\/a|\/aclick)\?[^\s"'<>\\]+/gi;
    for (const match of text.matchAll(relPattern)) {
      urls.add("https://www.bing.com" + match[0].replace(/&quot;?$/i, "").replace(/[),.;]+$/, ""));
    }

    // 3. Embedded JSON url attributes
    const jsonUrlPattern = /"(?:purl|ourl|surl|targetUrl|targeturl|landingPageUrl|productUrl|seeMoreUrl|merchantUrl|destUrl)"\s*:\s*"([^"]+)"/gi;
    for (const match of text.matchAll(jsonUrlPattern)) {
      urls.add(match[1]);
    }

    // 4. Amazon direct product paths without protocol
    const directAmazonPattern = /(?:www\.)?amazon\.[a-z.]+\/(?:dp|gp\/product|product|d)\/[A-Z0-9]{10}[^\s"'<>\\]*/gi;
    for (const match of text.matchAll(directAmazonPattern)) {
      const raw = match[0];
      urls.add(raw.startsWith("http") ? raw : "https://" + raw);
    }

    return [...urls];
  }

  function addCandidate(rawUrl, node = {}, inheritedTitle = "") {
    if (!rawUrl) return;

    let candidateUrl = unwrapUrl(rawUrl);
    if (!candidateUrl) return;

    const isLensGoto = /^https?:\/\/lens\.google\.com\/goto/i.test(candidateUrl);
    const isAmazonSource = /amazon/i.test(String(node?.source || "")) || /amazon\./i.test(String(node?.display_link || ""));

    if (!isAmazonProductUrl(candidateUrl) && !(isLensGoto && isAmazonSource)) return;

    const clean = isLensGoto ? candidateUrl : cleanAmazonUrl(candidateUrl);
    const rich = node?.rich_snippet?.top?.detected_extensions ||
      node?.richSnippet?.top?.detectedExtensions ||
      node?.detected_extensions || {};

    const asin = asinFromUrl(clean) || asinFromUrl(candidateUrl) || (node?.asin && /^[A-Z0-9]{10}$/i.test(node.asin) ? node.asin.toUpperCase() : "");

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
      node.productImage,
      node.murl
    ));

    const candidate = {
      url: clean,
      title,
      rating,
      ratingsTotal,
      badgeText,
      image,
      asin,
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
      const trimmed = node.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          const parsed = JSON.parse(trimmed);
          walk(parsed, inheritedTitle);
          return;
        } catch {}
      }
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
        node.productLink,
        node.purl,
        node.ourl,
        node.targetUrl,
        node.targeturl,
        node.landingPageUrl,
        node.destinationUrl,
        node.seeMoreUrl,
        node.merchantUrl
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

async function decodoLensWithAuth(imageUrl, authBase64, label, attempt = 0) {
  if (!authBase64) throw new Error(`Missing ${label}`);

  const bingUrl = `https://www.bing.com/images/search?view=detailv2&iss=sbi&FORM=SBIHSC&q=imgurl:${encodeURIComponent(imageUrl)}`;

  const presets = [
    // 1. Desktop with JS rendering: renders Bing visual search product and shopping matches
    {
      target: "bing",
      url: bingUrl,
      headless: "html",
      device_type: "desktop",
      geo: process.env.DECODO_GEO || "United States"
    },
    // 2. Mobile with JS rendering: Mobile Bing visual search
    {
      target: "bing",
      url: bingUrl,
      headless: "html",
      device_type: "mobile",
      geo: process.env.DECODO_GEO || "United States"
    },
    // 3. Desktop non-JS: Fast initial HTML scrape of Bing visual search page
    {
      target: "bing",
      url: bingUrl,
      headless: null,
      device_type: "desktop",
      geo: process.env.DECODO_GEO || "United States"
    },
    // 4. Desktop auto geo: Automatic residential IP rotation
    {
      target: "bing",
      url: bingUrl,
      headless: "html",
      device_type: "desktop",
      geo: null
    }
  ];

  const currentConfig = presets[attempt % presets.length];

  const payload = {
    target: currentConfig.target,
    url: currentConfig.url,
    parse: false
  };
  if (currentConfig.headless) payload.headless = currentConfig.headless;
  if (currentConfig.device_type) payload.device_type = currentConfig.device_type;
  if (currentConfig.geo) payload.geo = currentConfig.geo;

  const response = await fetchJson("https://scraper-api.decodo.com/v2/scrape", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Basic ${authBase64}`
    },
    body: JSON.stringify(payload)
  });

  const isFailed = String(response?.status || "").toLowerCase() === "failed";
  const firstResult = Array.isArray(response?.results) ? response.results[0] : null;
  const resultStatusCode = firstResult?.status_code ? Number(firstResult.status_code) : 200;
  const contentLength = typeof firstResult?.content === "string" ? firstResult.content.length : 0;

  if (isFailed || resultStatusCode >= 400 || (contentLength < 500 && attempt < 2)) {
    const errCode = String(response?.status_code || firstResult?.status_code || (contentLength < 500 ? "empty_content" : ""));
    const errMsg = String(response?.message || firstResult?.content || firstResult?.message || "scraper error");

    if (attempt < 3 && (/613|retry|timeout|empty_content/i.test(errCode) || /scrape the target/i.test(errMsg))) {
      const nextConfig = presets[(attempt + 1) % presets.length];
      const backoffMs = 3000 + (attempt * 1500);
      console.log(`Decodo returned ${errCode}. Spreading request and retrying (attempt ${attempt + 2}/4) with device_type=${nextConfig.device_type}, headless=${nextConfig.headless || "none"}, geo=${nextConfig.geo || "auto"} after ${backoffMs}ms...`);
      await sleep(backoffMs);
      return decodoLensWithAuth(imageUrl, authBase64, label, attempt + 1);
    }

    if (isFailed || resultStatusCode >= 400) {
      throw new Error(
        "Decodo " + label + " failed (status " + errCode +
        "): " + errMsg
      );
    }
  }

  const links = extractAmazonLinks(response);
  if (!links.length) {
    const rootKeys = response && typeof response === "object" ? Object.keys(response).slice(0, 12) : [];
    const results = response?.results;
    const resultKeys = results && typeof results === "object" && !Array.isArray(results)
      ? Object.keys(results).slice(0, 12)
      : [];
    const status = String(response?.status ?? "");
    const statusCode = String(response?.status_code ?? "");
    const message = String(response?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const taskId = String(response?.task_id ?? "");
    const firstResult = Array.isArray(results) ? results[0] : null;
    const content = typeof firstResult?.content === "string" ? firstResult.content : "";
    const contentUrlCount = (content.match(/https?:\/\//gi) || []).length;
    console.log(
      "Decodo response detail: status=" + JSON.stringify(status) +
      ", statusCode=" + JSON.stringify(statusCode) +
      ", message=" + JSON.stringify(message) +
      ", taskId=" + JSON.stringify(taskId)
    );
    console.log(
      "Decodo result detail: firstResultKeys=[" +
      (firstResult && typeof firstResult === "object" ? Object.keys(firstResult).slice(0, 12).join(", ") : "") +
      "], contentChars=" + content.length +
      ", contentUrlCount=" + contentUrlCount +
      ", contentHasAmazon=" + /amazon\./i.test(content) +
      ", contentHasCaptcha=" + /captcha|unusual traffic|sorry/i.test(content)
    );
    console.log(
      `Decodo empty-result diagnostic: rootKeys=[${rootKeys.join(", ")}], resultsType=${Array.isArray(results) ? "array" : typeof results}, resultsKeys=[${resultKeys.join(", ")}]`
    );
  }

  return links;
}

async function decodoLens(imageUrl) {
  return decodoLensWithAuth(imageUrl, process.env.DECODO_AUTH_BASE64, "DECODO_AUTH_BASE64");
}

async function decodoLens2(imageUrl) {
  return decodoLensWithAuth(imageUrl, process.env.DECODO_2_AUTH_BASE64, "DECODO_2_AUTH_BASE64");
}

async function decodoLens3(imageUrl) {
  return decodoLensWithAuth(imageUrl, process.env.DECODO_3_AUTH_BASE64, "DECODO_3_AUTH_BASE64");
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

function unwrapRedirectUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("google.") && (u.pathname === "/url" || u.searchParams.has("q") || u.searchParams.has("url"))) {
      const target = u.searchParams.get("q") || u.searchParams.get("url");
      if (target) return target;
    }
  } catch {}
  return url;
}

function parseApifyBatchDataset(items, fallbackUrls = []) {
  const byImage = new Map();
  if (!Array.isArray(items)) return byImage;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object") continue;
    const searchType = it.searchType || it.mode || "visual_matches";
    const container = it[searchType] || it;
    let inputUrl = it.input_image || it.imageUrl || it.image || container?.inputUrl || it.inputUrl;
    if (!inputUrl && fallbackUrls.length === 1) {
      inputUrl = fallbackUrls[0];
    } else if (!inputUrl && fallbackUrls[i]) {
      inputUrl = fallbackUrls[i];
    }
    if (!inputUrl) continue;

    if (!byImage.has(inputUrl)) {
      byImage.set(inputUrl, []);
    }
    const list = byImage.get(inputUrl);

    // Support omkar-cloud format (visual_matches, web_results, products, exact_matches)
    // gio21 format (visualMatches, exactMatches)
    // and borderline format (results)
    const rawMatches = [
      ...(Array.isArray(it.visual_matches) ? it.visual_matches : []),
      ...(Array.isArray(it.visualMatches) ? it.visualMatches : []),
      ...(Array.isArray(it.web_results) ? it.web_results : []),
      ...(Array.isArray(it.webResults) ? it.webResults : []),
      ...(Array.isArray(it.products) ? it.products : []),
      ...(Array.isArray(it.exact_matches) ? it.exact_matches : []),
      ...(Array.isArray(it.exactMatches) ? it.exactMatches : []),
      ...(Array.isArray(container.results) ? container.results : [])
    ];

    for (const r of rawMatches) {
      if (!r || typeof r !== "object") continue;
      const c = r.search || r;
      let rawUrl = c.link || c.href || r.link || r.href || c.url || r.url || c.googleRedirectUrl || r.googleRedirectUrl;
      if (rawUrl) rawUrl = unwrapRedirectUrl(rawUrl);
      const title = String(c.title || r.title || c.name || r.name || "").trim();
      const thumb = safeUrl(
        c.thumbnail || r.thumbnail ||
        c.imageUrl || r.imageUrl ||
        (typeof c.image === "object" ? c.image?.link : c.image) ||
        (typeof r.image === "object" ? r.image?.link : r.image) || ""
      );

      if (rawUrl && isAmazonProductUrl(rawUrl)) {
        const clean = cleanAmazonUrl(rawUrl);
        const asin = asinFromUrl(clean) || asinFromUrl(rawUrl);
        if (!list.some(x => x.url === clean || (asin && x.asin === asin))) {
          list.push({
            url: clean,
            asin,
            title,
            image: thumb,
            searchType,
            providerMetadata: {
              title,
              image: thumb,
              asin,
              searchType
            }
          });
        }
      }
    }
  }

  return byImage;
}

async function apifyLensBatch(imageUrls, token, attempt = 0) {
  if (!token) throw new Error("Missing Apify token");

  const actorId = process.env.APIFY_ACTOR_ID || "omkar-cloud~google-lens-scraper";
  const isOmkar = actorId.includes("omkar-cloud");
  const isGio = actorId.includes("gio21");

  let payload;
  let memory = 1024;

  if (isOmkar) {
    memory = 256;
    payload = {
      images: imageUrls,
      mode: process.env.APIFY_LENS_MODE || "search",
      country: process.env.APIFY_LENS_COUNTRY || "US",
      language: process.env.APIFY_LENS_LANGUAGE || "en"
    };
  } else if (isGio) {
    payload = {
      imageUrls: imageUrls,
      country: "US",
      language: "en",
      includeExactMatches: true,
      includeAI: false
    };
  } else {
    payload = {
      searchTypes: ["all", "visual-match"],
      imageUrls: imageUrls.map(url => ({ url })),
      language: "en"
    };
  }

  // Start Actor run asynchronously
  const startUrl = `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}&memory=${memory}`;

  try {
    const runRes = await fetchJson(startUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const runId = runRes?.data?.id;
    const defaultDatasetId = runRes?.data?.defaultDatasetId;

    if (!runId || !defaultDatasetId) {
      throw new Error(`Apify run failed to start: ${JSON.stringify(runRes)}`);
    }

    const shortId = runId.slice(0, 8);
    console.log(`Apify Lens run started (${shortId}). Polling status...`);

    const pollIntervalMs = 7000;
    const maxPollTimeMs = 35 * 60 * 1000; // 35 minutes ceiling
    const startTime = Date.now();

    while (Date.now() - startTime < maxPollTimeMs) {
      await sleep(pollIntervalMs);

      const statusUrl = `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`;
      const statusRes = await fetchJson(statusUrl);
      const status = statusRes?.data?.status;
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);

      console.log(`Apify run [${shortId}] status: ${status} (${elapsedSec}s elapsed)...`);

      if (status === "SUCCEEDED") {
        const datasetUrl = `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${token}`;
        const dataset = await fetchJson(datasetUrl);
        if (!Array.isArray(dataset)) {
          throw new Error(`Apify dataset is not an array: ${typeof dataset}`);
        }
        return dataset;
      }

      if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
        const statusMsg = statusRes?.data?.statusMessage || `Actor run ended with status ${status}`;
        throw new Error(`Apify run ${status}: ${statusMsg}`);
      }
    }

    throw new Error(`Apify run ${runId} timed out after 35 minutes`);
  } catch (err) {
    const msg = err.message || String(err);
    const isMemoryBusy = /actor-memory-limit-exceeded/i.test(msg);
    if (isMemoryBusy && attempt < 3) {
      const waitMs = 15000 + (attempt * 10000);
      console.log(`Apify concurrent memory busy on token (runs still active). Waiting ${waitMs / 1000}s for memory to free (attempt ${attempt + 2}/4)...`);
      await sleep(waitMs);
      return apifyLensBatch(imageUrls, token, attempt + 1);
    }
    const isQuotaOrRate = /429|rate-limit|insufficient|credit|quota|monthly usage|free tier|platform-feature-disabled/i.test(msg);
    if (isQuotaOrRate) {
      throw err;
    }
    if (attempt < 1) {
      console.log(`Apify batch request failed (${msg}). Retrying in 4000ms...`);
      await sleep(4000);
      return apifyLensBatch(imageUrls, token, attempt + 1);
    }
    throw err;
  }
}

async function apifyLens(imageUrl, attempt = 0) {
  const token = getCurrentApifyToken();
  if (!token) throw new Error("No active APIFY_TOKEN available");

  try {
    const response = await apifyLensBatch([imageUrl], token);
    const parsedMap = parseApifyBatchDataset(response, [imageUrl]);
    const links = parsedMap.get(imageUrl) || extractAmazonLinks(response);
    return links;
  } catch (err) {
    const msg = err.message || String(err);
    const isMemoryBusy = /actor-memory-limit-exceeded/i.test(msg);
    if (isMemoryBusy && attempt < 3) {
      const waitMs = 15000 + (attempt * 10000);
      console.log(`Apify concurrent memory busy on token. Waiting ${waitMs / 1000}s...`);
      await sleep(waitMs);
      return apifyLens(imageUrl, attempt + 1);
    }
    const isQuotaOrRate = /429|rate-limit|insufficient|credit|quota|monthly usage|free tier|platform-feature-disabled/i.test(msg);
    if (isQuotaOrRate) {
      markApifyTokenExhausted(token, msg);
      if (getCurrentApifyToken()) {
        console.log(`Apify quota exhausted on token, retrying with next token...`);
        return apifyLens(imageUrl, attempt);
      }
    }
    if (attempt < 1) {
      const backoffMs = 3000;
      console.log(`Apify Lens request failed (${msg}). Retrying after ${backoffMs}ms...`);
      await sleep(backoffMs);
      return apifyLens(imageUrl, attempt + 1);
    }
    throw err;
  }
}

async function brightdataLens(imageUrl, attempt = 0) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) throw new Error("Missing BRIGHTDATA_API_KEY");
  const zone = process.env.BRIGHTDATA_ZONE || "serp_api1";

  // Google Lens uploadbyurl endpoint. International targeting: no &gl or country filter.
  const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;

  const payload = {
    zone,
    url: lensUrl,
    format: "json",
    data_format: "parsed"
  };

  const response = await fetchJson("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const isFailed = String(response?.status || "").toLowerCase() === "failed";
  const statusCode = response?.status_code ? Number(response.status_code) : 200;

  if ((isFailed || statusCode >= 400 || !response?.body) && attempt < 2) {
    const backoffMs = 3000 + (attempt * 2000);
    console.log(`Bright Data returned status ${statusCode}. Retrying (attempt ${attempt + 2}/3) after ${backoffMs}ms...`);
    await sleep(backoffMs);
    return brightdataLens(imageUrl, attempt + 1);
  }

  return extractAmazonLinks(response);
}

function providerQueue() {
  // IMPORTANT:
  // Sequential quota order. It does NOT try another provider just because a product has no match.
  // It uses the first available provider until its monthly limit is exhausted, then moves to next.
  const q = [];

  if (getCurrentApifyToken()) q.push(["apify", apifyLens]);
  if (process.env.SERPAPI_KEY_1) q.push(["serpapi_1", img => serpapiLens(img, process.env.SERPAPI_KEY_1)]);
  if (process.env.SERPAPI_KEY_2) q.push(["serpapi_2", img => serpapiLens(img, process.env.SERPAPI_KEY_2)]);
  if (process.env.SEARCHAPI_KEY) q.push(["searchapi", searchapiLens]);
  if (process.env.SCRAPINGDOG_API_KEY) q.push(["scrapingdog", scrapingdogLens]);
  if (process.env.BRIGHTDATA_API_KEY) q.push(["brightdata", brightdataLens]);
  if (process.env.DECODO_AUTH_BASE64) q.push(["decodo", decodoLens]);
  if (process.env.DECODO_2_AUTH_BASE64) q.push(["decodo_2", decodoLens2]);
  if (process.env.DECODO_3_AUTH_BASE64) q.push(["decodo_3", decodoLens3]);

  return q;
}

function seedFreshMatrixChunkUsage() {
  if (!FORCE_REFRESH && sameMonthCache) return;

  // Every matrix job gets its own copy of the usage file. Seed each job from its
  // absolute product offset so all jobs consume non-overlapping provider quota ranges.
  // Example with 700-request accounts: start=600 begins at Decodo 1 usage 600,
  // then automatically switches to Decodo 2 after another 100 requests.
  let remainingOffset = Math.max(0, START_INDEX);
  const availableProviders = providerQueue();

  for (const [name] of availableProviders) {
    const budget = Math.max(0, Number(BUDGETS[name] || 0));
    const seededUsage = Math.min(budget, remainingOffset);
    usage[month][name] = seededUsage;
    remainingOffset = Math.max(0, remainingOffset - budget);
  }

  writeJson(USAGE_PATH, usage);
  console.log(`Fresh matrix quota seed for chunk start ${START_INDEX}:`, usage[month]);
}

seedFreshMatrixChunkUsage();

if (START_INDEX > 0) {
  const initialStaggerMs = Math.min(15000, Math.floor((START_INDEX / 200) * 1500));
  console.log(`Staggering chunk ${START_INDEX} by ${initialStaggerMs}ms to spread initial provider requests...`);
  await sleep(initialStaggerMs);
}

function currentProvider() {
  return providerQueue().find(([name]) => canUse(name)) || null;
}

async function findAmazonCandidatesByLens(imageUrl) {
  const providerCount = providerQueue().length;
  let lastQuotaError = "";

  // Retry the same product only when a provider explicitly reports exhausted
  // quota/credits. A normal zero-result response still moves to the next product,
  // preserving the intended sequential provider policy.
  for (let attempt = 0; attempt < Math.max(1, providerCount); attempt += 1) {
    const provider = currentProvider();

    if (!provider) {
      return {
        exhausted: true,
        provider: null,
        links: [],
        error: lastQuotaError
      };
    }

    const [name, call] = provider;

    try {
      console.log(`Lens provider: ${name} (${used(name) + 1}/${BUDGETS[name]})`);
      const links = await call(imageUrl);
      markUsed(name);
      const decodoDelay = name.startsWith("decodo")
        ? Math.max(DELAY_MS, Number(process.env.DECODO_DELAY_MS || 2500))
        : DELAY_MS;
      await sleep(decodoDelay);

      const amazon = links
        .filter(x => x?.url && isAmazonProductUrl(x.url))
        .slice(0, AMAZON_CANDIDATE_LIMIT);

      console.log(
        `${name} returned ${links.length} extracted links, ${amazon.length} Amazon product links. Checking best ${amazon.length}/${AMAZON_CANDIDATE_LIMIT} candidates.`
      );

      if (amazon[0]) {
        console.log(`First Amazon candidate via ${name}: ${amazon[0].url}`);
      }

      return {
        exhausted: false,
        provider: name,
        links: amazon
      };
    } catch (err) {
      const message = err.message || String(err);

      // Count API errors as usage because many APIs bill attempts.
      markUsed(name);

      const quotaExhausted = /429|run out of searches|out of searches|quota|limit|exhausted|credits|insufficient/i.test(message);

      if (quotaExhausted) {
        usage[month][name] = Number(BUDGETS[name] || used(name));
        writeJson(USAGE_PATH, usage);
        lastQuotaError = message;
        console.log(`${name} quota exhausted. Retrying this product with the next provider. Error: ${message}`);
        await sleep(DELAY_MS);
        continue;
      }

      console.log(`${name} failed for this product: ${message}`);
      const decodoFailDelay = name.startsWith("decodo")
        ? Math.max(DELAY_MS, Number(process.env.DECODO_DELAY_MS || 2000))
        : DELAY_MS;
      await sleep(decodoFailDelay);
      return {
        exhausted: false,
        provider: name,
        links: [],
        error: message
      };
    }
  }

  return {
    exhausted: true,
    provider: null,
    links: [],
    error: lastQuotaError || "all configured Lens provider quotas exhausted"
  };
}

function betterAmazonCandidate(candidate, best) {
  if (!best) return true;

  // Prefer stronger title match first, then higher demand score, then more reviews.
  if (num(candidate.matchScore) !== num(best.matchScore)) {
    return num(candidate.matchScore) > num(best.matchScore);
  }

  if (num(candidate.score) !== num(best.score)) {
    return num(candidate.score) > num(best.score);
  }

  return num(candidate.ratingsTotal) > num(best.ratingsTotal);
}

function randomViewport() {
  const widths = [1280, 1365, 1440, 1536];
  const heights = [720, 768, 800, 864, 900];
  return {
    width: widths[Math.floor(Math.random() * widths.length)],
    height: heights[Math.floor(Math.random() * heights.length)]
  };
}

async function setupAmazonPage(page, targetUrl = "") {
  await page.setViewport(randomViewport());
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    {
      brands: [
        { brand: "Google Chrome", version: "131" },
        { brand: "Chromium", version: "131" },
        { brand: "Not_A Brand", version: "24" }
      ],
      fullVersionList: [
        { brand: "Google Chrome", version: "131.0.6778.86" },
        { brand: "Chromium", version: "131.0.6778.86" },
        { brand: "Not_A Brand", version: "24.0.0.0" }
      ],
      mobile: false,
      platform: "Windows",
      platformVersion: "10.0.0",
      architecture: "x86",
      model: "",
      bitness: "64"
    }
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1"
  });

  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return "Intel Inc.";
        if (parameter === 37446) return "Intel(R) Iris(R) Xe Graphics";
        return getParameter.apply(this, [parameter]);
      };
      if (typeof WebGL2RenderingContext !== "undefined") {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return "Intel Inc.";
          if (parameter === 37446) return "Intel(R) Iris(R) Xe Graphics";
          return getParameter2.apply(this, [parameter]);
        };
      }
    } catch {}
  });

  let domain = ".amazon.com";
  try {
    if (targetUrl) {
      const host = new URL(targetUrl).hostname;
      if (host) domain = "." + host.replace(/^www\./, "");
    }
  } catch {}

  await page.setCookie(
    { name: "i18n-prefs", value: "USD", domain },
    { name: "lc-main", value: "en_US", domain }
  ).catch(() => {});
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
    /reviews?\s*[:\-]?\s*(\d[\d,\.]*\s*[km]?)/i,
    /(\d[\d,\.]*\s*[km]?)\s+(?:valutazioni|recensioni|bewertungen|évaluations|valoraciones)/i
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
    /"ratingValue"\s*:\s*"?([0-5](?:\.\d+)?)"?/i,
    /([0-5](?:\.\d+)?)\s+out of 5 stars/i
  ];

  const reviewPatterns = [
    /"ratingCount"\s*:\s*"?([\d,.]+[km]?)"?/i,
    /"reviewCount"\s*:\s*"?([\d,.]+[km]?)"?/i,
    /"totalReviewCount"\s*:\s*"?([\d,.]+[km]?)"?/i,
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
  const isBlocked = await page.evaluate(() => {
    const title = (document.title || "").toLowerCase();
    if (title.includes("robot check") || title === "captcha") return "Amazon CAPTCHA (robot check title)";
    if (document.querySelector("form[action*='validateCaptcha']") || document.querySelector("#captchacharacters")) {
      return "Amazon CAPTCHA form detected";
    }
    const body = (document.body ? document.body.innerText : "").toLowerCase();
    if (body.includes("enter the characters you see below") || body.includes("verify you are human")) {
      return "Amazon CAPTCHA verification prompt";
    }
    if (body.includes("automated access to amazon data") || body.includes("api-services-support@amazon.com")) {
      return "Amazon automated access interstitial";
    }
    return false;
  }).catch(() => false);

  if (isBlocked) {
    throw new Error(isBlocked);
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

async function scrapeAmazonWithPuppeteer(browser, candidate, cjName) {
  const amazonUrl = candidate.url;
  const page = await browser.newPage();
  await setupAmazonPage(page, amazonUrl);

  try {
    let response = await page.goto(amazonUrl, { waitUntil: "domcontentloaded", timeout: 70000 });
    let status = response?.status?.() || 0;

    let landedUrl = page.url() || amazonUrl;
    if (!isAmazonUrl(landedUrl)) {
      console.log(`Candidate ${amazonUrl} landed on non-Amazon URL: ${landedUrl}`);
      return null;
    }

    await Promise.race([
      page.waitForSelector("#productTitle, #title, h1, script[type='application/ld+json']", { timeout: AMAZON_PAGE_WAIT_MS }),
      sleep(AMAZON_PAGE_WAIT_MS)
    ]).catch(() => {});

    await sleep(Math.min(5000, AMAZON_DELAY_MS) + Math.floor(Math.random() * 1800));

    let blockedError = null;
    try {
      await checkAmazonBlocked(page);
    } catch (err) {
      blockedError = err;
    }

    const asin = candidate.asin || asinFromUrl(landedUrl) || asinFromUrl(amazonUrl);

    // If desktop page was blocked or status is 503/403, retry using Amazon mobile endpoint (/gp/aw/d/<ASIN>)
    if ((blockedError || status === 503 || status === 403) && asin) {
      console.log(`Desktop Amazon access blocked (${blockedError ? blockedError.message : status}). Retrying with mobile endpoint /gp/aw/d/${asin}...`);
      try {
        const u = new URL(landedUrl || amazonUrl);
        const mobileUrl = `https://${u.hostname}/gp/aw/d/${asin}`;
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.setUserAgent(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
        );
        await sleep(1500 + Math.floor(Math.random() * 1500));
        response = await page.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 50000 });
        status = response?.status?.() || 0;

        await Promise.race([
          page.waitForSelector("#productTitle, #title, h1, script[type='application/ld+json']", { timeout: AMAZON_PAGE_WAIT_MS }),
          sleep(AMAZON_PAGE_WAIT_MS)
        ]).catch(() => {});

        try {
          await checkAmazonBlocked(page);
          blockedError = null;
          console.log(`Mobile endpoint loaded successfully for ASIN ${asin} (status ${status}).`);
        } catch (mErr) {
          blockedError = mErr;
        }
      } catch (mNavErr) {
        console.log(`Mobile endpoint retry failed: ${mNavErr.message}`);
      }
    }

    await humanPause(page);

    const jsonLd = await extractJsonLdProduct(page);
    const html = await page.content().catch(() => "");
    const embedded = extractEmbeddedAmazonData(html);

    const selectorTitle =
      await safeText(page, "#productTitle") ||
      await safeText(page, "#title") ||
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
      await safeText(page, "#averageCustomerReviews .a-icon-alt") ||
      await safeAttr(page, "meta[name='twitter:data1']", "content") ||
      await safeAttr(page, "meta[property='og:rating']", "content");

    const ratingMatch = ratingText.replace(/,/g, ".").match(/(\d+(?:\.\d+)?)/);
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
      `Amazon extracted data: status=${status} finalUrl="${page.url()}" title="${title}" ` +
      `ratingText="${ratingText}" reviewsText="${reviewsText}" rating="${rating}" reviews="${ratingsTotal}" ` +
      `sources="${sourceParts.join("+") || "none"}"${blockedError ? ` blocked="${blockedError.message}"` : ""}`
    );

    if (blockedError && !title && !rating && !ratingsTotal) throw blockedError;

    return {
      title,
      url: cleanAmazonUrl(page.url() || amazonUrl),
      asin: candidate.asin || asin || asinFromUrl(page.url() || amazonUrl),
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

function alreadyHasAmazon(product) {
  const pid = String(product.id || "");
  const name = productName(product).toLowerCase();

  return existingAmazon.some(a => {
    const aid = String(a.productId || "");
    const aname = String(a.productName || "").toLowerCase();
    return (pid && aid && pid === aid) || (name && aname && name === aname);
  });
}

const puppeteerArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--window-size=1920,1080",
  "--lang=en-US,en"
];

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: puppeteerArgs
});

const matches = [];
const failures = [];
const amazonSignals = [...existingAmazon];
const endIndex = Math.min(products.length, START_INDEX + MAX_PRODUCTS);

async function evaluateAndEnrichCandidates(browser, candidates, p, candidateFailures) {
  const name = productName(p);
  let bestData = null;

  for (let c = 0; c < candidates.length; c++) {
    const candidate = candidates[c];
    console.log(`Amazon candidate ${c + 1}/${candidates.length}: ${candidate.url}`);
    console.log(`Scraping Amazon page with Puppeteer: ${candidate.url}`);

    let candidateData = null;

    try {
      candidateData = await scrapeAmazonWithPuppeteer(browser, candidate, name);
    } catch (err) {
      console.log(`Amazon page extraction failed for candidate ${c + 1}/${candidates.length}: ${err.message}`);

      if (ACCEPT_PROVIDER_METADATA) {
        candidateData = dataFromProviderCandidate(candidate, name);
        if (candidateData) {
          console.log(
            `Using provider metadata fallback for candidate ${c + 1}: ` +
            `title="${candidateData.title}" rating="${candidateData.rating}" reviews="${candidateData.ratingsTotal}"`
          );
        }
      }

      if (!candidateData) {
        candidateFailures.push({
          candidate: c + 1,
          amazonUrl: candidate.url,
          reason: `amazon page extraction failed: ${err.message}`
        });
        continue;
      }
    }

    if (!candidateData) continue;
    candidateData.candidatePosition = c + 1;

    if (!candidateData.title || (!candidateData.rating && !candidateData.ratingsTotal && !candidateData.isBestSeller)) {
      console.log(
        `Amazon candidate rejected: missing usable demand metadata | candidate=${c + 1} title="${candidateData.title}" rating="${candidateData.rating}" reviews="${candidateData.ratingsTotal}"`
      );
      candidateFailures.push({
        candidate: c + 1,
        amazonUrl: candidate.url,
        title: candidateData.title,
        rating: candidateData.rating,
        ratingsTotal: candidateData.ratingsTotal,
        reason: "amazon candidate missing title and usable rating/review/badge data"
      });
      continue;
    }

    if (candidateData.matchScore < MIN_TITLE_MATCH) {
      console.log(
        `Amazon candidate rejected: weak title match ${candidateData.matchScore}/${MIN_TITLE_MATCH} | candidate=${c + 1} CJ="${name}" | Amazon="${candidateData.title}"`
      );
      candidateFailures.push({
        candidate: c + 1,
        amazonUrl: candidate.url,
        title: candidateData.title,
        rating: candidateData.rating,
        ratingsTotal: candidateData.ratingsTotal,
        matchScore: candidateData.matchScore,
        reason: `weak amazon title match: ${candidateData.matchScore}`
      });
      continue;
    }

    if (betterAmazonCandidate(candidateData, bestData)) {
      bestData = candidateData;
      console.log(
        `Best Amazon candidate so far: candidate=${c + 1} match=${bestData.matchScore} score=${bestData.score} reviews=${bestData.ratingsTotal} title="${bestData.title}"`
      );
    }
  }

  return bestData;
}

function saveMatchSignal(p, data, candidatesCount, candidateFailures, providerName) {
  const name = productName(p);
  const image = productImage(p);

  console.log(
    `Selected best Amazon candidate ${data.candidatePosition || 1}/${candidatesCount}: ${data.url} | match ${data.matchScore} | score ${data.score}`
  );

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
    amazonCandidatesChecked: candidatesCount,
    isBestSeller: data.isBestSeller,
    badgeText: data.badgeText,
    productUrl: data.url,
    matchScore: data.matchScore,
    matchType: "image",
    lensProvider: providerName,
    source: data.source,
    fetchedAt: data.fetchedAt
  };

  amazonSignals.push(signal);
  matches.push({
    productId: p.id,
    productName: name,
    productImage: image,
    provider: providerName,
    amazonCandidatesChecked: candidatesCount,
    candidateFailures,
    amazon: data
  });

  console.log(`Matched via ${providerName}: ${name} -> ${data.title} | rating ${data.rating} | reviews ${data.ratingsTotal} | score ${data.score}`);
}

let i = START_INDEX;
while (i < endIndex) {
  const hasApify = Boolean(getCurrentApifyToken() && canUse("apify"));
  if (!hasApify && !currentProvider()) {
    console.log("All monthly provider limits exhausted. Stopping Lens enrichment.");
    break;
  }

  const batchLimit = hasApify ? APIFY_BATCH_SIZE : 1;
  const batch = [];

  while (i < endIndex && batch.length < batchLimit) {
    const p = products[i];
    const pIndex = i;
    i++;

    const name = productName(p);
    const image = productImage(p);

    if (!name || !image) {
      failures.push({ index: pIndex, name, reason: "missing product name or image" });
      continue;
    }

    if (alreadyHasAmazon(p)) {
      console.log(`Skip existing Amazon data: ${name}`);
      continue;
    }

    batch.push({ product: p, index: pIndex, name, image });
  }

  if (batch.length === 0) continue;

  console.log(`Processing batch of ${batch.length} products (indices ${batch[0].index}..${batch[batch.length - 1].index})...`);

  let batchHandledByApify = false;

  while (getCurrentApifyToken() && canUse("apify")) {
    const tok = getCurrentApifyToken();
    const tokDisplay = tok.slice(0, 14) + "..." + tok.slice(-4);
    console.log(`Sending batch of ${batch.length} products to Apify Lens (${tokDisplay})...`);

    try {
      const urls = batch.map(b => b.image);
      const rawItems = await apifyLensBatch(urls, tok);
      const linksByImage = parseApifyBatchDataset(rawItems, urls);

      for (const item of batch) {
        markUsed("apify");
        const links = (linksByImage.get(item.image) || [])
          .filter(x => x?.url && isAmazonProductUrl(x.url))
          .slice(0, AMAZON_CANDIDATE_LIMIT);

        console.log(`Apify returned ${links.length} Amazon candidate links for: ${item.name}`);

        if (!links.length) {
          console.log(`No Amazon match via apify: ${item.name}`);
          failures.push({
            index: item.index,
            name: item.name,
            image: item.image,
            provider: "apify",
            reason: "no amazon links returned by lens"
          });
          continue;
        }

        const candidateFailures = [];
        const bestData = await evaluateAndEnrichCandidates(browser, links, item.product, candidateFailures);

        if (!bestData) {
          console.log(`No valid Amazon candidate after checking ${links.length} links: ${item.name}`);
          failures.push({
            index: item.index,
            name: item.name,
            image: item.image,
            provider: "apify",
            amazonCandidatesChecked: links.length,
            amazonUrls: links.map(x => x.url),
            candidateFailures,
            reason: "no valid amazon candidate after puppeteer checks"
          });
          continue;
        }

        saveMatchSignal(item.product, bestData, links.length, candidateFailures, "apify");
        await sleep(AMAZON_DELAY_MS + Math.floor(Math.random() * 2000));
      }

      batchHandledByApify = true;
      await sleep(DELAY_MS);
      break;
    } catch (err) {
      const msg = err.message || String(err);
      console.log(`Apify batch failed with token ${tokDisplay}: ${msg}`);
      if (/actor-memory-limit-exceeded/i.test(msg)) {
        console.log(`Apify memory busy across active runs on this account, waiting 15s to retry...`);
        await sleep(15000);
        continue;
      }
      const quotaExhausted = /429|run out of searches|quota|exhausted|credits|insufficient|monthly usage|rate-limit|platform-feature-disabled/i.test(msg);
      if (quotaExhausted) {
        markApifyTokenExhausted(tok, msg);
        if (getCurrentApifyToken()) {
          console.log(`Retrying batch with next available Apify token...`);
          continue;
        }
      }
      break;
    }
  }

  if (!batchHandledByApify) {
    for (const item of batch) {
      const provider = currentProvider();
      if (!provider) {
        console.log("All monthly provider limits exhausted. Stopping Lens enrichment.");
        break;
      }

      console.log(`Fallback Monthly Lens ${item.index + 1}/${products.length}: ${item.name}`);
      const found = await findAmazonCandidatesByLens(item.image);

      if (found.exhausted) {
        console.log("All monthly provider limits exhausted. Stopping Lens enrichment.");
        break;
      }

      if (!found.links.length) {
        console.log(`No Amazon match via ${found.provider}: ${item.name}`);
        failures.push({
          index: item.index,
          name: item.name,
          image: item.image,
          provider: found.provider,
          reason: found.error || "no amazon links from current provider"
        });
        continue;
      }

      const candidateFailures = [];
      const bestData = await evaluateAndEnrichCandidates(browser, found.links, item.product, candidateFailures);

      if (!bestData) {
        console.log(`No valid Amazon candidate after checking ${found.links.length} links: ${item.name}`);
        failures.push({
          index: item.index,
          name: item.name,
          image: item.image,
          provider: found.provider,
          amazonCandidatesChecked: found.links.length,
          amazonUrls: found.links.map(x => x.url),
          candidateFailures,
          reason: "no valid amazon candidate after puppeteer checks"
        });
        continue;
      }

      saveMatchSignal(item.product, bestData, found.links.length, candidateFailures, found.provider);
      await sleep(AMAZON_DELAY_MS + Math.floor(Math.random() * 2000));
    }
  }

  writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
  writeJson("lens-amazon-matches.json", matches);
  writeJson("lens-amazon-failures.json", failures);
  writeJson(USAGE_PATH, usage);
}

await browser.close().catch(() => {});

writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
writeJson("lens-amazon-matches.json", matches);
writeJson("lens-amazon-failures.json", failures);
writeJson(USAGE_PATH, usage);
writeJson("lens-amazon-meta.json", {
  updatedAt: new Date().toISOString(),
  month,
  mode: "batch Apify Lens + sequential quota fallback pool + best Amazon candidate per product",
  startIndex: START_INDEX,
  maxProducts: MAX_PRODUCTS,
  apifyTokensCount: apifyTokens.length,
  batchSize: APIFY_BATCH_SIZE,
  providerUsage: usage[month],
  providerBudgets: BUDGETS,
  amazonCandidateLimit: AMAZON_CANDIDATE_LIMIT,
  matches: matches.length,
  failures: failures.length,
  resetAmazonCache: FORCE_REFRESH,
  matrixQuotaSeededFromStartIndex: FORCE_REFRESH || !sameMonthCache,
  note: "Batch Apify Lens runs up to 15 images concurrently per run across rotating Apify accounts. When exhausted, sequential fallback pool takes over. For each candidate, Puppeteer extracts Amazon DOM, JSON-LD and embedded structured metadata."
});

console.log(`Monthly Lens complete. Matches: ${matches.length}, failures: ${failures.length}`);
console.log("Provider usage:", usage[month]);
