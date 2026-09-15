export const splitDefaults = { useMask:true, keepText:true, preserveAppearance:true, resolutionMode:"hd", generationMode:"individual", granularity:"layers", notes:"" };
export const splitStorageKey = "drawpaint.ui-studio.split-options.v2";
export const minimumHdSide = 768;
export const connectedStructureInstructions = "Split into independently usable structures by default. Keep connected borders, end caps, inlaid decorations, patterns and corner ornaments in one complete border layer, preserving continuous contours and seams. Do not cut at connections or create fragment layers merely for different names or colors. Still separate text, independent icons and bases. Separate connected ornaments only when the user explicitly requests independent editing; then reconstruct the complete connecting structure, avoiding residual edges, stuck pixels and duplicate contours. Preserve approved plans. If a legacy plan fragments a connected structure, replan first; do not silently merge regionId values.";
// Existing jobs retain their original contract; newly normalized preferences default to HD.
export const sourcePixelMode = value => value?.resolutionMode === "source" || (value?.resolutionMode === undefined && value?.preserveAppearance === true);

export function normalizeSplitOptions(value = {}) {
  return {
    useMask:typeof value?.useMask === "boolean" ? value.useMask : splitDefaults.useMask,
    keepText:typeof value?.keepText === "boolean" ? value.keepText : splitDefaults.keepText,
    preserveAppearance:typeof value?.preserveAppearance === "boolean" ? value.preserveAppearance : splitDefaults.preserveAppearance,
    resolutionMode:["hd","source"].includes(value?.resolutionMode) ? value.resolutionMode : splitDefaults.resolutionMode,
    generationMode:["sheet","individual"].includes(value?.generationMode) ? value.generationMode : splitDefaults.generationMode,
    granularity:["layers","components"].includes(value?.granularity) ? value.granularity : splitDefaults.granularity,
    notes:typeof value?.notes === "string" ? value.notes.slice(0,10000) : "",
  };
}

export function loadSplitOptions(storage) {
  try {
    const current = storage.getItem(splitStorageKey);
    if (current) return normalizeSplitOptions(JSON.parse(current));
    const previous = JSON.parse(storage.getItem("drawpaint.ui-studio.split-options.v1") || "null");
    // Upgrade browser preferences once; immutable job options keep their contract.
    return normalizeSplitOptions({...previous,resolutionMode:"hd",generationMode:"individual",preserveAppearance:true});
  }
  catch { return {...splitDefaults}; }
}

export function splitInstructions(value) {
  if (!value) return "";
  const options=normalizeSplitOptions(value);
  return [
    "The following job-specific split configuration takes precedence over generic split instructions:",
    sourcePixelMode(value) ? "Source pixel extraction: preserve visible source pixels and repair only occlusions and removed-text regions. Keep the original resolution; enlarging a small image does not add real detail." : "HD output: use AI image editing to recover crisp lines, contours and materials, preserving the generated image's native resolution. Layout dimensions are not output pixel dimensions. Do not shrink HD images back to layout dimensions or substitute interpolation upscaling for real HD generation.",
    options.preserveAppearance ? "Appearance fidelity: preserve character identity, main shapes, contours, proportions, palette, relative line widths, text style and layer positions. Reconstruct blurred or pixelated details as crisp lines and materials; small local detail differences are allowed. Do not change the overall design or exaggerate relief. Masks indicate element ownership only; do not copy their jagged edges, soft boundaries or pixel blocks." : "AI layer reconstruction is allowed; preserve the source appearance as closely as possible.",
    !sourcePixelMode(value) ? `Sharpness requirements: generate each layer at native HD resolution, preferably with a visible-content long side of at least 1024 pixels. Results below ${minimumHdSide} pixels after trimming padding are rejected; do not upscale by interpolation to meet this limit. Reused assets must also satisfy this requirement and be visually crisp. Remove blur, pixelation and background-color fringes, preserving smooth antialiasing and intentional translucency without blurry feathering. Remove independent foreground elements from bases and reconstruct covered material; cleanly separate icons, text and borders.` : "",
    options.keepText ? "Preserve all source text exactly, including complete words and phrases, original glyph shapes and styling." : "Remove all readable text, including titles, numbers, button labels and text in decorations. Do not output text layers or leave text in components or bases. Reconstruct the exposed material after text removal. Use OCR only to locate text to remove.",
    options.granularity === "components" ? "Split into complete components: each button, counter or similar item is one reusable component. Keep its internal icons, borders and retained text together; do not fragment it into smaller layers." : "Split into independent layers: separate bases, icons, complete decorated borders and retained text, reconstructing occluded underlying material.",
    connectedStructureInstructions,
    "Transparency and glow: preserve intentional translucent gradients as fractional PNG alpha. Prefer genuine transparent RGBA for glow-heavy icons. If using a uniform key background, choose magenta or green absent from the artwork, declare the exact key, and leave clear gutters. Never flatten a glow onto a decorative backing or harden its edge. Inspect the extracted PNG on both light and dark backgrounds; do not reuse assets with baked-in key-colour fringes. The server decontaminates keyed edge gradients, but cannot uniquely recover original alpha from a single flattened image.",
    "Inspect existing assets first and compare patterns, text, state, style and sharpness. Reuse matches and generate only missing or mismatched parts. In text-removal mode, do not reuse layers that still contain text.",
    options.notes.trim() ? `Additional requirements: ${options.notes.trim()}` : "",
  ].filter(Boolean).join("\n");
}
