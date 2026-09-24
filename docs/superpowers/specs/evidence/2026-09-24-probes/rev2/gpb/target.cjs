const loader = async (args) => {
  const a = args.x + 1;
  return a;
};
async function f2(q) {
  const b = q * 2;
  return b;
}
const after = 5;
module.exports = { loader, f2, after };
