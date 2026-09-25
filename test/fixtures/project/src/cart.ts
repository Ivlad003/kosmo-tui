import { price } from "./price";
import { log } from "./log";

export type Item = { id: number; discount: number };

/**
 * Line total for one cart item.
 * Throws when the discount is above 100%.
 */
const ZERO = 0;

export async function calculateLineTotal(item, qty) {
  const p = await price(item.id);
  if (item.discount > 100) {
    throw new RangeError("discount > 100%");
  }
  const total = p * qty;
  log(total);
  return total;
}

export function emptyTotal() {
  return ZERO;
}
