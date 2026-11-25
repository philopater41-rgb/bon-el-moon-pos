import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { findLegacyWeight } from '@/lib/legacy-weight';

export async function GET() {
  try {
    const rawMaterials = await prisma.rawMaterial.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    const materialsWithStatus = rawMaterials.map((mat) => ({
      ...mat,
      isLowStock: (mat.stockQty <= 0 || mat.stockQty < mat.minStockLevel),
    }));

    return NextResponse.json({ rawMaterials: materialsWithStatus });
  } catch (error) {
    console.error('GET raw materials error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { name, stockQty, minStockLevel, purchaseUnit, deductUnit, conversionFactor, costPerPurchaseUnit } = await request.json();

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: 'اسم الخامة مطلوب' },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();
    const pUnit = purchaseUnit?.trim() || 'kg';
    const dUnit = deductUnit?.trim() || (pUnit === 'kg' ? 'g' : pUnit === 'liter' ? 'ml' : 'unit');
    const factor = parseFloat(conversionFactor) || (pUnit === 'kg' || pUnit === 'liter' ? 1000 : 1.0);

    const exists = await prisma.rawMaterial.findUnique({
      where: { name: trimmedName },
    });

    if (exists) {
      return NextResponse.json({ error: 'يوجد خامة مسجلة بنفس هذا الاسم مسبقاً' }, { status: 400 });
    }

    const material = await prisma.rawMaterial.create({
      data: {
        name: trimmedName,
        stockQty: parseFloat(stockQty) || 0.0,
        minStockLevel: parseFloat(minStockLevel) || 0.0,
        purchaseUnit: pUnit,
        deductUnit: dUnit,
        conversionFactor: factor,
        costPerPurchaseUnit: parseFloat(costPerPurchaseUnit) || 0.0,
      },
    });

    return NextResponse.json({ rawMaterial: material });
  } catch (error) {
    console.error('Create raw material error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { rawMaterialId, id, name, stockQty, minStockLevel, purchaseUnit, deductUnit, conversionFactor, costPerPurchaseUnit, expectedStockQty } = await request.json();
    const targetId = rawMaterialId || id;
    if (!targetId) {
      return NextResponse.json({ error: 'الخامة مطلوبة.' }, { status: 400 });
    }
    const data: Record<string, string | number> = {};
    if (name !== undefined) data.name = String(name).trim();
    if (stockQty !== undefined) data.stockQty = Number(stockQty);
    if (minStockLevel !== undefined) data.minStockLevel = Number(minStockLevel);
    if (purchaseUnit !== undefined) data.purchaseUnit = String(purchaseUnit).trim();
    if (deductUnit !== undefined) data.deductUnit = String(deductUnit).trim();
    if (conversionFactor !== undefined) data.conversionFactor = Number(conversionFactor);
    if (costPerPurchaseUnit !== undefined) data.costPerPurchaseUnit = Number(costPerPurchaseUnit);

    if (!Object.keys(data).length || Object.values(data).some((value) => typeof value === 'number' && (!Number.isFinite(value) || value < 0))) {
      return NextResponse.json({ error: 'راجع بيانات الخامة وتأكد أن الأرقام صحيحة.' }, { status: 400 });
    }
    const original = await prisma.rawMaterial.findUnique({ where: { id: targetId } });
    if (original && (data.name !== undefined || data.purchaseUnit !== undefined || data.deductUnit !== undefined || data.conversionFactor !== undefined)) {
      const related = await prisma.item.findMany({ where: { name: original.name, isActive: true }, select: { id: true }, take: 2 });
      const legacy = related.length === 1 ? await findLegacyWeight(prisma, related[0].id) : null;
      if (legacy?.id === targetId && ((data.name !== undefined && data.name !== original.name) || (data.purchaseUnit !== undefined && data.purchaseUnit !== original.purchaseUnit) || (data.deductUnit !== undefined && data.deductUnit !== original.deductUnit) || (data.conversionFactor !== undefined && data.conversionFactor !== original.conversionFactor))) return NextResponse.json({ error: 'لا يمكن تغيير اسم أو وحدات خامة مرتبطة بصنف يباع بالكيلو.' }, { status: 409 });
    }
    if (expectedStockQty !== undefined && stockQty !== undefined) {
      const expected = Number(expectedStockQty);
      if (!Number.isFinite(expected) || expected < 0) return NextResponse.json({ error: 'الرصيد السابق غير صالح.' }, { status: 400 });
      const changed = await prisma.rawMaterial.updateMany({ where: { id: targetId, stockQty: expected }, data });
      if (!changed.count) return NextResponse.json({ error: 'تغير رصيد الخامة أثناء التعديل؛ حدّث البيانات وحاول مرة أخرى.' }, { status: 409 });
      const rawMaterial = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: targetId } });
      return NextResponse.json({ rawMaterial });
    }
    const rawMaterial = await prisma.rawMaterial.update({ where: { id: targetId }, data });
    return NextResponse.json({ rawMaterial });
  } catch (error) {
    console.error('Update raw material error:', error);
    return NextResponse.json({ error: 'تعذر تعديل بيانات الخامة.' }, { status: 500 });
  }
}

export const PUT = PATCH;

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    let rawMaterialId = searchParams.get('id') || searchParams.get('rawMaterialId');
    if (!rawMaterialId) {
      try {
        const body = await request.json();
        rawMaterialId = body?.rawMaterialId || body?.id;
      } catch {
        // ignore
      }
    }
    if (!rawMaterialId) return NextResponse.json({ error: 'الخامة مطلوبة.' }, { status: 400 });

    const result = await prisma.$transaction(async (tx) => {
      const material = await tx.rawMaterial.findUnique({ where: { id: rawMaterialId } });
      if (!material) return 'missing';
      const [recipeCount, modifierCount] = await Promise.all([
        tx.recipe.count({ where: { rawMaterialId } }),
        tx.recipeModifier.count({ where: { rawMaterialId } }),
      ]);
      const related = await tx.item.findMany({ where: { name: material.name }, select: { id: true }, take: 2 });
      const linked = related.length === 1 ? await findLegacyWeight(tx, related[0].id, true) : null;
      if (recipeCount || modifierCount || linked?.id === rawMaterialId) return 'in-use';
      await tx.rawMaterial.update({ where: { id: rawMaterialId }, data: { isActive: false } });
      return 'hidden';
    });
    if (result === 'missing') return NextResponse.json({ error: 'الخامة غير موجودة.' }, { status: 404 });
    if (result === 'in-use') return NextResponse.json({ error: 'الخامة مستخدمة في وصفات؛ احذفها من الوصفات أولاً.' }, { status: 409 });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete raw material error:', error);
    return NextResponse.json({ error: 'تعذر حذف الخامة.' }, { status: 500 });
  }
}

