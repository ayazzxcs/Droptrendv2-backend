# DropTrend Backend - Fully API-Free Trend Scrapers

This version removes both:
- SerpApi
- Rainforest API

It uses:
- CJ API for products
- Playwright for Google Trends
- Playwright for Amazon search validation

## GitHub Secrets Needed
Only:
- CJ_EMAIL
- CJ_API_KEY

You can delete:
- SERPAPI_KEY
- RAINFOREST_API_KEY

## Output Files
- products.json
- trend-keywords.json
- google-trends.json
- amazon-keywords.json
- amazon-products.json

## Important note
Amazon can sometimes show CAPTCHA/bot-check pages. This scraper includes delays and lightweight extraction, but if Amazon blocks GitHub Actions, lower `AMAZON_KEYWORD_LIMIT` to 20-40 or run less often.


## CJ Trending Products Only
This version intentionally fetches only CJ trending products using `searchType=2` plus listed/sort parameters. It does not fall back to the full CJ product list. If CJ returns fewer products, that is expected: the frontend will show only CJ trending products that are then validated by Google Trends and Amazon Playwright signals.

No SerpApi or Rainforest API is required.
