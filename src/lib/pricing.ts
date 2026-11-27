/** Profit relative to cost (markup); unavailable when cost is missing or zero. */
export function markupPercent(cost: number, price: number): number | null {
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(price) || price < 0) return null;
  return ((price - cost) / cost) * 100;
}
export function priceFromMarkup(cost: number, markup: number): number | null {
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(markup) || markup < -100) return null;
  return cost * (1 + markup / 100);
}
export function costFromMarkup(price: number, markup: number): number | null {
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(markup) || markup <= -100) return null;
  return price / (1 + markup / 100);
}
