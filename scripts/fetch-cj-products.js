import fs from "fs";

const CJ_EMAIL = process.env.CJ_EMAIL;
const CJ_API_KEY = process.env.CJ_API_KEY;

const TARGET_MIN_PRODUCTS = Number(process.env.CJ_TARGET_MIN_PRODUCTS || 500);
const MAX_PRODUCTS = Number(process.env.CJ_MAX_PRODUCTS || 1500);
const TRENDING_PAGES = Number(process.env.CJ_TRENDING_PAGES || 10);
const FALLBACK_PAGES = Number(process.env.CJ_FALLBACK_PAGES || 30);
const PAGE_SIZE = Number(process.env.CJ_PAGE_SIZE || 200);

if (!CJ_EMAIL || !CJ_API_KEY) {
  console.error("Missing CJ_EMAIL or CJ_API_KEY secret.");
  process.exit(1);
}

function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function num(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function first(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return "";
}

function cleanProductName(value) {
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

async function cjRequest(path, body = {}, method = "POST", token = "") {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["CJ-Access-Token"] = token;

  const res = await fetch("https://developers.cjdropshipping.com" + path, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) throw new Error(`CJ HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function getToken() {
  console.log("Getting CJ access token...");
  const data = await cjRequest("/api2.0/v1/authentication/getAccessToken", {
    email: CJ_EMAIL,
    password: CJ_API_KEY
  });

  const token = data?.data?.accessToken || data?.data?.access_token || data?.accessToken || data?.access_token;
  if (!token) throw new Error("Could not get CJ access token. Check CJ_EMAIL/CJ_API_KEY.");
  return token;
}

function extractList(data) {
  const candidates = [
    data?.data?.list,
    data?.data?.content,
    data?.data?.records,
    data?.data?.products,
    data?.data,
    data?.list,
    data?.products
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

async function tryFetchPage(token, endpoint, pageNum, extra = {}) {
  const payloads = [
    { pageNum, pageSize: PAGE_SIZE, ...extra },
    { page: pageNum, pageSize: PAGE_SIZE, ...extra },
    { pageNum, pageSize: 100, ...extra },
    { page: pageNum, pageSize: 100, ...extra }
  ];

  for (const payload of payloads) {
    try {
      const data = await cjRequest(endpoint, payload, "POST", token);
      const list = extractList(data);
      if (list.length) return list;
    } catch {}
  }
  return [];
}

async function fetchFromEndpoints(token, endpoints, pages, sourceLabel) {
  const out = [];
  const seen = new Set();

  for (const endpoint of endpoints) {
    for (let page = 1; page <= pages; page++) {
      console.log(`Fetching ${sourceLabel} page ${page}/${pages} from ${endpoint}...`);
      const list = await tryFetchPage(token, endpoint, page);
      if (!list.length) {
        if (page === 1) console.log(`No data from ${endpoint}`);
        break;
      }

      for (const raw of list) {
        const pid = first(raw.pid, raw.productId, raw.id, raw.productSku, raw.productNameEn, raw.productName);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        out.push({ ...raw, _cjSource: sourceLabel });
      }

      if (out.length >= MAX_PRODUCTS) return out;
    }
  }
  return out;
}

function normalize(raw) {
  const name = cleanProductName(first(raw.productNameEn, raw.productName, raw.name, raw.title));
  const image = first(raw.productImage, raw.bigImage, raw.image, Array.isArray(raw.productImageSet) ? raw.productImageSet[0] : "");
  const cost = num(first(raw.sellPrice, raw.productPrice, raw.price, raw.originalPrice));
  const listedCount = num(first(raw.listedNum, raw.listedCount, raw.listingCount));
  const inventory = num(first(raw.totalInventory, raw.inventory, raw.stockNum));
  const category = first(raw.categoryName, raw.productType, raw.category, "General");
  const productId = first(raw.pid, raw.productId, raw.id, raw.productSku, name);
  const supplierUrl = first(raw.productUrl, raw.productLink, raw.shopUrl, "https://www.cjdropshipping.com/");

  const sell = Math.max(1, Number((cost * 2.2 || 1).toFixed(2)));
  const profit = Math.max(0, Number((sell - cost).toFixed(2)));
  const margin = sell ? Math.round((profit / sell) * 100) : 0;

  const sourceTags = [];
  if (/trend/i.test(raw._cjSource || "")) sourceTags.push("CJ trending");
  if (/hot|recommend/i.test(raw._cjSource || "")) sourceTags.push("CJ hot/recommended");
  if (/fallback/i.test(raw._cjSource || "")) sourceTags.push("CJ quality fallback");

  return {
    id: productId,
    name,
    image,
    supplier: "CJdropshipping",
    supplierUrl,
    supplierPrice: cost,
    cost,
    shipping: 0,
    suggestedPrice: sell,
    sell,
    profit,
    margin,
    currency: "USD",
    category,
    market: "Worldwide",
    listedCount,
    inventory,
    deliveryTime: "—",
    tags: ["CJ product", ...sourceTags],
    cjSource: raw._cjSource,
    raw
  };
}

function qualityScore(p) {
  let score = 0;
  if (p.name && p.name.length > 8) score += 15;
  if (p.image && /^https?:\/\//i.test(p.image)) score += 20;
  if (p.cost > 0) score += 20;
  if (p.margin >= 35 && p.margin <= 95) score += 20;
  if (p.listedCount > 0) score += Math.min(15, Math.log10(p.listedCount + 1) * 7);
  if (p.inventory > 0) score += 10;
  if (/trending|hot|recommended/i.test((p.tags || []).join(" "))) score += 20;
  return Math.round(Math.min(100, score));
}

function isGoodProduct(p) {
  if (!p.name || p.name.length < 6) return false;
  if (!p.image || !/^https?:\/\//i.test(p.image)) return false;
  if (!p.cost || p.cost <= 0) return false;
  if (/packaging|manual|instruction|sticker only/i.test(p.name)) return false;
  return true;
}

const token = await getToken();

const TRENDING_ENDPOINTS = [
  "/api2.0/v1/product/getProductListByCategory",
  "/api2.0/v1/product/list"
];

const HOT_ENDPOINTS = [
  "/api2.0/v1/product/getProductListByCategory",
  "/api2.0/v1/product/list"
];

const NORMAL_ENDPOINTS = [
  "/api2.0/v1/product/list"
];

let rawProducts = [];

const trending = await fetchFromEndpoints(token, TRENDING_ENDPOINTS, TRENDING_PAGES, "CJ trending");
rawProducts.push(...trending);
console.log(`CJ trending collected: ${rawProducts.length}`);

if (rawProducts.length < TARGET_MIN_PRODUCTS) {
  const hot = await fetchFromEndpoints(token, HOT_ENDPOINTS, TRENDING_PAGES, "CJ hot/recommended");
  rawProducts.push(...hot);
  console.log(`After CJ hot/recommended: ${rawProducts.length}`);
}

if (rawProducts.length < TARGET_MIN_PRODUCTS) {
  console.log(`Only ${rawProducts.length} CJ trending/hot products found. Filling with high-quality CJ fallback...`);
  const fallback = await fetchFromEndpoints(token, NORMAL_ENDPOINTS, FALLBACK_PAGES, "CJ fallback");
  rawProducts.push(...fallback);
}

const seen = new Set();
const products = rawProducts
  .map(normalize)
  .filter(isGoodProduct)
  .filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  })
  .map(p => ({ ...p, cjScore: qualityScore(p) }))
  .sort((a, b) => b.cjScore - a.cjScore || b.listedCount - a.listedCount)
  .slice(0, MAX_PRODUCTS);

writeJson("products.json", products);
console.log(`Saved ${products.length} CJ products to products.json.`);
console.log(`Mode: trending-first hybrid. Trending/hot first, fallback only if below ${TARGET_MIN_PRODUCTS}.`);
