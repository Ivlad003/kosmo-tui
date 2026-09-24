// plain ESM
export function calcLineTotal(item, qty) {
  const total = item.price * qty;
  return total;
}
async function tick(n) {
  await new Promise((r) => setTimeout(r, 10));
  calcLineTotal({ id: n, price: 3 }, 2);
}
setInterval(() => { void tick(1); }, 200);
