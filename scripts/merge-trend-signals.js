import { readJson, writeJson, num, extractProductKeywords, normalizeKeyword } from "./utils.js";

const products = readJson("products.json", []);
const googleSignals = readJson("google-trends.json", []);
const amazonSignals = readJson("amazon-products.json", []);

function productText(p) {
  return `${p.raw?.productNameEn || p.productNameEn || p.name || p.productName || ""} ${p.category || p.categoryName || p.raw?.categoryName || ""}`.toLowerCase();
}

function productName(p) {
  return String(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "").trim();
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

function productKeywords(p) {
  return extractProductKeywords(p, "", 8);
}

function findGoogleMatches(p) {
  const keywordPool = productKeywords(p);
  const categoryWords = words(p.category || p.categoryName || p.raw?.categoryName || "");
  const nameWords = words(p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "");

  const matches = googleSignals
    .map(signal => {
      const candidates = [signal.keyword, signal.usedKeyword].map(normalizeKeyword).filter(Boolean);
      let matchScore = 0;
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

          if (score > matchScore) {
            matchScore = score;
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
        wordCount: words(signal.keyword || signal.usedKeyword || "").length,
        signalScore: num(signal.score)
      };
    })
    .filter(x => x.matchScore >= 24)
    .sort((a, b) =>
      b.matchScore - a.matchScore ||
      b.signalScore - a.signalScore ||
      b.wordCount - a.wordCount
    );

  return uniqBy(matches, item => normalizeKeyword(item.signal.keyword || item.signal.usedKeyword || "")).slice(0, 5);
}

function combineGoogleScore(matches) {
  if (!matches.length) return { score: 0, best: null, topMatches: [], top3Average: 0, categoryScore: 0 };

  const topMatches = matches.slice(0, 5);
  const best = topMatches[0];
  const top3 = topMatches.slice(0, 3);
  const top3Average = top3.length
    ? Math.round(top3.reduce((sum, item) => sum + num(item.signal.score), 0) / top3.length)
    : 0;

  const categoryItem = topMatches.find(item => item.categoryMatch) || best;
  const categoryScore = num(categoryItem?.signal?.score);
  const combinedScore = Math.round((num(best.signal.score) * 0.5) + (top3Average * 0.3) + (categoryScore * 0.2));

  return { score: combinedScore, best, topMatches, top3Average, categoryScore };
}

function findAmazon(p) {
  const pid = String(p.id || "").trim();
  const name = productName(p).toLowerCase();

  const matches = amazonSignals
    .map(a => {
      const aid = String(a.productId || "").trim();
      const aname = String(a.productName || "").toLowerCase().trim();

      let matchScore = 0;
      if (pid && aid && pid === aid) matchScore = 100;
      else if (name && aname && name === aname) matchScore = 95;
      else if (name && aname && (name.includes(aname) || aname.includes(name))) matchScore = 80;

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

function cjScore(p) {
  const image = p.image || p.productImage || p.raw?.productImage;
  const price = num(p.cost || p.supplierPrice || p.raw?.sellPrice);
  const margin = num(p.margin);
  const listed = num(p.listedCount || p.raw?.listingCount || p.raw?.listedNum);

  let score = 0;
  if (image) score += 20;
  if (price > 0) score += 20;
  score += Math.min(25, Math.max(0, margin - 25) * 0.7);
  score += Math.min(25, Math.log10(listed + 1) * 10);
  score += 10;

  return Math.round(Math.max(1, Math.min(100, score)));
}

const merged = products.map(p => {
  const googleMatches = findGoogleMatches(p);
  const googleCombined = combineGoogleScore(googleMatches);
  const a = findAmazon(p);
  const c = cjScore(p);

  const googleScore = googleCombined.score;
  const amazonScore = a ? num(a.score) : 0;
  const dropTrendScore = Math.round((googleScore * 0.4) + (amazonScore * 0.4) + (c * 0.2));

  return {
    ...p,
    dropTrendScore,
    trend: dropTrendScore,
    aiKeywords: p.aiKeywords || productKeywords(p),
    specificKeywords: p.specificKeywords || productKeywords(p),
    trendProof: {
      confidence: googleScore && amazonScore ? "High" : (googleScore || amazonScore ? "Medium" : "Low"),
      googleTrends: googleCombined.best ? {
        keyword: googleCombined.best.signal.keyword,
        usedKeyword: googleCombined.best.signal.usedKeyword,
        score: googleScore,
        rawScore: googleCombined.best.signal.rawScore,
        growthPercent: googleCombined.best.signal.growthPercent,
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
          matchScore: item.matchScore
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
        score: c,
        price: p.cost || p.supplierPrice || p.raw?.sellPrice,
        shipping: p.shipping || p.shippingPrice || 0,
        margin: p.margin,
        listedCount: p.listedCount || p.raw?.listingCount || p.raw?.listedNum
      }
    }
  };
});

writeJson("products.json", merged);
console.log(`Merged ${googleSignals.length} Google signals and ${amazonSignals.length} monthly Amazon signals into ${merged.length} products with combined multi-keyword Google Trends scoring.`);
