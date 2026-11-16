/** Revenue excludes the cash principal handed out in a cash-out transaction. */
export function salesRevenue(order: { paymentMethod: string; total: number; returnedAmount?: number | null; cashOutFee?: number | null }): number {
  if (order.paymentMethod === 'CASH_OUT') return order.cashOutFee || 0;
  return order.total - (order.returnedAmount || 0);
}
