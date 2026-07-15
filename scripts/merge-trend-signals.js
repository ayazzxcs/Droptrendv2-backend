import { readJson, writeJson, num, extractProductKeywords, normalizeKeyword } from "./utils.js";

const products = readJson("products.json", []);
const googleSignals = readJson("google-trends.json", []);
const googleSignalsByProduct = readJson("google-trends-by-product.json", {});
const rawAmazonSignals = readJson("amazon-products.json", []);
const existingHistory = readJson("trend-history.json", {});
const nextHistory = {};
const runDate = new Date().toISOString().slice(0, 10);

function productText(p) {
  return `${p.raw?.productNameEn || p.productNameEn || p.name || p.productName || ""} ${p.category || p.categoryName || p.raw?.categoryName || ""}`.toLowerCase();
}

function productName(p) {
  return String(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "").trim();
}

function productId(p) {
  return String(
    p.id ||
    p.pid ||
    p.productId ||
    p.sku ||
    p.raw?.pid ||
    p.raw?.productId ||
    productName(p)
  ).trim();
}

function googleSignalsForProduct(p) {
  const id = productId(p);
  const keyed = googleSignalsByProduct && typeof googleSignalsByProduct === "object"
    ? googleSignalsByProduct[id]
    : null;

  if (Array.isArray(keyed)) return keyed.filter(Boolean);
  if (keyed && typeof keyed === "object") return [keyed];

  // Fallback for older runs that only wrote google-trends.json.
  // Only accept signals that explicitly list the current product id.
  return (Array.isArray(googleSignals) ? googleSignals : []).filter(signal =>
    Array.isArray(signal?.productIds) &&
    signal.productIds.some(signalId => String(signalId) === id)
  );
}

function timelineFromSignal(signal, limit = 60) {
  if (!signal) return [];

  if (Array.isArray(signal.timeline)) {
    return signal.timeline
      .map((point, index) => ({
        label: String(point?.label || point?.date || `P${index + 1}`),
        value: num(point?.value ?? point?.score ?? point)
      }))
      .filter(point => Number.isFinite(point.value))
      .slice(-limit);
  }

  if (Array.isArray(signal.timelineValues)) {
    return signal.timelineValues
      .map((value, index) => ({
        label: `P${index + 1}`,
        value: num(value)
      }))
      .filter(point => Number.isFinite(point.value))
      .slice(-limit);
  }

  return [];
}

function appendHistory(previous, entry, limit = 370) {
  const list = Array.isArray(previous) ? previous.filter(Boolean) : [];
  const withoutToday = list.filter(item => item?.date !== entry.date);
  return [...withoutToday, entry].slice(-limit);
}

function words(text) {
  return normalizeKeyword(text).split(/\s+/).filter(Boolean);
}

function overlapCount(a, b) {
  const setB = new Set(b);
  return a.filter(x => setB.has(x)).length;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function cleanKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[?#].*$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function amazonKey(a) {
  const productIdValue = cleanKey(a.productId || a.cjProductId || a.sourceProductId || a.id);
  if (productIdValue) return `product:${productIdValue}`;

  const productNameValue = cleanKey(a.productName || a.cjProductName || a.originalProductName || a.keyword);
  if (productNameValue) return `name:${productNameValue}`;

  const productUrl = cleanKey(a.productUrl || a.url || a.amazonUrl);
  if (productUrl) return `url:${productUrl}`;

  const title = cleanKey(a.title || a.amazonTitle);
  if (title) return `title:${title}`;

  return "";
}

function amazonQuality(a) {
  return (
    num(a.score) * 1000 +
    num(a.matchScore) * 20 +
    num(a.bestRating) * 20 +
    Math.log10(num(a.bestRatingsTotal) + 1) * 60 +
    (a.productUrl || a.url || a.amazonUrl ? 30 : 0) +
    (a.asin ? 30 : 0) +
    (a.isBestSeller ? 40 : 0)
  );
}

function dedupeAmazonSignals(signals) {
  const bestByKey = new Map();

  for (const signal of Array.isArray(signals) ? signals : []) {
    const key = amazonKey(signal);
    if (!key) continue;

    const previous = bestByKey.get(key);
    if (!previous || amazonQuality(signal) > amazonQuality(previous)) {
      bestByKey.set(key, signal);
    }
  }

  return [...bestByKey.values()];
}

const amazonSignals = dedupeAmazonSignals(rawAmazonSignals);

function productKeywords(p) {
  return extractProductKeywords(p, "", 8);
}

function findGoogleMatches(p) {
  const productGoogleSignals = googleSignalsForProduct(p);
  if (!productGoogleSignals.length) return [];

  const keywordPool = productKeywords(p);
  const categoryWords = words(p.category || p.categoryName || p.raw?.categoryName || "");
  const nameWords = words(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "");

  const matches = productGoogleSignals
    .map(signal => {
      const candidates = [signal.keyword, signal.usedKeyword]
        .map(normalizeKeyword)
        .filter(Boolean);

      const currentProductId = productId(p);
      const exactProductMatch =
        Array.isArray(signal.productIds) &&
        signal.productIds.some(id => String(id) === currentProductId);

      // productGoogleSignals already restricts candidates to this product id.
      // If productIds are missing or wrong, do not allow broad keyword-only matching.
      if (!exactProductMatch) return null;

      let matchScore = 200;
      let matchedKeyword = "";
      let categoryMatch = false;

      for (const poolKeyword of keywordPool) {
        const poolNorm = normalizeKeyword(poolKeyword);
        const poolWords = words(poolKeyword);

        for (const candidate of candidates) {
          if (!candidate) continue;

          const candidateWords = words(candidate);
          const overlap = overlapCount(poolWords, candidateWords);
          const nameOverlap = overlapCount(nameWords, candidateWords);
          const categoryOverlap = overlapCount(categoryWords, candidateWords);
          const exact = poolNorm === candidate ? 100 : 0;
          const contains = poolNorm.includes(candidate) || candidate.includes(poolNorm) ? 30 : 0;
          const score = exact + contains + overlap * 12 + nameOverlap * 6 + categoryOverlap * 5;
          const finalScore = score + 200;

          if (finalScore > matchScore) {
            matchScore = finalScore;
            matchedKeyword = poolKeyword;
            categoryMatch = categoryOverlap > 0;
          }
        }
      }

      return {
        signal,
        matchScore,
        matchedKeyword,
        categoryMatch,
        exactProductMatch,
        wordCount: words(signal.keyword || signal.usedKeyword || "").length,
        signalScore: num(signal.score)
      };
    })
    .filter(Boolean)
    .filter(x => x.matchScore >= 200)
    .sort((a, b) =>
      b.matchScore - a.matchScore ||
      b.signalScore - a.signalScore ||
      b.wordCount - a.wordCount
    );

  // Important: do NOT count five different saved signals if they all used the
  // same real Google Trends keyword.
  const uniqueUsedKeywordMatches = uniqBy(
    matches,
    item => normalizeKeyword(item.signal.usedKeyword || item.signal.keyword || "")
  );

  return uniqueUsedKeywordMatches.slice(0, 5);
}

function combineGoogleScore(matches) {
  if (!matches.length) {
    return {
      score: 0,
      best: null,
      topMatches: [],
      top3Average: 0,
      categoryScore: 0
    };
  }

  const topMatches = matches.slice(0, 5);
  const best = topMatches[0];
  const top3 = topMatches.slice(0, 3);
  const top3Average = top3.length
    ? Math.round(top3.reduce((sum, item) => sum + num(item.signal.score), 0) / top3.length)
    : 0;
  const categoryItem = topMatches.find(item => item.categoryMatch) || best;
  const categoryScore = num(categoryItem?.signal?.score);
  const combinedScore = Math.round(
    num(best.signal.score) * 0.5 +
    top3Average * 0.3 +
    categoryScore * 0.2
  );

  return {
    score: combinedScore,
    best,
    topMatches,
    top3Average,
    categoryScore
  };
}

function findAmazon(p) {
  const pid = String(p.id || "").trim();
  const name = productName(p).toLowerCase();

  const matches = amazonSignals
    .map(a => {
      const aid = String(a.productId || "").trim();
      const aname = String(a.productName || "").toLowerCase().trim();
      let matchScore = 0;

      if (pid && aid && pid === aid) {
        matchScore = 100;
      } else if (name && aname && name === aname) {
        matchScore = 95;
      } else if (name && aname && (name.includes(aname) || aname.includes(name))) {
        matchScore = 80;
      }

      return {
        signal: a,
        matchScore,
        signalScore: num(a.score),
        lensMatchScore: num(a.matchScore)
      };
    })
    .filter(x => x.matchScore >= 80);

  if (!matches.length) return null;

  matches.sort((a, b) =>
    b.matchScore - a.matchScore ||
    b.lensMatchScore - a.lensMatchScore ||
    b.signalScore - a.signalScore
  );

  return matches[0].signal;
}

function productSource(p) {
  const source = String(p.source || p.supplier || p.marketplace || "").toLowerCase();
  if (source.includes("ali")) return "AliExpress";
  if (source.includes("cj")) return "CJdropshipping";
  return p.supplier || p.source || "Supplier";
}

function sourceScore(p) {
  const source = productSource(p);
  const image = p.image || p.productImage || p.raw?.productImage;
  const price = num(p.cost || p.supplierPrice || p.raw?.sellPrice || p.price);
  const margin = num(p.margin);
  const listed = num(
    p.listedCount ||
    p.orders ||
    p.soldCount ||
    p.raw?.listingCount ||
    p.raw?.listedNum
  );
  const orders = num(
    p.orders ||
    p.soldCount ||
    p.raw?.orders ||
    p.raw?.sold
  );
  const rating = num(p.rating || p.raw?.rating || p.raw?.averageStar);
  const existingSourceScore = num(p.sourceScore);

  let score = 0;
  if (image) score += 18;
  if (price > 0) score += 18;
  score += Math.min(22, Math.max(0, margin - 25) * 0.55);
  score += Math.min(24, Math.log10(listed + 1) * 9);
  score += Math.min(12, Math.log10(orders + 1) * 5);
  score += Math.min(12, Math.max(0, rating - 3.5) * 8);

  // AliExpress scraper already computes sourceScore from orders/rating/rank.
  // Blend it in, but do not allow source-only score to dominate final Quvirl score.
  if (existingSourceScore > 0) {
    score = Math.max(score, existingSourceScore * 0.75);
  }

  if (source === "CJdropshipping") score += 8;
  if (source === "AliExpress") score += 8;

  return Math.round(Math.max(1, Math.min(100, score)));
}

const merged = products.map(p => {
  const id = productId(p);
  const googleMatches = findGoogleMatches(p);
  const googleCombined = combineGoogleScore(googleMatches);
  const a = findAmazon(p);
  const source = productSource(p);
  const s = sourceScore(p);

  const googleScore = googleCombined.score;
  const amazonScore = a ? num(a.score) : 0;
  const dropTrendScore = Math.round(
    googleScore * 0.4 +
    amazonScore * 0.4 +
    s * 0.2
  );

  const historyEntry = {
    date: runDate,
    productId: id,
    quvirlScore: dropTrendScore,
    dropTrendScore,
    googleScore,
    amazonScore,
    supplierScore: s,
    cjScore: source === "CJdropshipping" ? s : 0,
    aliExpressScore: source === "AliExpress" ? s : 0,
    googleKeyword: googleCombined.best?.signal?.usedKeyword || googleCombined.best?.signal?.keyword || "",
    amazonMatched: Boolean(a),
    source,
    confidence: googleScore && amazonScore ? "High" : (googleScore || amazonScore ? "Medium" : "Low")
  };

  const previousHistory = existingHistory[id] || p.scoreHistory || p.history || [];
  const scoreHistory = appendHistory(previousHistory, historyEntry);
  nextHistory[id] = scoreHistory;

  return {
    ...p,
    id,
    dropTrendScore,
    scoreHistory,
    trend: dropTrendScore,
    aiKeywords: p.aiKeywords || productKeywords(p),
    specificKeywords: p.specificKeywords || productKeywords(p),
    trendProof: {
      confidence: googleScore && amazonScore
        ? "High"
        : (googleScore || amazonScore ? "Medium" : "Low"),
      googleTrends: googleCombined.best ? {
        keyword: googleCombined.best.signal.keyword,
        usedKeyword: googleCombined.best.signal.usedKeyword,
        score: googleScore,
        rawScore: googleCombined.best.signal.rawScore,
        growthPercent: googleCombined.best.signal.growthPercent,
        firstAvg: googleCombined.best.signal.firstAvg,
        lastAvg: googleCombined.best.signal.lastAvg,
        latestValue: googleCombined.best.signal.latestValue,
        maxValue: googleCombined.best.signal.maxValue,
        timeline: timelineFromSignal(googleCombined.best.signal),
        timelineValues: timelineFromSignal(googleCombined.best.signal).map(point => point.value),
        timelinePoints:
          timelineFromSignal(googleCombined.best.signal).length ||
          googleCombined.best.signal.timelinePoints ||
          0,
        match: 1,
        combined: googleCombined.topMatches.length > 1,
        bestKeywordScore: num(googleCombined.best.signal.score),
        top3Average: googleCombined.top3Average,
        categoryScore: googleCombined.categoryScore,
        matchedKeywordCount: googleCombined.topMatches.length,
        keywordScores: googleCombined.topMatches.map(item => ({
          keyword: item.signal.keyword,
          usedKeyword: item.signal.usedKeyword,
          score: num(item.signal.score),
          growthPercent: num(item.signal.growthPercent),
          matchedKeyword: item.matchedKeyword,
          matchScore: item.matchScore,
          timelinePoints:
            timelineFromSignal(item.signal).length ||
            item.signal.timelinePoints ||
            0
        })),
        checkedKeywords: productKeywords(p)
      } : null,
      amazon: a ? {
        keyword: a.keyword || "image-match",
        score: amazonScore,
        bestRating: a.bestRating,
        bestRatingsTotal: a.bestRatingsTotal,
        bestPrice: "",
        position: a.position || 1,
        isBestSeller: a.isBestSeller,
        badgeText: a.badgeText,
        productUrl: a.productUrl,
        title: a.title,
        matchScore: a.matchScore,
        matchType: "image",
        lensProvider: a.lensProvider,
        source: a.source || "monthly-lens-provider",
        match: 1
      } : null,
      cjSupplier: {
        // Kept as cjSupplier for frontend/backward compatibility.
        // For AliExpress products this represents AliExpress source/supplier strength.
        score: s,
        source,
        price: p.cost || p.supplierPrice || p.raw?.sellPrice,
        shipping: p.shipping || p.shippingPrice || 0,
        margin: p.margin,
        listedCount:
          p.listedCount ||
          p.orders ||
          p.soldCount ||
          p.raw?.listingCount ||
          p.raw?.listedNum,
        orders: p.orders || p.soldCount || 0,
        rating: p.rating || 0,
        productUrl: p.supplierUrl || p.productUrl || ""
      },
      supplierSource: {
        score: s,
        source,
        supplier: p.supplier || source,
        marketplace: p.marketplace || source,
        price: p.cost || p.supplierPrice || p.raw?.sellPrice,
        shipping: p.shipping || p.shippingPrice || 0,
        margin: p.margin,
        listedCount:
          p.listedCount ||
          p.orders ||
          p.soldCount ||
          p.raw?.listingCount ||
          p.raw?.listedNum,
        orders: p.orders || p.soldCount || 0,
        rating: p.rating || 0,
        productUrl: p.supplierUrl || p.productUrl || ""
      }
    }
  };
});

writeJson("products.json", merged);
writeJson("trend-history.json", nextHistory);

console.log(
  `Merged ${googleSignals.length} Google signals (${Object.keys(googleSignalsByProduct || {}).length} product-keyed) ` +
  `and ${amazonSignals.length} deduped monthly Amazon signals from ${rawAmazonSignals.length} raw Amazon records ` +
  `into ${merged.length} products with product-id-locked Google Trends scoring and source-aware supplier scoring. ` +
  `Updated trend-history.json for ${Object.keys(nextHistory).length} products.`
);
