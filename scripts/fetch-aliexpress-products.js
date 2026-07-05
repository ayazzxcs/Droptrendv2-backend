import puppeteerBase from "puppeteer";
import { readJson, writeJson, normalizeKeyword, sleep, num } from "./utils.js";

let puppeteer = puppeteerBase;
try {
  const puppeteerExtra = (await import("puppeteer-extra")).default;
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  puppeteerExtra.use(StealthPlugin());
  puppeteer = puppeteerExtra;
  console.log("AliExpress Puppeteer stealth mode enabled");
} catch {
  console.log("AliExpress Puppeteer stealth mode not available; using normal Puppeteer");
}

const MAX_PRODUCTS = Number(process.env.ALIEXPRESS_MAX_PRODUCTS || 750);
const MAX_SEARCHES = Number(process.env.ALIEXPRESS_MAX_SEARCHES || 70);
const PRODUCTS_PER_KEYWORD = Number(process.env.ALIEXPRESS_PRODUCTS_PER_KEYWORD || 24);
const MIN_PRODUCTS_PER_KEYWORD = Number(process.env.ALIEXPRESS_MIN_PRODUCTS_PER_KEYWORD || Math.min(12, PRODUCTS_PER_KEYWORD));
const DELAY_MS = Number(process.env.ALIEXPRESS_DELAY_MS || 2500);
const SEARCH_TIMEOUT_MS = Number(process.env.ALIEXPRESS_TIMEOUT_MS || 60000);
const HEADLESS = String(process.env.ALIEXPRESS_HEADLESS || "true").toLowerCase() !== "false";
const FALLBACK_CACHE = String(process.env.ALIEXPRESS_FALLBACK_CACHE || "true").toLowerCase() !== "false";
const MAX_RETRIES = Number(process.env.ALIEXPRESS_RETRIES || 3);
const CAPTCHA_COOLDOWN_MS = Number(process.env.ALIEXPRESS_CAPTCHA_COOLDOWN_MS || 45000);
const RETRY_FAILED_KEYWORDS = String(process.env.ALIEXPRESS_RETRY_FAILED_KEYWORDS || "true").toLowerCase() !== "false";
const RESET_SESSION_AFTER_KEYWORD = String(process.env.ALIEXPRESS_RESET_SESSION_AFTER_KEYWORD || "false").toLowerCase() === "true";
const SESSION_KEYWORD_BATCH_SIZE = Number(process.env.ALIEXPRESS_SESSION_KEYWORD_BATCH_SIZE || 8);
const BROWSER_RESTART_ON_ZERO = String(process.env.ALIEXPRESS_BROWSER_RESTART_ON_ZERO || "true").toLowerCase() !== "false";
const BROWSER_RESTART_LIMIT = Number(process.env.ALIEXPRESS_BROWSER_RESTART_LIMIT || 3);

const OUTPUT_PATH = process.env.ALIEXPRESS_OUTPUT_PATH || "aliexpress-products.json";
const META_PATH = process.env.ALIEXPRESS_META_PATH || "aliexpress-meta.json";
const KEYWORDS_PATH = process.env.ALIEXPRESS_KEYWORDS_PATH || "aliexpress-keywords.json";

const previousAliExpress = readJson(OUTPUT_PATH, []);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

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
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
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

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function uniqueKey(text) {
  return normalizeKeyword(text)
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  src = src.replace(/\\\//g, "/");
  src = src.split(",")[0].trim().split(/\s+/)[0].trim();
  if (src.startsWith("//")) src = `https:${src}`;
  if (src.startsWith("/")) src = `https:${src}`;
  if (!/^https?:\/\//i.test(src)) return "";
  if (/data:image|blank|placeholder|transparent|base64/i.test(src)) return "";
  return src;
}

function decodeValue(value) {
  try {
    return cleanText(String(value || "")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, "/")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'"));
  } catch {
    return cleanText(value);
  }
}

function parsePrice(text) {
  const s = cleanText(text);

  const currencyMatches = [
    ...s.matchAll(/(?:US\s*)?[$€£₹]\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi),
    ...s.matchAll(/(?:USD|EUR|GBP|INR)\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi),
    ...s.matchAll(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:USD|EUR|GBP|INR)/gi)
  ]
    .map(m => Number(String(m[1]).replace(",", ".")))
    .filter(n => Number.isFinite(n) && n > 0 && n < 100000);

  if (currencyMatches.length) return Math.min(...currencyMatches);

  const generic = [...s.matchAll(/\b([0-9]+(?:[.,][0-9]{1,2})?)\b/g)]
    .map(m => Number(String(m[1]).replace(",", ".")))
    .filter(n => Number.isFinite(n) && n > 0.2 && n < 10000);

  return generic.length ? Math.min(...generic) : 0;
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

function isCaptchaText(text) {
  return /captcha|verify you are human|robot check|security check|unusual traffic|slide to verify|access denied|sorry, we have detected unusual traffic|login required/i.test(String(text || ""));
}

function isCaptchaError(err) {
  return isCaptchaText(err?.message || err);
}

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0];
}

function makeAliExpressUrl(keyword, page = 1) {
  const url = new URL("https://www.aliexpress.com/wholesale");
  url.searchParams.set("SearchText", keyword);
  url.searchParams.set("sortType", "total_tranpro_desc");
  url.searchParams.set("page", String(page));
  url.searchParams.set("trafficChannel", "main");
  url.searchParams.set("g", "y");
  url.searchParams.set("d", "y");
  return url.toString();
}

function makeAliExpressUrlVariants(keyword, page = 1) {
  const encoded = encodeURIComponent(keyword);
  const slug = normalizeKeyword(keyword).replace(/\s+/g, "-");
  return [
    makeAliExpressUrl(keyword, page),
    `https://www.aliexpress.com/w/wholesale-${slug}.html?SearchText=${encoded}&sortType=total_tranpro_desc&page=${page}&g=y&d=y&trafficChannel=main`,
    `https://www.aliexpress.us/w/wholesale-${slug}.html?SearchText=${encoded}&sortType=total_tranpro_desc&page=${page}&g=y&d=y&trafficChannel=main`
  ];
}

function makeKeywordSearchVariants(keyword) {
  const base = normalizeKeyword(keyword);
  const variants = [base];
  const fallbackMap = {
    "neck fan": ["portable neck fan", "usb neck fan", "portable fan", "mini fan"],
    "desk lamp": ["led desk lamp", "study lamp", "table lamp"],
    "kids toys": ["children toys", "baby toys", "educational toys"],
    "car vacuum": ["portable car vacuum", "wireless car vacuum", "mini vacuum cleaner"],
    "humidifier": ["mini humidifier", "usb humidifier", "air humidifier"],
    "led lights": ["led strip lights", "rgb led lights", "room led lights"],
    "nail tools": ["nail art tools", "manicure tools", "nail drill"],
    "massage tools": ["massage gun", "neck massager", "body massager"],
    "mini printer": ["portable printer", "thermal printer", "label printer"],
    "mosquito lamp": ["mosquito killer lamp", "bug zapper", "mosquito trap"],
    "shoe organizer": ["shoe rack", "shoe storage", "closet shoe organizer"],
    "laundry organizer": ["laundry basket", "laundry storage", "laundry bag"],
    "wall hooks": ["adhesive wall hooks", "storage hooks", "kitchen hooks"],
    "silicone mold": ["resin mold", "cake mold", "silicone baking mold"],
    "coffee accessories": ["coffee tools", "espresso accessories", "coffee grinder"],
    "home gadgets": ["smart home gadgets", "useful home gadgets", "household gadgets"],
    "kitchen gadgets": ["kitchen tools", "kitchen accessories", "cooking gadgets"],
    "pet supplies": ["pet accessories", "dog supplies", "cat supplies"],
    "beauty tools": ["beauty devices", "makeup tools", "skin care tools"],
    "phone accessories": ["mobile phone accessories", "iphone accessories", "phone holder"],
    "car accessories": ["auto accessories", "car interior accessories", "car gadgets"],
    "room decor": ["home decor", "bedroom decor", "wall decor"],
    "travel accessories": ["travel gadgets", "luggage accessories", "travel organizer"],
    "fitness equipment": ["workout equipment", "fitness accessories", "resistance bands"],
    "yoga accessories": ["yoga mat", "yoga equipment", "pilates accessories"],
    "baby products": ["baby accessories", "baby care", "baby toys"],
    "summer dress": ["women summer dress", "beach dress", "casual dress"],
    "women dress": ["women dresses", "casual dress", "party dress"],
    "mens fashion": ["men fashion", "mens clothing", "men accessories"],
    "storage organizer": ["home organizer", "storage box", "closet organizer"],
    "bathroom organizer": ["bathroom storage", "shower organizer", "toothbrush holder"],
    "makeup organizer": ["cosmetic organizer", "makeup storage", "beauty organizer"],
    "smart watch accessories": ["watch strap", "smartwatch band", "apple watch band"],
    "wireless earbuds": ["bluetooth earbuds", "wireless headphones", "earphones"],
    "portable blender": ["mini blender", "usb blender", "juice blender"],
    "electric chopper": ["food chopper", "mini chopper", "garlic chopper"],
    "gaming accessories": ["gaming gadgets", "game controller", "gaming keyboard"],
    "outdoor camping": ["camping gear", "camping accessories", "outdoor gear"],
    "garden tools": ["gardening tools", "garden accessories", "plant tools"],
    "jewelry accessories": ["fashion jewelry", "earrings", "necklace"]
  };

  for (const v of fallbackMap[base] || []) variants.push(v);

  const words = base.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    variants.push(words.slice(-2).join(" "));
    variants.push(words[words.length - 1]);
  }

  return [...new Set(variants.map(normalizeKeyword).filter(Boolean))].slice(0, 5);
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

  for (const item of SEED_KEYWORDS) add(item, 3);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEARCHES)
    .map(([keyword, weight]) => ({ keyword, weight }));
}

function extractProductLikeObjects(obj, sourceUrl = "", out = [], depth = 0, seen = new Set()) {
  if (!obj || depth > 12 || out.length > 500) return out;
  if (typeof obj !== "object") return out;
  if (seen.has(obj)) return out;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) extractProductLikeObjects(item, sourceUrl, out, depth + 1, seen);
    return out;
  }

  const get = (...keys) => {
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return "";
  };

  const nested = (...paths) => {
    for (const path of paths) {
      let cur = obj;
      for (const part of path) cur = cur?.[part];
      if (cur !== undefined && cur !== null && cur !== "") return cur;
    }
    return "";
  };

  let productId = String(get("productId", "itemId", "itemIdStr", "id", "product_id", "item_id") || "").trim();
  let title = decodeValue(get("title", "productTitle", "subject", "productName", "itemTitle", "displayTitle", "name") || nested(["title", "displayTitle"], ["productTitle", "displayTitle"]));
  let url = safeUrl(get("url", "itemUrl", "productUrl", "detailUrl", "targetUrl", "productDetailUrl") || nested(["action", "url"], ["target", "url"]));
  let image = absoluteImage(get("image", "imageUrl", "imgUrl", "imgSrc", "productImage", "productImageUrl", "mainImage", "itemImage") || nested(["image", "url"], ["image", "imgUrl"], ["productImage", "url"], ["mainImage", "url"]));

  if (!image && Array.isArray(obj.images)) {
    for (const img of obj.images) {
      image = absoluteImage(typeof img === "string" ? img : (img?.url || img?.imgUrl || img?.imageUrl));
      if (image) break;
    }
  }

  if (!url && productId) url = `https://www.aliexpress.com/item/${productId}.html`;
  if (!productId && url) productId = url.match(/\/item\/(\d+)\.html/i)?.[1] || "";

  const priceText = cleanText(
    get("price", "salePrice", "formattedPrice", "displayPrice", "priceText", "minPrice", "maxPrice") ||
    nested(["salePrice", "formattedPrice"], ["price", "formattedPrice"], ["price", "displayPrice"], ["prices", "salePrice", "formattedPrice"])
  );
  const soldText = cleanText(get("orders", "ordersCount", "sold", "soldCount", "tradeCount", "tradeDesc", "soldText", "sales") || nested(["trade", "tradeDesc"]));
  const ratingText = cleanText(get("rating", "averageStar", "starRating", "avgRating") || nested(["evaluation", "starRating"]));
  const discountText = cleanText(get("discount", "discountPercent", "discountText", "promotionText"));

  const titleLooksReal = title && title.length >= 8 && title.length <= 260 && !/^(shop now|free shipping|choice|sponsored)$/i.test(title);
  const hasItemIdentity = productId || /\/item\/\d+\.html/i.test(url);

  if (titleLooksReal && image && (url || productId) && hasItemIdentity) {
    out.push({
      productId,
      title,
      url,
      image,
      text: cleanText(`${title} ${priceText} ${soldText} ${ratingText} ${discountText}`),
      priceText,
      soldText,
      ratingText,
      discountText,
      sourceUrl
    });
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") extractProductLikeObjects(value, sourceUrl, out, depth + 1, seen);
  }

  return out;
}

function extractProductsFromText(text, sourceUrl = "") {
  const out = [];
  const raw = String(text || "");
  if (!raw || raw.length < 200) return out;

  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const data = JSON.parse(trimmed);
      extractProductLikeObjects(data, sourceUrl, out);
    } catch {}
  }

  if (out.length >= 40) return dedupeRawProducts(out).slice(0, 300);

  const idRegex = /["']?(?:productId|itemId|itemIdStr|item_id|product_id)["']?\s*[:=]\s*["']?(\d{8,})["']?/gi;
  let match;
  let guard = 0;

  while ((match = idRegex.exec(raw)) && guard++ < 250) {
    const productId = match[1];
    const start = Math.max(0, match.index - 5000);
    const end = Math.min(raw.length, match.index + 9000);
    const chunk = raw.slice(start, end);

    const firstRegex = (patterns) => {
      for (const pattern of patterns) {
        const m = chunk.match(pattern);
        if (m && m[1]) return decodeValue(m[1]);
      }
      return "";
    };

    const title = firstRegex([
      /["'](?:title|productTitle|subject|productName|displayTitle|itemTitle)["']\s*:\s*["']([^"']{8,260})["']/i,
      /alt=["']([^"']{8,260})["']/i
    ]);

    let image = firstRegex([
      /["'](?:imageUrl|image|imgUrl|imgSrc|productImage|mainImage|itemImage)["']\s*:\s*["']([^"']+?(?:\.jpg|\.jpeg|\.png|\.webp)[^"']*)["']/i,
      /(https?:\\?\/\\?\/[^"'\s]+?\.(?:jpg|jpeg|png|webp)[^"'\s]*)/i,
      /(\\?\/\\?\/[^"'\s]+?\.(?:jpg|jpeg|png|webp)[^"'\s]*)/i
    ]);
    image = absoluteImage(image);

    let url = firstRegex([
      /["'](?:itemUrl|productUrl|url|detailUrl|targetUrl)["']\s*:\s*["']([^"']*\/item\/\d+\.html[^"']*)["']/i,
      /(https?:\\?\/\\?\/[^"'\s]+?\/item\/\d+\.html[^"'\s]*)/i,
      /(\\?\/\\?\/[^"'\s]+?\/item\/\d+\.html[^"'\s]*)/i
    ]).replace(/\\\//g, "/");
    if (url.startsWith("//")) url = `https:${url}`;
    if (!url) url = `https://www.aliexpress.com/item/${productId}.html`;
    url = safeUrl(url);

    const priceText = firstRegex([
      /["'](?:salePrice|price|formattedPrice|displayPrice|minPrice|priceText)["']\s*:\s*["']([^"']{1,80})["']/i,
      /((?:US\s*)?\$\s*[0-9][0-9.,]*)/i
    ]);

    const soldText = firstRegex([
      /["'](?:orders|ordersCount|sold|soldCount|tradeCount|tradeDesc|trade)["']\s*:\s*["']?([^,"'}]{1,60})/i,
      /([0-9]+(?:[.,][0-9]+)?[km]?\s*(?:sold|orders|ordered|purchased))/i
    ]);

    const ratingText = firstRegex([
      /["'](?:rating|averageStar|starRating|avgRating)["']\s*:\s*["']?([1-5](?:\.\d)?)/i
    ]);

    const discountText = firstRegex([
      /["'](?:discount|discountPercent|discountText)["']\s*:\s*["']?([0-9]{1,2}%?)/i,
      /(\d{1,2}\s*%\s*off)/i
    ]);

    if (title && image && url) {
      out.push({ productId, title, url, image, text: chunk.slice(0, 1200), priceText, soldText, ratingText, discountText, sourceUrl });
    }
  }

  return dedupeRawProducts(out).slice(0, 300);
}

function rawProductKey(p) {
  const id = String(p.productId || "").trim();
  if (id) return `id:${id}`;
  const url = safeUrl(p.url);
  if (url) return `url:${url.replace(/[?#].*$/, "")}`;
  return `name:${uniqueKey(`${p.title} ${p.image}`).slice(0, 120)}`;
}

function dedupeRawProducts(items) {
  const map = new Map();
  for (const item of items || []) {
    if (!item) continue;
    const key = rawProductKey(item);
    if (!key) continue;
    const prev = map.get(key);
    const itemScore = (item.title ? 1 : 0) + (item.url ? 1 : 0) + (item.image ? 1 : 0) + (item.priceText ? 1 : 0) + (item.soldText ? 1 : 0);
    const prevScore = prev ? (prev.title ? 1 : 0) + (prev.url ? 1 : 0) + (prev.image ? 1 : 0) + (prev.priceText ? 1 : 0) + (prev.soldText ? 1 : 0) : -1;
    if (!prev || itemScore > prevScore) map.set(key, item);
  }
  return [...map.values()];
}

function normalizeProduct(raw, keyword, rank) {
  const title = cleanText(first(raw.title, raw.name, raw.productTitle));
  const url = safeUrl(first(raw.url, raw.productUrl, raw.href));
  const productId =
    String(first(raw.productId, raw.itemId, raw.id, url.match(/\/item\/(\d+)\.html/i)?.[1], "")).trim() ||
    hashId(`${title}|${url}|${keyword}`);

  const price = num(first(raw.price, raw.salePrice, parsePrice(raw.priceText || raw.text)));
  const originalPrice = num(first(raw.originalPrice, raw.originalPriceText, price));
  const orders = num(first(raw.orders, raw.sold, raw.soldCount, parseOrders(raw.soldText || raw.text)));
  const rating = num(first(raw.rating, raw.averageStar, parseRating(raw.ratingText || raw.text)));
  const discount = num(first(raw.discount, raw.discountPercent, parseDiscount(raw.discountText || raw.text)));
  const image = absoluteImage(first(raw.image, raw.imageUrl, raw.img));

  // For Quvirl + Amazon Lens, image/title/URL are the critical fields.
  // Keep valid product cards even when AliExpress hides price in headless mode.
  if (!title || !url || !image) return null;

  const hasPrice = price > 0;
  const sell = hasPrice ? Math.ceil(price * 2.25) : 0;
  const shipping = 0;
  const profit = hasPrice ? Math.max(0, sell - price - shipping) : 0;
  const margin = sell ? Math.round((profit / sell) * 100) : 0;
  const listedCount = Math.max(orders, num(raw.listedCount));

  const sourceScore = computeAliExpressSourceScore({ image, price, orders, rating, discount, margin, rank });

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
    tags: ["AliExpress product", "AliExpress top search page"],
    raw
  };
}

function computeAliExpressSourceScore(p) {
  let score = 0;
  if (p.image) score += 18;
  if (p.price > 0) score += 12;
  score += Math.min(30, Math.log10(num(p.orders) + 1) * 12);
  score += Math.min(20, Math.max(0, num(p.rating) - 3.5) * 14);
  score += Math.min(8, num(p.discount) / 8);
  score += Math.min(6, Math.max(0, num(p.margin) - 35) * 0.2);
  if (p.rank <= 5) score += 8;
  else if (p.rank <= 12) score += 4;
  return Math.round(Math.max(1, Math.min(100, score)));
}

async function extractDomCards(page) {
  return await page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const isItemLink = (href) => /\/item\/\d+\.html/i.test(href || "") || /aliexpress\.[^/]+\/item\//i.test(href || "");

    const bestImage = (node) => {
      const imgs = [...(node?.querySelectorAll?.("img, source") || [])];
      const attrs = ["src", "data-src", "data-lazy-src", "data-original", "srcset", "data-srcset", "currentSrc"];
      for (const img of imgs) {
        for (const attr of attrs) {
          let v = attr === "currentSrc" ? img.currentSrc : img.getAttribute(attr);
          if (!v) continue;
          v = String(v).split(",")[0].trim().split(/\s+/)[0].trim();
          if (v.startsWith("//")) v = `https:${v}`;
          if (/^https?:\/\//i.test(v) && !/data:image|blank|placeholder|transparent/i.test(v)) return v;
        }
      }
      return "";
    };

    const findCardRoot = (link) => {
      let root = link;
      let best = link;
      for (let i = 0; i < 10 && root; i++) {
        const text = clean(root.innerText || "");
        const imgs = root.querySelectorAll?.("img").length || 0;
        const itemLinks = root.querySelectorAll?.('a[href*="/item/"]').length || 0;
        if (imgs && text.length >= 5 && text.length <= 2200 && itemLinks <= 6) best = root;
        root = root.parentElement;
      }
      return best;
    };

    const links = [...document.querySelectorAll('a[href*="/item/"]')];
    const out = [];
    const seen = new Set();

    for (const link of links) {
      const href = link.href || link.getAttribute("href") || "";
      if (!isItemLink(href) || seen.has(href)) continue;
      seen.add(href);

      const root = findCardRoot(link);
      const img = link.querySelector("img") || root?.querySelector("img");
      const imgSrc = bestImage(link) || bestImage(root) || img?.src || "";
      const rootText = clean(root?.innerText || "");
      const linkText = clean(link.innerText || "");
      const aria = clean(link.getAttribute("aria-label") || link.getAttribute("title") || "");
      const imgAlt = clean(img?.getAttribute("alt") || "");

      let title = clean(aria || imgAlt || linkText);
      if (!title || title.length < 8 || /^(shop now|free shipping|choice|sponsored)$/i.test(title)) {
        const lines = rootText
          .split(/\n|\||(?=US\s*\$)|(?=[$€£₹])/)
          .map(clean)
          .filter(Boolean);
        title = lines.find(line =>
          line.length >= 8 &&
          line.length <= 240 &&
          !/(sold|orders|ordered|free shipping|choice|coupon|%\s*off|US\s*\$|[$€£₹]|sponsored)/i.test(line)
        ) || clean(rootText.split(/(?:US\s*)?[$€£₹]/)[0]);
      }

      title = clean(title)
        .replace(/\bUS\s*\$.*$/i, "")
        .replace(/\s*-\s*AliExpress.*$/i, "")
        .slice(0, 240)
        .trim();

      const productId = href.match(/\/item\/(\d+)\.html/i)?.[1] || "";
      const priceText = clean(
        rootText.match(/(?:US\s*)?[$€£₹]\s*[0-9][0-9.,]*(?:\s*-\s*(?:US\s*)?[$€£₹]?\s*[0-9][0-9.,]*)?/i)?.[0] ||
        rootText.match(/(?:USD|EUR|GBP|INR)\s*[0-9][0-9.,]*/i)?.[0] ||
        ""
      );
      const ratingText = clean(rootText.match(/\b[1-5](?:\.\d)?\b\s*(?:\/\s*5|stars?)?/i)?.[0] || "");
      const soldText = clean(rootText.match(/[0-9]+(?:[.,][0-9]+)?[km]?\s*(?:sold|orders|ordered|purchased)/i)?.[0] || "");
      const discountText = clean(rootText.match(/\d{1,2}\s*%\s*off/i)?.[0] || "");

      out.push({ productId, title, url: href, image: imgSrc, text: rootText, priceText, ratingText, soldText, discountText, source: "dom" });
    }

    return out.slice(0, 250);
  });
}

async function fullPageScroll(page) {
  let lastHeight = 0;
  let sameHeight = 0;
  for (let i = 0; i < 22; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85))).catch(() => null);
    await sleep(850 + Math.floor(Math.random() * 550));

    const stats = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
      itemLinks: document.querySelectorAll('a[href*="/item/"]').length,
      bodyText: document.body?.innerText?.length || 0
    })).catch(() => ({ height: 0, itemLinks: 0, bodyText: 0 }));

    if (stats.height <= lastHeight + 10) sameHeight += 1;
    else sameHeight = 0;
    lastHeight = Math.max(lastHeight, stats.height);

    if (sameHeight >= 4 && stats.itemLinks >= 30) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => null);
  await sleep(800);
}

async function waitForNetworkIdleSafe(page, timeout = 18000) {
  try {
    if (typeof page.waitForNetworkIdle === "function") {
      await page.waitForNetworkIdle({ idleTime: 1000, timeout });
      return;
    }
  } catch {}
  await sleep(1500);
}

function attachNetworkCollector(page) {
  const bucket = [];
  let active = true;

  const handler = async (response) => {
    if (!active) return;
    try {
      const url = response.url();
      const headers = response.headers() || {};
      const type = String(headers["content-type"] || "").toLowerCase();
      if (!/aliexpress|alicdn|ae\.mmstat|aep|glosearch|wholesale|search/i.test(url)) return;
      if (!/json|javascript|text|html/.test(type) && !/api|search|product|wholesale|glosearch/i.test(url)) return;
      const text = await response.text().catch(() => "");
      if (!/productId|itemId|itemIdStr|\/item\/\d+\.html|productTitle|imageUrl/i.test(text)) return;
      const products = extractProductsFromText(text, url);
      if (products.length) bucket.push(...products);
    } catch {}
  };

  page.on("response", handler);

  return {
    mark: () => bucket.length,
    since: (mark) => bucket.slice(mark),
    stop: () => {
      active = false;
      page.off("response", handler);
    }
  };
}

async function createBrowserContext(browser) {
  if (typeof browser.createBrowserContext === "function") return await browser.createBrowserContext();
  if (typeof browser.createIncognitoBrowserContext === "function") return await browser.createIncognitoBrowserContext();
  return browser.defaultBrowserContext();
}

async function createAliExpressPage(browser) {
  const context = await createBrowserContext(browser);
  const page = await context.newPage();

  await page.setViewport({ width: 1920, height: 2200, deviceScaleFactor: 1 });
  await page.setUserAgent(pickUserAgent());
  await page.setCacheEnabled(false).catch(() => null);
  await page.setBypassCSP(true).catch(() => null);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1"
  });

  if (typeof page.emulateTimezone === "function") await page.emulateTimezone("America/New_York").catch(() => null);

  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    } catch {}
  });

  await page.setCookie(
    { name: "aep_usuc_f", value: "site=glo&c_tp=USD&region=US&b_locale=en_US", domain: ".aliexpress.com", path: "/" },
    { name: "intl_locale", value: "en_US", domain: ".aliexpress.com", path: "/" },
    { name: "xman_us_f", value: "x_l=0&x_locale=en_US", domain: ".aliexpress.com", path: "/" },
    { name: "aep_usuc_f", value: "site=glo&c_tp=USD&region=US&b_locale=en_US", domain: ".aliexpress.us", path: "/" },
    { name: "intl_locale", value: "en_US", domain: ".aliexpress.us", path: "/" }
  ).catch(() => null);

  return { context, page };
}

async function closeContext(obj) {
  if (!obj) return;
  if (obj.collector) obj.collector.stop();
  if (obj.page && !obj.page.isClosed()) {
    try { await obj.page.close(); } catch {}
  }
  if (obj.context) {
    try { await obj.context.close(); } catch {}
  }
}

async function createAliExpressSession(browser) {
  const session = await createAliExpressPage(browser);
  session.collector = attachNetworkCollector(session.page);
  session.keywordsUsed = 0;

  try {
    await session.page.goto("https://www.aliexpress.com/", { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
    await waitForNetworkIdleSafe(session.page, 8000);
    await sleep(2500 + Math.floor(Math.random() * 1500));
  } catch (err) {
    console.log(`AliExpress warmup skipped: ${err.message}`);
  }

  return session;
}

async function resetAliExpressSession(browser, state, reason = "reset") {
  if (state.session) {
    await closeContext(state.session);
    state.session = null;
  }
  console.log(`AliExpress browser session reset: ${reason}`);
  state.session = await createAliExpressSession(browser);
  return state.session;
}

async function getAliExpressSession(browser, state) {
  if (!state.session) return await resetAliExpressSession(browser, state, "initial session");
  if (RESET_SESSION_AFTER_KEYWORD) return await resetAliExpressSession(browser, state, "forced reset after keyword");
  if (SESSION_KEYWORD_BATCH_SIZE > 0 && state.session.keywordsUsed >= SESSION_KEYWORD_BATCH_SIZE) {
    return await resetAliExpressSession(browser, state, `batch limit ${SESSION_KEYWORD_BATCH_SIZE}`);
  }
  return state.session;
}

async function fetchKeywordProducts(page, collector, keyword, attempt = 1) {
  console.log(`AliExpress search: ${keyword}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);

  let bestProducts = [];
  let bestRawCount = 0;
  let captchaError = null;
  const searchVariants = makeKeywordSearchVariants(keyword);

  for (const searchKeyword of searchVariants) {
    if (searchKeyword !== keyword) console.log(`AliExpress fallback query for ${keyword}: ${searchKeyword}`);

    for (const url of makeAliExpressUrlVariants(searchKeyword, 1)) {
      const networkMark = collector.mark();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await waitForNetworkIdleSafe(page, 18000);
      await sleep(4500 + Math.floor(Math.random() * 2500));

      const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      if (isCaptchaText(bodyText)) {
        captchaError = new Error(`AliExpress captcha/security check for keyword: ${keyword}`);
        continue;
      }

      await page.waitForFunction(() => document.querySelectorAll('a[href*="/item/"]').length > 0 || document.body.innerText.length > 500, { timeout: 12000 }).catch(() => null);
      await fullPageScroll(page);
      await waitForNetworkIdleSafe(page, 12000);

      const domCards = await extractDomCards(page).catch(() => []);
      const networkCards = collector.since(networkMark);
      const html = await page.content().catch(() => "");
      const htmlCards = extractProductsFromText(html, url);
      const rawCards = dedupeRawProducts([...domCards, ...networkCards, ...htmlCards]);

      console.log(
        `AliExpress extracted for ${keyword}${searchKeyword !== keyword ? ` via ${searchKeyword}` : ""}: ` +
        `dom=${domCards.length}, network=${networkCards.length}, html=${htmlCards.length}, merged=${rawCards.length}`
      );

      bestRawCount = Math.max(bestRawCount, rawCards.length);

      const products = rawCards
        .map((card, index) => ({
          ...card,
          price: parsePrice(card.priceText || card.text),
          orders: parseOrders(card.soldText || card.text),
          rating: parseRating(card.ratingText || card.text),
          discount: parseDiscount(card.discountText || card.text)
        }))
        .map((card, index) => normalizeProduct(card, searchKeyword, index + 1))
        .filter(Boolean)
        .slice(0, PRODUCTS_PER_KEYWORD);

      if (products.length > bestProducts.length) bestProducts = products;
      if (products.length >= MIN_PRODUCTS_PER_KEYWORD || products.length >= PRODUCTS_PER_KEYWORD) return products;

      console.log(
        `AliExpress low usable count for ${keyword}${searchKeyword !== keyword ? ` via ${searchKeyword}` : ""}: ` +
        `${products.length} usable from ${rawCards.length} raw. Trying alternate URL/query...`
      );
      await sleep(1800 + Math.floor(Math.random() * 1200));
    }
  }

  if (bestProducts.length) return bestProducts;
  if (captchaError) throw captchaError;
  throw new Error(`AliExpress low/empty product page for keyword: ${keyword}; best raw count ${bestRawCount}`);
}

async function fetchKeywordProductsWithRetries(browser, state, keyword) {
  let lastError = null;
  let bestProducts = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let session = await getAliExpressSession(browser, state);

    try {
      const products = await fetchKeywordProducts(session.page, session.collector, keyword, attempt);
      session.keywordsUsed += 1;

      if (products.length > bestProducts.length) bestProducts = products;

      if (products.length >= MIN_PRODUCTS_PER_KEYWORD || products.length >= PRODUCTS_PER_KEYWORD) {
        state.emptyStreak = 0;
        return products;
      }

      // Keep partial valid products, but retry once in a fresh session to try to recover the full page.
      if (products.length > 0 && attempt >= 2) {
        console.log(`AliExpress accepting partial usable count for ${keyword}: ${products.length} products after retry`);
        state.emptyStreak = 0;
        return products;
      }

      throw new Error(`AliExpress low/empty product count for keyword: ${keyword}: ${products.length}`);
    } catch (err) {
      lastError = err;
      const captcha = isCaptchaError(err);
      console.log(`AliExpress attempt failed: ${keyword}: ${err.message}`);

      // A zero/blocked page usually poisons the current session. Reset before retrying same keyword.
      await resetAliExpressSession(browser, state, captcha ? `captcha on ${keyword}` : `low/empty page on ${keyword}`);

      if (captcha && attempt < MAX_RETRIES) {
        console.log(`AliExpress captcha retry queued for same keyword: ${keyword}. Cooling down ${CAPTCHA_COOLDOWN_MS}ms`);
        await sleep(CAPTCHA_COOLDOWN_MS);
      } else if (attempt < MAX_RETRIES) {
        await sleep(Math.min(20000, DELAY_MS * attempt + 2500));
      }
    }
  }

  if (bestProducts.length) {
    console.log(`AliExpress using best partial result for ${keyword}: ${bestProducts.length} products`);
    return bestProducts;
  }

  state.emptyStreak = (state.emptyStreak || 0) + 1;
  throw lastError || new Error(`AliExpress failed for keyword: ${keyword}`);
}

function dedupeProducts(products) {
  const byKey = new Map();
  function score(p) {
    return num(p.winningScore) + num(p.sourceScore) + Math.min(50, Math.log10(num(p.orders) + 1) * 15);
  }

  for (const p of products) {
    const key = p.sourceProductId ? `id:${p.sourceProductId}` :
      p.supplierUrl ? `url:${p.supplierUrl.replace(/[?#].*$/, "")}` :
      `name:${uniqueKey(p.name).split(/\s+/).slice(0, 8).join(" ")}`;
    const prev = byKey.get(key);
    if (!prev || score(p) > score(prev)) byKey.set(key, p);
  }

  return [...byKey.values()];
}


async function launchAliExpressBrowser(reason = "launch") {
  console.log(`AliExpress browser launch: ${reason}`);
  return await puppeteer.launch({
    headless: HEADLESS ? "new" : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,2200"
    ]
  });
}

function isZeroLikeAliExpressError(err) {
  return /low\/empty|empty product page|0 usable|captcha|security check|blocked|access denied|unusual traffic/i.test(String(err?.message || err || ""));
}

async function hardRestartAliExpressBrowser(state, browser, reason) {
  console.log(`AliExpress HARD browser restart: ${reason}`);
  try { await closeContext(state.session); } catch {}
  state.session = null;
  state.emptyStreak = 0;
  try { await browser.close(); } catch {}
  await sleep(5000 + Math.floor(Math.random() * 3000));
  return await launchAliExpressBrowser(reason);
}

async function main() {
  const keywordPool = buildKeywordPool();
  writeJson(KEYWORDS_PATH, keywordPool);
  console.log(`AliExpress keyword pool: ${keywordPool.length} searches`);
  console.log(`Target AliExpress products: ${MAX_PRODUCTS}`);

  const all = [];
  const errors = [];
  const delayedRetry = [];

  const sessionState = { session: null, emptyStreak: 0 };

  let browser = await launchAliExpressBrowser("initial browser");
  let hardRestartCount = 0;

  try {
    for (const item of keywordPool) {
      if (all.length >= MAX_PRODUCTS) break;
      try {
        const products = await fetchKeywordProductsWithRetries(browser, sessionState, item.keyword);
        console.log(`AliExpress ${item.keyword}: ${products.length} products`);
        all.push(...products);
        const deduped = dedupeProducts(all);
        all.length = 0;
        all.push(...deduped);
        console.log(`AliExpress unique collected: ${all.length}/${MAX_PRODUCTS}`);
      } catch (err) {
        console.log(`AliExpress keyword failed after retries: ${item.keyword}: ${err.message}`);

        // If AliExpress gives a zero/blocked session, context reset is sometimes not enough.
        // Relaunch the whole Chrome browser and retry the same keyword once before moving on.
        if (BROWSER_RESTART_ON_ZERO && hardRestartCount < BROWSER_RESTART_LIMIT && isZeroLikeAliExpressError(err)) {
          hardRestartCount += 1;
          browser = await hardRestartAliExpressBrowser(sessionState, browser, `zero/blocked keyword ${item.keyword} (${hardRestartCount}/${BROWSER_RESTART_LIMIT})`);
          try {
            const products = await fetchKeywordProductsWithRetries(browser, sessionState, item.keyword);
            console.log(`AliExpress ${item.keyword} after hard restart: ${products.length} products`);
            all.push(...products);
            const deduped = dedupeProducts(all);
            all.length = 0;
            all.push(...deduped);
            console.log(`AliExpress unique collected: ${all.length}/${MAX_PRODUCTS}`);
            await sleep(DELAY_MS + Math.floor(Math.random() * 1600));
            continue;
          } catch (retryErr) {
            console.log(`AliExpress hard restart retry failed: ${item.keyword}: ${retryErr.message}`);
            errors.push({ keyword: item.keyword, error: `hard restart retry: ${retryErr.message}` });
          }
        } else {
          errors.push({ keyword: item.keyword, error: err.message });
        }

        if (RETRY_FAILED_KEYWORDS && isCaptchaError(err)) delayedRetry.push(item);
      }
      await sleep(DELAY_MS + Math.floor(Math.random() * 1600));
    }

    if (RETRY_FAILED_KEYWORDS && all.length < MAX_PRODUCTS && delayedRetry.length) {
      console.log(`Retrying ${delayedRetry.length} captcha-blocked AliExpress keywords after cooldown.`);
      await sleep(CAPTCHA_COOLDOWN_MS);
      for (const item of delayedRetry) {
        if (all.length >= MAX_PRODUCTS) break;
        try {
          const products = await fetchKeywordProductsWithRetries(browser, sessionState, item.keyword);
          console.log(`AliExpress delayed retry ${item.keyword}: ${products.length} products`);
          all.push(...products);
          const deduped = dedupeProducts(all);
          all.length = 0;
          all.push(...deduped);
          console.log(`AliExpress unique collected: ${all.length}/${MAX_PRODUCTS}`);
        } catch (err) {
          console.log(`AliExpress delayed retry failed: ${item.keyword}: ${err.message}`);
          errors.push({ keyword: item.keyword, error: `delayed retry: ${err.message}` });
        }
        await sleep(DELAY_MS + Math.floor(Math.random() * 1800));
      }
    }
  } finally {
    await closeContext(sessionState.session);
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
    mode: "Puppeteer persistent-session page-1 DOM + network + HTML extractor",
    count: output.length,
    maxProducts: MAX_PRODUCTS,
    maxSearches: MAX_SEARCHES,
    productsPerKeyword: PRODUCTS_PER_KEYWORD,
    minProductsPerKeyword: MIN_PRODUCTS_PER_KEYWORD,
    maxRetries: MAX_RETRIES,
    captchaCooldownMs: CAPTCHA_COOLDOWN_MS,
    retryFailedKeywords: RETRY_FAILED_KEYWORDS,
    resetSessionAfterKeyword: RESET_SESSION_AFTER_KEYWORD,
    sessionKeywordBatchSize: SESSION_KEYWORD_BATCH_SIZE,
    browserRestartOnZero: BROWSER_RESTART_ON_ZERO,
    browserRestartLimit: BROWSER_RESTART_LIMIT,
    keywordCount: keywordPool.length,
    usedFallback,
    errorCount: errors.length,
    errors: errors.slice(0, 80),
    note: "AliExpress is treated as a product source like CJ. It fetches page 1 sorted by orders/sales for AliExpress/dropshipping seed categories. This version uses Puppeteer with a persistent warm AliExpress session, automatic session reset only on zero/captcha/low-count pages, tall viewport, deeper scrolling, visible DOM extraction, network-response extraction, and safe HTML hydration extraction. It keeps products with title + URL + image even if price is hidden, so Amazon Lens still has usable product images. Zero/low-count pages are retried in fresh sessions, and if the session remains empty the whole Chrome browser is relaunched once for that keyword before moving on. CJ product titles and Google Trends keywords are intentionally not used as AliExpress keywords. If AliExpress blocks or returns no data, old aliexpress-products.json cache is kept."
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
