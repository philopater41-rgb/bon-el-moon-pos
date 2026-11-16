import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET all expenses / cash transactions
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const shiftId = searchParams.get('shiftId');

    const where: Prisma.CashTransactionWhereInput = { type: 'PAYOUT' };
    if (shiftId) where.shiftId = shiftId;

    const expenses = await prisma.cashTransaction.findMany({
      where,
      include: {
        shift: {
          select: {
            id: true,
            cashierName: true,
            openedAt: true,
            closedAt: true,
            user: {
              select: { id: true, name: true, username: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const todayTotal = expenses
      .filter((e) => new Date(e.createdAt) >= startOfToday)
      .reduce((sum, e) => sum + e.amount, 0);

    const grandTotal = expenses.reduce((sum, e) => sum + e.amount, 0);

    return NextResponse.json({
      expenses,
      todayTotal,
      grandTotal,
    });
  } catch (error) {
    console.error('GET expenses error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST create an expense transaction
export async function POST(request: Request) {
  try {
    const { shiftId, type = 'PAYOUT', amount, reason } = await request.json();

    const parsedAmount = Number(amount);
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || !trimmedReason) {
      return NextResponse.json({ error: 'مبلغ موجب وبيان المصروف مطلوبان' }, { status: 400 });
    }
    if (type !== 'PAYOUT' && type !== 'PAYIN') {
      return NextResponse.json({ error: 'نوع الحركة غير صحيح' }, { status: 400 });
    }

    const transaction = await prisma.$transaction(async (tx) => {
      const activeShift = await tx.shift.findFirst({
        where: { closedAt: null, ...(shiftId ? { id: shiftId } : {}) },
        orderBy: { openedAt: 'desc' },
      });
      if (!activeShift) return null;
      return tx.cashTransaction.create({
        data: { shiftId: activeShift.id, type, amount: parsedAmount, reason: trimmedReason },
      });
    });
    if (!transaction) {
      return NextResponse.json({ error: 'لا توجد وردية مفتوحة لتسجيل الحركة' }, { status: 400 });
    }

    return NextResponse.json({ transaction });
  } catch (error) {
    console.error('Add cash transaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE an expense
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'ID is required' }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const transaction = await tx.cashTransaction.findUnique({
        where: { id },
        include: { shift: { select: { closedAt: true } } },
      });
      if (!transaction) return 'missing';
      if (transaction.shift.closedAt) return 'closed';
      await tx.cashTransaction.delete({ where: { id } });
      return 'deleted';
    });
    if (result === 'missing') return NextResponse.json({ error: 'المصروف غير موجود' }, { status: 404 });
    if (result === 'closed') return NextResponse.json({ error: 'لا يمكن حذف حركة من وردية مقفولة' }, { status: 409 });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE expense error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
