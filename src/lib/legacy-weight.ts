import type { Prisma } from '@prisma/client';

// Older imports stored whole-bean stock as grams in a separate material with the
// exact same name as the product. Only infer a link when it is unambiguous.
export async function findLegacyWeight(db: Prisma.TransactionClient, itemId: string, allowInactive = false) {
  const item = await db.item.findUnique({ where: { id: itemId }, select: { id: true, name: true, isActive: true, recipe: { select: { id: true } } } });
  if (!item || (!item.isActive && !allowInactive) || item.recipe.length) return null;
  const [items, materials] = await Promise.all([
    db.item.count({ where: { name: item.name, OR: [{ isActive: true }, { id: item.id }] } }),
    db.rawMaterial.findMany({ where: { name: item.name, isActive: true, purchaseUnit: 'kg', deductUnit: 'g', conversionFactor: 1000 }, take: 2 }),
  ]);
  return items === 1 && materials.length === 1 ? materials[0] : null;
}
