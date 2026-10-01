// One colour per schema, stable across pipelines (derived from the name). Mid-tone
// hues that read on both the light and the dark theme; no reds, which mean "error".
const PALETTE = ["#7961db", "#00a396", "#946638", "#d1980b", "#147eb3", "#29a634", "#c22762", "#634dbf"];
const UNTYPED = "#8f99a8";

export const ALL_COLORS = [...PALETTE, UNTYPED];

export function schemaColor(schema: string | null | undefined): string {
  if (!schema) return UNTYPED;
  let h = 0;
  for (let i = 0; i < schema.length; i++) h = (h * 31 + schema.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
