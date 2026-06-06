import { readJson, writeJson, num } from "./utils.js";

const products = readJson("products.json", []);
const googleSignals = readJson("google-trends.json", []);
const amazonProducts = readJson("amazon-products.json", []);

function productText(p) {
  return `${p.raw?.productNameEn || p.productNameEn || p.name || p.productName || ""} ${p.category || p.categoryName || p.raw?.categoryName || ""}`.toLowerCase();
}

function findGoogle(p) {
  const text = productText(p);
  return googleSignals.find(s => text.includes(String(s.keyword).toLowerCase())) || null;
}

function findAmazon(p) {
  const text = productText(p);
  const matches = amazonProducts.filter(a => text.includes(String(a.keyword).toLowerCase()));
  if (!matches.length) return null;
  return matches.sort((a,b) => num(b.score) - num(a.score))[0];
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
    trendProof: {
      confidence: googleScore && amazonScore ? "High" : (googleScore || amazonScore ? "Medium" : "Low"),
      googleTrends: g ? {
        keyword: g.keyword,
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
console.log(`Merged ${googleSignals.length} Google signals and ${new Set(amazonProducts.map(a => a.keyword)).size} Amazon signals into ${merged.length} products.`);
