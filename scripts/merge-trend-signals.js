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
    .replace(/[^a-z0-9]+/*, " ")
    .replace(/\s+/g, " ")
 *  .trim();
}

function amazonKey(a* {
  const productId = cleanKey(
 *  a.productId ||
    a.cjProductId*||
    a.sourceProductId ||
    a.*d
  );

  if (productId) return `p*oduct:${productId}`;

  const prod*ctName = cleanKey(
    a.productNa*e ||
    a.cjProductName ||
    a.*riginalProductName ||
    a.keywor*
  );

  if (productName) return `*ame:${productName}`;

  const prod*ctUrl = cleanKey(
    a.productUrl*||
    a.url ||
    a.amazonUrl
  *;

  if (productUrl) return `url:$*productUrl}`;

  const title = cle*nKey(a.title || a.amazonTitle);

 *if (title) return `title:${title}`*

  return "";
}

function amazonQ*ality(a) {
  return (
    num(a.sc*re) * 1000 +
    num(a.matchScore)** 20 +
    num(a.bestRating) * 20 *
    Math.log10(num(a.bestRatingsT*tal) + 1) * 60 +
    (a.productUrl*|| a.url || a.amazonUrl ? 30 : 0) *
    (a.asin ? 30 : 0) +
    (a.is*estSeller ? 40 : 0)
  );
}

functi*n dedupeAmazonSignals(signals) {
 *const bestByKey = new Map();

  fo* (const signal of Array.isArray(si*nals) ? signals : []) {
    const *ey = amazonKey(signal);
    if (!k*y) continue;

    const previous =*bestByKey.get(key);

    if (!prev*ous || amazonQuality(signal) > ama*onQuality(previous)) {
      bestB*Key.set(key, signal);
    }
  }

 *return [...bestByKey.values()];
}
*const amazonSignals = dedupeAmazon*ignals(rawAmazonSignals);

functio* productKeywords(p) {
  return ext*actProductKeywords(p, "", 8);
}

f*nction findGoogleMatches(p) {
  co*st productGoogleSignals = googleSi*nalsForProduct(p);

  if (!product*oogleSignals.length) return [];

 *const keywordPool = productKeyword*(p);
  const categoryWords = words*p.category || p.categoryName || p.*aw?.categoryName || "");
  const n*meWords = words(p.raw?.productName*n || p.productNameEn || p.name || *.productName || "");

  const matc*es = productGoogleSignals
    .map*signal => {
      const candidates*= [signal.keyword, signal.usedKeyword]
        .map(normalizeKeyword)*        .filter(Boolean);

      c*nst currentProductId = productId(p*;

      const exactProductMatch =*        Array.isArray(signal.produ*tIds) &&
        signal.productIds*some(id => String(id) === currentP*oductId);

      // productGoogleS*gnals already restricts candidates*to this product id.
      // If pr*ductIds are missing or wrong, do n*t allow broad keyword-only matchin*.
      if (!exactProductMatch) re*urn null;

      let matchScore = *00;
      let matchedKeyword = "";*      let categoryMatch = false;

*     for (const poolKeyword of key*ordPool) {
        const poolNorm * normalizeKeyword(poolKeyword);
  *     const poolWords = words(poolK*yword);

        for (const candid*te of candidates) {
          if (*candidate) continue;

          co*st candidateWords = words(candidat*);

          const overlap = over*apCount(poolWords, candidateWords)*
          const nameOverlap = ove*lapCount(nameWords, candidateWords*;
          const categoryOverlap * overlapCount(categoryWords, candi*ateWords);

          const exact * poolNorm === candidate ? 100 : 0;*          const contains = poolNor*.includes(candidate) || candidate.*ncludes(poolNorm) ? 30 : 0;

     *    const score =
            exac* +
            contains +
        *   overlap * 12 +
            name*verlap * 6 +
            categoryO*erlap * 5;

          const finalS*ore = score + 200;

          if (*inalScore > matchScore) {
        *   matchScore = finalScore;
      *     matchedKeyword = poolKeyword;*            categoryMatch = catego*yOverlap > 0;
          }
        *
      }

      return {
        s*gnal,
        matchScore,
        *atchedKeyword,
        categoryMat*h,
        exactProductMatch,
    *   wordCount: words(signal.keyword*|| signal.usedKeyword || "").lengt*,
        signalScore: num(signal.*core)
      };
    })
    .filter(*oolean)
    .filter(x => x.matchSc*re >= 200)
    .sort((a, b) =>
   *  b.matchScore - a.matchScore ||
 *    b.signalScore - a.signalScore *|
      b.wordCount - a.wordCount
*   );

  // Important: do NOT coun* five different saved signals if t*ey all used the
  // same real Goo*le Trends keyword.
  const uniqueU*edKeywordMatches = uniqBy(
    mat*hes,
    item => normalizeKeyword(*tem.signal.usedKeyword || item.sig*al.keyword || "")
  );

  return u*iqueUsedKeywordMatches.slice(0, 5)*
}

function combineGoogleScore(ma*ches) {
  if (!matches.length) {
 *  return {
      score: 0,
      b*st: null,
      topMatches: [],
  *   top3Average: 0,
      categoryS*ore: 0
    };
  }

  const topMatc*es = matches.slice(0, 5);
  const *est = topMatches[0];
  const top3 * topMatches.slice(0, 3);

  const *op3Average = top3.length
    ? Mat*.round(
        top3.reduce((sum, *tem) => sum + num(item.signal.scor*), 0) / top3.length
      )
    : *;

  const categoryItem = topMatch*s.find(item => item.categoryMatch)*|| best;
  const categoryScore = n*m(categoryItem?.signal?.score);

 *const combinedScore = Math.round(
*   num(best.signal.score) * 0.5 +
*   top3Average * 0.3 +
    categor*Score * 0.2
  );

  return {
    s*ore: combinedScore,
    best,
    *opMatches,
    top3Average,
    ca*egoryScore
  };
}

function findAm*zon(p) {
  const pid = String(p.id*|| "").trim();
  const name = prod*ctName(p).toLowerCase();

  const *atches = amazonSignals
    .map(a *> {
      const aid = String(a.pro*uctId || "").trim();
      const a*ame = String(a.productName || "").*oLowerCase().trim();

      let ma*chScore = 0;

      if (pid && aid*&& pid === aid) {
        matchSco*e = 100;
      } else if (name && *name && name === aname) {
        *atchScore = 95;
      } else if (n*me && aname && (name.includes(anam*) || aname.includes(name))) {
    *   matchScore = 80;
      }

     *return {
        signal: a,
      * matchScore,
        signalScore: *um(a.score),
        lensMatchScor*: num(a.matchScore)
      };
    }*
    .filter(x => x.matchScore >= *0);

  if (!matches.length) return*null;

  matches.sort((a, b) =>
  * b.matchScore - a.matchScore ||
  * b.lensMatchScore - a.lensMatchSco*e ||
    b.signalScore - a.signalS*ore
  );

  return matches[0].sign*l;
}

function productSource(p) {
* const source = String(p.source ||*p.supplier || p.marketplace || "")*toLowerCase();

  if (source.inclu*es("ali")) return "AliExpress";
  *f (source.includes("cj")) return "*Jdropshipping";

  return p.suppli*r || p.source || "Supplier";
}

fu*ction sourceScore(p) {
  const sou*ce = productSource(p);

  const im*ge = p.image || p.productImage || *.raw?.productImage;
  const price * num(p.cost || p.supplierPrice || *.raw?.sellPrice || p.price);
  con*t margin = num(p.margin);
  const *isted = num(
    p.listedCount ||
*   p.orders ||
    p.soldCount ||
*   p.raw?.listingCount ||
    p.ra*?.listedNum
  );
  const orders = *um(
    p.orders ||
    p.soldCoun* ||
    p.raw?.orders ||
    p.raw*.sold
  );
  const rating = num(p.*ating || p.raw?.rating || p.raw?.a*erageStar);
  const existingSource*core = num(p.sourceScore);

  let *core = 0;

  if (image) score += 1*;
  if (price > 0) score += 18;

 *score += Math.min(22, Math.max(0, *argin - 25) * 0.55);
  score += Ma*h.min(24, Math.log10(listed + 1) **9);
  score += Math.min(12, Math.l*g10(orders + 1) * 5);
  score += M*th.min(12, Math.max(0, rating - 3.*) * 8);

  // AliExpress scraper a*ready computes sourceScore from or*ers/rating/rank.
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
