/**
 * Bot detection for `/r/[code]` (§10: "Bot user agents are logged but flagged"). A user agent
 * heuristic, not a security control: crawlers, link-preview fetchers (the apps where creators post
 * fetch every link to show a card), HTTP libraries and headless browsers count as bots; so does a
 * missing user agent. Pure; unit-tested.
 */

const BOT_PATTERNS: readonly RegExp[] = [
  /(?<!cu)bot\b|robot|crawl|spider|slurp|scrap/i,
  /facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegrambot|slackbot|discordbot|twitterbot|linkedinbot|pinterest|redditbot|skypeuripreview|embedly|iframely|vkshare|quora link preview|bitlybot|tumblr|snapchat.*preview/i,
  /googlebot|google-inspectiontool|adsbot|mediapartners-google|feedfetcher|apis-google|bingbot|bingpreview|yandex|baiduspider|duckduckbot|applebot|petalbot|semrush|ahrefs|mj12bot|dotbot|bytespider|gptbot|chatgpt-user|claudebot|anthropic-ai|perplexitybot|ccbot/i,
  /headlesschrome|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|pingdom|uptimerobot|statuscake|site24x7/i,
  /^(curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww-perl|ruby|php|apache-httpclient|postmanruntime|insomnia|http_request)/i,
]

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.trim() ?? ""
  if (ua === "") return true
  return BOT_PATTERNS.some((pattern) => pattern.test(ua))
}
