import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getBarcodes } from '@/lib/barcodes';
import { itemStockMarker } from '@/lib/item-stock';

export async function GET() {
  try {
    const items = await prisma.item.findMany({
      where: { isActive: true },
      include: {
        category: { select: { id: true, name: true } },
        recipe: {
          include: {
            rawMaterial: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const barcodeMap = await getBarcodes();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Fetch today's sales items
    const todayOrderItems = await prisma.salesOrderItem.findMany({
      where: {
        order: {
          createdAt: { gte: startOfToday },
          status: 'COMPLETED',
        },
      },
    });

    // Group today's sold quantities
    const todaySoldMap = new Map<string, number>();
    for (const oi of todayOrderItems) {
      const current = todaySoldMap.get(oi.itemId) || 0;
      todaySoldMap.set(oi.itemId, current + oi.qty);
    }

    const calculatedItems = items.map((item) => {
      // Calculate true cost from recipe ingredients if any
      let totalRecipeCost = 0;
      const ingredientsBreakdown = item.recipe.map((r) => {
        const costPerDeductUnit =
          r.rawMaterial.conversionFactor > 0
            ? (r.rawMaterial.costPerPurchaseUnit || 0) / r.rawMaterial.conversionFactor
            : 0;
        const ingCost = r.quantity * costPerDeductUnit;
        totalRecipeCost += ingCost;
        return {
          rawMaterialId: r.rawMaterialId,
          materialName: r.rawMaterial.name,
          quantity: r.quantity,
          deductUnit: r.rawMaterial.deductUnit,
          cost: ingCost,
        };
      });

      // Unit cost: recipe cost if defined, otherwise manual/direct item cost
      const totalUnitCost = totalRecipeCost > 0 ? totalRecipeCost : (item.cost || 0);

      const tracked = item.recipe.find(r => r.rawMaterial.name.endsWith(itemStockMarker(item.id)))?.rawMaterial;
      const profitPerUnit = item.price - totalUnitCost;
      const profitMarginPct = item.price > 0 ? (profitPerUnit / item.price) * 100 : 0;
      const qtySoldToday = todaySoldMap.get(item.id) || 0;
      const totalRevenueToday = qtySoldToday * item.price;
      const totalCostToday = qtySoldToday * totalUnitCost;
      const totalProfitToday = qtySoldToday * profitPerUnit;

      return {
        id: item.id,
        name: item.name,
        barcode: barcodeMap?.get(item.id) || null,
        stock: tracked ? { quantity: tracked.stockQty, unit: tracked.deductUnit, minimum: tracked.minStockLevel, materialId: tracked.id } : null,
        categoryId: item.categoryId,
        categoryName: item.category?.name || 'عام',
        price: item.price,
        cost: item.cost || 0,
        unitCost: Number(totalUnitCost.toFixed(2)),
        profitPerUnit: Number(profitPerUnit.toFixed(2)),
        profitMarginPct: Number(profitMarginPct.toFixed(1)),
        ingredients: ingredientsBreakdown,
        hasRecipe: item.recipe.length > 0,
        qtySoldToday,
        totalRevenueToday,
        totalCostToday: Number(totalCostToday.toFixed(2)),
        totalProfitToday: Number(totalProfitToday.toFixed(2)),
      };
    });

    return NextResponse.json({
      items: calculatedItems,
      barcodeAvailable: barcodeMap !== null,
      totalTodayProfit: Number(
        calculatedItems.reduce((sum, it) => sum + it.totalProfitToday, 0).toFixed(2)
      ),
      totalTodayCost: Number(
        calculatedItems.reduce((sum, it) => sum + it.totalCostToday, 0).toFixed(2)
      ),
    });
  } catch (error) {
    console.error('GET product costs error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
