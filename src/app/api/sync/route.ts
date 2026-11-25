import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { itemStockMarker } from '@/lib/item-stock';
import { findLegacyWeight } from '@/lib/legacy-weight';

interface SyncOrderItemModifier {
  modifierId: string;
  unitPriceImpact: number;
}

interface SyncOrderItem {
  id: string;
  itemId: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  comment?: string | null;
  modifiers?: SyncOrderItemModifier[];
}

interface SyncOrder {
  id: string;
  receiptNumber?: string;
  shiftId: string;
  tableId?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  orderType: string; // "DINE_IN" | "TAKEAWAY"
  paymentMethod: string; // "CASH" | "VISA" | "INSTAPAY" | "VODAFONE_CASH" | "CASH_OUT"
  cashOutAmount?: number;
  cashOutFee?: number;
  status: string; // "COMPLETED" | "CANCELLED" | "REFUNDED"
  subtotal: number;
  discount: number;
  discountReason?: string | null;
  tax: number;
  total: number;
  returnStatus?: string;
  returnedAmount?: number;
  returnReason?: string | null;
  createdAt: string;
  items: SyncOrderItem[];
}

export async function POST(request: Request) {
  try {
    const { orders } = (await request.json()) as { orders: SyncOrder[] };

    if (!orders || !Array.isArray(orders)) {
      return NextResponse.json({ error: 'Invalid orders array' }, { status: 400 });
    }

    const validPaymentMethods = ['CASH', 'VISA', 'INSTAPAY', 'VODAFONE_CASH', 'CASH_OUT'];

    const syncedIds: string[] = [];
    const errors: { orderId: string; message: string }[] = [];

    for (const order of orders) {
      try {
        if (!validPaymentMethods.includes(order.paymentMethod)) throw new Error('طريقة الدفع غير صالحة');
        const paymentMethod = order.paymentMethod;
        if (!Array.isArray(order.items) || (order.items.length === 0 && order.paymentMethod !== 'CASH_OUT')) throw new Error('الطلب لا يحتوي على أصناف');

        // 1. Check if order already exists in the database
        const existing = await prisma.salesOrder.findUnique({
          where: { id: order.id },
        });

        if (existing) {
          syncedIds.push(order.id);
          continue; // Already synced
        }

        // 2. Wrap order insertion and stock deduction in a Prisma transaction
        await prisma.$transaction(async (tx) => {
          // Resolve any duplicate receipt number collision safely
          let finalReceiptNumber = order.receiptNumber;
          if (finalReceiptNumber) {
            const existingReceipt = await tx.salesOrder.findUnique({
              where: { receiptNumber: finalReceiptNumber },
            });
            if (existingReceipt && existingReceipt.id !== order.id) {
              finalReceiptNumber = `${finalReceiptNumber}-${order.id.slice(0, 4).toUpperCase()}`;
            }
          }

          // 2a. Validate and sanitize foreign keys to prevent P2003 constraints
          let finalShiftId = order.shiftId;
          const shiftExists = await tx.shift.findUnique({ where: { id: finalShiftId } });
          if (!shiftExists) {
            // Find existing open shift in DB
            const activeDbShift = await tx.shift.findFirst({
              where: { closedAt: null },
              orderBy: { openedAt: 'desc' },
            });
            if (activeDbShift) {
              finalShiftId = activeDbShift.id;
            } else {
              // Create offline shift automatically in database so orders are never lost
              const defaultUser = await tx.user.findFirst();
              if (defaultUser) {
                const newShift = await tx.shift.create({
                  data: {
                    id: finalShiftId,
                    userId: defaultUser.id,
                    cashierName: order.customerName ? undefined : 'كاشير (أوفلاين)',
                    openedAt: new Date(order.createdAt),
                    floatCash: 0,
                  },
                });
                finalShiftId = newShift.id;
              } else {
                throw new Error('الوردية غير موجودة؛ لم تتم مزامنة الطلب');
              }
            }
          }

          const finalTableId = order.tableId || null;
          if (finalTableId) {
            const tableExists = await tx.table.findUnique({ where: { id: finalTableId } });
            if (!tableExists) throw new Error('الطاولة غير موجودة');
          }

          const finalCustomerId = order.customerId || null;
          if (finalCustomerId) {
            const customerExists = await tx.customer.findUnique({ where: { id: finalCustomerId } });
            if (!customerExists) throw new Error('العميل غير موجود');
          }

          // 2b. Sanitize items and modifiers
          const sanitizedItems = [];
          for (const item of order.items || []) {
            const validItemId = item.itemId;
            const itemExists = await tx.item.findUnique({ where: { id: validItemId } });
            if (!itemExists) throw new Error('صنف الطلب غير موجود');
            const tracked = await tx.recipe.findFirst({ where: { itemId: validItemId, rawMaterial: { name: { endsWith: itemStockMarker(validItemId) } } }, include: { rawMaterial: true } });
            const weighted = (tracked && ['kg', 'g'].includes(tracked.rawMaterial.deductUnit)) || Boolean(await findLegacyWeight(tx, validItemId));
            if (!Number.isFinite(item.qty) || item.qty <= 0 || (!weighted && !Number.isInteger(item.qty)) || (weighted && Math.abs(item.qty * 1000 - Math.round(item.qty * 1000)) > 1e-7)) throw new Error('كمية الصنف غير صالحة');

            const validModifiers = [];
            for (const mod of item.modifiers || []) {
              const modExists = await tx.modifier.findUnique({ where: { id: mod.modifierId } });
              if (!modExists) throw new Error('إضافة الصنف غير موجودة');
              if (modExists) {
                validModifiers.push({
                  modifierId: mod.modifierId,
                  unitPriceImpact: mod.unitPriceImpact,
                });
              }
            }

            sanitizedItems.push({
              id: item.id,
              itemId: validItemId,
              qty: item.qty,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              comment: item.comment?.trim() || null,
              modifiers: {
                create: validModifiers,
              },
            });
          }

          // Create the sales order
          await tx.salesOrder.create({
            data: {
              id: order.id,
              receiptNumber: finalReceiptNumber,
              shiftId: finalShiftId,
              tableId: finalTableId,
              customerId: finalCustomerId,
              customerName: order.customerName || null,
              orderType: order.orderType,
              paymentMethod,
              cashOutAmount: order.cashOutAmount || 0,
              cashOutFee: order.cashOutFee || 0,
              status: order.status,
              subtotal: order.subtotal,
              discount: order.discount,
              discountReason: order.discountReason || null,
              tax: order.tax,
              total: order.total,
              returnStatus: order.returnStatus || 'NONE',
              returnedAmount: order.returnedAmount || 0,
              returnReason: order.returnReason || null,
              createdAt: new Date(order.createdAt),
              items: {
                create: sanitizedItems,
              },
            },
          });

          // Only perform inventory deduction if order is COMPLETED
          if (order.status === 'COMPLETED') {
            for (const item of order.items) {
              // Deduct recipe for the item
              const recipeIngredients = await tx.recipe.findMany({
                where: { itemId: item.itemId },
              });

              for (const ing of recipeIngredients) {
                const totalDeduct = ing.quantity * item.qty;
                const material = await tx.rawMaterial.findUniqueOrThrow({ where: { id: ing.rawMaterialId } });
                const result = await tx.rawMaterial.updateMany({ where: { id: ing.rawMaterialId, stockQty: { gte: totalDeduct } }, data: { stockQty: { decrement: totalDeduct } } });
                if (!result.count) throw new Error(`المخزون غير كافٍ للصنف أو الخامة: ${material.name.replace(/\s*\[product-stock:[^\]]+\]$/, '')}؛ المتاح ${material.stockQty} ${material.deductUnit}`);
              }

              const legacy = await findLegacyWeight(tx, item.itemId);
              if (legacy) {
                const needed = item.qty * 1000;
                const changed = await tx.rawMaterial.updateMany({ where: { id: legacy.id, stockQty: { gte: needed } }, data: { stockQty: { decrement: needed } } });
                if (!changed.count) throw new Error(`المخزون غير كافٍ للصنف: ${legacy.name}؛ المتاح ${legacy.stockQty / 1000} كجم`);
              }

              // Deduct recipes for any modifiers
              if (item.modifiers) {
                for (const mod of item.modifiers) {
                  const modIngredients = await tx.recipeModifier.findMany({
                    where: { modifierId: mod.modifierId },
                  });

                  for (const ing of modIngredients) {
                    const totalDeduct = ing.quantity * item.qty; // Deducted per item quantity
                    const changed = await tx.rawMaterial.updateMany({ where: { id: ing.rawMaterialId, stockQty: { gte: totalDeduct } }, data: { stockQty: { decrement: totalDeduct } } });
                    if (!changed.count) { const material = await tx.rawMaterial.findUniqueOrThrow({ where: { id: ing.rawMaterialId } }); throw new Error(`المخزون غير كافٍ للإضافة: ${material.name}؛ المتاح ${material.stockQty} ${material.deductUnit}`); }
                  }
                }
              }
            }
          }

          // Update Table status to VACANT if it was Dine-In and completed
          if (order.orderType === 'DINE_IN' && finalTableId && order.status === 'COMPLETED') {
            await tx.table.update({
              where: { id: finalTableId },
              data: { status: 'VACANT' },
            });
          }
        });

        syncedIds.push(order.id);
      } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
        console.error(`Error syncing order ${order.id}:`, err);
        errors.push({ orderId: order.id, message: err.message || 'Sync transaction failed' });
      }
    }

    return NextResponse.json({
      success: true,
      syncedIds,
      errors,
    });
  } catch (error) {
    console.error('Batch sync endpoint error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
