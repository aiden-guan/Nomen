// The captions of the Naïve demo video, one per part of the walk-through. They say what the tour
// card said in the app, shorter, and sit where they cover nothing on screen at that moment
// (checked against the filmed frames). Numbers are the recording's (src/components/troy/camp/tour.ts).

export type Place = "bottom-left" | "top-left" | "top-right" | "right";

export type Caption = {
  /** The tour step it belongs to (the film log's key), or "landing" before the gates open. */
  key: string;
  kicker: string;
  title: string;
  body?: string;
  place: Place;
};

export const CAPTIONS: Caption[] = [
  { key: "landing", kicker: "Nomen", title: "One input: a website", body: "Type the company's site. The agents run the whole campaign from there.", place: "bottom-left" },
  { key: "start", kicker: "The camp", title: "A team of agents for every step", body: "Research, strategy, scripts, videos and posting: each building is one stage, each soldier one agent.", place: "top-right" },
  { key: "scouts", kicker: "1 · Research", title: "The scouts fan out", body: "10 sources at once: the brand's site, TikTok, Instagram, YouTube, ad libraries, Reddit and AI answers. 42 research runs.", place: "top-right" },
  { key: "agent", kicker: "One agent, up close", title: "The TikTok scout", body: "He rides out for 23 searches and brings back what he finds. His card shows what he is doing right now.", place: "bottom-left" },
  { key: "findings", kicker: "1 · Research", title: "What they brought back", body: "100 top videos, 9 live ads, 5 Reddit threads and 8 keywords.", place: "bottom-left" },
  { key: "oracle", kicker: "2 · Viral references", title: "Studying what went viral", body: "The 6 best outlier videos, broken down beat by beat: transcript, cuts and frames.", place: "bottom-left" },
  { key: "tent", kicker: "3 · Strategy", title: "The creative director's plan", body: "4 videos, each backed by evidence from the research.", place: "bottom-left" },
  { key: "workshop", kicker: "4 · Production", title: "Each video made its own way", body: "An AI creator, a one-to-one clone, a 3D ad in code, a meme shot by shot. Quality control checks every one.", place: "bottom-left" },
  { key: "video-0", kicker: "Video 1 · Organic talking head", title: "Template + Deploy = a team running your channel", place: "right" },
  { key: "video-1", kicker: "Video 2 · One-to-one clone", title: "I told Naïve I'm exhausted", place: "right" },
  { key: "video-2", kicker: "Video 3 · Code ad (3D)", title: "Two founders, one instruction: make money", place: "right" },
  { key: "video-3", kicker: "Video 4 · Brainrot meme", title: "Gary the Potato Deploys a Company", place: "right" },
  { key: "creators", kicker: "Or real creators", title: "The same briefs, to people who make these videos", body: "A client-taste agent vets each creator: @mplentg approved, 7/10. Outreach is drafted for you to send.", place: "bottom-left" },
  { key: "post", kicker: "5 · Posting", title: "Approve and post", body: "One click, and they go out to TikTok, Instagram and YouTube, labeled AI-generated.", place: "bottom-left" },
  { key: "battle", kicker: "6 · Results", title: "Into battle", body: "Each video fights the category's top videos on likes per view. Numbers here are illustrative.", place: "top-left" },
  { key: "loop", kicker: "Autopilot", title: "Then it goes again", body: "Campaign 2 starts on its own, planned from how these posts did: more of what led (illustrative numbers here).", place: "top-right" },
];
