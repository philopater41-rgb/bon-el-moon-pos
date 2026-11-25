import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getBarcodes } from '@/lib/barcodes';
import { itemStockMarker, parseStock } from '@/lib/item-stock';
import { findLegacyWeight } from '@/lib/legacy-weight';

// GET: Fetch all active items with recipes and categories
export async function GET() {
  try {
    const items = await prisma.item.findMany({
      where: { isActive: true },
      include: {
        category: true,
        recipe: {
          include: {
            rawMaterial: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json({ items, categories });
  } catch (error) {
    console.error('GET items error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Create a new menu item with optional recipe ingredients
export async function POST(request: Request) {
  try {
    const { name, price, cost, categoryName, recipe, barcode, stock } = await request.json();
    const itemName = typeof name === 'string' ? name.trim() : '';
    const normalizedCategoryName = typeof categoryName === 'string' ? categoryName.trim() : '';
    const parsedPrice = Number(price);
    const parsedCost = Number(cost) || 0;

    if (!itemName || !normalizedCategoryName || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return NextResponse.json({ error: 'اسم الصنف والقسم والسعر الصحيح مطلوبون.' }, { status: 400 });
    }

    const stockInput = parseStock(stock);
    if (stockInput && Array.isArray(recipe) && recipe.some(r => r.rawMaterialId && Number(r.quantity) > 0)) return NextResponse.json({ error: 'تتبع رصيد الصنف لا يجتمع مع وصفة خامات؛ استخدم أحدهما.' }, { status: 400 });
    const normalizedBarcode = typeof barcode === 'string' ? barcode.trim() : '';
    if (normalizedBarcode && !(await getBarcodes())) return NextResponse.json({ error: 'يلزم تجهيز قاعدة البيانات لدعم الباركود أولاً.' }, { status: 503 });
    if (normalizedBarcode) {
      const existingBarcode = await prisma.itemBarcode.findUnique({ where: { barcode: normalizedBarcode }, include: { item: true } });
      if (existingBarcode) return NextResponse.json({ error: `الباركود مستخدم بالفعل للصنف: ${existingBarcode.item.name}` }, { status: 409 });
    }
    const itemWithRecipe = await prisma.$transaction(async (tx) => {
      const category = await tx.category.upsert({
        where: { name: normalizedCategoryName },
        update: { isActive: true },
        create: { name: normalizedCategoryName, isActive: true },
      });

      const duplicate = await tx.item.findFirst({
        where: { name: itemName, categoryId: category.id, isActive: true },
      });
      if (duplicate) return null;

      const item = await tx.item.create({
        data: {
          name: itemName,
          price: parsedPrice,
          cost: parsedCost,
          categoryId: category.id,
          isActive: true,
        },
        include: { category: true, recipe: true },
      });

      if (normalizedBarcode) await tx.itemBarcode.create({ data: { itemId: item.id, barcode: normalizedBarcode } });
      if (stockInput) {
        if (await tx.rawMaterial.findFirst({ where: { name: itemName, isActive: true } })) throw new Error('توجد خامة بنفس الاسم في المخزون؛ اربطها بالوصفة بدلاً من إنشاء رصيد مكرر.');
        const material = await tx.rawMaterial.create({ data: { name: `${itemName} ${itemStockMarker(item.id)}`, stockQty: stockInput.quantity, minStockLevel: stockInput.minimum, purchaseUnit: stockInput.unit, deductUnit: stockInput.unit, conversionFactor: 1, costPerPurchaseUnit: parsedCost } });
        await tx.recipe.create({ data: { itemId: item.id, rawMaterialId: material.id, quantity: 1 } });
      }


      // If recipe ingredients were passed, create them
      if (recipe && Array.isArray(recipe) && recipe.length > 0) {
        const validIngredients = recipe.filter(
          (r: { rawMaterialId: string; quantity: string | number }) => r.rawMaterialId && Number(r.quantity) > 0
        );
        if (validIngredients.length > 0) {
          await tx.recipe.createMany({
            data: validIngredients.map((r: { rawMaterialId: string; quantity: string | number }) => ({
              itemId: item.id,
              rawMaterialId: r.rawMaterialId,
              quantity: Number(r.quantity),
            })),
          });
        }
      }

      return tx.item.findUniqueOrThrow({
        where: { id: item.id },
        include: {
          category: true,
          recipe: { include: { rawMaterial: true } },
        },
      });

    });
    if (!itemWithRecipe) {
      return NextResponse.json({ error: 'هذا الصنف موجود بالفعل في هذا القسم.' }, { status: 409 });
    }

    return NextResponse.json({ item: itemWithRecipe }, { status: 201 });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: 'الباركود مستخدم لصنف آخر بالفعل.' }, { status: 409 });
    if (error instanceof Error && (error.message.includes('المخزون') || error.message.includes('الكمية'))) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Create menu item error:', error);
    return NextResponse.json({ error: 'تعذر إضافة الصنف.' }, { status: 500 });
  }
}

// PUT: Update an existing menu item and its recipe
export async function PUT(request: Request) {
  try {
    const { id, name, price, cost, categoryName, recipe, barcode, stock } = await request.json();
    if (!id) {
      return NextResponse.json({ error: 'معرّف الصنف مطلوب.' }, { status: 400 });
    }

    const itemName = typeof name === 'string' ? name.trim() : '';
    const normalizedCategoryName = typeof categoryName === 'string' ? categoryName.trim() : '';
    const parsedPrice = Number(price);
    const parsedCost = cost !== undefined ? Number(cost) : undefined;

    if (!itemName || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return NextResponse.json({ error: 'بيانات الصنف غير صحيحة.' }, { status: 400 });
    }

    const stockInput = parseStock(stock);
    const barcodeMap = barcode !== undefined ? await getBarcodes() : null;
    const normalizedBarcode = typeof barcode === 'string' ? barcode.trim() : '';
    if (normalizedBarcode && !barcodeMap) return NextResponse.json({ error: 'يلزم تجهيز قاعدة البيانات لدعم الباركود أولاً.' }, { status: 503 });
    if (normalizedBarcode) {
      const existingBarcode = await prisma.itemBarcode.findUnique({ where: { barcode: normalizedBarcode }, include: { item: true } });
      if (existingBarcode && existingBarcode.itemId !== id) return NextResponse.json({ error: `الباركود مستخدم بالفعل للصنف: ${existingBarcode.item.name}` }, { status: 409 });
    }
    const updatedItem = await prisma.$transaction(async (tx) => {
      const legacyWeight = await findLegacyWeight(tx, id);
      if (legacyWeight && (itemName !== legacyWeight.name || (Array.isArray(recipe) && recipe.some(r => r.rawMaterialId && Number(r.quantity) > 0)))) throw new Error('لا يمكن تغيير اسم الصنف أو إضافة وصفة لأنه مرتبط بخامة وزن في المخزون.');
      const previousRecipe = await tx.recipe.findMany({ where: { itemId: id }, include: { rawMaterial: true } });
      const stockRecipe = previousRecipe.find(r => r.rawMaterial.name.endsWith(itemStockMarker(id)));
      const otherIngredients = Array.isArray(recipe) ? recipe.filter(r => r.rawMaterialId && Number(r.quantity) > 0) : previousRecipe.filter(r => r.id !== stockRecipe?.id);
      if ((stockInput || stockRecipe) && otherIngredients.length) throw new Error('تتبع رصيد الصنف لا يجتمع مع وصفة خامات؛ استخدم أحدهما.');
      if (stockInput && stockRecipe) {
        if (stockInput.unit !== stockRecipe.rawMaterial.deductUnit) throw new Error('لا يمكن تغيير وحدة رصيد موجود تلقائياً.');
        if (stockInput.expected === undefined) throw new Error('يجب تحديث البيانات قبل تعديل الرصيد.');
        const changed = await tx.rawMaterial.updateMany({ where: { id: stockRecipe.rawMaterialId, stockQty: stockInput.expected }, data: { stockQty: stockInput.quantity, minStockLevel: stockInput.minimum } });
        if (changed.count !== 1) throw new Error('تغير رصيد الصنف أثناء التعديل؛ حدّث البيانات وحاول مرة أخرى.');
      } else if (stockInput) {
        if (await tx.rawMaterial.findFirst({ where: { name: itemName, isActive: true } })) throw new Error('توجد خامة بنفس الاسم في المخزون؛ اربطها بالوصفة بدلاً من إنشاء رصيد مكرر.');
        const material = await tx.rawMaterial.create({ data: { name: `${itemName} ${itemStockMarker(id)}`, stockQty: stockInput.quantity, minStockLevel: stockInput.minimum, purchaseUnit: stockInput.unit, deductUnit: stockInput.unit, conversionFactor: 1, costPerPurchaseUnit: Number.isFinite(parsedCost) ? parsedCost : 0 } });
        await tx.recipe.create({ data: { itemId: id, rawMaterialId: material.id, quantity: 1 } });
      }
      let categoryId: string | undefined;
      if (normalizedCategoryName) {
        const category = await tx.category.upsert({
          where: { name: normalizedCategoryName },
          update: { isActive: true },
          create: { name: normalizedCategoryName, isActive: true },
        });
        categoryId = category.id;
      }
      await tx.item.update({
        where: { id },
        data: {
          name: itemName,
          price: parsedPrice,
          ...(parsedCost !== undefined && Number.isFinite(parsedCost) ? { cost: parsedCost } : {}),
          ...(categoryId ? { categoryId } : {}),
        },
      });
      if (stockRecipe) {
        const materialName = `${itemName} ${itemStockMarker(id)}`;
        if (stockRecipe.rawMaterial.name !== materialName || (parsedCost !== undefined && Number.isFinite(parsedCost) && stockRecipe.rawMaterial.costPerPurchaseUnit !== parsedCost)) {
          await tx.rawMaterial.update({ where: { id: stockRecipe.rawMaterialId }, data: { name: materialName, ...(parsedCost !== undefined && Number.isFinite(parsedCost) ? { costPerPurchaseUnit: parsedCost } : {}) } });
        }
      }
      if (barcode !== undefined && barcodeMap) {
        if (normalizedBarcode) await tx.itemBarcode.upsert({ where: { itemId: id }, create: { itemId: id, barcode: normalizedBarcode }, update: { barcode: normalizedBarcode } });
        else await tx.itemBarcode.deleteMany({ where: { itemId: id } });
      }
      if (Array.isArray(recipe)) {
        await tx.recipe.deleteMany({ where: { itemId: id, ...(stockRecipe ? { NOT: { id: stockRecipe.id } } : stockInput ? { rawMaterial: { name: { not: `${itemName} ${itemStockMarker(id)}` } } } : {}) } });
        const validIngredients = recipe.filter(
          (r: { rawMaterialId: string; quantity: string | number }) => r.rawMaterialId && Number(r.quantity) > 0
        );
        if (validIngredients.length > 0) {
          await tx.recipe.createMany({ data: validIngredients.map((r: { rawMaterialId: string; quantity: string | number }) => ({
            itemId: id, rawMaterialId: r.rawMaterialId, quantity: Number(r.quantity),
          })) });
        }
      }
      return tx.item.findUnique({ where: { id }, include: { category: true, recipe: { include: { rawMaterial: true } } } });
    });
    return NextResponse.json({ item: updatedItem });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: 'الباركود مستخدم لصنف آخر بالفعل.' }, { status: 409 });
    if (error instanceof Error && (error.message.includes('الرصيد') || error.message.includes('رصيد') || error.message.includes('المخزون') || error.message.includes('الكمية') || error.message.includes('وصفة'))) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Update menu item error:', error);
    return NextResponse.json({ error: 'تعذر تعديل الصنف.' }, { status: 500 });
  }
}

// DELETE: Delete menu item safely
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    let itemId = searchParams.get('id');
    if (!itemId) {
      try {
        const body = await request.json();
        itemId = body?.id;
      } catch {
        // ignore
      }
    }
    if (!itemId) return NextResponse.json({ error: 'معرّف الصنف مطلوب.' }, { status: 400 });

    // Check if item has order history
    const orderCount = await prisma.salesOrderItem.count({ where: { itemId } });
    const returnCount = await prisma.orderReturnItem.count({ where: { itemId } });

    if (orderCount === 0 && returnCount === 0) {
      // Safe to completely delete
      await prisma.recipe.deleteMany({ where: { itemId } });
      await prisma.item.delete({ where: { id: itemId } });
      return NextResponse.json({ success: true, deleted: true });
    } else {
      // Keep sales history intact: hide the item from active menu & POS
      const item = await prisma.item.update({
        where: { id: itemId },
        data: { isActive: false },
      });
      return NextResponse.json({ success: true, deactivated: true, item });
    }
  } catch (error) {
    console.error('Delete menu item error:', error);
    return NextResponse.json({ error: 'تعذر حذف الصنف.' }, { status: 500 });
  }
}

