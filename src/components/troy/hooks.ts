"use client";

import { useEffect, useState } from "react";

/** True when the visitor asked for less motion: skip camera flights and the long opening. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

/** Wide enough to show the whole camp with floating labels (otherwise one station at a time). */
export function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    setWide(query.matches);
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}

/**
 * These pages cover the whole window. If an app layout renders chrome around them (a header),
 * make it inert while they are open so keyboard focus can't wander into what is hidden.
 */
export function useInertSiblings(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const touched: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && !child.contains(root) && !child.hasAttribute("inert") && child.tagName !== "SCRIPT" && !child.tagName.includes("-")) {
        child.setAttribute("inert", "");
        touched.push(child);
      }
    }
    return () => touched.forEach((el) => el.removeAttribute("inert"));
  }, [rootRef]);
}
