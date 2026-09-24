export function calc(item, qty) {
  const x = 1;
  const total = item.price * qty;
  return total;
}
setInterval(() => calc({ id: 1, price: 3 }, 2), 50);
