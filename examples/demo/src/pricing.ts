const PRICES: Record<number, number> = { 7: 12.5 };

export async function price(id: number): Promise<number> {
  return PRICES[id] ?? 0;
}
