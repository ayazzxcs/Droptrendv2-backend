import { readJson, writeJson, num, normalizeKeyword } from "./utils.js";

const CJ_TARGET = Number(process.env.CJ_SOURCE_TARGET || process.env.CJ_MAX_PRODUCTS || 750);
const ALIEXPRESS_TARGET = Number(process.env.ALIEXPRESS_SOURCE_TARGET || process.env.ALIEXPRESS_MAX_PRODUCTS || 750);
const FINAL_MAX_PRODUCTS = Number(process.env.FINAL_MAX_PRODUCTS || 1500);

const cjProducts = readJson("cj-products.json", readJson("products.json", []));
const aliExpressProducts = readJson("aliexpress-products.json", []);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sourceName(p) {
  const s = String(p.source || p.supplier || p.marketplace || "").toLowerCase();
  if (s.includes("ali")) return "AliExpress";
  if (s.includes("cj")) return "CJdropshipping";
  return p.supplier || p.source || "Unknown";
}

function sourcePrefix(p) {
  const s = sourceName(p);
  return s === "AliExpress" ? "aliexpress" : (s === "CJdropshipping" ? "cj" : "source");
}

function getName(p) {
  return cleanText(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || p.title || "");
}

function wordsKey(text) {
  return normalizeKeyword(text)
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 8)
    .join(" ");
}

function productKey(p) {
  const source = sourcePrefix(p);
  const id = cleanText(p.id || p.sourceProductId || p.raw?.pid || p.raw?.productId || p.raw?.productIdStr);
  if (id) return `${source}:id:${id}`;

  const url = cleanText(p.supplierUrl || p.productUrl || p.url);
  if (url) return `${source}:url:${url.toLowerCase().replace(/[?#].*$/g, "")}`;

  return `${source}:name:${wordsKey(getName(p))}`;
}

function crossProductKey(p) {
  // Soft cross-source dedupe key. It only removes very similar titles, not loose category overlap.
  return wordsKey(getName(p));
}

function qualityScore(p) {
  return (
    num(p.winningScore) * 1.2 +
    num(p.trend) +
    num(p.sourceScore) +
    Math.min(60, Math.log10(num(p.orders || p.soldCount || p.listedCount) + 1) * 20) +
    Math.min(25, num(p.rating) * 5) +
    (p.image ? 20 : 0) +
    (p.supplierUrl || p.productUrl ? 15 : 0)
  );
}

function normalizeSourceProduct(p) {
  const source = sourceName(p);
  const prefix = sourcePrefix(p);
  const name = getName(p);

  const sourceProductId = cleanText(
    p.sourceProductId ||
    p.raw?.pid ||
    p.raw?.productId ||
    p.raw?.id ||
    p.id
  ).replace(new RegExp(`^${prefix}-`, "i"), "");

  const id = prefix === "aliexpress"
    ? (String(p.id || "").startsWith("aliexpress-") ? p.id : `aliexpress-${sourceProductId || wordsKey(name)}`)
    : (p.id || sourceProductId || name);

  const supplierPrice = num(p.supplierPrice || p.cost || p.raw?.sellPrice || p.price);
  const sell = num(p.sell || p.suggestedPrice || p.suggestSellPrice) || (supplierPrice ? Math.ceil(supplierPrice * 2.25) : 0);
  const shipping = num(p.shipping || p.shippingPrice || 0);
  const profit = num(p.profit) || Math.max(0, sell - supplierPrice - shipping);
  const margin = num(p.margin) || (sell ? Math.round((profit / sell) * 100) : 0);

  return {
    ...p,
    id,
    source,
    marketplace: p.marketplace || source,
    supplier: p.supplier || source,
    sourceProductId,
    name,
    productName: p.productName || name,
    productNameEn: p.productNameEn || name,
    supplierPrice,
    cost: supplierPrice,
    sell,
    suggestedPrice: sell,
    shipping,
    shippingPrice: shipping,
    profit,
    margin,
    market: p.market || "Worldwide",
    tags: Array.from(new Set([...(Array.isArray(p.tags) ? p.tags : []), `${source} source`])),
    sourceScore: num(p.sourceScore || p.trend || p.winningScore),
    trend: num(p.trend || p.sourceScore || p.winningScore),
    winningScore: num(p.winningScore || p.trend || p.sourceScore)
  };
}

function dedupeWithin(list) {
  const map = new Map();

  for (const raw of Array.isArray(list) ? list : []) {
    const p = normalizeSourceProduct(raw);
    if (!getName(p) || !p.image) continue;

    const key = productKey(p);
    const prev = map.get(key);

    if (!prev || qualityScore(p) > qualityScore(prev)) {
      map.set(key, p);
    }
  }

  return [...map.values()].sort((a, b) => qualityScore(b) - qualityScore(a));
}

function pickBalanced(cj, ali) {
  const final = [];
  const crossSeen = new Set();

  function add(p, strictCross = true) {
    if (final.length >= FINAL_MAX_PRODUCTS) return false;

    const key = crossProductKey(p);
    if (strictCross && key && crossSeen.has(key)) return false;

    final.push(p);
    if (key) crossSeen.add(key);
    return true;
  }

  const cjTop = cj.slice(0, CJ_TARGET);
  const aliTop = ali.slice(0, ALIEXPRESS_TARGET);

  for (const p of cjTop) add(p, true);
  for (const p of aliTop) add(p, true);

  // If strict cross-source dedupe removed too much, fill with good leftovers.
  const leftovers = [...cj.slice(CJ_TARGET), ...ali.slice(ALIEXPRESS_TARGET), ...cjTop, ...aliTop]
    .sort((a, b) => qualityScore(b) - qualityScore(a));

  const ids = new Set(final.map(p => productKey(p)));
  for (const p of leftovers) {
    if (final.length >= FINAL_MAX_PRODUCTS) break;
    const idKey = productKey(p);
    if (ids.has(idKey)) continue;
    final.push(p);
    ids.add(idKey);
  }

  return final.slice(0, FINAL_MAX_PRODUCTS);
}

const cj = dedupeWithin(cjProducts);
const ali = dedupeWithin(aliExpressProducts);
const merged = pickBalanced(cj, ali);

writeJson("products.json", merged);
writeJson("source-products-meta.json", {
  updatedAt: new Date().toISOString(),
  finalCount: merged.length,
  finalMaxProducts: FINAL_MAX_PRODUCTS,
  cj: {
    rawCount: Array.isArray(cjProducts) ? cjProducts.length : 0,
    dedupedCount: cj.length,
    target: CJ_TARGET,
    selectedCount: merged.filter(p => sourceName(p) === "CJdropshipping").length
  },
  aliexpress: {
    rawCount: Array.isArray(aliExpressProducts) ? aliExpressProducts.length : 0,
    dedupedCount: ali.length,
    target: ALIEXPRESS_TARGET,
    selectedCount: merged.filter(p => sourceName(p) === "AliExpress").length
  },
  note: "Final products.json is built from balanced source ingestion: 750 CJ + 750 AliExpress target, with dedupe and fallback fill if one source has fewer valid products."
});

console.log(`Merged sources into products.json: ${merged.length} products`);
console.log(`CJ selected: ${merged.filter(p => sourceName(p) === "CJdropshipping").length}/${cj.length}`);
console.log(`AliExpress selected: ${merged.filter(p => sourceName(p) === "AliExpress").length}/${ali.length}`);