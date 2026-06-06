import { readJson, writeJson, num, makeSpecificKeywords } from "./utils.js";

const products = readJson("products.json", []);
const googleSignals = readJson("google-trends.json", []);

function productText(p) {
  return `${p.raw?.productNameEn || p.productNameEn || p.name || p.productName || ""} ${p.category || p.categoryName || p.raw?.categoryName || ""}`.toLowerCase();
}

function productKeywords(p) {
  const name = p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "";
  const category = p.category || p.categoryName || p.raw?.categoryName || "";
  return makeSpecificKeywords(name, category);
}

function findGoogle(p) {
  const text = productText(p);
  const pKeywords = productKeywords(p).map(k => k.toLowerCase());

  const matches = googleSignals
    .map(g => {
      const keyword = String(g.keyword || "").toLowerCase().trim();
      const usedKeyword = String(g.usedKeyword || "").toLowerCase().trim();

      let matchScore = 0;

      if (keyword && pKeywords.includes(keyword)) matchScore = 95;
      else if (usedKeyword && pKeywords.includes(usedKeyword)) matchScore = 90;
      else if (keyword && text.includes(keyword)) matchScore = 75;
      else if (usedKeyword && text.includes(usedKeyword)) matchScore = 70;

      return {
        signal: g,
        matchScore,
        signalScore: num(g.score),
        wordCount: keyword.split(/\s+/).filter(Boolean).length
      };
    })
    .filter(x => x.matchScore >= 70);

  if (!matches.length) return null;

  matches.sort((a, b) =>
    b.matchScore - a.matchScore ||
    b.wordCount - a.wordCount ||
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
  const g = findGoogle(p);
  const c = cjScore(p);

  const googleScore = g ? num(g.score) : 0;

  // Amazon keyword system removed.
  // Amazon score will be added later by fetch-lens-amazon-matches.js using Google Lens image matching.
  const existingLensAmazon = p.trendProof?.amazonLens || p.amazonLens || null;
  const amazonScore = existingLensAmazon ? num(existingLensAmazon.score) : 0;

  const dropTrendScore = Math.round((googleScore * 0.4) + (amazonScore * 0.4) + (c * 0.2));

  return {
    ...p,
    dropTrendScore,
    trend: dropTrendScore,
    aiKeywords: productKeywords(p).slice(0, 8),
    specificKeywords: productKeywords(p).slice(0, 8),
    trendProof: {
      confidence: googleScore && amazonScore ? "High" : (googleScore || amazonScore ? "Medium" : "Low"),
      googleTrends: g ? {
        keyword: g.keyword,
        usedKeyword: g.usedKeyword,
        score: googleScore,
        rawScore: g.rawScore,
        growthPercent: g.growthPercent,
        match: g.match
      } : null,
      amazon: existingLensAmazon ? {
        ...existingLensAmazon,
        matchType: "image",
        source: "google-lens-amazon"
      } : null,
      amazonLens: existingLensAmazon || null,
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
console.log(`Merged ${googleSignals.length} Google keyword signals into ${merged.length} products. Amazon keyword system is removed; Amazon demand now comes only from Google Lens image matching.`);
