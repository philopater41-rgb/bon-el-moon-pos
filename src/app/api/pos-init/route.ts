import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getBarcodes } from '@/lib/barcodes';
import { itemStockMarker } from '@/lib/item-stock';

export async function GET() {
  try {
    // 1. Fetch categories with items
    const categories = await prisma.category.findMany({
      where: {
        isActive: true,
        items: { some: { isActive: true } },
      },
      include: {
        items: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          include: { recipe: { include: { rawMaterial: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    const barcodeMap = await getBarcodes();

    // 2. Fetch modifiers
    const modifiers = await prisma.modifier.findMany({
      orderBy: { name: 'asc' },
    });

    // 3. Fetch halls with tables
    const halls = await prisma.hall.findMany({
      where: { name: { not: 'Terrace (Outdoor)' } },
      include: {
        tables: {
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    // خدمات ليست قائمة بيع عادية؛ تبقى آخر تبويب حتى مع إضافة أقسام جديدة.
    categories.sort((a, b) => {
      if (a.name === 'خدمات') return 1;
      if (b.name === 'خدمات') return -1;
      return a.name.localeCompare(b.name, 'ar');
    });
    for (const hall of halls) {
      hall.tables.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
    }

    // 4. Get customers and fixed discount reasons
    const [customers, discountReasons] = await Promise.all([
      prisma.customer.findMany({
        orderBy: { name: 'asc' },
      }),
      prisma.discountReason.findMany({
        orderBy: { reason: 'asc' },
      }),
    ]);

    // 5. Get count of today's orders to sync receipt numbering counter
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayOrdersCount = await prisma.salesOrder.count({
      where: { createdAt: { gte: startOfToday } },
    });

    return NextResponse.json({
      categories: categories.map(category => ({ ...category, items: category.items.map(item => { const tracked = item.recipe.find(recipe => recipe.rawMaterial.name.endsWith(itemStockMarker(item.id)))?.rawMaterial; return { id: item.id, name: item.name, price: item.price, barcode: barcodeMap?.get(item.id) || null, stock: tracked ? { quantity: tracked.stockQty, minimum: tracked.minStockLevel, unit: tracked.deductUnit } : null }; }) })),
      modifiers,
      halls,
      customers,
      discountReasons,
      todayOrdersCount,
    });
  } catch (error) {
    console.error('POS init endpoint error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

