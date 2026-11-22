import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getBarcodes } from '@/lib/barcodes';

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
    const { name, price, cost, categoryName, recipe, barcode } = await request.json();
    const itemName = typeof name === 'string' ? name.trim() : '';
    const normalizedCategoryName = typeof categoryName === 'string' ? categoryName.trim() : '';
    const parsedPrice = Number(price);
    const parsedCost = Number(cost) || 0;

    if (!itemName || !normalizedCategoryName || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return NextResponse.json({ error: 'اسم الصنف والقسم والسعر الصحيح مطلوبون.' }, { status: 400 });
    }

    const normalizedBarcode = typeof barcode === 'string' ? barcode.trim() : '';
    if (normalizedBarcode && !(await getBarcodes())) return NextResponse.json({ error: 'يلزم تجهيز قاعدة البيانات لدعم الباركود أولاً.' }, { status: 503 });
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
    console.error('Create menu item error:', error);
    return NextResponse.json({ error: 'تعذر إضافة الصنف.' }, { status: 500 });
  }
}

// PUT: Update an existing menu item and its recipe
export async function PUT(request: Request) {
  try {
    const { id, name, price, cost, categoryName, recipe, barcode } = await request.json();
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

    const barcodeMap = barcode !== undefined ? await getBarcodes() : null;
    const normalizedBarcode = typeof barcode === 'string' ? barcode.trim() : '';
    if (normalizedBarcode && !barcodeMap) return NextResponse.json({ error: 'يلزم تجهيز قاعدة البيانات لدعم الباركود أولاً.' }, { status: 503 });
    const updatedItem = await prisma.$transaction(async (tx) => {
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
      if (barcode !== undefined && barcodeMap) {
        if (normalizedBarcode) await tx.itemBarcode.upsert({ where: { itemId: id }, create: { itemId: id, barcode: normalizedBarcode }, update: { barcode: normalizedBarcode } });
        else await tx.itemBarcode.deleteMany({ where: { itemId: id } });
      }
      if (Array.isArray(recipe)) {
        await tx.recipe.deleteMany({ where: { itemId: id } });
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

