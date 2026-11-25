import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { itemStockMarker } from '@/lib/item-stock';

// GET: Fetch all order returns
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const orderId = searchParams.get('orderId');
    const shiftId = searchParams.get('shiftId');

    const where: Prisma.OrderReturnWhereInput = {};
    if (orderId) where.orderId = orderId;
    if (shiftId) where.shiftId = shiftId;

    const returns = await prisma.orderReturn.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          include: {
            shift: { select: { id: true, cashierName: true, openedAt: true, user: { select: { name: true } } } },
            table: { select: { name: true } },
            customer: { select: { name: true, phone: true } },
            items: {
              include: {
                item: { select: { id: true, name: true, price: true } },
                modifiers: { include: { modifier: { select: { name: true } } } },
              },
            },
          },
        },
        items: {
          include: {
            item: { select: { id: true, name: true } },
          },
        },
      },
    });

    return NextResponse.json({ returns });
  } catch (error) {
    console.error('GET returns error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Process an order return / refund
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      orderId,
      shiftId,
      refundAmount,
      paymentMethod = 'CASH',
      reason,
      cashierName,
      restockItems = true,
      items, // Array<{ itemId: string; quantity: number; refundPrice: number }>
    } = body;

    if (!orderId || !refundAmount || Number(refundAmount) <= 0) {
      return NextResponse.json({ error: 'بيانات المرتجع غير مكتملة' }, { status: 400 });
    }

    if (!reason || !reason.trim()) {
      return NextResponse.json({ error: 'سبب الإرجاع مطلوب' }, { status: 400 });
    }

    const totalRefundVal = Number(refundAmount);
    if (!Number.isFinite(totalRefundVal) || !['CASH', 'VISA', 'INSTAPAY', 'VODAFONE_CASH'].includes(paymentMethod)) {
      return NextResponse.json({ error: 'مبلغ المرتجع أو طريقة الدفع غير صالحة' }, { status: 400 });
    }
    if (items !== undefined && !Array.isArray(items)) {
      return NextResponse.json({ error: 'أصناف المرتجع غير صالحة' }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({
        where: { id: orderId },
        include: { items: { include: { modifiers: true } }, returns: { include: { items: true } } },
      });
      if (!order) throw new Error('الطلب غير موجود');
      if (!['COMPLETED', 'REFUNDED'].includes(order.status)) throw new Error('لا يمكن إرجاع هذا الطلب');
      if (order.paymentMethod === 'CASH_OUT') throw new Error('لا يمكن إرجاع عملية كاش آوت تلقائياً؛ يلزم تسويتها يدوياً');
      const newReturnedAmount = (order.returnedAmount || 0) + totalRefundVal;
      if (newReturnedAmount > order.total + 0.000001) throw new Error('مبلغ المرتجع يتجاوز المبلغ المتبقي من الفاتورة');
      const returnShiftId = shiftId || order.shiftId;
      const returnShift = await tx.shift.findUnique({ where: { id: returnShiftId } });
      if (!returnShift || returnShift.closedAt) throw new Error('يجب تسجيل المرتجع في وردية مفتوحة');
      const requested = new Map<string, number>();
      for (const it of items || []) {
        const qty = Number(it.quantity);
        if (!it.itemId || !Number.isFinite(qty) || qty <= 0 || Math.abs(qty * 1000 - Math.round(qty * 1000)) > 1e-7 || !Number.isFinite(Number(it.refundPrice)) || Number(it.refundPrice) < 0) throw new Error('بيانات صنف المرتجع غير صالحة');
        const tracked = await tx.recipe.findFirst({ where: { itemId: it.itemId, rawMaterial: { name: { endsWith: itemStockMarker(it.itemId) } } }, include: { rawMaterial: true } });
        if ((!tracked || !['kg', 'g'].includes(tracked.rawMaterial.deductUnit)) && !Number.isInteger(qty)) throw new Error('كمية القطع المرتجعة يجب أن تكون عددًا صحيحًا');
        requested.set(it.itemId, (requested.get(it.itemId) || 0) + qty);
      }
      for (const [itemId, qty] of requested) {
        const sold = order.items.filter(it => it.itemId === itemId).reduce((sum, it) => sum + it.qty, 0);
        const returned = order.returns.flatMap(r => r.items).filter(it => it.itemId === itemId).reduce((sum, it) => sum + it.quantity, 0);
        if (qty > sold - returned) throw new Error('كمية المرتجع تتجاوز الكمية المباعة المتبقية');
      }
      const orderReturn = await tx.orderReturn.create({
        data: {
          orderId, receiptNumber: order.receiptNumber, shiftId: returnShiftId,
          refundAmount: totalRefundVal, paymentMethod, reason: reason.trim(), cashierName: cashierName || null,
          restockItems: Boolean(restockItems),
          items: { create: (items || []).map((it: { itemId: string; quantity: number; refundPrice: number }) => ({ itemId: it.itemId, quantity: Number(it.quantity), refundPrice: Number(it.refundPrice) })) },
        }, include: { items: true },
      });
      const isFullReturn = newReturnedAmount >= order.total - 0.000001;
      await tx.salesOrder.update({ where: { id: orderId }, data: {
        returnStatus: isFullReturn ? 'FULL' : 'PARTIAL', returnedAmount: newReturnedAmount,
        returnReason: reason.trim(), status: isFullReturn ? 'REFUNDED' : order.status,
      } });
      if (restockItems) {
        for (const [itemId, qty] of requested) {
          const ingredients = await tx.recipe.findMany({ where: { itemId } });
          for (const ing of ingredients) await tx.rawMaterial.update({ where: { id: ing.rawMaterialId }, data: { stockQty: { increment: ing.quantity * qty } } });
          // Item-level returns cannot identify which modifier was returned when
          // identical products have different modifiers. Avoid inventing stock.
        }
      }
      return orderReturn;
    });
    return NextResponse.json({ success: true, returnRecord: result });
  } catch (caught: unknown) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
    console.error('POST order return error:', error);
    return NextResponse.json({ error: error.message || 'Failed to process return' }, { status: 400 });
  }
}
