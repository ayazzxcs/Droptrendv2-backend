import { readJson, writeJson, num, makeSpecificKeywords, tokenizeProductText } from "./utils.js";

const products = readJson("products.json", []);
const googleSignals = readJson("google-trends.json", []);
const amazonProducts = readJson("amazon-products.json", []);

function productText(p) {
  return `${p.raw?.productNameEn || p.productNameEn || p.name || p.productName || ""} ${p.category || p.categoryName || p.raw?.categoryName || ""}`.toLowerCase();
}

function productKeywords(p) {
  const name = p.raw?.productNameEn || p.productNameEn || p.name || p.productName || "";
  const category = p.category || p.categoryName || p.raw?.categoryName || "";
  return makeSpecificKeywords(name, category);
}

function keywordMatchScore(product, signalKeyword) {
  const sig = String(signalKeyword || "").toLowerCase().trim();
  if (!sig) return 0;

  const pKeywords = productKeywords(product).map(k => k.toLowerCase());
  const text = productText(product);
  const sigWords = tokenizeProductText(sig);
  if (!sigWords.length) return 0;

  if (pKeywords.includes(sig)) {
    return 80 + Math.min(20, sigWords.length * 5);
  }

  if (text.includes(sig)) {
    return 55 + Math.min(30, sigWords.length * 8);
  }

  const pTokens = new Set(tokenizeProductText(text));
  const hits = sigWords.filter(t => pTokens.has(t));

  if (sigWords.length === 1) return hits.length ? 25 : 0;
  if (hits.length < 2) return 0;

  const ratio = hits.length / sigWords.length;
  return Math.round(35 + ratio * 40 + Math.min(15, sigWords.length * 3));
}

function findGoogle(p) {
  const matches = googleSignals
    .map(s => ({
      signal: s,
      matchScore: keywordMatchScore(p, s.keyword),
      signalScore: num(s.score),
      wordCount: String(s.keyword || "").split(/\s+/).filter(Boolean).length
    }))
    .filter(x => x.matchScore >= 45);

  if (!matches.length) return null;

  matches.sort((a, b) => b.matchScore - a.matchScore || b.wordCount - a.wordCount || b.signalScore - a.signalScore);
  return matches[0].signal;
}

function findAmazon(p) {
  const matches = amazonProducts
    .map(a => ({
      signal: a,
      matchScore: keywordMatchScore(p, a.keyword),
      signalScore: num(a.score),
      wordCount: String(a.keyword || "").split(/\s+/).filter(Boolean).length
    }))
    .filter(x => x.matchScore >= 45);

  if (!matches.length) return null;

  matches.sort((a, b) => b.matchScore - a.matchScore || b.wordCount - a.wordCount || b.signalScore - a.signalScore);
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
  const a = findAmazon(p);
  const c = cjScore(p);

  const googleScore = g ? num(g.score) : 0;
  const amazonScore = a ? num(a.score) : 0;
  const dropTrendScore = Math.round((googleScore * 0.4) + (amazonScore * 0.4) + (c * 0.2));

  return {
    ...p,
    dropTrendScore,
    trend: dropTrendScore,
    specificKeywords: productKeywords(p).slice(0, 6),
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
      amazon: a ? {
        keyword: a.keyword,
        score: amazonScore,
        bestRating: a.bestRating,
        bestRatingsTotal: a.bestRatingsTotal,
        bestPrice: a.bestPrice,
        position: a.position,
        isBestSeller: a.isBestSeller,
        productUrl: a.productUrl,
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
console.log(`Merged ${googleSignals.length} Google signals and ${new Set(amazonProducts.map(a => a.keyword)).size} Amazon signals into ${merged.length} products with specific keyword matching.`);
