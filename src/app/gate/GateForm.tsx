"use client";

import { type FormEvent, useRef, useState } from "react";
import { pixelFont } from "@/components/troy/fonts";
import { useInertSiblings } from "@/components/troy/hooks";
import styles from "@/components/troy/troy.module.css";

/** The password screen in front of a demo deployment. */
export function GateForm({ next }: { next: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useInertSiblings(rootRef);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/gate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (response.ok) {
        // A full load, so the server sees the new cookie; replace, so Back skips this screen.
        window.location.replace(next);
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Something went wrong. Try again.");
    } catch {
      setError("Can't reach the site. Check your connection and try again.");
    }
    setBusy(false);
    setAttempt((n) => n + 1);
  }

  return (
    <div ref={rootRef} className={`${styles.root} ${pixelFont.variable} grid place-items-center px-4`}>
      <form key={attempt} onSubmit={submit} className={`${styles.enter} ${error ? styles.shake : ""} w-full max-w-[380px] text-center`} aria-label="Enter the password">
        <h1 className={`${styles.pixel} text-[34px] font-semibold tracking-tight`}>Nomen</h1>
        <p className="mt-2 text-[14px] text-[var(--ink-soft)]">Private preview. Enter the password to continue.</p>
        <div className={`${styles.box} mt-7 flex items-center gap-2 py-1.5 pl-4 pr-1.5`}>
          <label htmlFor="gate-password" className="sr-only">
            Password
          </label>
          <input
            id="gate-password"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError(null);
            }}
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            aria-invalid={Boolean(error)}
            aria-describedby="gate-error"
            className={`${styles.input} ${styles.pixel} h-11 flex-1 text-[19px]`}
          />
          <button type="submit" disabled={busy || !password} className={`${styles.button} ${styles.pixel} h-10 shrink-0 px-4 text-[15px]`}>
            {busy ? <span className={styles.spinner} aria-hidden="true" /> : null} Enter <span aria-hidden="true">→</span>
          </button>
        </div>
        <p id="gate-error" role="alert" className="mt-3 min-h-5 text-[13px] font-medium text-[var(--crimson)]">
          {error}
        </p>
      </form>
    </div>
  );
}
