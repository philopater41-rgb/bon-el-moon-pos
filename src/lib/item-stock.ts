export type StockUnit = 'unit' | 'kg' | 'g';
export const itemStockMarker = (itemId: string) => `[product-stock:${itemId}]`;
export function parseStock(value: unknown): { quantity: number; unit: StockUnit; minimum: number; expected?: number } | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('بيانات المخزون غير صحيحة');
  const stock = value as Record<string, unknown>;
  const quantity = Number(stock.quantity), minimum = Number(stock.minimum ?? 0);
  const expected = stock.expected === undefined ? undefined : Number(stock.expected);
  if (stock.quantity === '' || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(minimum) || minimum < 0 || (expected !== undefined && (!Number.isFinite(expected) || expected < 0)) || !['unit', 'kg', 'g'].includes(String(stock.unit))) throw new Error('أدخل كمية وحد تنبيه صحيحين للمخزون');
  if (stock.unit === 'unit' && (!Number.isInteger(quantity) || !Number.isInteger(minimum))) throw new Error('الكمية بالقطعة يجب أن تكون عددًا صحيحًا');
  return { quantity, unit: stock.unit as StockUnit, minimum, expected };
}
