import { chromium } from "playwright";
import { readJson, writeJson, normalizeKeyword, sleep, num } from "./utils.js";

const MAX_PRODUCTS = Number(process.env.ALIEXPRESS_MAX_PRODUCTS || 750);
const MAX_SEARCHES = Number(process.env.ALIEXPRESS_MAX_SEARCHES || 70);
const PRODUCTS_PER_KEYWORD = Number(process.env.ALIEXPRESS_PRODUCTS_PER_KEYWORD || 60);
const MIN_PRODUCTS_PER_KEYWORD = Number(process.env.ALIEXPRESS_MIN_PRODUCTS_PER_KEYWORD || Math.min(12, PRODUCTS_PER_KEYWORD));
const DELAY_MS = Number(process.env.ALIEXPRESS_DELAY_MS || 2500);
const SEARCH_TIMEOUT_MS = Number(process.env.ALIEXPRESS_TIMEOUT_MS || 60000);
const HEADLESS = String(process.env.ALIEXPRESS_HEADLESS || "true").toLowerCase() !== "false";
const FALLBACK_CACHE = String(process.env.ALIEXPRESS_FALLBACK_CACHE || "true").toLowerCase() !== "false";
const MAX_RETRIES = Number(process.env.ALIEXPRESS_RETRIES || 3);
const CAPTCHA_COOLDOWN_MS = Number(process.env.ALIEXPRESS_CAPTCHA_COOLDOWN_MS || 45000);
const RETRY_FAILED_KEYWORDS = String(process.env.ALIEXPRESS_RETRY_FAILED_KEYWORDS || "true").toLowerCase() !== "false";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
];

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


function isCaptchaText(text) {
  return /captcha|verify you are human|robot check|security check|unusual traffic|slide to verify|access denied|sorry, we have detected unusual traffic/i.test(String(text || ""));
}

function isCaptchaError(err) {
  return isCaptchaText(err?.message || err);
}

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0];
}

function absoluteImage(value) {
  let src = String(value || "").trim();
  if (!src) return "";

  // srcset/data-srcset often contains multiple candidates. Use the first real image URL.
  src = src.split(",")[0].trim().split(/\s+/)[0].trim();

  if (src.startsWith("//")) src = `https:${src}`;
  if (!/^https?:\/\//i.test(src)) return "";

  // Ignore placeholders and tracking pixels.
  if (/data:image|blank|placeholder|transparent/i.test(src)) return "";

  return src;
}

function parsePrice(text) {
  const s = cleanText(text);

  // Prefer numbers next to a currency marker so ratings/order counts are not misread as price.
  const currencyMatches = [
    ...s.matchAll(/(?:US\s*)?[$€£₹]\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi),
    ...s.matchAll(/(?:USD|EUR|GBP|INR)\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi),
    ...s.matchAll(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:USD|EUR|GBP|INR)/gi)
  ]
    .map(m => Number(String(m[1]).replace(",", ".")))
    .filter(n => Number.isFinite(n) && n > 0 && n < 100000);

  if (currencyMatches.length) return Math.min(...currencyMatches);

  // Fallback: AliExpress sometimes renders price text without a symbol in headless mode.
  const generic = [...s.matchAll(/([0-9]+(?:[.,][0-9]{1,2})?)/g)]
    .map(m => Number(String(m[1]).replace(",", ".")))
    .filter(n => Number.isFinite(n) && n > 0.2 && n < 10000);

  if (!generic.length) return 0;
  return Math.min(...generic);
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

function makeAliExpressUrlVariants(keyword, page = 1) {
  const encoded = encodeURIComponent(keyword);
  const slug = normalizeKeyword(keyword).replace(/\s+/g, "-");

  return [
    makeAliExpressUrl(keyword, page),
    `https://www.aliexpress.com/w/wholesale-${slug}.html?SearchText=${encoded}&sortType=total_tranpro_desc&page=${page}&g=y&trafficChannel=main`,
    `https://www.aliexpress.us/w/wholesale-${slug}.html?SearchText=${encoded}&sortType=total_tranpro_desc&page=${page}&g=y&trafficChannel=main`
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

  // Generic safe fallbacks: if a two-word search returns an empty AliExpress page,
  // try the important head word too, but only after specific variants.
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

      for (let i = 0; i < 9 && root; i++) {
        const text = clean(root.innerText || "");
        const imgs = root.querySelectorAll?.("img").length || 0;
        const itemLinks = root.querySelectorAll?.('a[href*="/item/"]').length || 0;
        const hasPrice = /(?:US\s*)?[$€£₹]|USD|EUR|GBP|INR|\b\d+[.,]?\d*\b/.test(text);

        if (imgs && text.length >= 8 && text.length <= 1800 && hasPrice && itemLinks <= 4) {
          best = root;
        }

        root = root.parentElement;
      }

      return best;
    };

    const links = [...document.querySelectorAll('a[href*="/item/"]')];
    const out = [];
    const seen = new Set();

    const decodeText = (value) => {
      try {
        return clean(String(value || "")
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\\//g, "/")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&#39;/g, "'"));
      } catch {
        return clean(value);
      }
    };

    const firstMatch = (text, patterns) => {
      for (const pattern of patterns) {
        const m = text.match(pattern);
        if (m && m[1]) return decodeText(m[1]);
      }
      return "";
    };

    const extractEmbeddedProducts = () => {
      const embedded = [];
      const texts = [];

      // AliExpress often has many products in hydration/script data even when
      // the visible DOM only exposes a few cards in headless browsers.
      for (const script of [...document.scripts]) {
        const text = script.textContent || "";
        if (/productId|itemId|itemIdStr|productTitle|imageUrl|itemUrl|salePrice/i.test(text)) {
          texts.push(text.slice(0, 1500000));
        }
      }

      const html = document.documentElement?.innerHTML || "";
      if (/productId|itemId|itemIdStr|\/item\/\d+\.html/i.test(html)) {
        texts.push(html.slice(0, 2500000));
      }

      const joined = texts.join("\n");
      const idRegex = /["']?(?:productId|itemId|itemIdStr|item_id|product_id)["']?\s*[:=]\s*["']?(\d{8,})["']?/gi;
      let match;
      let guard = 0;
      const localSeen = new Set();

      while ((match = idRegex.exec(joined)) && guard++ < 300) {
        const productId = match[1];
        if (!productId || localSeen.has(productId)) continue;
        localSeen.add(productId);

        const start = Math.max(0, match.index - 5000);
        const end = Math.min(joined.length, match.index + 9000);
        const chunk = joined.slice(start, end);

        const title = firstMatch(chunk, [
          /["'](?:title|productTitle|subject|productName|displayTitle|itemTitle)["']\s*:\s*["']([^"']{8,260})["']/i,
          /["'](?:title|productTitle|subject|productName|displayTitle|itemTitle)["']\s*:\s*`([^`]{8,260})`/i,
          /alt=["']([^"']{8,260})["']/i
        ]);

        let image = firstMatch(chunk, [
          /["'](?:imageUrl|image|imgUrl|imgSrc|productImage|mainImage|itemImage)["']\s*:\s*["']([^"']+?(?:\.jpg|\.jpeg|\.png|\.webp)[^"']*)["']/i,
          /(https?:\?\/\?\/[^"'\s]+?\.(?:jpg|jpeg|png|webp)[^"'\s]*)/i,
          /(\?\/\?\/[^"'\s]+?\.(?:jpg|jpeg|png|webp)[^"'\s]*)/i
        ]);
        image = image.replace(/\\//g, "/");
        if (image.startsWith("//")) image = `https:${image}`;
        if (image.startsWith("/")) image = `https:${image}`;

        let url = firstMatch(chunk, [
          /["'](?:itemUrl|productUrl|url|detailUrl)["']\s*:\s*["']([^"']*\/item\/\d+\.html[^"']*)["']/i,
          /(https?:\?\/\?\/[^"'\s]+?\/item\/\d+\.html[^"'\s]*)/i,
          /(\?\/\?\/[^"'\s]+?\/item\/\d+\.html[^"'\s]*)/i
        ]);
        url = url.replace(/\\//g, "/");
        if (url.startsWith("//")) url = `https:${url}`;
        if (!url) url = `https://www.aliexpress.com/item/${productId}.html`;

        const priceText = firstMatch(chunk, [
          /["'](?:salePrice|price|formattedPrice|displayPrice|minPrice|priceText)["']\s*:\s*["']([^"']{1,80})["']/i,
          /(?:US\s*)?\$\s*[0-9][0-9.,]*/i
        ]) || clean((chunk.match(/(?:US\s*)?\$\s*[0-9][0-9.,]*/i) || [""])[0]);

        const soldText = firstMatch(chunk, [
          /["'](?:orders|ordersCount|sold|soldCount|tradeCount|trade)["']\s*:\s*["']?([^,"'}]{1,40})/i,
          /([0-9]+(?:[.,][0-9]+)?[km]?\s*(?:sold|orders|ordered|purchased))/i
        ]);

        const ratingText = firstMatch(chunk, [
          /["'](?:rating|averageStar|starRating|avgRating)["']\s*:\s*["']?([1-5](?:\.\d)?)/i
        ]);

        const discountText = firstMatch(chunk, [
          /["'](?:discount|discountPercent)["']\s*:\s*["']?([0-9]{1,2}%?)/i,
          /(\d{1,2}\s*%\s*off)/i
        ]);

        if (title && image && url) {
          embedded.push({ productId, title, url, image, text: chunk.slice(0, 1200), priceText, ratingText, soldText, discountText });
        }
      }

      return embedded;
    };

    for (const link of links) {
      const href = link.href || link.getAttribute("href") || "";
      if (!isItemLink(href) || seen.has(href)) continue;

      const root = findCardRoot(link);
      const img = link.querySelector("img") || root?.querySelector("img");
      const imgSrc = bestImage(link) || bestImage(root) || img?.src || "";

      const aria = link.getAttribute("aria-label") || link.getAttribute("title") || "";
      const imgAlt = img?.getAttribute("alt") || "";
      const rootText = clean(root?.innerText || "");
      const linkText = clean(link.innerText || "");

      let title = clean(aria || imgAlt || linkText || "");
      if (!title || title.length < 8 || /^(shop now|free shipping|choice)$/i.test(title)) {
        const lines = rootText
          .split(/(?=US\s*\$|[$€£₹])|\n|\|/)
          .map(clean)
          .filter(Boolean);
        title = lines.find(line =>
          line.length >= 8 &&
          line.length <= 220 &&
          !/(sold|orders|ordered|free shipping|choice|coupon|%\s*off|US\s*\$|[$€£₹])/i.test(line)
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

    for (const item of extractEmbeddedProducts()) {
      const key = item.productId || item.url;
      if (!key || seen.has(key)) continue;
      out.push(item);
      seen.add(key);
    }

    return out.slice(0, 180);
  });
}

async function scrollSearchPage(page) {
  let lastCount = 0;
  let stableRounds = 0;

  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 1400 + Math.floor(Math.random() * 900));
    await sleep(900 + Math.floor(Math.random() * 600));

    const count = await page.evaluate(() => document.querySelectorAll('a[href*="/item/"]').length).catch(() => 0);
    if (count <= lastCount) stableRounds += 1;
    else stableRounds = 0;
    lastCount = Math.max(lastCount, count);

    if (stableRounds >= 3 && count >= PRODUCTS_PER_KEYWORD) break;
  }

  await page.mouse.wheel(0, -400);
  await sleep(500);
}

async function fetchKeywordProducts(page, keyword, attempt = 1) {
  console.log(`AliExpress search: ${keyword}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);

  // Go through the homepage first on retry attempts. This often clears a bad search-session state
  // without changing the product logic or skipping the keyword.
  if (attempt > 1) {
    try {
      await page.goto("https://www.aliexpress.com/", { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await sleep(2500 + Math.floor(Math.random() * 1500));
    } catch {}
  }

  let bestProducts = [];
  let captchaError = null;
  const searchVariants = makeKeywordSearchVariants(keyword);

  for (const searchKeyword of searchVariants) {
    if (searchKeyword !== keyword) {
      console.log(`AliExpress fallback query for ${keyword}: ${searchKeyword}`);
    }

    for (const url of makeAliExpressUrlVariants(searchKeyword, 1)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 18000 }).catch(() => null);
      await sleep(5500 + Math.floor(Math.random() * 2500));

      await page.waitForFunction(() => document.querySelectorAll('a[href*="/item/"]').length > 0 || document.body.innerText.length > 500, { timeout: 12000 }).catch(() => null);

      const blocked = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || "";
        return /captcha|verify you are human|robot check|security check|unusual traffic|slide to verify|access denied|sorry, we have detected unusual traffic/.test(text);
      });

      if (blocked) {
        captchaError = new Error(`AliExpress captcha/security check for keyword: ${keyword}`);
        continue;
      }

      await scrollSearchPage(page);

      const cards = await extractCards(page);
      console.log(`AliExpress raw extracted cards for ${keyword}${searchKeyword !== keyword ? ` via ${searchKeyword}` : ""}: ${cards.length}`);
      const products = cards
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

      console.log(`AliExpress low product count for ${keyword}${searchKeyword !== keyword ? ` via ${searchKeyword}` : ""}: ${products.length}. Trying alternate page URL/query...`);
      await sleep(1800 + Math.floor(Math.random() * 1200));
    }
  }

  if (bestProducts.length) return bestProducts;
  if (captchaError) throw captchaError;
  return [];
}

async function createAliExpressContext(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
    userAgent: pickUserAgent(),
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "DNT": "1",
      "Upgrade-Insecure-Requests": "1"
    }
  });

  await context.addCookies([
    { name: "aep_usuc_f", value: "site=glo&c_tp=USD&region=US&b_locale=en_US", domain: ".aliexpress.com", path: "/" },
    { name: "intl_locale", value: "en_US", domain: ".aliexpress.com", path: "/" },
    { name: "aep_usuc_f", value: "site=glo&c_tp=USD&region=US&b_locale=en_US", domain: ".aliexpress.us", path: "/" },
    { name: "intl_locale", value: "en_US", domain: ".aliexpress.us", path: "/" }
  ]).catch(() => null);

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    } catch {}
  });

  return context;
}

async function closeSharedContext(shared) {
  if (shared?.context) {
    try { await shared.context.close(); } catch {}
  }
  if (shared) {
    shared.context = null;
    shared.page = null;
  }
}

async function ensureSharedPage(browser, shared) {
  if (shared.page && !shared.page.isClosed()) return shared.page;

  await closeSharedContext(shared);
  shared.context = await createAliExpressContext(browser);
  shared.page = await shared.context.newPage();
  return shared.page;
}

async function rotateSharedPage(browser, shared) {
  await closeSharedContext(shared);
  shared.context = await createAliExpressContext(browser);
  shared.page = await shared.context.newPage();
  return shared.page;
}

async function fetchKeywordProductsWithRetries(browser, keyword, shared) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Use one warm AliExpress browser session for normal searches, like the earlier version.
      // Only rotate the context after captcha/security errors. This keeps product-card counts stable
      // and prevents the first-page result list from shrinking to only a few products.
      const page = attempt === 1
        ? await ensureSharedPage(browser, shared)
        : await rotateSharedPage(browser, shared);

      const products = await fetchKeywordProducts(page, keyword, attempt);

      // Treat BOTH zero and very-low product counts as a bad AliExpress session/page.
      // AliExpress can return normal results for the same keyword in one run and an empty
      // anti-bot/partial page in the next GitHub Actions run. Retrying in a fresh context
      // fixes that without changing the keyword or moving to page 2.
      if (products.length < MIN_PRODUCTS_PER_KEYWORD && attempt < MAX_RETRIES) {
        throw new Error(`AliExpress low/empty product count for keyword: ${keyword}: ${products.length}`);
      }

      return products;
    } catch (err) {
      lastError = err;
      const captcha = isCaptchaError(err);
      console.log(`AliExpress attempt failed: ${keyword}: ${err.message}`);

      if (captcha) {
        await closeSharedContext(shared);
      }

      if (captcha && attempt < MAX_RETRIES) {
        console.log(`AliExpress captcha retry queued for same keyword: ${keyword}. Cooling down ${CAPTCHA_COOLDOWN_MS}ms`);
        await sleep(CAPTCHA_COOLDOWN_MS);
      } else if (attempt < MAX_RETRIES) {
        await sleep(Math.min(15000, DELAY_MS * attempt));
      }
    }
  }

  throw lastError || new Error(`AliExpress failed for keyword: ${keyword}`);
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

  const shared = { context: null, page: null };

  try {
    const delayedRetry = [];

    for (const item of keywordPool) {
      if (all.length >= MAX_PRODUCTS) break;

      try {
        const products = await fetchKeywordProductsWithRetries(browser, item.keyword, shared);
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

      await sleep(DELAY_MS + Math.floor(Math.random() * 1200));
    }

    if (RETRY_FAILED_KEYWORDS && all.length < MAX_PRODUCTS && delayedRetry.length) {
      console.log(`Retrying ${delayedRetry.length} captcha-blocked AliExpress keywords after cooldown instead of skipping immediately.`);
      await sleep(CAPTCHA_COOLDOWN_MS);

      for (const item of delayedRetry) {
        if (all.length >= MAX_PRODUCTS) break;

        try {
          const products = await fetchKeywordProductsWithRetries(browser, item.keyword, shared);
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

        await sleep(DELAY_MS + Math.floor(Math.random() * 1500));
      }
    }
  } finally {
    await closeSharedContext(shared);
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
    minProductsPerKeyword: MIN_PRODUCTS_PER_KEYWORD,
    maxRetries: MAX_RETRIES,
    captchaCooldownMs: CAPTCHA_COOLDOWN_MS,
    retryFailedKeywords: RETRY_FAILED_KEYWORDS,
    keywordCount: keywordPool.length,
    usedFallback,
    errorCount: errors.length,
    errors: errors.slice(0, 50),
    note: "AliExpress is treated as a product source like CJ: it fetches high-demand AliExpress products using only AliExpress/dropshipping seed categories. Normal searches use one warm AliExpress browser session for stable first-page product counts. The scraper now extracts the full loaded first page more aggressively, tries alternate AliExpress search URL formats and keyword fallback queries when a page returns zero/few products, and retries zero/low-count keywords in a fresh browser context instead of accepting empty or 3-6 product pages as normal. Captcha-blocked keywords rotate into a fresh browser context with cooldown instead of being skipped immediately. CJ product titles and Google Trends keywords are intentionally not used as AliExpress keywords. If AliExpress blocks or returns no data, old aliexpress-products.json cache is kept."
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