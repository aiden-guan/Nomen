import { Composition } from "remotion";
import { Demo, durationOf } from "./Demo";

export function Root() {
  return <Composition id="Demo" component={Demo} durationInFrames={durationOf()} fps={30} width={1920} height={1080} />;
}
