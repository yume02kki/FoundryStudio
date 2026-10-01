// One colour per schema, stable across pipelines (derived from the name).
const PALETTE = ["#e8a33d", "#9b7be0", "#3fb8a9", "#e5c07b", "#61afef", "#98c379", "#d19a66", "#c678dd"];
const UNTYPED = "#6b6b6b";

export const ALL_COLORS = [...PALETTE, UNTYPED];

export function schemaColor(schema: string | null | undefined): string {
  if (!schema) return UNTYPED;
  let h = 0;
  for (let i = 0; i < schema.length; i++) h = (h * 31 + schema.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
