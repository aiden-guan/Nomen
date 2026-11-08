"use client";

import { useCallback, useEffect, useState } from "react";
import { type CreativeView, type PhonePostView, type PhonePostsView, phonePosts, postThroughPhone } from "../api";
import styles from "../troy.module.css";
import { ago } from "./format";

const ACTIVE = new Set<PhonePostView["status"]>(["pending", "waiting", "starting", "queued", "running"]);
const STATUS_WORDS: Record<PhonePostView["status"], string> = {
  pending: "queued",
  waiting: "waking the phone",
  starting: "copying to the phone",
  queued: "queued on the phone",
  running: "posting",
  posted: "posted",
  failed: "failed",
  cancelled: "stopped",
};

const tone = (status: PhonePostView["status"]) =>
  status === "posted" ? "text-[var(--olive)]" : status === "failed" ? "text-[var(--crimson-dark)]" : ACTIVE.has(status) ? "text-[var(--crimson)]" : "text-[var(--ink-faint)]";

/**
 * "Post through phone": one finished, approved video posted on TikTok by Mobilerun's phone agent,
 * in the TikTok app on the brand's own phone (src/lib/phones/posting.ts). A separate path from the
 * posting above it, and it runs only when a person clicks it for one video; warm-ups never post.
 */
export function PhonePosting({ brandId, videos }: { brandId: string; videos: CreativeView[] }) {
  const [state, setState] = useState<PhonePostsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");
  // A private test post: TikTok shows it only to the brand's own account ("Only you").
  const [onlyYou, setOnlyYou] = useState(false);
  // The song the agent adds from TikTok's sounds; empty means a trending one.
  const [song, setSong] = useState("");

  const load = useCallback(async () => {
    try {
      setState(await phonePosts(brandId));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [brandId]);
  useEffect(() => {
    void load();
  }, [load]);

  // Follow the posts while one is on its way.
  const inFlight = state?.posts.some((post) => ACTIVE.has(post.status)) ?? false;
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  if (!state) return error ? <p className="mt-4 text-[12px] text-[var(--crimson-dark)]">Posting through the phone: {error}</p> : null;
  // Not offered where phones don't run (the Vercel deployment).
  if (!state.available) return null;

  // Approved videos that aren't held back or on their way already; a public post also skips videos
  // that went out publicly. A private test doesn't count: the video can still go out to everyone.
  const onTheirWay = new Set(state.posts.filter((post) => ACTIVE.has(post.status)).map((post) => post.creativeId));
  const outPublicly = new Set(state.posts.filter((post) => post.status === "posted" && post.visibility === "public").map((post) => post.creativeId));
  const approved = videos.filter((video) => video.approved && !(video.internal && !video.cleared));
  const choices = approved.filter((video) => !onTheirWay.has(video.id) && (onlyYou || !outPublicly.has(video.id)));
  const choice = choices.find((video) => video.id === picked) ?? choices[0] ?? null;

  const post = async () => {
    if (!choice) return;
    const title = choice.concept?.title ?? "this video";
    const ask = onlyYou
      ? `Post “${title}” on the brand's TikTok as “Only you”, through its phone? Only the brand's own account will see it.`
      : `Post “${title}” publicly on the brand's TikTok, through its phone?`;
    const music = song.trim() ? `“${song.trim()}” (or the closest song the account can use)` : "a trending song";
    const ok = window.confirm(
      `${ask}\n\nThe phone agent uploads it in the TikTok app with its caption, TikTok's AI-generated label, and ${music} from TikTok's own sounds, low under the voice. It costs up to ${state.cost.credits} Mobilerun credits (about $${(state.cost.credits / 100).toFixed(2)}) plus up to ${state.cost.minutes} minutes of phone time.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      setState(await postThroughPhone(choice.id, onlyYou ? "private" : "public", song));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t-2 border-dotted border-[rgba(43,29,20,0.15)] pt-3">
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        Or post one video on TikTok through the brand&apos;s own phone: the phone agent uploads it in the TikTok app, with its caption and the AI-generated label. It runs only when you click it, one video at a time.
      </p>
      {!state.ready ? (
        <p className="mt-2 text-[12px] text-[var(--ink-faint)]">
          {state.blocker}{" "}
          <a href={`/brands/${encodeURIComponent(brandId)}`} className={`${styles.link} underline decoration-dotted underline-offset-4`}>
            Open the workspace
          </a>
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {choices.length === 0 ? (
            <p className="w-full text-[12px] text-[var(--ink-faint)]">
              {approved.length === 0 ? "Approve a video to post it through the phone." : "Every approved video is on its way or already out through the phone."}
            </p>
          ) : (
            <>
              <select
                value={choice?.id ?? ""}
                onChange={(event) => setPicked(event.target.value)}
                aria-label="Video to post through the phone"
                className={`${styles.input} h-9 min-w-0 flex-1 border-2 border-[rgba(43,29,20,0.2)] bg-[var(--paper)] px-2 text-[13px]`}
              >
                {choices.map((video) => (
                  <option key={video.id} value={video.id}>
                    {video.concept?.title ?? "Video"}
                  </option>
                ))}
              </select>
              <button type="button" className={`${styles.button} ${styles.buttonQuiet} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={busy} onClick={() => void post()}>
                {busy ? <span className={styles.spinner} aria-hidden="true" /> : null} Post through phone
              </button>
            </>
          )}
          {choices.length > 0 && (
            <input
              type="text"
              value={song}
              maxLength={120}
              onChange={(event) => setSong(event.target.value)}
              placeholder="Song from TikTok's sounds (optional), e.g. Timeless by The Weeknd"
              aria-label="Song to add from TikTok's sounds"
              className={`${styles.input} h-9 w-full border-2 border-[rgba(43,29,20,0.2)] bg-[var(--paper)] px-2 text-[13px]`}
            />
          )}
          {/* Shown even with nothing to pick: a video already out publicly can still get a private test. */}
          <label className="flex w-full cursor-pointer items-center gap-2 text-[12px] text-[var(--ink-soft)]">
            <input type="checkbox" checked={onlyYou} onChange={(event) => setOnlyYou(event.target.checked)} className="size-4 accent-[var(--crimson)]" />
            <span>
              <span className={styles.pixel}>Only you</span>: a private test post that only the brand&apos;s own account can see
            </span>
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-[var(--crimson-dark)]">
          {error}
        </p>
      )}
      {state.posts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {state.posts.slice(0, 5).map((post) => (
            <li key={post.id} className="text-[12px]">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{post.title}</span>
                {post.visibility === "private" && <span className="shrink-0 text-[var(--ink-faint)]">only you</span>}
                <span className={`${styles.pixel} ${tone(post.status)}`}>{STATUS_WORDS[post.status]}</span>
              </div>
              <p className={post.status === "failed" ? "text-[var(--crimson-dark)]" : "text-[var(--ink-faint)]"}>
                {post.message ?? (post.error ? `Retrying: ${post.error}` : null)} {ago(post.finishedAt ?? post.startedAt ?? post.createdAt)}
              </p>
              {(post.sound || post.songRequest) && (
                <p className="text-[var(--ink-faint)]">
                  ♪ {post.sound ?? `asked for “${post.songRequest}”`}
                  {post.soundCleared === false && post.visibility === "public" && <span className="text-[var(--crimson-dark)]"> · not cleared for brand content</span>}
                </p>
              )}
              {post.url && (
                <a href={post.url} target="_blank" rel="noreferrer" className={`${styles.link} underline decoration-dotted underline-offset-4`}>
                  See the post
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
