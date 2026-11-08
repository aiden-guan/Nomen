// What each ad platform accepts, as checked against the platforms' own help pages on 2026-11-08.
// Every size and limit below carries the page it came from (docs/static-ads.md lists them too).
// Where two official pages disagree, the stricter value is used.

export type Platform = "meta" | "x" | "reddit" | "google";

export type Placement = {
  id: string;
  platform: Platform;
  /** Folder in the download pack. */
  folder: string;
  label: string;
  width: number;
  height: number;
  maxBytes: number;
  /** A picture with no text on it (Google's display guidance asks for these). */
  textFree?: boolean;
  /** Whether a call-to-action button may be drawn in the image. */
  cta: boolean;
  source: string;
};

const MB = 1024 * 1024;

export const PLACEMENTS: Placement[] = [
  // Meta: 4:5 at 1440x1800 for feeds, 9:16 at 1440x2560 for Stories and Reels, JPG or PNG up to 30 MB.
  { id: "meta-feed-4x5", platform: "meta", folder: "meta", label: "Facebook and Instagram feed, 4:5", width: 1440, height: 1800, maxBytes: 30 * MB, cta: true, source: "https://www.facebook.com/business/ads-guide/update/image/instagram-feed" },
  { id: "meta-feed-1x1", platform: "meta", folder: "meta", label: "Feed and Marketplace, 1:1", width: 1440, height: 1440, maxBytes: 30 * MB, cta: true, source: "https://www.facebook.com/business/ads-guide/update/image/facebook-marketplace" },
  { id: "meta-story-9x16", platform: "meta", folder: "meta", label: "Stories and Reels, 9:16 (safe zones kept clear)", width: 1440, height: 2560, maxBytes: 30 * MB, cta: true, source: "https://www.facebook.com/business/ads-guide/update/image/instagram-reels" },
  // X: 1:1 at 1200x1200 and 1.91:1 at 1200x628. The website-card limit is 3 MB in X's API docs (5 MB on its ads page): use 3.
  { id: "x-1x1", platform: "x", folder: "x", label: "Image ad, 1:1", width: 1200, height: 1200, maxBytes: 3 * MB, cta: false, source: "https://docs.x.com/x-ads-api/creatives" },
  { id: "x-1.91x1", platform: "x", folder: "x", label: "Image ad and website card, 1.91:1", width: 1200, height: 628, maxBytes: 3 * MB, cta: false, source: "https://docs.x.com/x-ads-api/creatives" },
  // Reddit: 4:3 at 1440x1080 is recommended across devices; 4:5 and 1:1 for mobile. 3 MB.
  { id: "reddit-4x5", platform: "reddit", folder: "reddit", label: "Image ad, 4:5 (mobile)", width: 1080, height: 1350, maxBytes: 3 * MB, cta: false, source: "https://business.reddithelp.com/s/article/image-ad-specifications" },
  { id: "reddit-4x3", platform: "reddit", folder: "reddit", label: "Image ad, 4:3 (all devices)", width: 1440, height: 1080, maxBytes: 3 * MB, cta: false, source: "https://business.reddithelp.com/s/article/image-ad-specifications" },
  { id: "reddit-1x1", platform: "reddit", folder: "reddit", label: "Image ad, 1:1 (mobile)", width: 1080, height: 1080, maxBytes: 3 * MB, cta: false, source: "https://business.reddithelp.com/s/article/image-ad-specifications" },
  // Google display (responsive display ads, Demand Gen) and Performance Max: 1.91:1 1200x628, 1:1 1200x1200,
  // 4:5 960x1200, 5120 KB. Display guidance: no text or logos over images and no fake buttons, so these are
  // text-free; Performance Max also takes designed images, without a drawn button.
  { id: "google-1.91x1", platform: "google", folder: "google-display-pmax/images", label: "Landscape image, no text", width: 1200, height: 628, maxBytes: 5120 * 1024, textFree: true, cta: false, source: "https://support.google.com/google-ads/answer/17091269" },
  { id: "google-1x1", platform: "google", folder: "google-display-pmax/images", label: "Square image, no text", width: 1200, height: 1200, maxBytes: 5120 * 1024, textFree: true, cta: false, source: "https://support.google.com/google-ads/answer/17091269" },
  { id: "google-4x5", platform: "google", folder: "google-display-pmax/images", label: "Portrait image, no text", width: 960, height: 1200, maxBytes: 5120 * 1024, textFree: true, cta: false, source: "https://support.google.com/google-ads/answer/17091269" },
  { id: "pmax-1.91x1", platform: "google", folder: "google-display-pmax/designed-for-pmax", label: "Performance Max landscape, with text", width: 1200, height: 628, maxBytes: 5120 * 1024, cta: false, source: "https://support.google.com/adspolicy/answer/10347108" },
  { id: "pmax-1x1", platform: "google", folder: "google-display-pmax/designed-for-pmax", label: "Performance Max square, with text", width: 1200, height: 1200, maxBytes: 5120 * 1024, cta: false, source: "https://support.google.com/adspolicy/answer/10347108" },
  { id: "pmax-4x5", platform: "google", folder: "google-display-pmax/designed-for-pmax", label: "Performance Max portrait, with text", width: 960, height: 1200, maxBytes: 5120 * 1024, cta: false, source: "https://support.google.com/adspolicy/answer/10347108" },
];

/** Google logo assets: 1:1 at 1200x1200 (minimum 128) and 4:1 at 1200x300 (minimum 512x128). */
export const LOGO_PLACEMENTS = [
  { id: "logo-1x1", width: 1200, height: 1200, source: "https://support.google.com/google-ads/answer/17090561" },
  { id: "logo-4x1", width: 1200, height: 300, source: "https://support.google.com/google-ads/answer/17090561" },
] as const;

/** Text limits in characters. Google counts CJK characters double, which this generator does not write. */
export const LIMITS = {
  rsa: { headlines: { min: 3, max: 15, chars: 30 }, descriptions: { min: 2, max: 4, chars: 90 }, path: 15, sitelinkText: 25, sitelinkLine: 35, callout: 25, snippetValue: 25, snippetValues: { min: 3, max: 10 } },
  display: { shortHeadlines: { min: 1, max: 5, chars: 30 }, longHeadline: 90, descriptions: { min: 1, max: 5, chars: 90 }, businessName: 25 },
  pmax: { headlines: { min: 3, max: 15, chars: 30 }, longHeadlines: { min: 1, max: 5, chars: 90 }, descriptions: { min: 2, max: 5, chars: 90 }, shortDescription: 60, businessName: 25 },
  // Meta: Instagram feed shows 125 characters of primary text and a 40-character headline; Facebook feed
  // headlines are recommended at 27. Description: 30 (Marketplace and search results).
  meta: { primaryText: 125, headline: 40, headlineFacebook: 27, description: 30 },
  // X: 280 weighted characters (a link counts 23); X's guidance favors 50-100. Website card headline 70.
  x: { post: 280, postTarget: 100, cardHeadline: 70 },
  // Reddit: headline up to 300, recommended 100 or less.
  reddit: { headline: 300, headlineTarget: 100 },
} as const;

/** Google structured snippet headers (the only values Google accepts). */
export const SNIPPET_HEADERS = ["Amenities", "Brands", "Courses", "Degree programs", "Destinations", "Featured hotels", "Insurance coverage", "Models", "Neighborhoods", "Service catalog", "Shows", "Styles", "Types"] as const;

/** Meta call-to-action buttons for a website destination, as Ads Manager names them and as its import file spells them. */
export const META_CTAS: Record<string, string> = {
  "Learn more": "LEARN_MORE",
  "Shop now": "SHOP_NOW",
  "Sign up": "SIGN_UP",
  "Get offer": "GET_OFFER",
  "Order now": "ORDER_NOW",
  "Book now": "BOOK_TRAVEL",
  "Download": "DOWNLOAD",
  "Contact us": "CONTACT_US",
  "Subscribe": "SUBSCRIBE",
  "Get quote": "GET_QUOTE",
  "Apply now": "APPLY_NOW",
  "See details": "SEE_DETAILS",
};

export const REDDIT_CTAS = ["Learn More", "Shop Now", "Sign Up", "Download", "Install", "Get Quote", "Contact Us", "Order Now", "Subscribe", "View More", "Read More", "Apply Now", "Book Now", "Watch Now"] as const;

export const SPEC_SOURCES = {
  rsa: "https://support.google.com/google-ads/answer/7684791",
  rsaPaths: "https://support.google.com/google-ads/answer/7046795",
  sitelinks: "https://support.google.com/google-ads/answer/2375416",
  callouts: "https://support.google.com/google-ads/answer/6079510",
  snippets: "https://support.google.com/google-ads/answer/6280012",
  editorial: "https://support.google.com/adspolicy/answer/14847994",
  editorCsv: "https://support.google.com/google-ads/editor/answer/57747",
  display: "https://support.google.com/google-ads/answer/17090561",
  pmax: "https://support.google.com/google-ads/answer/17091269",
  imagePolicy: "https://support.google.com/adspolicy/answer/10347108",
  metaFeed: "https://www.facebook.com/business/ads-guide/update/image/instagram-feed",
  metaReels: "https://www.facebook.com/business/ads-guide/update/image/instagram-reels",
  metaBulk: "https://www.facebook.com/business/help/1471948569691450",
  x: "https://docs.x.com/x-ads-api/creatives",
  xCounting: "https://docs.x.com/fundamentals/counting-characters",
  reddit: "https://business.reddithelp.com/s/article/image-ad-specifications",
  redditCtas: "https://business.reddithelp.com/s/article/Reddit-Ad-Unit-Specifications",
} as const;
