export function parseWeightInput(input: string, stockUnit: 'kg' | 'g'): number | null {
  const normalized = input.trim().replace(/[٠-٩]/g, char => String('٠١٢٣٤٥٦٧٨٩'.indexOf(char))).replace(/[۰-۹]/g, char => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(char))).replace(/[٫,]/g, '.').toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(kg|كجم|كيلو|كيلوجرام|g|جم|جرام)?$/);
  if (!match) return null;
  let quantity = Number(match[1]);
  const supplied = match[2];
  const isKg = supplied && ['kg', 'كجم', 'كيلو', 'كيلوجرام'].includes(supplied);
  const isGram = supplied && ['g', 'جم', 'جرام'].includes(supplied);
  if (stockUnit === 'kg' && isGram) quantity /= 1000;
  if (stockUnit === 'g' && isKg) quantity *= 1000;
  if (!Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-7) return null;
  return Math.round(quantity * 1000) / 1000;
}
