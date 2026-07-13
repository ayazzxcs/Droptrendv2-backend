import fs from "fs";

export function readJson(path, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

export function num(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function cleanProductName(value) {
  let s = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value ?? "");
  s = s.trim();
  if ((s.startsWith("[") && s.endsWith("]")) || s.includes('","') || s.includes("','")) {
    try {
      const parsed = JSON.parse(s.replace(/'/g, '"'));
      if (Array.isArray(parsed)) s = parsed.filter(Boolean).join(" ");
    } catch {
      s = s.replace(/^\s*\[+/, "").replace(/\]+\s*$/, "").replace(/["']/g, "").replace(/,/g, " ");
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "new", "2026", "2025", "2024", "for", "with", "and", "the", "hot", "sale",
  "fashion", "style", "men", "mens", "women", "womens", "woman", "male", "female",
  "wholesale", "supplier", "cross", "border", "dropshipping", "product", "products",
  "high", "quality", "good", "summer", "winter", "spring", "autumn", "portable",
  "multifunctional", "solid", "color", "colors", "mini", "large", "small", "piece",
  "pieces", "set", "sets", "plus", "best", "other", "replacement", "parts", "front",
  "only", "self", "pickup", "latest", "item", "items", "support", "supports",
  "supported", "compatible", "compatibility", "official", "certified", "brand",
  "aliexpress", "ali", "express"
]);

const PRODUCT_TERMS = new Set([
  // Electronics and phone accessories
  "charger", "chargers", "cable", "cables", "adapter", "adapters", "powerbank", "powerbanks",
  "battery", "batteries", "speaker", "speakers", "earphone", "earphones", "earbud", "earbuds",
  "headphone", "headphones", "headset", "headsets", "microphone", "microphones", "camera", "cameras",
  "webcam", "webcams", "projector", "projectors", "monitor", "monitors", "keyboard", "keyboards",
  "mouse", "mice", "router", "routers", "repeater", "repeaters", "hub", "hubs", "dock", "docks",
  "converter", "converters", "inverter", "inverters", "controller", "controllers", "gamepad", "gamepads",
  "console", "consoles", "smartwatch", "smartwatches", "tracker", "trackers", "tablet", "tablets",
  "laptop", "laptops", "computer", "computers", "printer", "printers", "scanner", "scanners",
  "flashlight", "flashlights", "torch", "torches", "bulb", "bulbs", "socket", "sockets",
  "plug", "plugs", "switch", "switches", "remote", "remotes", "antenna", "antennas",
  "receiver", "receivers", "transmitter", "transmitters", "stylus", "tripod", "tripods",
  "gimbal", "gimbals", "protector", "protectors", "screen", "screens", "glass", "lens", "lenses",
  "holder", "holders", "stand", "stands", "mount", "mounts", "grip", "grips",

  // Home, kitchen and household
  "sofa", "chair", "chairs", "table", "tables", "storage", "organizer", "organizers", "kitchen",
  "vacuum", "vacuums", "cleaner", "cleaners", "mop", "mops", "brush", "brushes", "broom", "brooms",
  "dispenser", "dispensers", "humidifier", "humidifiers", "diffuser", "diffusers", "fan", "fans",
  "heater", "heaters", "cooler", "coolers", "blender", "blenders", "mixer", "mixers",
  "grinder", "grinders", "juicer", "juicers", "kettle", "kettles", "cooker", "cookers",
  "toaster", "toasters", "pan", "pans", "pot", "pots", "rack", "racks", "shelf", "shelves",
  "box", "boxes", "basket", "baskets", "bin", "bins", "bottle", "bottles", "cup", "cups",
  "mug", "mugs", "mat", "mats", "pillow", "pillows", "blanket", "blankets", "sheet", "sheets",
  "curtain", "curtains", "lamp", "lamps", "light", "lights", "decor", "mirror", "mirrors",

  // Clothing and fashion accessories
  "shirt", "shirts", "tshirt", "tshirts", "blouse", "blouses", "top", "tops", "dress", "dresses",
  "skirt", "skirts", "pants", "trousers", "jeans", "shorts", "jacket", "jackets", "coat", "coats",
  "hoodie", "hoodies", "sweater", "sweaters", "cardigan", "cardigans", "vest", "vests",
  "bra", "bras", "underwear", "sock", "socks", "shoe", "shoes", "sandals", "slippers", "boots",
  "cap", "caps", "hat", "hats", "belt", "belts", "wallet", "wallets", "purse", "purses",
  "backpack", "backpacks", "handbag", "handbags", "bag", "bags", "bracelet", "bracelets",
  "necklace", "necklaces", "earring", "earrings", "ring", "rings", "watch", "watches",
  "blazer", "blazers",

  // Beauty and personal care
  "makeup", "skincare", "serum", "serums", "cream", "creams", "cleanser", "cleansers",
  "mask", "masks", "comb", "combs", "dryer", "dryers", "curler", "curlers",
  "straightener", "straighteners", "shaver", "shavers", "trimmer", "trimmers", "clipper", "clippers",
  "razor", "razors", "massager", "massagers", "spray", "sprays",

  // Tools, outdoor, auto and pet products
  "tool", "tools", "screwdriver", "screwdrivers", "drill", "drills", "saw", "saws",
  "wrench", "wrenches", "plier", "pliers", "cutter", "cutters", "knife", "knives",
  "meter", "meters", "tester", "testers", "sensor", "sensors", "detector", "detectors",
  "pump", "pumps", "sprayer", "sprayers", "blower", "blowers", "washer", "washers",
  "machine", "machines", "inflator", "inflators", "compressor", "compressors",
  "collar", "collars", "leash", "leashes", "harness", "harnesses", "feeder", "feeders",
  "bowl", "bowls", "toy", "toys", "bed", "beds", "pet", "pets", "dog", "dogs", "cat", "cats",

  // Broad but still useful product nouns
  "phone", "phones", "car", "cars", "baby", "fitness", "shower", "travel", "office", "home",
  "beauty", "bathroom", "garden", "outdoor", "airplane", "neck", "body", "care", "party",
  "supplies", "kids", "child", "children", "case", "cases", "cover", "covers"
]);

const WEAK_SINGLE_WORDS = new Set([
  "usb", "type", "fast", "charging", "charge", "wireless", "bluetooth", "magnetic",
  "smart", "digital", "electric", "electronic", "rechargeable", "adjustable", "foldable",
  "waterproof", "lightweight", "universal", "compatible", "support", "supported", "original",
  "official", "premium", "professional", "version", "model", "pro", "max", "ultra",
  "iphone", "ipad", "android", "samsung", "xiaomi", "huawei", "macbook", "tablet",
  "home", "outdoor", "travel", "office", "beauty", "care", "body", "party", "supplies"
]);

function productTermBase(word) {
  if (PRODUCT_TERMS.has(word)) return word;

  const candidates = [];
  if (word.endsWith("ies") && word.length > 4) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("ves") && word.length > 4) candidates.push(`${word.slice(0, -3)}f`);
  if (word.endsWith("es") && word.length > 4) candidates.push(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 3) candidates.push(word.slice(0, -1));

  return candidates.find(candidate => PRODUCT_TERMS.has(candidate)) || "";
}

function isProductTerm(word) {
  return Boolean(productTermBase(word));
}

function isMeaningfulSingleWordFallback(word, words) {
  if (!word || word.length < 4 || WEAK_SINGLE_WORDS.has(word) || TECH_TOKENS.has(word)) return false;
  if (isProductTerm(word)) return true;

  // Generic safety net for a product noun not yet in the dictionary. Only the
  // final word of a multi-word phrase is allowed, which gives useful fallbacks
  // such as "usb charger" -> "charger" without trying every adjective/brand.
  return words.length >= 2 && words[words.length - 1] === word;
}

// Short technical tokens that are meaningful in product searches and should not
// be discarded merely because they contain fewer than three characters.
const TECH_TOKENS = new Set([
  "c", "pd", "qc", "tv", "hd", "uhd", "4k", "5g", "3d", "vr", "ar", "ai",
  "xl", "xxl", "s", "m", "l"
]);

export function normalizeKeyword(text) {
  return cleanProductName(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\b\d+(?:w|v|a|mah|wh|gb|tb|hz|khz|mhz|ghz|mm|cm|ft|inch|mp)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function isAliExpressProduct(product) {
  if (!product || typeof product !== "object") return false;

  const markers = [
    product.source,
    product.marketplace,
    product.supplier,
    product.platform,
    product.category
  ].map(v => String(v || "").toLowerCase());

  return Boolean(product.aliExpressKeyword || product.raw?.aliExpressKeyword) ||
    markers.some(v => v.includes("aliexpress") || v.includes("ali express"));
}

function getAliExpressKeyword(product) {
  if (!product || typeof product !== "object") return "";
  return cleanProductName(
    product.aliExpressKeyword ||
    product.raw?.aliExpressKeyword ||
    product.raw?.keyword ||
    ""
  );
}

function addEdgePhrases(collected, words, maxWords = 4) {
  const upper = Math.min(maxWords, words.length);
  for (let size = upper; size >= 2; size -= 1) {
    collected.push(words.slice(0, size).join(" "));
    collected.push(words.slice(-size).join(" "));
  }
}

function addProductCenteredPhrases(collected, words) {
  words.forEach((word, index) => {
    if (!isProductTerm(word)) return;

    collected.push(word);

    // Build product-noun phrases with up to three useful words before the noun
    // and one after it. Examples: "usb c charger", "type c charger",
    // "portable air blower". This is broader than only first/last title words.
    for (let left = 1; left <= 3; left += 1) {
      const start = Math.max(0, index - left);
      if (start < index) collected.push(words.slice(start, index + 1).join(" "));
      if (index + 1 < words.length) {
        collected.push(words.slice(start, index + 2).join(" "));
      }
    }

    if (index + 1 < words.length) collected.push(words.slice(index, index + 2).join(" "));
  });
}

function buildKeywordCandidatesFromPhrase(phrase) {
  const words = cleanedWords(phrase);
  if (!words.length) return [];

  const productWords = unique(words.filter(isProductTerm));
  const collected = [];

  // Complete cleaned phrase plus every deliberately generated useful form.
  // There is no numeric variant cap, but we avoid every possible n-gram because
  // that would create tens of thousands of weak Google Trends requests.
  collected.push(words.join(" "));
  addEdgePhrases(collected, words, 4);
  addProductCenteredPhrases(collected, words);

  if (productWords.length) {
    collected.push(productWords.join(" "));
    addEdgePhrases(collected, productWords, 4);
    for (const word of productWords) {
      collected.push(word);
      const base = productTermBase(word);
      if (base && base !== word) collected.push(base);
    }
  }

  // Last-resort noun fallback for phrases whose product noun is not yet in the
  // dictionary. This is intentionally narrow: only the final meaningful word
  // of a multi-word phrase is added, never every individual word.
  const lastWord = words[words.length - 1];
  if (!productWords.length && isMeaningfulSingleWordFallback(lastWord, words)) collected.push(lastWord);

  return unique(collected).filter(keyword => keyword.length >= 3);
}

function scoreKeywordCandidate(keyword) {
  const words = keyword.split(/\s+/).filter(Boolean);
  const importantCount = words.filter(isProductTerm).length;
  const phraseBonus = words.length >= 2 && words.length <= 4 ? 4 : 0;
  const longPenalty = words.length > 5 ? -4 : 0;
  const oneWordPenalty = words.length === 1 ? -3 : 0;
  return importantCount * 5 + phraseBonus + longPenalty + oneWordPenalty + Math.min(3, words.length);
}

function cleanedWords(text) {
  return normalizeKeyword(text)
    .split(/\s+/)
    .filter(w => (w.length > 2 || TECH_TOKENS.has(w)) && !STOP_WORDS.has(w));
}

export function makeKeyword(text) {
  const words = cleanedWords(text);
  return words.slice(0, 4).join(" ").trim();
}

export function extractProductKeywords(productOrName, categoryArg = "", maxKeywords = 8) {
  let rawName = "";
  let category = categoryArg || "";
  let existing = [];
  let aliExpressKeyword = "";
  let brand = "";
  let aliExpressProduct = false;

  if (typeof productOrName === "object" && productOrName !== null) {
    rawName = productOrName?.raw?.productNameEn || productOrName?.productNameEn || productOrName?.name || productOrName?.productName || "";
    category = productOrName?.category || productOrName?.categoryName || productOrName?.raw?.categoryName || categoryArg || "";
    existing = [
      ...(Array.isArray(productOrName?.aiKeywords) ? productOrName.aiKeywords : []),
      ...(Array.isArray(productOrName?.specificKeywords) ? productOrName.specificKeywords : [])
    ];
    aliExpressProduct = isAliExpressProduct(productOrName);
    aliExpressKeyword = getAliExpressKeyword(productOrName);
    brand = cleanProductName(
      productOrName?.brand ||
      productOrName?.brandName ||
      productOrName?.raw?.brand ||
      productOrName?.raw?.brandName ||
      productOrName?.raw?.productBrand ||
      ""
    );
  } else {
    rawName = productOrName || "";
  }

  // Google Trends keyword sources:
  // CJ and other sources: product title + category + existing keyword fields.
  // AliExpress: product title + AliExpress/existing keywords only; do NOT use category.
  const normalizedTitle = normalizeKeyword(rawName);
  const normalizedBrand = normalizeKeyword(brand);
  const brandAlreadyInTitle = normalizedBrand && normalizedTitle
    .split(/\s+/)
    .includes(normalizedBrand);
  const brandedTitle = brand && rawName && !brandAlreadyInTitle
    ? `${brand} ${rawName}`
    : "";

  const basePhrases = (aliExpressProduct
    ? [
        rawName,
        aliExpressKeyword,
        brand,
        brandedTitle,
        ...existing
      ]
    : [
        rawName,
        category,
        brand,
        brandedTitle,
        `${category} ${rawName}`,
        ...existing
      ]
  ).map(cleanProductName).filter(Boolean);

  const collected = [];

  for (const phrase of basePhrases) {
    collected.push(...buildKeywordCandidatesFromPhrase(phrase));
  }

  const ranked = unique(collected)
    .map(keyword => ({
      keyword,
      score: scoreKeywordCandidate(keyword)
    }))
    .filter(item => item.keyword.length >= 3)
    .sort((a, b) =>
      b.score - a.score ||
      b.keyword.split(/\s+/).length - a.keyword.split(/\s+/).length ||
      a.keyword.length - b.keyword.length ||
      a.keyword.localeCompare(b.keyword)
    )
    .map(item => item.keyword);

  // A positive value keeps old callers bounded. Zero/negative means all useful
  // variants, which the Google Trends collector uses for each product bundle.
  return maxKeywords > 0 ? ranked.slice(0, maxKeywords) : ranked;
}

// Backward-compatible name used by some merge scripts.
export function makeSpecificKeywords(name, category = "", maxKeywords = 8) {
  return extractProductKeywords(name, category, maxKeywords);
}

function productIdentity(product, index) {
  return String(
    product?.id ||
    product?.productId ||
    product?.pid ||
    product?.raw?.pid ||
    product?.raw?.productId ||
    product?.supplierUrl ||
    product?.url ||
    `product-${index}`
  );
}

export function extractKeywords(products, limit = 120) {
  const keywordMap = new Map();

  products.forEach((product, index) => {
    // Keep the same multi-keyword architecture: each product contributes its
    // strongest keyword anchors, and merge-trend-signals can combine up to five
    // distinct Google signals. Each anchor now carries the full product-derived
    // variant set instead of being tested as an isolated short phrase.
    const anchors = extractProductKeywords(product, "", 8);
    const allVariants = extractProductKeywords(product, "", 0);
    if (!anchors.length || !allVariants.length) return;

    const id = productIdentity(product, index);
    const title = cleanProductName(
      product?.raw?.productNameEn ||
      product?.productNameEn ||
      product?.name ||
      product?.productName ||
      anchors[0]
    );

    anchors.forEach((keyword, anchorRank) => {
      if (!keywordMap.has(keyword)) {
        keywordMap.set(keyword, {
          keyword,
          count: 0,
          variants: [],
          representativeRank: Number.POSITIVE_INFINITY,
          productIds: new Set(),
          sourceTitles: new Set(),
          productTitle: "" // will be set below
        });
      }

      const entry = keywordMap.get(keyword);
      entry.count += 1;
      entry.productIds.add(id);
      if (title) entry.sourceTitles.add(title);

      // A shared keyword such as "mat cover" may belong to many products. Do
      // not combine every title into thousands of requests. Keep the complete,
      // unlimited variant set from the strongest representative product for
      // this anchor. There is still no numeric variant cap.
      if (
        anchorRank < entry.representativeRank ||
        (anchorRank === entry.representativeRank && allVariants.length > entry.variants.length)
      ) {
        entry.representativeRank = anchorRank;
        entry.variants = [...allVariants];
        // Store the title of the product that contributed the variants.
        entry.productTitle = title;
      }
    });
  });

  return [...keywordMap.values()]
    .map(entry => ({
      keyword: entry.keyword,
      count: entry.count,
      variants: entry.variants,
      productIds: [...entry.productIds],
      sourceTitles: [...entry.sourceTitles].slice(0, 12),
      productTitle: entry.productTitle || (entry.sourceTitles.length ? entry.sourceTitles[0] : "")
    }))
    .sort((a, b) =>
      b.count - a.count ||
      b.variants.length - a.variants.length ||
      b.keyword.split(/\s+/).length - a.keyword.split(/\s+/).length ||
      a.keyword.localeCompare(b.keyword)
    )
    .slice(0, limit);
}