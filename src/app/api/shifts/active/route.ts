import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET active shift
export async function GET() {
  try {
    const activeShift = await prisma.shift.findFirst({
      where: { closedAt: null },
      include: {
        user: {
          select: { id: true, name: true, username: true, role: true },
        },
        transactions: true,
        orders: true,
        returns: true,
      },
    });

    if (!activeShift) {
      return NextResponse.json({ activeShift: null });
    }

    let salesCash = 0;
    let salesInstaPay = 0;
    let salesVisa = 0;
    let salesVodafoneCash = 0;
    let salesCashOut = 0;
    let visaCashOutReceived = 0;

    for (const order of activeShift.orders) {
      if (order.status === 'CANCELLED') continue;
      const netTotal = order.total;
      if (order.paymentMethod === 'CASH') {
        salesCash += netTotal;
      } else if (order.paymentMethod === 'INSTAPAY') {
        salesInstaPay += netTotal;
      } else if (order.paymentMethod === 'VISA') {
        salesVisa += netTotal;
      } else if (order.paymentMethod === 'VODAFONE_CASH') {
        salesVodafoneCash += netTotal;
      } else if (order.paymentMethod === 'CASH_OUT') {
        const handedCash = order.cashOutAmount || netTotal;
        salesCashOut += handedCash;
        visaCashOutReceived += netTotal;
      }
    }

    for (const refund of activeShift.returns) {
      if (refund.paymentMethod === 'CASH') salesCash -= refund.refundAmount;
      else if (refund.paymentMethod === 'VISA') salesVisa -= refund.refundAmount;
      else if (refund.paymentMethod === 'INSTAPAY') salesInstaPay -= refund.refundAmount;
      else if (refund.paymentMethod === 'VODAFONE_CASH') salesVodafoneCash -= refund.refundAmount;
    }

    let cashTxImpact = 0;
    for (const tx of activeShift.transactions) {
      if (tx.reason?.startsWith('مرتجع فاتورة')) continue;
      if (tx.type === 'PAYIN') {
        cashTxImpact += tx.amount;
      } else if (tx.type === 'PAYOUT') {
        cashTxImpact -= tx.amount;
      }
    }

    const resultShift = {
      ...activeShift,
      expectedCash: activeShift.floatCash + salesCash - salesCashOut + cashTxImpact,
      expectedInstaPay: salesInstaPay,
      expectedVisa: salesVisa + visaCashOutReceived,
      expectedVodafoneCash: salesVodafoneCash,
      expectedCashOut: salesCashOut,
    };

    return NextResponse.json({ activeShift: resultShift });
  } catch (error) {
    console.error('GET active shift error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST open a new shift
export async function POST(request: Request) {
  try {
    const { userId, floatCash, cashierName } = await request.json();
    const normalizedCashierName = typeof cashierName === 'string' ? cashierName.trim() : '';

    if (!userId || !normalizedCashierName) {
      return NextResponse.json({ error: 'User ID and cashier name are required' }, { status: 400 });
    }

    // Check if there is already an active shift
    const existingActive = await prisma.shift.findFirst({
      where: { closedAt: null },
    });

    if (existingActive) {
      return NextResponse.json(
        { error: 'There is already an active shift running' },
        { status: 400 }
      );
    }

    const newShift = await prisma.$transaction(async (tx) => {
      await tx.savedCashierName.upsert({
        where: { name: normalizedCashierName },
        create: { name: normalizedCashierName },
        update: {},
      });
      return tx.shift.create({
        data: {
          userId,
          cashierName: normalizedCashierName,
          floatCash: parseFloat(floatCash) || 0,
          expectedCash: parseFloat(floatCash) || 0,
          expectedInstaPay: 0,
          expectedVisa: 0,
        },
      include: {
        user: {
          select: { id: true, name: true, username: true, role: true },
        },
      },
      });
    });

    return NextResponse.json({ shift: newShift });
  } catch (error) {
    console.error('POST open shift error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
