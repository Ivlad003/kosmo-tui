import { price } from "./pricing.js";

export type Item = { id: number; discount: number };

export async function loadCart(userId: string) {
  const items: Item[] = [{ id: 7, discount: 120 }];
  const lines = await Promise.all(items.map((item) => calculateLineTotal(item, 2)));
  return { userId, lines };
}

/** The demo's bug: a discount above 100% throws. */
export async function calculateLineTotal(item: Item, qty: number) {
  const p = await price(item.id);
  if (item.discount > 100) {
    throw new RangeError("discount > 100%");
  }
  return p * qty;
}
