const fetch = require("node-fetch");

const ISLAMIC_FINDER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.islamicfinder.org/",
};

async function islamicFinderFetch(url) {

    const response = await fetch(url, {
      headers: {
        ...ISLAMIC_FINDER_HEADERS
      },
    });

    if (!response.ok) {
      throw new Error(`IslamicFinder HTTP ${response.status}`);
    }
    return response;
}


module.exports = { islamicFinderFetch };