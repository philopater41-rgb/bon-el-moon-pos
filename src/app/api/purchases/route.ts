import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET: Fetch all purchase invoices
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const supplierId = searchParams.get('supplierId');
    const paymentMethod = searchParams.get('paymentMethod');

    const where: Prisma.PurchaseInvoiceWhereInput = {};
    if (supplierId) where.supplierId = supplierId;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    const invoices = await prisma.purchaseInvoice.findMany({
      where,
      orderBy: { invoiceDate: 'desc' },
      include: {
        supplier: {
          select: { id: true, name: true, phone: true, companyName: true },
        },
        items: {
          include: {
            rawMaterial: { select: { id: true, name: true, purchaseUnit: true, deductUnit: true } },
          },
        },
      },
    });

    return NextResponse.json({ invoices });
  } catch (error) {
    console.error('GET purchase invoices error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: Create a purchase invoice and update stock
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      invoiceNumber,
      supplierId,
      supplierName,
      invoiceDate,
      items,
      paymentMethod = 'CASH',
      paidAmount,
      notes,
    } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'يجب إضافة أصناف أو خامات للفاتورة' }, { status: 400 });
    }

    let calculatedTotal = 0;
    for (const it of items) {
      const quantity = Number(it.quantity);
      const itemTotal = it.totalPrice !== undefined && it.totalPrice !== '' ? Number(it.totalPrice) : quantity * Number(it.unitPrice || 0);
      if (typeof it.itemName !== 'string' || !it.itemName.trim() || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(itemTotal) || itemTotal < 0) {
        return NextResponse.json({ error: 'اسم الصنف والكمية والسعر يجب أن تكون صحيحة' }, { status: 400 });
      }
      calculatedTotal += itemTotal;
    }

    const actualPaid = paidAmount !== undefined && paidAmount !== '' ? Number(paidAmount) : calculatedTotal;
    if (!Number.isFinite(calculatedTotal) || !Number.isFinite(actualPaid) || actualPaid < 0 || actualPaid > calculatedTotal) {
      return NextResponse.json({ error: 'المبلغ المدفوع يجب أن يكون بين صفر وإجمالي الفاتورة' }, { status: 400 });
    }
    const remainingAmount = Math.max(0, calculatedTotal - actualPaid);

    const generatedNumber =
      invoiceNumber || `PINV-${Date.now().toString().slice(-6)}`;

    // Prisma Transaction
    const createdInvoice = await prisma.$transaction(async (tx) => {
      // 1. Create Purchase Invoice
      const invoice = await tx.purchaseInvoice.create({
        data: {
          invoiceNumber: generatedNumber,
          supplierId: supplierId || null,
          supplierName: supplierName || null,
          invoiceDate: invoiceDate ? new Date(invoiceDate) : new Date(),
          totalAmount: calculatedTotal,
          paidAmount: actualPaid,
          remainingAmount,
          paymentMethod,
          notes: notes || null,
          items: {
            create: items.map((it: { rawMaterialId?: string; itemName: string; quantity: number | string; totalPrice?: number | string; unitPrice?: number | string; purchaseUnit?: string }) => {
              const qty = Number(it.quantity) || 1;
              const tot = it.totalPrice !== undefined && it.totalPrice !== '' ? Number(it.totalPrice) : qty * Number(it.unitPrice || 0);
              const unit = qty > 0 ? tot / qty : tot;
              return {
                rawMaterialId: it.rawMaterialId || null,
                itemName: it.itemName,
                quantity: qty,
                purchaseUnit: it.purchaseUnit || 'unit',
                unitPrice: unit,
                totalPrice: tot,
              };
            }),
          },
        },
        include: {
          items: true,
        },
      });

      // 2. Increment Stock & Update Cost per Purchase Unit for RawMaterials
      for (const it of items) {
        if (it.rawMaterialId) {
          const qty = Number(it.quantity) || 0;
          const tot = it.totalPrice !== undefined && it.totalPrice !== '' ? Number(it.totalPrice) : qty * Number(it.unitPrice || 0);
          const unit = qty > 0 ? tot / qty : tot;

          const rawMat = await tx.rawMaterial.findUnique({
            where: { id: it.rawMaterialId },
          });

          if (rawMat) {
            const addedStockInDeductUnits = qty * (rawMat.conversionFactor || 1);
            await tx.rawMaterial.update({
              where: { id: it.rawMaterialId },
              data: {
                stockQty: {
                  increment: addedStockInDeductUnits,
                },
                costPerPurchaseUnit: unit > 0 ? unit : (rawMat.costPerPurchaseUnit || 0),
              },
            });

            // Also record a restock log for history
            await tx.restockLog.create({
              data: {
                rawMaterialId: it.rawMaterialId,
                quantity: Number(it.quantity),
                amount: tot,
                createdAt: invoiceDate ? new Date(invoiceDate) : new Date(),
              },
            });
          }
        }
      }

      return invoice;
    });

    return NextResponse.json({ success: true, invoice: createdInvoice });
  } catch (caught: unknown) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
    console.error('POST purchase invoice error:', error);
    return NextResponse.json({ error: error.message || 'Failed to create purchase invoice' }, { status: 500 });
  }
}

// PATCH: Settle or add partial payment to existing purchase invoice
export async function PATCH(request: Request) {
  try {
    const { invoiceId, paymentAmount, paymentMethod = 'CASH', notes } = await request.json();

    if (!invoiceId || paymentAmount === undefined || !Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
      return NextResponse.json({ error: 'يرجى تحديد الفاتورة ومبلغ السداد الصحيح' }, { status: 400 });
    }

    const pay = Number(paymentAmount);

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.purchaseInvoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) return { error: 'الفاتورة غير موجودة', status: 404 } as const;
      if (pay > invoice.remainingAmount + 0.000001) return { error: 'مبلغ السداد أكبر من المتبقي على الفاتورة', status: 400 } as const;
      const paymentNote = `سداد مبلغ ${pay} ج (${paymentMethod}) بتاريخ ${new Date().toLocaleDateString()}${notes ? `: ${notes}` : ''}`;
      const updatedNotes = invoice.notes ? `${invoice.notes}\n${paymentNote}` : paymentNote;
      const changed = await tx.purchaseInvoice.updateMany({
        where: { id: invoiceId, remainingAmount: { gte: pay } },
        data: { paidAmount: { increment: pay }, remainingAmount: { decrement: pay }, notes: updatedNotes },
      });
      if (!changed.count) return { error: 'تغير المبلغ المتبقي؛ أعد المحاولة', status: 409 } as const;
      return { invoice: await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId } }) } as const;
    });
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
    const updated = result.invoice;
    return NextResponse.json({ success: true, invoice: updated });
  } catch (caught: unknown) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
    console.error('PATCH purchase payment error:', error);
    return NextResponse.json({ error: error.message || 'Failed to update payment' }, { status: 500 });
  }
}
