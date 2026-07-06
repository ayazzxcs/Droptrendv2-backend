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
const SESSION_KEYWORD_BATCH_SIZE = Number(process.env.ALIEXPRESS_SESSION_KEYWORD_BATCH_SIZE || 0);

const OUTPUT_PATH = process.env.ALIEXPRESS_OUTPUT_PATH || "aliexpress-products.json";
const META_PATH = process.env.ALIEXPRESS_META_PATH || "aliexpress-meta.json";
const KEYWORDS_PATH = process.env.ALIEXPRESS_KEYWORDS_PATH || "aliexpress-keywords.json";

const DISCOVER_KEYWORDS_FROM_ALIEXPRESS = String(process.env.ALIEXPRESS_DISCOVER_KEYWORDS || "true").toLowerCase() !== "false";
const DISCOVERY_CANDIDATE_LIMIT = Number(process.env.ALIEXPRESS_DISCOVERY_CANDIDATE_LIMIT || 90);
const DISCOVERY_VALIDATION_LIMIT = Number(process.env.ALIEXPRESS_DISCOVERY_VALIDATION_LIMIT || 45);
const DISCOVERY_MIN_PRODUCTS = Number(process.env.ALIEXPRESS_DISCOVERY_MIN_PRODUCTS || 8);
const STATIC_FALLBACK_ON_DISCOVERY_FAIL = String(process.env.ALIEXPRESS_STATIC_FALLBACK_ON_DISCOVERY_FAIL || "true").toLowerCase() !== "false";

// Stop wasting runtime once the AliExpress discovery probe reaches the weak/empty tail.
// This prevents logs like many repeated "usable=0, raw=0, network=0, html=0" after the
// strong keywords have already been found.
const DISCOVERY_EMPTY_STREAK_LIMIT = Number(process.env.ALIEXPRESS_DISCOVERY_EMPTY_STREAK_LIMIT || 2);
const DISCOVERY_MAX_EMPTY_PROBES = Number(process.env.ALIEXPRESS_DISCOVERY_MAX_EMPTY_PROBES || 5);
const DISCOVERY_MIN_CHECKS_BEFORE_EMPTY_STOP = Number(process.env.ALIEXPRESS_DISCOVERY_MIN_CHECKS_BEFORE_EMPTY_STOP || 12);

const keywordFallbackVariants = new Map();

const previousAliExpress = readJson(OUTPUT_PATH, []);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

const STATIC_FALLBACK_KEYWORDS = [
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


const DISCOVERY_JUNK_EXACT = new Set([
  "all", "all item", "all items", "over all", "overall", "sold", "score", "icon", "icons", "welcome",
  "summer fun", "shop now", "view all", "see all", "view more", "learn more", "more", "new", "hot",
  "sale", "deal", "deals", "coupon", "coupons", "free shipping", "choice", "super deals",
  "top ranking", "best sellers", "new arrivals", "download app", "app only", "help center",
  "buyer protection", "sign in", "account", "cart", "wishlist", "orders", "order", "store", "official store",
  "home page", "homepage", "category", "categories", "product", "products", "wholesale", "ali express", "aliexpress"
]);

const DISCOVERY_JUNK_WORDS = new Set([
  "welcome", "icon", "icons", "score", "sold", "overall", "coupon", "coupons", "cart", "wishlist",
  "signin", "login", "account", "help", "center", "download", "app", "official", "store", "stores",
  "seller", "sellers", "buyer", "protection", "shipping", "free", "sale", "deal", "deals", "choice",
  "item", "items", "product", "products", "category", "categories", "homepage", "wholesale", "more", "view", "see",
  "plus", "coins", "bonus", "invite", "register", "privacy", "policy", "terms", "service", "search", "popular"
]);

const ALIEXPRESS_CATEGORY_SINGLE_WORDS = new Set([
  "shoes", "clothing", "furniture", "jewelry", "watches", "bags", "luggage", "beauty", "health",
  "electronics", "toys", "kids", "baby", "pets", "pet", "automotive", "motorcycle", "garden",
  "tools", "home", "kitchen", "lighting", "sports", "outdoors", "camping", "fitness", "makeup",
  "hair", "nails", "nail", "skincare", "decor", "storage", "organizers", "organizer", "phones",
  "accessories", "dresses", "dress", "sneakers", "sandals", "boots", "slippers", "headphones",
  "earbuds", "chargers", "cables", "lamps", "lights", "vacuum", "humidifier", "purifier", "printer"
]);

const ALIEXPRESS_PRODUCT_NOUNS = new Set([
  "accessory", "accessories", "tool", "tools", "toy", "toys", "lamp", "lamps", "light", "lights",
  "fan", "fans", "vacuum", "humidifier", "purifier", "printer", "organizer", "organizers", "holder", "stand",
  "rack", "hook", "hooks", "brush", "bottle", "cup", "mug", "bag", "bags", "watch", "watches", "shoe", "shoes",
  "dress", "dresses", "clothing", "jewelry", "necklace", "bracelet", "ring", "earrings", "makeup", "nail", "nails",
  "hair", "skin", "skincare", "camera", "charger", "chargers", "cable", "cables", "phone", "phones", "case", "cases",
  "headphones", "earbuds", "speaker", "speakers", "keyboard", "mouse", "gaming", "pet", "pets", "cat", "dog", "baby",
  "kids", "kitchen", "bathroom", "bedroom", "garden", "furniture", "decor", "storage", "travel", "camping", "fitness",
  "automotive", "car", "motorcycle", "bike", "bicycle", "led", "silicone", "coffee", "massage", "cleaning", "laundry"
]);

function isGoodAliExpressDiscoveryKeyword(keyword, source = "") {
  const k = normalizeKeyword(keyword || "").replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!k) return false;
  if (DISCOVERY_JUNK_EXACT.has(k)) return false;
  if (/^\d+$/.test(k)) return false;
  if (k.length < 3 || k.length > 55) return false;
  if (/\b(shop|view|see|click|buy|save|coupon|deal|sale|sold|score|icon|welcome|official|store|category|product|item|download|login|signin|account|cart|wishlist|privacy|policy|terms)\b/.test(k)) return false;

  const words = k.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (words.some(w => DISCOVERY_JUNK_WORDS.has(w))) return false;
  if (words.some(w => w.length > 24)) return false;

  if (words.length === 1) return ALIEXPRESS_CATEGORY_SINGLE_WORDS.has(k);

  const hasProductNoun = words.some(w => ALIEXPRESS_PRODUCT_NOUNS.has(w));
  const hasCategorySignal = /category|catid|wholesale|product-title|product-link|validated-product/i.test(source || "");
  const hasCategoryWord = words.some(w => ALIEXPRESS_CATEGORY_SINGLE_WORDS.has(w));

  // Keep real product/category phrases, reject UI phrases like "over all" even if AliExpress returns generic results.
  return hasProductNoun || hasCategoryWord || hasCategorySignal;
}

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

function parseQuantityToken(value) {
  const raw = decodeValue(value).toLowerCase().replace(/\+/g, "").trim();
  const m = raw.match(/(\d[\d,.]*)(\s*[km])?/i);
  if (!m) return 0;

  let numberText = m[1];
  const suffix = String(m[2] || "").trim().toLowerCase();

  // AliExpress commonly returns values like 10,000+ sold or 1,000+ sold.
  // Treat comma groups as thousands, not decimals.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(numberText)) {
    numberText = numberText.replace(/,/g, "");
  } else if (numberText.includes(",") && !numberText.includes(".")) {
    // 1,5k style decimals are rare in AliExpress English logs; keep support anyway.
    const parts = numberText.split(",");
    numberText = parts.length === 2 && parts[1].length <= 2 ? numberText.replace(",", ".") : numberText.replace(/,/g, "");
  } else {
    numberText = numberText.replace(/,/g, "");
  }

  const base = Number(numberText);
  if (!Number.isFinite(base) || base <= 0) return 0;

  const mult = suffix === "m" ? 1000000 : (suffix === "k" ? 1000 : 1);
  return Math.round(base * mult);
}

function parseOrders(text) {
  const s = decodeValue(text).toLowerCase();
  if (!s) return 0;

  const patterns = [
    /(?:tradeDesc|tradeCount|ordersCount|soldCount|orders|sold|sales)["'\s:={]+([0-9][0-9,]*(?:\.[0-9]+)?\s*[km]?\+?\s*(?:sold|orders|ordered|purchased)?)/i,
    /([0-9][0-9,]*(?:\.[0-9]+)?\s*[km]?\+?)\s*(?:sold|orders|ordered|purchased|vendidos|vendu)/i,
    /(?:sold|orders|ordered|purchased|vendidos|vendu)\s*([0-9][0-9,]*(?:\.[0-9]+)?\s*[km]?\+?)/i
  ];

  for (const pattern of patterns) {
    const m = s.match(pattern);
    if (!m) continue;
    const value = parseQuantityToken(m[1]);
    if (value > 0) return value;
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
  const s = decodeValue(text);
  const percent = s.match(/(\d{1,2})\s*%\s*off/i);
  if (percent) return Number(percent[1]);

  const field = s.match(/(?:discount|discountPercent|minPriceDiscount)["'\s:]+(\d{1,2})/i);
  if (field) return Number(field[1]);

  const plain = cleanText(text).match(/^(\d{1,2})%?$/);
  return plain ? Number(plain[1]) : 0;
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

function addKeywordFallback(baseKeyword, variants = []) {
  const base = normalizeKeyword(baseKeyword);
  if (!base) return;
  const existing = keywordFallbackVariants.get(base) || [];
  const next = [...existing];
  for (const raw of variants) {
    const v = sanitizeDiscoveredKeyword(raw);
    if (v && v !== base && !next.includes(v)) next.push(v);
  }
  keywordFallbackVariants.set(base, next.slice(0, 6));
}

function makeKeywordSearchVariants(keyword) {
  const base = normalizeKeyword(keyword);
  const variants = [base];

  for (const v of keywordFallbackVariants.get(base) || []) variants.push(v);

  const words = base.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    variants.push(words.slice(-2).join(" "));
    variants.push(words.slice(0, 2).join(" "));
  }

  return [...new Set(variants.map(sanitizeDiscoveredKeyword).filter(Boolean))].slice(0, 6);
}

function sanitizeDiscoveredKeyword(value) {
  let k = normalizeKeyword(decodeValue(value || ""))
    .replace(/\b(ali\s*express|aliexpress|choice|super deals?|flash deals?|free shipping|coupon|coupons|shop now|view all|see all|more to love|limited offer|new arrivals?|best sellers?|top ranking|recommended|sponsored|official store|sale|deals|deal|products?|categories?|category|wholesale|homepage|buyer protection|download app|app only|cart|wishlist|sign in|account|orders?|help center)\b/g, " ")
    .replace(/\b(202[0-9]|19[0-9]{2})\b/g, " ")
    .replace(/\b(us|usd|eur|gbp|inr|rs|dollar|price|off|percent)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  k = k.replace(/\b(for|with|and|the|a|an|to|of|in|on|at|by|from|via)\b/g, " ").replace(/\s+/g, " ").trim();

  const words = k.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return "";
  if (k.length < 3 || k.length > 55) return "";
  if (/^\d+$/.test(k)) return "";
  if (DISCOVERY_JUNK_EXACT.has(k)) return "";
  if (words.some(w => DISCOVERY_JUNK_WORDS.has(w))) return "";
  if (words.some(w => w.length > 24)) return "";
  return k;
}

function titleKeywordCandidates(title) {
  const clean = normalizeKeyword(decodeValue(title || ""))
    .replace(/\b(ali\s*express|aliexpress|choice|new|hot|sale|free|shipping|for|with|without|and|the|a|an|to|of|in|on|at|by|from|202[0-9]|men|women|kids|baby)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stop = new Set([
    "color", "size", "pcs", "piece", "pieces", "set", "pack", "mini", "new", "hot", "sale",
    "portable", "electric", "wireless", "smart", "digital", "multi", "multifunctional", "universal",
    "high", "quality", "fashion", "cute", "large", "small", "waterproof", "rechargeable"
  ]);

  const words = clean.split(/\s+/).filter(w => w.length >= 3 && !stop.has(w) && !/^\d+$/.test(w));
  const out = [];

  for (const n of [2, 3]) {
    for (let i = 0; i <= words.length - n; i++) {
      const phrase = sanitizeDiscoveredKeyword(words.slice(i, i + n).join(" "));
      if (phrase && !out.includes(phrase)) out.push(phrase);
    }
  }

  const firstTwo = sanitizeDiscoveredKeyword(words.slice(0, 2).join(" "));
  if (firstTwo && !out.includes(firstTwo)) out.unshift(firstTwo);

  return out.slice(0, 8);
}

function addCandidate(candidates, keyword, weight = 1, source = "unknown") {
  const k = sanitizeDiscoveredKeyword(keyword);
  if (!k || !isGoodAliExpressDiscoveryKeyword(k, source)) return;
  const prev = candidates.get(k) || { keyword: k, weight: 0, sources: [] };
  prev.weight += weight;
  if (!prev.sources.includes(source)) prev.sources.push(source);
  candidates.set(k, prev);
}

function addTitleDerivedCandidates(candidates, title, weight = 1, source = "title") {
  for (const phrase of titleKeywordCandidates(title)) addCandidate(candidates, phrase, weight, source);
}

function buildStaticKeywordPool() {
  const counts = new Map();
  function add(keyword, weight = 1) {
    const k = sanitizeDiscoveredKeyword(keyword);
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + weight);
  }

  for (const item of STATIC_FALLBACK_KEYWORDS) add(item, 3);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEARCHES)
    .map(([keyword, weight]) => ({ keyword, weight, source: "static-emergency-fallback" }));
}

function scoreKeywordProducts(products = [], rawCount = 0, baseWeight = 0) {
  let score = baseWeight * 2 + rawCount;
  for (const p of products.slice(0, PRODUCTS_PER_KEYWORD)) {
    score += 4;
    score += Math.min(25, Math.log10(num(p.orders) + 1) * 10);
    score += Math.min(8, Math.max(0, num(p.rating) - 3.5) * 6);
    score += p.image ? 3 : 0;
    score += p.supplierUrl ? 2 : 0;
  }
  return Math.round(score);
}

async function extractAliExpressDiscoveryTexts(page) {
  return await page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const out = [];
    const push = (text, source, weight = 1) => {
      text = clean(text);
      if (text && text.length >= 3 && text.length <= 180) out.push({ text, source, weight });
    };

    for (const a of document.querySelectorAll("a")) {
      const href = a.href || a.getAttribute("href") || "";
      const text = clean(a.innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "");
      const isCategory = /category|catId|wholesale|w\/wholesale/i.test(href);
      const isItem = /\/item\/\d+\.html/i.test(href);
      if (isCategory) push(text, "aliexpress-category-link", 5);
      else if (isItem) push(text, "aliexpress-product-link", 2);
      else push(text, "aliexpress-link", 1);
    }

    for (const el of document.querySelectorAll("h1,h2,h3,h4,[aria-label],[title],img[alt]")) {
      push(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.innerText || "", "aliexpress-page-text", 1);
    }

    return out.slice(0, 800);
  }).catch(() => []);
}

async function probeAliExpressKeyword(page, collector, keyword) {
  let best = { keyword, rawCount: 0, products: [], dom: 0, network: 0, html: 0 };

  for (const url of makeAliExpressUrlVariants(keyword, 1).slice(0, 2)) {
    const networkMark = collector.mark();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
    await waitForNetworkIdleSafe(page, 15000);
    await sleep(2500 + Math.floor(Math.random() * 1200));

    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (isCaptchaText(bodyText)) continue;

    await fullPageScroll(page);
    await waitForNetworkIdleSafe(page, 10000);

    const domCards = await extractDomCards(page).catch(() => []);
    const networkCards = collector.since(networkMark);
    const html = await page.content().catch(() => "");
    const htmlCards = extractProductsFromText(html, url, "html");
    const rawCards = dedupeRawProducts([...domCards, ...networkCards, ...htmlCards]);
    const products = rawCards
      .map((card, index) => ({
        ...card,
        price: parsePrice(`${card.priceText || ""} ${card.text || ""}`),
        orders: parseOrders(`${card.soldText || ""} ${card.text || ""}`),
        rating: parseRating(`${card.ratingText || ""} ${card.text || ""}`),
        discount: Math.max(parseDiscount(card.discountText || ""), parseDiscount(card.text || ""))
      }))
      .map((card, index) => normalizeProduct(card, keyword, index + 1))
      .filter(Boolean)
      .slice(0, PRODUCTS_PER_KEYWORD);

    if (products.length > best.products.length || rawCards.length > best.rawCount) {
      best = { keyword, rawCount: rawCards.length, products, dom: domCards.length, network: networkCards.length, html: htmlCards.length, url };
    }

    if (products.length >= MIN_PRODUCTS_PER_KEYWORD) break;
  }

  return best;
}

async function discoverAliExpressKeywordPool(browser) {
  if (!DISCOVER_KEYWORDS_FROM_ALIEXPRESS) return buildStaticKeywordPool();

  const candidates = new Map();
  const discoveryState = { session: null, emptyStreak: 0 };

  try {
    const session = await resetAliExpressSession(browser, discoveryState, "AliExpress keyword discovery");
    const discoveryUrls = [
      "https://www.aliexpress.com/",
      "https://www.aliexpress.com/w/wholesale.html?catId=0&g=y&d=y&trafficChannel=main",
      "https://www.aliexpress.com/w/wholesale.html?g=y&d=y&trafficChannel=main"
    ];

    for (const url of discoveryUrls) {
      try {
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
        await waitForNetworkIdleSafe(session.page, 10000);
        await sleep(2500 + Math.floor(Math.random() * 1200));
        await fullPageScroll(session.page);

        const discoveryTexts = await extractAliExpressDiscoveryTexts(session.page);
        for (const item of discoveryTexts) {
          addCandidate(candidates, item.text, item.weight || 1, item.source || "aliexpress");
          addTitleDerivedCandidates(candidates, item.text, item.weight || 1, `${item.source || "aliexpress"}-title-cluster`);
        }

        const html = await session.page.content().catch(() => "");
        const pageProducts = extractProductsFromText(html, url, "html");
        for (const p of pageProducts.slice(0, 120)) {
          addTitleDerivedCandidates(candidates, p.title, 4, "aliexpress-home-product-title");
        }
      } catch (err) {
        console.log(`AliExpress keyword discovery page skipped: ${url}: ${err.message}`);
      }
    }

    const candidateList = [...candidates.values()]
      .filter(item => isGoodAliExpressDiscoveryKeyword(item.keyword, (item.sources || []).join(" ")))
      .sort((a, b) => b.weight - a.weight || a.keyword.length - b.keyword.length || a.keyword.localeCompare(b.keyword))
      .slice(0, DISCOVERY_CANDIDATE_LIMIT);

    console.log(`AliExpress discovered ${candidateList.length} raw keyword/category candidates from AliExpress pages`);

    const scored = [];
    const derived = new Map();
    let checked = 0;
    let emptyProbeStreak = 0;
    let totalEmptyProbes = 0;

    for (const candidate of candidateList) {
      if (checked >= DISCOVERY_VALIDATION_LIMIT) break;

      if (!isGoodAliExpressDiscoveryKeyword(candidate.keyword, (candidate.sources || []).join(" "))) {
        console.log(`AliExpress keyword probe skipped junk candidate: ${candidate.keyword}`);
        continue;
      }

      checked += 1;
      try {
        const result = await probeAliExpressKeyword(session.page, session.collector, candidate.keyword);
        const score = scoreKeywordProducts(result.products, result.rawCount, candidate.weight);
        const isEmptyProbe =
          result.products.length === 0 &&
          result.rawCount === 0 &&
          result.dom === 0 &&
          result.network === 0 &&
          result.html === 0;

        console.log(
          `AliExpress keyword probe: ${candidate.keyword}: usable=${result.products.length}, raw=${result.rawCount}, ` +
          `dom=${result.dom}, network=${result.network}, html=${result.html}, score=${score}`
        );

        if (isEmptyProbe) {
          emptyProbeStreak += 1;
          totalEmptyProbes += 1;
          console.log(
            `AliExpress keyword probe ignored empty candidate: ${candidate.keyword} ` +
            `(empty streak ${emptyProbeStreak}/${DISCOVERY_EMPTY_STREAK_LIMIT}, total empty ${totalEmptyProbes}/${DISCOVERY_MAX_EMPTY_PROBES})`
          );

          if (
            checked >= DISCOVERY_MIN_CHECKS_BEFORE_EMPTY_STOP &&
            (emptyProbeStreak >= DISCOVERY_EMPTY_STREAK_LIMIT || totalEmptyProbes >= DISCOVERY_MAX_EMPTY_PROBES)
          ) {
            console.log(
              `AliExpress keyword probe stopped early after ${checked} checks because the remaining candidate tail is empty. ` +
              `Validated keywords kept: ${scored.length}.`
            );
            break;
          }

          await sleep(Math.max(900, Math.floor(DELAY_MS * 0.6)) + Math.floor(Math.random() * 800));
          continue;
        }

        emptyProbeStreak = 0;

        if (result.products.length >= DISCOVERY_MIN_PRODUCTS || result.rawCount >= DISCOVERY_MIN_PRODUCTS) {
          scored.push({
            keyword: candidate.keyword,
            weight: score,
            source: "aliexpress-discovered-validated",
            usableProducts: result.products.length,
            rawProducts: result.rawCount,
            sources: candidate.sources
          });

          const titlePhrases = [];
          for (const p of result.products) {
            for (const phrase of titleKeywordCandidates(p.name || p.title)) {
              addCandidate(derived, phrase, Math.max(1, Math.round(score / 20)), "aliexpress-validated-product-title");
              titlePhrases.push(phrase);
            }
          }
          addKeywordFallback(candidate.keyword, titlePhrases);
        } else {
          console.log(
            `AliExpress keyword probe rejected weak candidate: ${candidate.keyword} ` +
            `(usable=${result.products.length}, raw=${result.rawCount}, min=${DISCOVERY_MIN_PRODUCTS})`
          );
        }
      } catch (err) {
        console.log(`AliExpress keyword probe failed: ${candidate.keyword}: ${err.message}`);
        if (isCaptchaError(err)) {
          emptyProbeStreak += 1;
          totalEmptyProbes += 1;
          if (
            checked >= DISCOVERY_MIN_CHECKS_BEFORE_EMPTY_STOP &&
            (emptyProbeStreak >= DISCOVERY_EMPTY_STREAK_LIMIT || totalEmptyProbes >= DISCOVERY_MAX_EMPTY_PROBES)
          ) {
            console.log(
              `AliExpress keyword probe stopped early after repeated blocked/empty probes. ` +
              `Validated keywords kept: ${scored.length}.`
            );
            break;
          }
        }
      }
      await sleep(Math.max(900, Math.floor(DELAY_MS * 0.6)) + Math.floor(Math.random() * 800));
    }

    // Add the strongest product-title clusters discovered from validated AliExpress pages.
    const derivedList = [...derived.values()]
      .filter(item => !scored.some(s => s.keyword === item.keyword))
      .sort((a, b) => b.weight - a.weight || a.keyword.length - b.keyword.length || a.keyword.localeCompare(b.keyword))
      .slice(0, Math.max(0, MAX_SEARCHES - scored.length));

    for (const item of derivedList) {
      scored.push({ keyword: item.keyword, weight: item.weight, source: "aliexpress-product-title-cluster", sources: item.sources });
    }

    const finalKeywords = scored
      .sort((a, b) => b.weight - a.weight || a.keyword.length - b.keyword.length || a.keyword.localeCompare(b.keyword))
      .slice(0, MAX_SEARCHES);

    if (finalKeywords.length) {
      console.log(`AliExpress final keyword pool from AliExpress discovery: ${finalKeywords.length} searches`);
      return finalKeywords;
    }
  } finally {
    await closeContext(discoveryState.session);
  }

  console.log("AliExpress keyword discovery returned 0 usable keywords.");
  if (STATIC_FALLBACK_ON_DISCOVERY_FAIL) {
    console.log("Using emergency static fallback keyword list because AliExpress discovery failed.");
    return buildStaticKeywordPool();
  }

  return [];
}

function extractProductLikeObjects(obj, sourceUrl = "", out = [], depth = 0, seen = new Set(), sourceType = "network") {
  if (!obj || depth > 12 || out.length > 500) return out;
  if (typeof obj !== "object") return out;
  if (seen.has(obj)) return out;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) extractProductLikeObjects(item, sourceUrl, out, depth + 1, seen, sourceType);
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
  const soldText = cleanText(
    nested(["trade", "tradeDesc"], ["trade", "tradeCount"], ["trade", "orders"], ["trade", "soldCount"]) ||
    get("tradeDesc", "ordersCount", "soldCount", "tradeCount", "orders", "sold", "soldText", "sales")
  );
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
      sourceUrl,
      source: sourceType
    });
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") extractProductLikeObjects(value, sourceUrl, out, depth + 1, seen, sourceType);
  }

  return out;
}

function extractProductsFromText(text, sourceUrl = "", sourceType = "html") {
  const out = [];
  const raw = String(text || "");
  if (!raw || raw.length < 200) return out;

  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const data = JSON.parse(trimmed);
      extractProductLikeObjects(data, sourceUrl, out, 0, new Set(), sourceType);
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
      /["'](?:tradeDesc|ordersCount|soldCount|tradeCount|orders|sold|sales)["']\s*:\s*["']?([^,"'}]{1,80})/i,
      /["']trade["']\s*:\s*\{[^}]*["']tradeDesc["']\s*:\s*["']([^"']{1,80})/i,
      /([0-9][0-9,]*(?:\.[0-9]+)?[km]?\+?\s*(?:sold|orders|ordered|purchased))/i
    ]);

    const ratingText = firstRegex([
      /["'](?:rating|averageStar|starRating|avgRating)["']\s*:\s*["']?([1-5](?:\.\d)?)/i
    ]);

    const discountText = firstRegex([
      /["'](?:discount|discountPercent|discountText)["']\s*:\s*["']?([0-9]{1,2}%?)/i,
      /(\d{1,2}\s*%\s*off)/i
    ]);

    if (title && image && url) {
      out.push({ productId, title, url, image, text: chunk.slice(0, 1200), priceText, soldText, ratingText, discountText, sourceUrl, source: sourceType });
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
    const itemScore =
      (item.title ? 2 : 0) +
      (item.url ? 2 : 0) +
      (item.image ? 2 : 0) +
      (item.priceText ? 1 : 0) +
      (parseOrders(`${item.soldText || ""} ${item.text || ""}`) > 0 ? 3 : 0) +
      (parseRating(`${item.ratingText || ""} ${item.text || ""}`) > 0 ? 1 : 0) +
      (item.source === "dom" ? 2 : item.source === "network" ? 1 : 0);
    const prevScore = prev ? (
      (prev.title ? 2 : 0) +
      (prev.url ? 2 : 0) +
      (prev.image ? 2 : 0) +
      (prev.priceText ? 1 : 0) +
      (parseOrders(`${prev.soldText || ""} ${prev.text || ""}`) > 0 ? 3 : 0) +
      (parseRating(`${prev.ratingText || ""} ${prev.text || ""}`) > 0 ? 1 : 0) +
      (prev.source === "dom" ? 2 : prev.source === "network" ? 1 : 0)
    ) : -1;
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

  const price = num(first(raw.price, raw.salePrice, parsePrice(`${raw.priceText || ""} ${raw.text || ""}`)));
  const originalPrice = num(first(raw.originalPrice, raw.originalPriceText, price));

  const rawOrders = Math.max(num(raw.orders), num(raw.sold), num(raw.soldCount), num(raw.tradeCount));
  const parsedOrders = parseOrders(`${raw.soldText || ""} ${raw.text || ""}`);
  const orders = Math.max(rawOrders, parsedOrders);

  const rawRating = Math.max(num(raw.rating), num(raw.averageStar));
  const parsedRating = parseRating(`${raw.ratingText || ""} ${raw.text || ""}`);
  const rating = rawRating > 0 ? rawRating : parsedRating;

  const rawDiscount = Math.max(num(raw.discount), num(raw.discountPercent));
  const parsedDiscount = Math.max(parseDiscount(raw.discountText || ""), parseDiscount(raw.text || ""));
  const discount = Math.max(rawDiscount, parsedDiscount);

  const image = absoluteImage(first(raw.image, raw.imageUrl, raw.img));

  // For Quvirl + Amazon Lens, image/title/URL are the critical fields.
  // Keep valid product cards even when AliExpress hides price in headless mode.
  if (!title || !url || !image) return null;
  if (/^(shipping from|add to cart|similar items|see preview|customizable|choice|free shipping)$/i.test(title)) return null;
  if (image && /\/48x48\.|\/60x60\.|logo|sprite|icon/i.test(image)) return null;

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
      const products = extractProductsFromText(text, url, "network");
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
      const htmlCards = extractProductsFromText(html, url, "html");
      const rawCards = dedupeRawProducts([...domCards, ...networkCards, ...htmlCards]);

      console.log(
        `AliExpress extracted for ${keyword}${searchKeyword !== keyword ? ` via ${searchKeyword}` : ""}: ` +
        `dom=${domCards.length}, network=${networkCards.length}, html=${htmlCards.length}, merged=${rawCards.length}`
      );

      bestRawCount = Math.max(bestRawCount, rawCards.length);

      const products = rawCards
        .map((card, index) => ({
          ...card,
          price: parsePrice(`${card.priceText || ""} ${card.text || ""}`),
          orders: parseOrders(`${card.soldText || ""} ${card.text || ""}`),
          rating: parseRating(`${card.ratingText || ""} ${card.text || ""}`),
          discount: Math.max(parseDiscount(card.discountText || ""), parseDiscount(card.text || ""))
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

async function main() {
  console.log(`Target AliExpress products: ${MAX_PRODUCTS}`);

  const all = [];
  const errors = [];
  const delayedRetry = [];

  const sessionState = { session: null, emptyStreak: 0 };

  const browser = await puppeteer.launch({
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

  let keywordPool = [];

  try {
    keywordPool = await discoverAliExpressKeywordPool(browser);
    writeJson(KEYWORDS_PATH, keywordPool);
    console.log(`AliExpress keyword pool: ${keywordPool.length} searches`);

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
        errors.push({ keyword: item.keyword, error: err.message });
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
    keywordCount: keywordPool.length,
    keywordDiscoveryMode: DISCOVER_KEYWORDS_FROM_ALIEXPRESS ? "aliexpress-discovered-validated" : "static-fallback",
    discoveryCandidateLimit: DISCOVERY_CANDIDATE_LIMIT,
    discoveryValidationLimit: DISCOVERY_VALIDATION_LIMIT,
    discoveryMinProducts: DISCOVERY_MIN_PRODUCTS,
    discoveryEmptyStreakLimit: DISCOVERY_EMPTY_STREAK_LIMIT,
    discoveryMaxEmptyProbes: DISCOVERY_MAX_EMPTY_PROBES,
    discoveryMinChecksBeforeEmptyStop: DISCOVERY_MIN_CHECKS_BEFORE_EMPTY_STOP,
    staticFallbackOnDiscoveryFail: STATIC_FALLBACK_ON_DISCOVERY_FAIL,
    usedFallback,
    errorCount: errors.length,
    errors: errors.slice(0, 80),
    note: "AliExpress is treated as a product source like CJ. The keyword/category pool is discovered from AliExpress itself: homepage/category links, AliExpress product-title clusters, and validation pages sorted by orders/sales. It then fetches page 1 sorted by orders/sales for the strongest validated AliExpress-discovered keywords/categories. This version uses Puppeteer with a persistent warm AliExpress session, no scheduled batch reset, session reset only on zero/captcha/low-count pages, tall viewport, deeper scrolling, visible DOM extraction, network-response extraction, and safe HTML hydration extraction. It keeps products with title + URL + image even if price is hidden, so Amazon Lens still has usable product images. Discovery validation now stops early after repeated empty probes, so it does not keep wasting time on the low-quality tail of keywords showing usable=0/raw=0/network=0/html=0. CJ product titles and Google Trends keywords are intentionally not used as AliExpress keywords. Emergency static fallback is used only if AliExpress keyword discovery completely fails."
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
