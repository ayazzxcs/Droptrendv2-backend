import fs from "fs";

const CJ_EMAIL = process.env.CJ_EMAIL;
const CJ_API_KEY = process.env.CJ_API_KEY;
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);
const MAX_PAGES = Number(process.env.MAX_PAGES || 30);
const BASE_URL = process.env.CJ_BASE_URL || "https://developers.cjdropshipping.com/api2.0/v1";

if (!CJ_EMAIL || !CJ_API_KEY) {
  console.error("Missing CJ_EMAIL or CJ_API_KEY secrets.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function number(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function first(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

async function cjRequest(path, options = {}, token = null) {
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "CJ-Access-Token": token } : {})
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok || data.result === false || data.success === false) {
    throw new Error(`CJ request failed ${res.status}: ${JSON.stringify(data).slice(0, 700)}`);
  }

  return data;
}

async function getToken() {
  const data = await cjRequest("/authentication/getAccessToken", {
    method: "POST",
    body: JSON.stringify({
      email: CJ_EMAIL,
      password: CJ_API_KEY
    })
  });

  return first(
    data?.data?.accessToken,
    data?.data?.access_token,
    data?.accessToken,
    data?.result?.accessToken
  );
}

function normalizeProduct(p) {
  const cost = number(first(
    p.sellPrice,
    p.productPrice,
    p.originalPrice,
    p.price,
    p.suggestSellPrice,
    p.variantSellPrice,
    p.nowPrice
  ));

  const shipping = number(first(p.shippingPrice, p.shipping, p.freight, 0));

  let sell = number(first(
    p.suggestedPrice,
    p.suggestSellPrice,
    p.salePrice,
    p.targetPrice
  ));

  if (!sell || sell <= cost) {
    sell = Math.ceil((cost + shipping) * 2.2);
  }

  const listedCount = number(first(
    p.listedNum,
    p.listedCount,
    p.listingCount,
    p.listNum,
    p.productListedNum
  ));

  const inventory = number(first(
    p.inventory,
    p.totalInventory,
    p.stock,
    p.stockNum,
    p.productStock,
    p.availableQuantity
  ));

  const orders = number(first(
    p.productSellNum,
    p.sellNum,
    p.orderNum,
    p.orders,
    p.sales,
    p.saleNum
  ));

  const image = first(
    p.productImage,
    Array.isArray(p.productImageSet) ? p.productImageSet[0] : "",
    p.bigImage,
    p.image
  );

  const supplierUrl = first(
    p.productUrl,
    p.productLink,
    p.shopUrl,
    p.productUrlEn,
    "https://www.cjdropshipping.com/"
  );

  const category = first(p.categoryName, p.productType, p.category, "General");
  const deliveryTime = first(p.deliveryTime, p.shippingTime, p.estimatedDelivery, "—");

  const profit = Math.max(0, sell - cost - shipping);
  const margin = sell ? Math.round((profit / sell) * 100) : 0;

  const product = {
    id: first(p.pid, p.productId, p.id, p.sku, `${p.productName}-${Math.random()}`),
    name: first(p.productNameEn, p.productName, p.name, p.title, "Untitled product"),
    image,
    supplier: "CJdropshipping",
    supplierUrl,
    supplierPrice: cost,
    cost,
    shippingPrice: shipping,
    shipping,
    suggestedPrice: sell,
    sell,
    profit,
    margin,
    currency: "USD",
    category,
    market: "Worldwide",
    listedCount,
    inventory,
    deliveryTime,
    orders,
    tags: ["CJ product"],
    raw: p
  };

  product.trend = computeTrendScore(product);
  product.winningScore = computeWinningScore(product);

  return product;
}

function hasImage(p) {
  return !!p.image && /^https?:\/\//i.test(p.image);
}

function hasSupplier(p) {
  return !!p.supplierUrl && /^https?:\/\//i.test(p.supplierUrl);
}

function hasValidPrice(p) {
  return number(p.cost) > 0 && number(p.sell) > number(p.cost) && number(p.margin) >= 20 && number(p.margin) <= 95;
}

function demandScore(p) {
  const listed = Math.min(45, Math.log10(number(p.listedCount) + 1) * 18);
  const inventory = Math.min(18, Math.log10(number(p.inventory) + 1) * 6);
  const orders = Math.min(25, Math.log10(number(p.orders) + 1) * 12);
  return listed + inventory + orders;
}

function computeTrendScore(p) {
  const demand = demandScore(p);
  const marginBoost = Math.min(20, Math.max(0, number(p.margin) - 35) * 0.45);
  const profitBoost = Math.min(15, Math.log10(number(p.profit) + 1) * 6);
  const quality = (hasImage(p) ? 5 : 0) + (hasSupplier(p) ? 5 : 0) + (hasValidPrice(p) ? 5 : -20);
  return Math.round(Math.max(1, Math.min(100, 35 + demand + marginBoost + profitBoost + quality)));
}

function computeWinningScore(p) {
  const demand = demandScore(p) * 1.45;
  const profit = Math.min(30, Math.log10(number(p.profit) + 1) * 12);
  const margin = Math.min(25, Math.max(0, number(p.margin) - 30) * 0.65);
  const quality = (hasImage(p) ? 10 : -25) + (hasSupplier(p) ? 8 : -20) + (hasValidPrice(p) ? 18 : -50);
  const bad = /packaging|manual|instruction|sticker|spare part|accessory only/i.test(p.name) ? -25 : 0;
  return Math.round(demand + profit + margin + quality + bad);
}

async function fetchProductsPage(token, pageNum, mode = "normal") {
  await sleep(1200);

  const query = new URLSearchParams({
    pageNum: String(pageNum),
    pageSize: String(PAGE_SIZE)
  });

  // CJ's searchType=2 can return very few products, so we only use it as an optional extra,
  // not as the main feed.
  if (mode === "trending") {
    query.set("searchType", "2");
    query.set("orderBy", "listedNum");
    query.set("sort", "desc");
  }

  const data = await cjRequest(`/product/list?${query.toString()}`, { method: "GET" }, token);
  const list = data?.data?.list || data?.data?.content || data?.data || data?.list || [];
  return Array.isArray(list) ? list : [];
}

async function collectMode(token, mode, maxPages) {
  const out = [];

  for (let page = 1; page <= maxPages; page++) {
    console.log(`Fetching ${mode} page ${page}/${maxPages}...`);
    const items = await fetchProductsPage(token, page, mode);

    if (!items.length) {
      console.log(`No more ${mode} products returned.`);
      break;
    }

    out.push(...items);

    if (items.length < PAGE_SIZE) {
      console.log(`${mode} last page reached.`);
      break;
    }

    await sleep(1500);
  }

  return out;
}

async function main() {
  console.log("Getting CJ access token...");
  const token = await getToken();
  if (!token) throw new Error("No CJ access token returned.");

  const trendingPages = Number(process.env.CJ_TRENDING_PAGES || 10);
  const normalPages = Number(process.env.CJ_NORMAL_PAGES || MAX_PAGES || 30);
  const minProducts = Number(process.env.CJ_MIN_PRODUCTS || 500);
  const maxProducts = Number(process.env.CJ_MAX_PRODUCTS || 1500);

  // 1) Fetch CJ trending first using the already-working searchType=2 logic.
  const trendingItems = await collectMode(token, "trending", trendingPages);
  console.log(`CJ trending products collected: ${trendingItems.length}`);

  // 2) If CJ only returns a tiny trending list, fill with normal CJ products.
  // This keeps the site usable while still ranking CJ trending products higher.
  let normalItems = [];
  if (trendingItems.length < minProducts) {
    console.log(`Only ${trendingItems.length} CJ trending products found. Fetching normal CJ products as fallback...`);
    normalItems = await collectMode(token, "normal", normalPages);
    console.log(`CJ normal fallback products collected: ${normalItems.length}`);
  }

  const all = [];
  const seen = new Set();
  let sampleRaw = trendingItems[0] || normalItems[0] || null;

  function addItems(items, isTrending) {
    for (const item of items) {
      const normalized = normalizeProduct(item);

      normalized.cjTrending = isTrending;
      normalized.tags = isTrending
        ? ["CJ trending", "CJ product"]
        : ["CJ product", "CJ fallback"];

      // Give true CJ trending products a boost, but still allow good normal products as backup.
      if (isTrending) {
        normalized.trend = Math.min(100, Math.max(normalized.trend, normalized.trend + 15));
        normalized.winningScore += 25;
      }

      // Basic quality filter so fallback doesn't fill the site with bad products.
      if (!hasImage(normalized)) continue;
      if (!hasSupplier(normalized)) continue;
      if (!hasValidPrice(normalized)) continue;
      if (/packaging|manual|instruction|sticker only/i.test(normalized.name)) continue;

      if (!seen.has(normalized.id)) {
        seen.add(normalized.id);
        all.push(normalized);
      }

      if (all.length >= maxProducts) break;
    }
  }

  // Trending products are added first, so they stay priority.
  addItems(trendingItems, true);

  if (all.length < minProducts) {
    addItems(normalItems, false);
  }

  all.sort((a, b) =>
    (b.cjTrending === true) - (a.cjTrending === true) ||
    (b.winningScore || 0) - (a.winningScore || 0) ||
    (b.trend || 0) - (a.trend || 0)
  );

  fs.writeFileSync("products.json", JSON.stringify(all, null, 2));
  fs.writeFileSync("products-meta.json", JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: all.length,
    maxProducts,
    pageSize: PAGE_SIZE,
    source: "CJdropshipping",
    mode: "CJ trending-first hybrid",
    trendingOnly: false,
    trendingCount: trendingItems.length,
    fallbackCount: normalItems.length,
    note: "CJ trending/searchType=2 products are fetched first and boosted. If CJ returns too few trending products, normal CJ products are used as quality fallback so products.json is not empty."
  }, null, 2));

  if (sampleRaw) {
    fs.writeFileSync("cj-sample-product.json", JSON.stringify(sampleRaw, null, 2));
  }

  console.log(`Saved ${all.length} CJ products to products.json`);
  console.log(`Trending-first hybrid mode: ${trendingItems.length} raw trending, ${normalItems.length} raw fallback.`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
