DropTrend Monthly Sequential Quota Lens Update

Changed logic:
- Use one provider until its monthly credit limit is reached.
- Do not switch providers just because a product has no Amazon match.
- One Lens request per product.
- One Amazon result per product.
- If no match, move to next product.
- If all providers are exhausted, stop Lens enrichment and merge whatever data exists.

Flow:
CJ image
→ Current quota provider
→ First Amazon URL only
→ Puppeteer extracts rating/reviews/badge
→ amazon-products.json
→ merge-trend-signals.js

Provider order:
1. SerpApi Account 1
2. SerpApi Account 2
3. SearchApi
4. HasData
5. ScrapingDog
6. Decodo
7. Apify
8. OpenWeb Ninja
9. Zenserp
