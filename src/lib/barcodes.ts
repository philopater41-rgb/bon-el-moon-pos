import { prisma } from '@/lib/db';

/** null means the optional barcode migration has not been applied yet. */
export async function getBarcodes(): Promise<Map<string, string> | null> {
  try {
    const rows = await prisma.itemBarcode.findMany({ select: { itemId: true, barcode: true } });
    return new Map(rows.map(row => [row.itemId, row.barcode]));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021') return null;
    const message = error instanceof Error ? error.message : String(error);
    if (/ItemBarcode/i.test(message) && /(no such table|does not exist)/i.test(message)) return null;
    throw error;
  }
}
