"use client";

import { useEffect, useRef } from "react";
import type { Baker } from "../engine/baker";
import { type Act, SOLDIER_FRAME } from "../engine/jobs";

/** A soldier's portrait: the baked sprite itself, cropped to the upper body, drawn crisp. */
export function Avatar({ baker, look, act, size = 40 }: { baker: Baker | null; look: number; act: Act; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!baker) return;
    let alive = true;
    const pose = act === "march" || act === "carry" ? "stand" : act;
    void baker.request({ k: "soldier", look, act: pose, dir: 1, f: 0 }, 6).then((baked) => {
      const canvas = ref.current;
      if (!alive || !canvas) return;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      // Head and shoulders, from the crest down; seated figures sit lower in the frame.
      const drop = pose === "watch" || pose === "type" ? 6 : pose === "sit" ? 3 : 0;
      const crop = { x: SOLDIER_FRAME.ax - 11, y: SOLDIER_FRAME.ay - 30 + drop, w: 22, h: 22 };
      ctx.drawImage(baked.image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    });
    return () => {
      alive = false;
    };
  }, [baker, look, act]);
  return <canvas ref={ref} width={22 * 4} height={22 * 4} style={{ width: size, height: size, imageRendering: "pixelated" }} aria-hidden="true" />;
}
