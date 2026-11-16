import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET: Fetch all wastage logs
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawMaterialId = searchParams.get('rawMaterialId');

    const where: Prisma.WastageLogWhereInput = {};
    if (rawMaterialId) where.rawMaterialId = rawMaterialId;

    const wastageLogs = await prisma.wastageLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        rawMaterial: {
          select: {
            id: true,
            name: true,
            deductUnit: true,
            purchaseUnit: true,
            costPerPurchaseUnit: true,
            conversionFactor: true,
          },
        },
      },
    });

    const totalWastageCost = wastageLogs.reduce((sum, w) => sum + (w.costAmount || 0), 0);

    return NextResponse.json({
      wastageLogs,
      totalWastageCost,
    });
  } catch (error) {
    console.error('GET wastage error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Add new wastage record
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { rawMaterialId, quantity, reason, loggedBy } = body;

    if (!rawMaterialId || !quantity || Number(quantity) <= 0) {
      return NextResponse.json({ error: 'يرجى اختيار المادة الخام وتحديد كمية الهالك' }, { status: 400 });
    }

    if (!reason || !reason.trim()) {
      return NextResponse.json({ error: 'سبب الهالك مطلوب' }, { status: 400 });
    }

    const rawMaterial = await prisma.rawMaterial.findUnique({
      where: { id: rawMaterialId },
    });

    if (!rawMaterial) {
      return NextResponse.json({ error: 'المادة الخام غير موجودة' }, { status: 404 });
    }

    const deductQty = Number(quantity);
    // Cost per deduct unit = costPerPurchaseUnit / conversionFactor
    const unitCost =
      rawMaterial.conversionFactor > 0
        ? (rawMaterial.costPerPurchaseUnit || 0) / rawMaterial.conversionFactor
        : 0;
    const costAmount = deductQty * unitCost;

    const log = await prisma.$transaction(async (tx) => {
      // 1. Decrement Stock
      await tx.rawMaterial.update({
        where: { id: rawMaterialId },
        data: {
          stockQty: {
            decrement: deductQty,
          },
        },
      });

      // 2. Create WastageLog
      return await tx.wastageLog.create({
        data: {
          rawMaterialId,
          quantity: deductQty,
          costAmount,
          reason: reason.trim(),
          loggedBy: loggedBy || 'Admin',
        },
        include: {
          rawMaterial: true,
        },
      });
    });

    return NextResponse.json({ success: true, wastageLog: log });
  } catch (caught: unknown) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
    console.error('POST wastage error:', error);
    return NextResponse.json({ error: error.message || 'Failed to record wastage' }, { status: 500 });
  }
}
