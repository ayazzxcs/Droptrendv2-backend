import net from "net";
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
        const proto = Array.isArray(p.protocols) ? p.protocols[0] : (p.protocols || "http");
        return {
          ip: p.ip,
          port: Number(p.port),
          proto,
          url: `${proto}://${p.ip}:${p.port}`
        };
      }).filter(p => p.ip && p.port);
      currentProxyIndex = 0;
      console.log(`Successfully built a pool of ${proxyPool.length} proxies from Geonode.`);
    }
  } catch (err) {
    console.error("Failed to fetch proxy pool from Geonode API:", err.message);
  }
}

/**
 * Step 2: Live Proxy Validation via rapid TCP socket probe
 * Checks if the remote host and port accept a socket connection within 1.5 seconds.
 */
function checkProxySocket(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => {
      cleanup();
      resolve(true);
    });
    socket.once("timeout", () => {
      cleanup();
      resolve(false);
    });
    socket.once("error", () => {
      cleanup();
      resolve(false);
    });

    try {
      socket.connect(port, host);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

/**
 * Step 3: Fast failover proxy selector
 * Validates candidate proxies with socket probes, rejecting dead ones in <1.5s.
 * Returns null if no live proxy found within maxChecks to prevent hanging.
 */
async function getNextValidProxy(maxChecks = 15) {
  let checked = 0;
  while (checked < maxChecks) {
    if (proxyPool.length === 0 || currentProxyIndex >= proxyPool.length) {
      await fetchProxyPool();
      if (proxyPool.length === 0) return null;
    }

    const item = proxyPool[currentProxyIndex++];
    checked++;

    const isLive = await checkProxySocket(item.ip, item.port, 1500);
    if (isLive) {
      console.log(`Proxy socket verified alive: ${item.url}`);
      return item.url;
    }
  }
  return null;
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
    .replace(/[^a-z0-9\s]/g, " ")
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
  const bTokens = tokens(b);
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  const hits = aTokens.filter(t => bSet.has(t)).length;
  const baseLen = Math.min(aTokens.length, bTokens.length);
  return Math.round(Math.min(100, (hits / Math.max(1, baseLen)) * 100));
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
    let text = String(value || "")
      .replace(/&amp;/gi, "&")
      .replaceAll("\\/", "/");

    const urls = new Set();
    const httpUrlPattern = new RegExp("https?://[^\\\\s\"'<>\\\\\\\\]+", "gi");
    for (const match of text.matchAll(httpUrlPattern)) {
      urls.add(match[0].replace(/[),.;]+$/, ""));
    }

    // Decode URL-encoded Amazon patterns found in Google search/Lens script blobs
    const encodedPattern = new RegExp("https?%3A%2F%2F[^\\\\s\"'<>\\\\\\\\]+amazon[^\\\\s\"'<>\\\\\\\\]*", "gi");
    for (const match of text.matchAll(encodedPattern)) {
      try {
        const decoded = decodeURIComponent(match[0].replace(/[),.;]+$/, ""));
        urls.add(decoded);
      } catch {}
    }

    return [...urls];
  }

  function addCandidate(rawUrl, node = {}, inheritedTitle = "") {
    if (!rawUrl) return;

    let candidateUrl = String(rawUrl).trim();
    try {
      if (candidateUrl.includes("%3A%2F%2F") || candidateUrl.includes("%3a%2f%2f")) {
        try { candidateUrl = decodeURIComponent(candidateUrl); } catch {}
      }
      const u = new URL(candidateUrl.startsWith("http") ? candidateUrl : `https://www.google.com${candidateUrl}`);
      const wrapped = u.searchParams.get("url") || u.searchParams.get("q") || u.searchParams.get("target") || u.searchParams.get("dest");
      if (wrapped) {
        let unwrapped = wrapped;
        if (unwrapped.includes("%3A%2F%2F") || unwrapped.includes("%3a%2f%2f")) {
          try { unwrapped = decodeURIComponent(unwrapped); } catch {}
        }
        if (/^https?:\/\//i.test(unwrapped)) candidateUrl = unwrapped;
      }
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

  if (data?.domLinks && Array.isArray(data.domLinks)) {
    for (const dl of data.domLinks) {
      if (dl?.url) addCandidate(dl.url, {}, dl.title || "");
    }
  }

  walk(data);
  return [...byUrl.values()];
}

let lensDirectBrowser = null;

async function getLensDirectBrowser() {
  if (!lensDirectBrowser || !lensDirectBrowser.connected) {
    try {
      if (lensDirectBrowser) await lensDirectBrowser.close().catch(() => {});
    } catch {}
    lensDirectBrowser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox"
      ]
    });
  }
  return lensDirectBrowser;
}

let directLensBlocked = false;

/**
 * Free Google Lens HTML Engine
 * Step 1: Direct Stealth Connection (no proxy, 15s timeout).
 * Step 2: Live Proxy Fallback if direct is blocked by Google (429 or CAPTCHA).
 */
async function scrapeGoogleLensFree(imageUrl) {
  const targetLensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;

  // Attempt 1: Direct connection
  if (!directLensBlocked) {
    let page = null;
    try {
      console.log(`[Google Lens] Querying via direct connection (no proxy)...`);
      const browser = await getLensDirectBrowser();
      page = await browser.newPage();
      await page.setViewport(randomViewport());
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
      });

      const response = await page.goto(targetLensUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000
      });

      const status = response?.status?.() || 0;
      const bodyTextStr = await page.evaluate(() => document.body?.innerText || "");

      if (status === 429 || /captcha|verify you are human|automated access/i.test(bodyTextStr)) {
        console.log(`[Google Lens] Direct connection blocked (Status: ${status} / CAPTCHA). Switching to proxy fallback.`);
        directLensBlocked = true;
      } else {
        // Wait for visual results to load in Google Lens
        await Promise.race([
          page.waitForSelector('a[href*="amazon"], [data-ved], c-wiz, div[jscontroller]', { timeout: 8000 }),
          sleep(5000)
        ]).catch(() => {});
        await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
        await sleep(1500);

        const domLinks = await page.evaluate(() => {
          const links = [];
          const seen = new Set();

          function checkAndAdd(rawUrl, title) {
            if (!rawUrl) return;
            let u = String(rawUrl).trim();
            try {
              if (u.includes("%3A%2F%2F") || u.includes("%3a%2f%2f")) {
                try { u = decodeURIComponent(u); } catch {}
              }
              if (u.includes("/url?") || u.includes("google.com/url")) {
                const parsed = new URL(u.startsWith("http") ? u : `https://www.google.com${u}`);
                const target = parsed.searchParams.get("url") || parsed.searchParams.get("q") || parsed.searchParams.get("target");
                if (target) {
                  let un = target;
                  if (un.includes("%3A%2F%2F") || un.includes("%3a%2f%2f")) {
                    try { un = decodeURIComponent(un); } catch {}
                  }
                  u = un;
                }
              }
              if (/(^|\.)amazon\./i.test(new URL(u).hostname)) {
                const clean = u.split("?")[0];
                if (!seen.has(clean)) {
                  seen.add(clean);
                  links.push({ url: clean, title: title || "" });
                }
              }
            } catch {}
          }

          for (const a of document.querySelectorAll("a")) {
            const href = a.getAttribute("href") || a.href || "";
            const title = (a.innerText || a.getAttribute("aria-label") || a.title || "").trim();
            checkAndAdd(href, title);
          }

          for (const el of document.querySelectorAll("[data-url], [data-website], [data-action-url], [data-lens-item-url]")) {
            const val = el.getAttribute("data-url") || el.getAttribute("data-website") || el.getAttribute("data-action-url") || el.getAttribute("data-lens-item-url") || "";
            const title = (el.innerText || el.getAttribute("aria-label") || "").trim();
            checkAndAdd(val, title);
          }

          return links;
        });

        const htmlContent = await page.content();
        const candidates = extractAmazonLinks({
          rawHtmlPayload: htmlContent,
          domLinks
        });

        await page.close().catch(() => {});
        return { links: candidates, error: null };
      }
    } catch (err) {
      console.log(`[Google Lens] Direct attempt failed: ${err.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // Attempt 2: Live Proxy Fallback
  const proxy = await getNextValidProxy(10);
  if (!proxy) {
    return { links: [], error: "Google Lens rate limited and no live proxy available" };
  }

  let proxyBrowser = null;
  try {
    console.log(`[Google Lens] Fallback query via verified live proxy: ${proxy}...`);
    proxyBrowser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        `--proxy-server=${proxy}`
      ]
    });

    const page = await proxyBrowser.newPage();
    await page.setViewport(randomViewport());
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.google.com/"
    });

    const response = await page.goto(targetLensUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });

    const status = response?.status?.() || 0;
    const bodyTextStr = await page.evaluate(() => document.body?.innerText || "");

    if (status === 429 || /captcha|verify you are human|automated access/i.test(bodyTextStr)) {
      throw new Error(`Proxy Google block detected (Status: ${status} / CAPTCHA)`);
    }

    // Wait for visual results to load in Google Lens
    await Promise.race([
      page.waitForSelector('a[href*="amazon"], [data-ved], c-wiz, div[jscontroller]', { timeout: 8000 }),
      sleep(5000)
    ]).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
    await sleep(1500);

    const domLinks = await page.evaluate(() => {
      const links = [];
      const seen = new Set();

      function checkAndAdd(rawUrl, title) {
        if (!rawUrl) return;
        let u = String(rawUrl).trim();
        try {
          if (u.includes("%3A%2F%2F") || u.includes("%3a%2f%2f")) {
            try { u = decodeURIComponent(u); } catch {}
          }
          if (u.includes("/url?") || u.includes("google.com/url")) {
            const parsed = new URL(u.startsWith("http") ? u : `https://www.google.com${u}`);
            const target = parsed.searchParams.get("url") || parsed.searchParams.get("q") || parsed.searchParams.get("target");
            if (target) {
              let un = target;
              if (un.includes("%3A%2F%2F") || un.includes("%3a%2f%2f")) {
                try { un = decodeURIComponent(un); } catch {}
              }
              u = un;
            }
          }
          if (/(^|\.)amazon\./i.test(new URL(u).hostname)) {
            const clean = u.split("?")[0];
            if (!seen.has(clean)) {
              seen.add(clean);
              links.push({ url: clean, title: title || "" });
            }
          }
        } catch {}
      }

      for (const a of document.querySelectorAll("a")) {
        const href = a.getAttribute("href") || a.href || "";
        const title = (a.innerText || a.getAttribute("aria-label") || a.title || "").trim();
        checkAndAdd(href, title);
      }

      for (const el of document.querySelectorAll("[data-url], [data-website], [data-action-url], [data-lens-item-url]")) {
        const val = el.getAttribute("data-url") || el.getAttribute("data-website") || el.getAttribute("data-action-url") || el.getAttribute("data-lens-item-url") || "";
        const title = (el.innerText || el.getAttribute("aria-label") || "").trim();
        checkAndAdd(val, title);
      }

      return links;
    });

    const htmlContent = await page.content();
    const candidates = extractAmazonLinks({
      rawHtmlPayload: htmlContent,
      domLinks
    });

    await proxyBrowser.close().catch(() => {});
    return { links: candidates, error: null };
  } catch (err) {
    console.log(`[Google Lens] Proxy scrape failed for ${proxy}: ${err.message}`);
    if (proxyBrowser) await proxyBrowser.close().catch(() => {});
    return { links: [], error: err.message };
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

    const blockedMessage = blockedError ? ` blocked="${blockedError.message}"` : "";
    console.log(
      `Amazon extracted data: status=${status} finalUrl="${page.url()}" title="${title}" ` +
      `ratingText="${ratingText}" reviewsText="${reviewsText}" rating="${rating}" reviews="${ratingsTotal}" ` +
      `sources="${sourceParts.join("+") || "none"}"${blockedMessage}`
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
  const combined = `${text}\n${html}`;

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

/**
 * Direct Amazon Keyword Search Fallback
 * Used when Google Lens yields 0 Amazon candidates or fails.
 * Queries Amazon search results directly using the product's title keywords.
 */
async function searchAmazonFallback(browser, name, p, image) {
  const nameTokens = tokens(name);
  if (!nameTokens.length) return null;
  const query = nameTokens.slice(0, 5).join(" ");
  console.log(`[Amazon Fallback] Searching Amazon directly for "${query}" (Original: "${name}")...`);

  const page = await browser.newPage();
  await setupAmazonPage(page);

  try {
    const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
    const response = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = response?.status?.() || 0;

    await Promise.race([
      page.waitForSelector("[data-component-type='s-search-result']", { timeout: 8000 }),
      sleep(8000)
    ]).catch(() => {});

    await checkAmazonBlocked(page);

    const cardsData = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll("[data-component-type='s-search-result'], [data-asin]:not([data-asin=''])");

      for (const card of cards) {
        const asin = (card.getAttribute("data-asin") || "").trim();
        if (!asin || asin.length !== 10) continue;

        const titleEl = card.querySelector("h2 a span, h2 span, span.a-text-normal");
        const title = (titleEl?.innerText || titleEl?.textContent || "").trim();
        if (!title || /sponsored/i.test(title)) continue;

        const linkEl = card.querySelector("h2 a, a.a-link-normal[href*='/dp/']");
        const href = linkEl?.getAttribute("href") || "";
        let url = "";
        if (href) {
          url = href.startsWith("http") ? href.split("?")[0] : `https://www.amazon.com${href.split("?")[0]}`;
        } else {
          url = `https://www.amazon.com/dp/${asin}`;
        }

        const ratingEl = card.querySelector("span.a-icon-alt, i.a-icon-star-small span.a-icon-alt");
        const ratingText = (ratingEl?.innerText || ratingEl?.textContent || "").trim();

        const reviewsEl = card.querySelector("span.a-size-base.s-underline-text, a[href*='customerReviews'] span, span[aria-label*='ratings']");
        const reviewsText = (reviewsEl?.innerText || reviewsEl?.textContent || "").trim();

        const badgeEl = card.querySelector(".a-badge-text, .a-badge-label-inner, .s-coupon-highlight-color");
        const badgeText = (badgeEl?.innerText || badgeEl?.textContent || "").trim();

        results.push({
          asin,
          title,
          url,
          ratingText,
          reviewsText,
          badgeText
        });
      }
      return results;
    });

    console.log(`[Amazon Fallback] Extracted ${cardsData.length} search items for "${query}"`);
    if (!cardsData.length) return null;

    let bestCandidate = null;

    for (let idx = 0; idx < Math.min(cardsData.length, AMAZON_CANDIDATE_LIMIT); idx++) {
      const item = cardsData[idx];
      const matchScore = titleSimilarity(name, item.title);
      if (matchScore < MIN_TITLE_MATCH) continue;

      const ratingMatch = item.ratingText.match(/(\d+(?:\.\d+)?)/);
      const rating = ratingMatch ? Number(ratingMatch[1]) : 0;
      const ratingsTotal = normalizeReviewCount(item.reviewsText);
      const isBestSeller = /best seller|amazon'?s choice|overall pick/i.test(item.badgeText);
      const score = demandScore({ rating, ratingsTotal, isBestSeller, matchScore });

      const candidate = {
        title: item.title,
        url: cleanAmazonUrl(item.url),
        asin: item.asin,
        rating: rating || "",
        ratingsTotal: ratingsTotal || 0,
        isBestSeller,
        badgeText: item.badgeText,
        matchScore,
        score,
        candidatePosition: idx + 1,
        source: "amazon-search-fallback",
        matchType: "keyword",
        fetchedAt: new Date().toISOString()
      };

      if (betterAmazonCandidate(candidate, bestCandidate)) {
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  } catch (err) {
    console.log(`[Amazon Fallback] Search error for "${query}": ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

let mainAmazonBrowser = null;

async function getAmazonBrowser() {
  if (!mainAmazonBrowser || !mainAmazonBrowser.connected) {
    try {
      if (mainAmazonBrowser) await mainAmazonBrowser.close().catch(() => {});
    } catch {}
    mainAmazonBrowser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox"
      ]
    });
  }
  return mainAmazonBrowser;
}

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
    console.log(`Skip existing Amazon data: ${name}`);
    continue;
  }

  try {
    console.log(`Monthly Free Lens ${i + 1}/${products.length}: ${name}`);

    // Free implementation: Try Google Lens first
    const found = await scrapeGoogleLensFree(image);

    let data = null;
    const candidateFailures = [];

    const filteredAmazonLinks = (found.links || [])
      .filter(x => x?.url && isAmazonUrl(x.url))
      .slice(0, AMAZON_CANDIDATE_LIMIT);

    if (filteredAmazonLinks.length > 0) {
      console.log(`Checking ${filteredAmazonLinks.length} Amazon candidates via standard browser window for: ${name}`);
      const browser = await getAmazonBrowser();

      for (let c = 0; c < filteredAmazonLinks.length; c++) {
        const candidate = filteredAmazonLinks[c];
        console.log(`Amazon candidate ${c + 1}/${filteredAmazonLinks.length}: ${candidate.url}`);

        let candidateData = null;

        try {
          candidateData = await scrapeAmazonWithPuppeteer(browser, candidate, name);
        } catch (err) {
          console.log(`Amazon page extraction failed for candidate ${c + 1}/${filteredAmazonLinks.length}: ${err.message}`);

          if (ACCEPT_PROVIDER_METADATA) {
            candidateData = dataFromProviderCandidate(candidate, name);
            if (candidateData) {
              console.log(
                `Using fallback metadata context for candidate ${c + 1}: ` +
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

        candidateData.candidatePosition = c + 1;

        if (!candidateData.title) {
          candidateFailures.push({
            candidate: c + 1,
            amazonUrl: candidate.url,
            reason: "amazon candidate missing usable product title"
          });
          continue;
        }

        if (candidateData.matchScore < MIN_TITLE_MATCH) {
          candidateFailures.push({
            candidate: c + 1,
            amazonUrl: candidate.url,
            title: candidateData.title,
            matchScore: candidateData.matchScore,
            reason: `weak title string correlation matrix match: ${candidateData.matchScore}`
          });
          continue;
        }

        if (betterAmazonCandidate(candidateData, data)) {
          data = candidateData;
        }
      }
    }

    // Direct Amazon Search Fallback if Lens yielded no valid Amazon candidate
    if (!data) {
      console.log(`Lens yielded no qualifying Amazon candidate for "${name}". Running Amazon search fallback...`);
      const browser = await getAmazonBrowser();
      data = await searchAmazonFallback(browser, name, p, image);
      if (data) {
        console.log(`[Amazon Fallback] Successfully matched: ASIN=${data.asin}, Title="${data.title}", Score=${data.score}`);
      }
    }

    if (!data) {
      failures.push({
        index: i,
        name,
        image,
        candidateFailures,
        reason: "no valid candidate from Google Lens or Amazon search fallback"
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
      bestPrice: data.price || "",
      position: data.candidatePosition || 1,
      amazonCandidatesChecked: filteredAmazonLinks.length || 1,
      isBestSeller: data.isBestSeller,
      badgeText: data.badgeText,
      productUrl: data.url,
      matchScore: data.matchScore,
      matchType: data.matchType || (filteredAmazonLinks.length > 0 ? "image" : "keyword"),
      lensProvider: data.matchType === "keyword" ? "amazon-search-fallback" : "free-google-lens",
      source: data.source,
      fetchedAt: data.fetchedAt || new Date().toISOString()
    };

    amazonSignals.push(signal);
    matches.push({
      productId: p.id,
      productName: name,
      productImage: image,
      provider: signal.lensProvider,
      amazonCandidatesChecked: signal.amazonCandidatesChecked,
      candidateFailures,
      amazon: data
    });

    if (matches.length % 5 === 0) {
      writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
      writeJson("lens-amazon-matches.json", matches);
      writeJson("lens-amazon-failures.json", failures);
    }

    await sleep(AMAZON_DELAY_MS + Math.floor(Math.random() * 1500));
  } catch (err) {
    console.log(`Free Processing Loop error for item "${name}": ${err.message}`);
    failures.push({ index: i, name, image, reason: err.message });
  }
}

if (mainAmazonBrowser) await mainAmazonBrowser.close().catch(() => {});
if (lensDirectBrowser) await lensDirectBrowser.close().catch(() => {});

writeJson(AMAZON_PRODUCTS_PATH, amazonSignals);
writeJson("lens-amazon-matches.json", matches);
writeJson("lens-amazon-failures.json", failures);
writeJson("lens-amazon-meta.json", {
  updatedAt: new Date().toISOString(),
  month,
  mode: "free-google-lens-and-amazon-search-fallback",
  startIndex: START_INDEX,
  maxProducts: MAX_PRODUCTS,
  matches: matches.length,
  failures: failures.length,
  resetAmazonCache: FORCE_REFRESH
});

console.log(`Job lifecycle finalized cleanly. Total Matches: ${matches.length}, Failures: ${failures.length}`);
