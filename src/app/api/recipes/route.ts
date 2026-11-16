import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const hiddenLegacyMaterialNames = [
  'Almond Milk Pack',
  'Chocolate Syrup',
  'Espresso Coffee Beans',
  'Frozen Croissant (Raw)',
  'Full Cream Milk',
  'White Sugar',
];

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

    const modifiers = await prisma.modifier.findMany({
      include: {
        recipe: {
          include: {
            rawMaterial: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const rawMaterials = await prisma.rawMaterial.findMany({
      where: { isActive: true, name: { notIn: hiddenLegacyMaterialNames } },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json({ items, modifiers, rawMaterials });
  } catch (error) {
    console.error('GET recipes error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { itemId, modifierId, ingredients } = await request.json(); // ingredients: Array<{ rawMaterialId: string, quantity: number }>

    if (!itemId && !modifierId) {
      return NextResponse.json({ error: 'Item ID or Modifier ID is required' }, { status: 400 });
    }

    if (ingredients !== undefined && !Array.isArray(ingredients)) {
      return NextResponse.json({ error: 'بيانات الوصفة غير صحيحة' }, { status: 400 });
    }
    const parsed = (ingredients || []).map((ing: { rawMaterialId: string; quantity: string | number }) => ({
      rawMaterialId: ing.rawMaterialId,
      quantity: Number(ing.quantity),
    }));
    if (parsed.some((ing: { rawMaterialId: string; quantity: number }) => !ing.rawMaterialId || !Number.isFinite(ing.quantity) || ing.quantity <= 0)) {
      return NextResponse.json({ error: 'الخامات والكميات يجب أن تكون صحيحة' }, { status: 400 });
    }
    await prisma.$transaction(async (tx) => {
      if (itemId) {
        await tx.recipe.deleteMany({ where: { itemId } });
        if (parsed.length) await tx.recipe.createMany({ data: parsed.map((ing: { rawMaterialId: string; quantity: number }) => ({ itemId, ...ing })) });
      } else {
        await tx.recipeModifier.deleteMany({ where: { modifierId } });
        if (parsed.length) await tx.recipeModifier.createMany({ data: parsed.map((ing: { rawMaterialId: string; quantity: number }) => ({ modifierId, ...ing })) });
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST recipes error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
