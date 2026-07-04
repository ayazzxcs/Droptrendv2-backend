import { chromium } from "playwright";
import { readJson, writeJson, normalizeKeyword, sleep, num } from "./utils.js";

const MAX_PRODUCTS = Number(process.env.ALIEXPRESS_MAX_PRODUCTS || 750);
const MAX_SEARCHES = Number(process.env.ALIEXPRESS_MAX_SEARCHES || 70);
const PRODUCTS_PER_KEYWORD = Number(process.env.ALIEXPRESS_PRODUCTS_PER_KEYWORD || 24);
const DELAY_MS = Number(process.env.ALIEXPRESS_DELAY_MS || 2500);
const SEARCH_TIMEOUT_MS = Number(process.env.ALIEXPRESS_TIMEOUT_MS || 60000);
const HEADLESS = String(process.env.ALIEXPRESS_HEADLESS || "true").toLowerCase() !== "false";
const FALLBACK_CACHE = String(process.env.ALIEXPRESS_FALLBACK_CACHE || "true").toLowerCase() !== "false";

const OUTPUT_PATH = process.env.ALIEXPRESS_OUTPUT_PATH || "aliexpress-products.json";
const META_PATH = process.env.ALIEXPRESS_META_PATH || "aliexpress-meta.json";
const KEYWORDS_PATH = process.env.ALIEXPRESS_KEYWORDS_PATH || "aliexpress-keywords.json";

const previousAliExpress = readJson(OUTPUT_PATH, []);
const SEED_KEYWORDS = [
  "home gadgets",
  "kitchen gadgets",
  "pet supplies",
  "cat toy",
  "dog grooming",
  "beauty tools",
  "skin care tools",
  "hair styling tools",
  "phone accessories",
  "car accessories",
  "car vacuum",
  "led lights",
  "room decor",
  "travel accessories",
  "fitness equipment",
  "yoga accessories",
  "baby products",
  "kids toys",
  "summer dress",
  "women dress",
  "mens fashion",
  "storage organizer",
  "bathroom organizer",
  "makeup organizer",
  "smart watch accessories",
  "wireless earbuds",
  "portable blender",
  "neck fan",
  "electric chopper",
  "desk lamp",
  "gaming accessories",
  "outdoor camping",
  "garden tools",
  "jewelry accessories",
  "nail tools",
  "massage tools",
  "posture corrector",
  "water bottle",
  "laptop stand",
  "cleaning brush",
  "mini printer",
  "humidifier",
  "air purifier",
  "mosquito lamp",
  "shoe organizer",
  "laundry organizer",
  "wall hooks",
  "silicone mold",
  "coffee accessories"
];

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function hashId(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function uniqueKey(text) {
  return normalizeKeyword(text)
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://www.aliexpress.com");
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function absoluteImage(value) {
  let src = String(value || "").trim();
  if (!src) return "";
  if (src.startsWith("//")) src = `https:${src}`;
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  return "";
}

function parsePrice(text) {
  const s = cleanText(text);
  const matches = [...s.matchAll(/(?:US\s*)?\$?\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi)]
    .map(m => Number(String(m[1]).replace(",", ".")))
    .filter(n => Number.isFinite(n) && n > 0 && n < 100000);

  if (!matches.length) return 0;

  // Product cards often contain a price range. Use the lowest visible price.
  return Math.min(...matches);
}

function parseOrders(text) {
  const s = cleanText(text).toLowerCase();

  const patterns = [
    /([0-9]+(?:[.,][0-9]+)?)(k|m)?\s*(?:sold|orders|ordered|purchased|vendidos|vendu)/i,
    /(?:sold|orders|ordered|purchased)\s*([0-9]+(?:[.,][0-9]+)?)(k|m)?/i
  ];

  for (const pattern of patterns) {
    const m = s.match(pattern);
    if (!m) continue;
    const base = Number(String(m[1]).replace(",", "."));
    const mult = String(m[2] || "").toLowerCase() === "m" ? 1000000 : (String(m[2] || "").toLowerCase() === "k" ? 1000 : 1);
    if (Number.isFinite(base)) return Math.round(base * mult);
  }

  return 0;
}

function parseRating(text) {
  const s = cleanText(text);
  const m = s.match(/\b([1-4](?:\.\d)?|5(?:\.0)?)\b\s*(?:\/\s*5|stars?|star rating)?/i);
  const rating = m ? Number(m[1]) : 0;
  return rating >= 1 && rating <= 5 ? rating : 0;
}

function parseDiscount(text) {
  const m = cleanText(text).match(/(\d{1,2})\s*%\s*off/i);
  return m ? Number(m[1]) : 0;
}

function makeAliExpressUrl(keyword, page = 1) {
  const url = new URL("https://www.aliexpress.com/wholesale");
  url.searchParams.set("SearchText", keyword);
  url.searchParams.set("sortType", "total_tranpro_desc");
  url.searchParams.set("page", String(page));
  url.searchParams.set("trafficChannel", "main");
  url.searchParams.set("g", "y");
  return url.toString();
}

function buildKeywordPool() {
  const counts = new Map();

  function add(keyword, weight = 1) {
    const k = normalizeKeyword(keyword);
    if (!k || k.length < 3) return;
    const words = k.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 5) return;
    counts.set(k, (counts.get(k) || 0) + weight);
  }

  // AliExpress should behave as its own independent product source.
  // Do not use CJ product titles or Google Trends keywords here.
  // The keyword pool is only AliExpress/dropshipping category seeds.
  for (const item of SEED_KEYWORDS) add(item, 3);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEARCHES)
    .map(([keyword, weight]) => ({ keyword, weight }));
}

function normalizeProduct(raw, keyword, rank) {
  const title = cleanText(first(raw.title, raw.name, raw.productTitle));
  const url = safeUrl(first(raw.url, raw.productUrl, raw.href));
  const productId =
    String(first(raw.productId, raw.itemId, raw.id, url.match(/\/item\/(\d+)\.html/i)?.[1], "")).trim() ||
    hashId(`${title}|${url}|${keyword}`);

  const price = num(first(raw.price, raw.salePrice, raw.priceText));
  const originalPrice = num(first(raw.originalPrice, raw.originalPriceText, price));
  const orders = num(first(raw.orders, raw.sold, raw.soldCount));
  const rating = num(first(raw.rating, raw.averageStar));
  const discount = num(first(raw.discount, raw.discountPercent));
  const image = absoluteImage(first(raw.image, raw.imageUrl, raw.img));

  if (!title || !url || !image || price <= 0) return null;

  const sell = Math.ceil(price * 2.25);
  const shipping = 0;
  const profit = Math.max(0, sell - price - shipping);
  const margin = sell ? Math.round((profit / sell) * 100) : 0;
  const listedCount = Math.max(orders, num(raw.listedCount));

  const sourceScore = computeAliExpressSourceScore({
    image,
    price,
    orders,
    rating,
    discount,
    margin,
    rank
  });

  return {
    id: `aliexpress-${productId}`,
    sourceProductId: productId,
    name: title,
    productName: title,
    productNameEn: title,
    image,
    supplier: "AliExpress",
    source: "AliExpress",
    marketplace: "AliExpress",
    supplierUrl: url,
    productUrl: url,
    supplierPrice: price,
    cost: price,
    originalPrice: originalPrice || price,
    shippingPrice: shipping,
    shipping,
    suggestedPrice: sell,
    sell,
    profit,
    margin,
    currency: raw.currency || "USD",
    category: raw.category || `AliExpress / ${keyword}`,
    market: "Worldwide",
    listedCount,
    inventory: num(raw.inventory || raw.stock || 0),
    orders,
    soldCount: orders,
    rating,
    discount,
    deliveryTime: raw.deliveryTime || "Check AliExpress",
    aliExpressKeyword: keyword,
    aliExpressRank: rank,
    sourceScore,
    trend: sourceScore,
    winningScore: sourceScore + Math.min(40, Math.log10(orders + 1) * 16),
    tags: ["AliExpress product", "AliExpress trending search"],
    raw
  };
}

function computeAliExpressSourceScore(p) {
  let score = 0;
  if (p.image) score += 15;
  if (p.price > 0) score += 15;
  score += Math.min(30, Math.log10(num(p.orders) + 1) * 12);
  score += Math.min(20, Math.max(0, num(p.rating) - 3.5) * 14);
  score += Math.min(10, num(p.discount) / 7);
  score += Math.min(10, Math.max(0, num(p.margin) - 35) * 0.25);

  // Higher ranked search results should get a small boost.
  if (p.rank <= 5) score += 8;
  else if (p.rank <= 12) score += 4;

  return Math.round(Math.max(1, Math.min(100, score)));
}

async function extractCards(page) {
  return await page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();

    const isItemLink = (href) => /\/item\/\d+\.html/i.test(href || "") || /aliexpress\.[^/]+\/item\//i.test(href || "");

    const links = [...document.querySelectorAll('a[href*="/item/"]')];
    const out = [];
    const seen = new Set();

    for (const link of links) {
      const href = link.href || link.getAttribute("href") || "";
      if (!isItemLink(href) || seen.has(href)) continue;

      let root = link;
      for (let i = 0; i < 4; i++) {
        if (root?.parentElement) root = root.parentElement;
      }

      const img = link.querySelector("img") || root?.querySelector("img");
      const imgSrc =
        img?.getAttribute("src") ||
        img?.getAttribute("data-src") ||
        img?.getAttribute("data-lazy-src") ||
        img?.src ||
        "";

      const aria = link.getAttribute("aria-label") || link.getAttribute("title") || "";
      const imgAlt = img?.getAttribute("alt") || "";
      const rootText = clean(root?.innerText || "");
      const linkText = clean(link.innerText || "");
      const title = clean(aria || imgAlt || linkText.split("$")[0] || rootText.split("$")[0]);

      const productId = href.match(/\/item\/(\d+)\.html/i)?.[1] || "";
      const priceText = clean(rootText.match(/(?:US\s*)?\$\s*[0-9][0-9.,]*(?:\s*-\s*(?:US\s*)?\$\s*[0-9][0-9.,]*)?/i)?.[0] || "");
      const ratingText = clean(rootText.match(/\b[1-5](?:\.\d)?\b\s*(?:\/\s*5|stars?)?/i)?.[0] || "");
      const soldText = clean(rootText.match(/[0-9]+(?:[.,][0-9]+)?[km]?\s*(?:sold|orders|ordered|purchased)/i)?.[0] || "");
      const discountText = clean(rootText.match(/\d{1,2}\s*%\s*off/i)?.[0] || "");

      out.push({
        productId,
        title,
        url: href,
        image: imgSrc,
        text: rootText,
        priceText,
        ratingText,
        soldText,
        discountText
      });

      seen.add(href);
    }

    return out.slice(0, 80);
  });
}

async function fetchKeywordProducts(page, keyword) {
  const url = makeAliExpressUrl(keyword, 1);
  console.log(`AliExpress search: ${keyword}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
  await sleep(3500);

  const blocked = await page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() || "";
    return /captcha|verify you are human|robot check|security check|unusual traffic/.test(text);
  });

  if (blocked) {
    throw new Error(`AliExpress captcha/security check for keyword: ${keyword}`);
  }

  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1600);
    await sleep(900);
  }

  const cards = await extractCards(page);

  return cards
    .map((card, index) => ({
      ...card,
      price: parsePrice(card.priceText || card.text),
      orders: parseOrders(card.soldText || card.text),
      rating: parseRating(card.ratingText || card.text),
      discount: parseDiscount(card.discountText || card.text)
    }))
    .map((card, index) => normalizeProduct(card, keyword, index + 1))
    .filter(Boolean)
    .slice(0, PRODUCTS_PER_KEYWORD);
}

function dedupeProducts(products) {
  const byKey = new Map();

  function score(p) {
    return num(p.winningScore) + num(p.sourceScore) + Math.min(50, Math.log10(num(p.orders) + 1) * 15);
  }

  for (const p of products) {
    const key =
      p.sourceProductId ? `id:${p.sourceProductId}` :
      p.supplierUrl ? `url:${p.supplierUrl}` :
      `name:${uniqueKey(p.name).split(/\s+/).slice(0, 8).join(" ")}`;

    const prev = byKey.get(key);
    if (!prev || score(p) > score(prev)) {
      byKey.set(key, p);
    }
  }

  return [...byKey.values()];
}

async function main() {
  const keywordPool = buildKeywordPool();
  writeJson(KEYWORDS_PATH, keywordPool);

  console.log(`AliExpress keyword pool: ${keywordPool.length} searches`);
  console.log(`Target AliExpress products: ${MAX_PRODUCTS}`);

  const all = [];
  const errors = [];

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "America/New_York",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const page = await context.newPage();

    for (const item of keywordPool) {
      if (all.length >= MAX_PRODUCTS) break;

      try {
        const products = await fetchKeywordProducts(page, item.keyword);
        console.log(`AliExpress ${item.keyword}: ${products.length} products`);
        all.push(...products);

        const deduped = dedupeProducts(all);
        all.length = 0;
        all.push(...deduped);

        console.log(`AliExpress unique collected: ${all.length}/${MAX_PRODUCTS}`);
      } catch (err) {
        console.log(`AliExpress keyword failed: ${item.keyword}: ${err.message}`);
        errors.push({ keyword: item.keyword, error: err.message });
      }

      await sleep(DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  const finalProducts = dedupeProducts(all)
    .sort((a, b) =>
      num(b.winningScore) - num(a.winningScore) ||
      num(b.orders) - num(a.orders) ||
      num(b.rating) - num(a.rating)
    )
    .slice(0, MAX_PRODUCTS);

  let output = finalProducts;
  let usedFallback = false;

  if (!output.length && FALLBACK_CACHE && Array.isArray(previousAliExpress) && previousAliExpress.length) {
    output = previousAliExpress.slice(0, MAX_PRODUCTS);
    usedFallback = true;
    console.log(`AliExpress scrape returned 0 products. Using previous cache: ${output.length}`);
  }

  writeJson(OUTPUT_PATH, output);
  writeJson(META_PATH, {
    updatedAt: new Date().toISOString(),
    source: "AliExpress",
    mode: "Playwright keyword/category search scraper",
    count: output.length,
    maxProducts: MAX_PRODUCTS,
    maxSearches: MAX_SEARCHES,
    productsPerKeyword: PRODUCTS_PER_KEYWORD,
    keywordCount: keywordPool.length,
    usedFallback,
    errorCount: errors.length,
    errors: errors.slice(0, 50),
    note: "AliExpress is treated as a product source like CJ: it fetches high-demand AliExpress products using only AliExpress/dropshipping seed categories. CJ product titles and Google Trends keywords are intentionally not used as AliExpress keywords. If AliExpress blocks or returns no data, old aliexpress-products.json cache is kept."
  });

  console.log(`Saved ${output.length} AliExpress products to ${OUTPUT_PATH}`);
  if (errors.length) console.log(`AliExpress errors: ${errors.length}`);
}

main().catch((err) => {
  console.error(err);

  if (FALLBACK_CACHE && Array.isArray(previousAliExpress) && previousAliExpress.length) {
    console.log(`Fatal AliExpress scrape error. Keeping previous cache with ${previousAliExpress.length} products.`);
    writeJson(OUTPUT_PATH, previousAliExpress.slice(0, MAX_PRODUCTS));
    writeJson(META_PATH, {
      updatedAt: new Date().toISOString(),
      source: "AliExpress",
      mode: "fallback-cache",
      count: Math.min(previousAliExpress.length, MAX_PRODUCTS),
      error: err.message,
      note: "AliExpress scrape failed. Old cache was kept so the full workflow can continue."
    });
    process.exit(0);
  }

  console.log("No AliExpress cache available. Writing empty AliExpress source file so workflow can continue with CJ products.");
  writeJson(OUTPUT_PATH, []);
  writeJson(META_PATH, {
    updatedAt: new Date().toISOString(),
    source: "AliExpress",
    mode: "empty-after-error",
    count: 0,
    error: err.message,
    note: "AliExpress scrape failed and no old cache existed. Workflow continues with CJ products only."
  });
  process.exit(0);
});