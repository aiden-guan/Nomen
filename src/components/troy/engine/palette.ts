import { defineRamp } from "./tracer";

// Every colour in the camp. Each ramp runs darkest to lightest; shadows lean cool, highlights warm,
// so a lit surface and its shadow read as one material under one sun.

export const BACKGROUND = "#f6f4ef";

export const R = {
  sand: defineRamp("sand", ["#a3866a", "#bd9d78", "#d2b386", "#e3c896", "#eed9ae", "#f7e9c9"]),
  dune: defineRamp("dune", ["#94795f", "#ab8f6f", "#c3a47c", "#d5b88b", "#e3caa0", "#efdcbb"]),
  path: defineRamp("path", ["#9b8064", "#b3946f", "#c6a77d", "#d7ba8e", "#e5cca3", "#f0dcb8"]),
  grass: defineRamp("grass", ["#4c5634", "#62703c", "#7b8946", "#97a052", "#b0b765", "#c9cd85"]),
  olive: defineRamp("olive", ["#3c4530", "#4f5b3b", "#647247", "#7c8a55", "#97a46a", "#b4bd86"]),
  wood: defineRamp("wood", ["#4a2e1d", "#664027", "#855634", "#a56f43", "#c18b56", "#d9aa70"]),
  woodDark: defineRamp("woodDark", ["#2a1b13", "#3d281c", "#523726", "#694833", "#7f5a40", "#977050"]),
  woodPale: defineRamp("woodPale", ["#6e5137", "#8b6848", "#a8835b", "#c29e72", "#d8b98b", "#eacfa6"]),
  iron: defineRamp("iron", ["#25272d", "#373a42", "#4c5059", "#656a73", "#838891", "#a8acb3"]),
  bronze: defineRamp("bronze", ["#4f2f14", "#7a4a1d", "#a66c2a", "#c98f3a", "#e3b45c", "#f6da94"]),
  gold: defineRamp("gold", ["#5c4012", "#8a6318", "#b78a22", "#d8ae33", "#efd05c", "#fcefa8"]),
  crimson: defineRamp("crimson", ["#3f1013", "#651b1d", "#8f2726", "#b73a31", "#d65a45", "#ec8467"]),
  coral: defineRamp("coral", ["#7a2e22", "#9f3e2b", "#c45237", "#de6c4a", "#ee9070", "#f8b99c"]),
  linen: defineRamp("linen", ["#77705f", "#998f7c", "#b9b09c", "#d5cdba", "#ebe5d5", "#faf7ee"]),
  cream: defineRamp("cream", ["#8c806b", "#ab9e86", "#c8bca2", "#dfd5bd", "#efe8d6", "#fbf8ef"]),
  skinLight: defineRamp("skinLight", ["#6e432f", "#935b40", "#b77953", "#d49a6d", "#e9ba8e", "#f6d7b3"]),
  skinMid: defineRamp("skinMid", ["#4d2d20", "#6d402b", "#8f5836", "#ad7247", "#c78e5c", "#dcab7a"]),
  skinDeep: defineRamp("skinDeep", ["#2c1a13", "#40261b", "#553325", "#6d4331", "#875840", "#a27152"]),
  hair: defineRamp("hair", ["#1d1613", "#2c211b", "#3e2f25", "#534031", "#6c5540", "#88704f"]),
  marble: defineRamp("marble", ["#7a756c", "#97918a", "#b4aea4", "#cfcac0", "#e5e1d8", "#f5f3ee"]),
  stone: defineRamp("stone", ["#5e5a55", "#77726b", "#918b82", "#aba59b", "#c4beb4", "#dbd6cd"]),
  teal: defineRamp("teal", ["#1b4762", "#235f7e", "#2d7b98", "#4599b0", "#78bcc6", "#b5dedb"]),
  navy: defineRamp("navy", ["#1a2036", "#252e4d", "#333f66", "#465583", "#61719f", "#8a98bf"]),
  screen: defineRamp("screen", ["#0f1b29", "#163049", "#20506f", "#337c9f", "#5fadcd", "#a9e0ef"]),
  plastic: defineRamp("plastic", ["#6c665a", "#8b8476", "#aaa293", "#c6bfae", "#ddd7c7", "#efebe0"]),
  black: defineRamp("black", ["#141519", "#1d1f25", "#282a32", "#353844", "#454958", "#5a5f71"]),
  fire: defineRamp("fire", ["#4c1a0a", "#7c2d0d", "#b44c15", "#df7c22", "#f5ad41", "#ffdf8c"]),
  rope: defineRamp("rope", ["#5a4630", "#76603f", "#927b51", "#ad9664", "#c6b07c", "#ddc999"]),
  violet: defineRamp("violet", ["#2e2346", "#40305f", "#56407e", "#6f55a0", "#8c73bf", "#b4a2dc"]),
  leaf: defineRamp("leaf", ["#2f3d29", "#3f5134", "#536840", "#6a804e", "#859a63", "#a5b781"]),
  water: defineRamp("water", ["#1d4f6e", "#25668a", "#3381a3", "#4f9fba", "#83c2cf", "#c3e4e0"]),
  white: defineRamp("white", ["#9a968c", "#b6b2a8", "#cecac0", "#e2dfd6", "#f1efe8", "#fdfcf8"]),
  shadow: defineRamp("shadow", ["#8e7a63", "#a48d72", "#b89f81", "#c9b190", "#d8c19f", "#e5cfae"]),
  // The lands the scouts ride to wear their platforms' colours.
  magenta: defineRamp("magenta", ["#4a0a1c", "#7a1030", "#b0183f", "#e0264f", "#f7587a", "#ff9db1"]),
  cyan: defineRamp("cyan", ["#0b3a40", "#0f5f68", "#16929b", "#21c8cf", "#5eecee", "#b8fbf7"]),
  blue: defineRamp("blue", ["#0b1f4d", "#12337a", "#1a4fb0", "#2b6be0", "#5b93f2", "#a8c6fb"]),
  jade: defineRamp("jade", ["#0a3328", "#0e5241", "#127a5f", "#18a07c", "#4dc3a0", "#a2e3cd"]),
  // The wine-dark sea: deep water to the shallows; and its pale foam.
  sea: defineRamp("sea", ["#14334f", "#1b4a6b", "#246387", "#327fa1", "#5a9fb9", "#9cc8d3"]),
  foam: defineRamp("foam", ["#8fb6c0", "#b0ced3", "#cbe0e0", "#e1ece8", "#f1f6f1", "#fcfdfa"]),
  // Roman terracotta roof tiles and ochre plaster.
  tile: defineRamp("tile", ["#5a1f14", "#7c2d1b", "#9e3f24", "#bd5631", "#d5774a", "#e7a074"]),
  ochre: defineRamp("ochre", ["#7a5222", "#9a6c2e", "#b98a3f", "#d1a757", "#e4c37c", "#f2dfab"]),
  cypress: defineRamp("cypress", ["#18261a", "#213622", "#2d4a2b", "#3d6136", "#557a46", "#7a9a5f"]),
};

export type RampName = keyof typeof R;
