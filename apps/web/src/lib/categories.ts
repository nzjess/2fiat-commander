import type { CategoryColor } from "../api.ts";

/**
 * The category palette: the dataviz skill's validated categorical palette, each hue with its step for light and
 * dark mode (checked against Mantine's surfaces, white and dark.7: every adjacent pair separates for colour-blind
 * readers). The server stores the key, and hands out the least-used one to a new category in this order.
 */
export const CATEGORY_PALETTE: Record<CategoryColor, { label: string; light: string; dark: string }> = {
  blue: { label: "Blue", light: "#2a78d6", dark: "#3987e5" },
  orange: { label: "Orange", light: "#eb6834", dark: "#d95926" },
  aqua: { label: "Aqua", light: "#1baf7a", dark: "#199e70" },
  yellow: { label: "Yellow", light: "#eda100", dark: "#c98500" },
  magenta: { label: "Magenta", light: "#e87ba4", dark: "#d55181" },
  green: { label: "Green", light: "#008300", dark: "#008300" },
  violet: { label: "Violet", light: "#6250d6", dark: "#9085e9" },
  red: { label: "Red", light: "#e34948", dark: "#e66767" },
};

export const CATEGORY_COLORS = Object.keys(CATEGORY_PALETTE) as CategoryColor[];

/** The neutral series beside the categories in spending: fees, what has no category yet, and the folded rest. */
export const NEUTRALS = {
  fees: { label: "Fees", light: "#495057", dark: "#adb5bd" },
  uncategorised: { label: "Uncategorised", light: "#ced4da", dark: "#5c5f66" },
  other: { label: "Other categories", light: "#868e96", dark: "#868e96" },
} as const;

export type Scheme = "light" | "dark";

export const categoryHex = (color: CategoryColor, scheme: Scheme) => CATEGORY_PALETTE[color][scheme];
