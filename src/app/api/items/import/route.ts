import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { getBarcodes } from '@/lib/barcodes';

const aliases: Record<string, string[]> = {
  name: ['اسم المنتج', 'اسم الصنف', 'الصنف', 'المنتج', 'product', 'product name', 'item', 'item name', 'name'],
  category: ['القسم', 'التصنيف', 'الفئة', 'المجموعة', 'category', 'category name', 'section'],
  price: ['سعر البيع', 'السعر', 'سعر', 'price', 'selling price', 'sale price'],
  cost: ['التكلفة', 'سعر التكلفة', 'تكلفة', 'cost', 'cost price'],
  barcode: ['الباركود', 'باركود', 'كود', 'barcode', 'bar code', 'sku'],
};
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const text = (v: ExcelJS.Cell) => v.text.trim();
export async function GET() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('المنتجات', { views: [{ rightToLeft: true }] });
  sheet.addRow(['اسم المنتج', 'القسم', 'سعر البيع', 'التكلفة', 'الباركود']);
  sheet.getColumn(5).numFmt = '@';
  sheet.columns.forEach(column => { column.width = 22; });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer as BodyInit, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="products-template.xlsx"' } });
}
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    const commit = form.get('commit') === 'true';
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.xlsx') || file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'اختر ملف Excel بصيغة xlsx وحجمه لا يتجاوز 5 ميجابايت.' }, { status: 400 });
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer() as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount > 5001 || sheet.columnCount > 100) return NextResponse.json({ error: 'الملف فارغ أو يتجاوز 5000 صف.' }, { status: 400 });
    const headers: Record<string, number> = {};
    let ambiguousCategory = 0;
    sheet.getRow(1).eachCell((cell, number) => {
      const label = normalize(text(cell));
      if (label === 'الصنف') { ambiguousCategory = number; return; }
      const key = Object.keys(aliases).find(k => aliases[k].includes(label));
      if (key && !headers[key]) headers[key] = number;
    });
    if (ambiguousCategory) {
      if (headers.name && !headers.category) headers.category = ambiguousCategory;
      else if (!headers.name) headers.name = ambiguousCategory;
    }
    if (!headers.name || !headers.category || !headers.price) return NextResponse.json({ error: 'يجب أن يحتوي الصف الأول على أعمدة: اسم المنتج، القسم، سعر البيع. التكلفة والباركود اختياريان.' }, { status: 400 });
    const rows: Array<{ row: number; name: string; categoryName: string; price: number; cost: number; barcode: string | null }> = [];
    const errors: string[] = [];
    const seenBarcode = new Set<string>();
    const seenName = new Set<string>();
    for (let n = 2; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n);
      const name = text(row.getCell(headers.name));
      const categoryName = text(row.getCell(headers.category));
      const priceText = text(row.getCell(headers.price));
      const costText = headers.cost ? text(row.getCell(headers.cost)) : '';
      const barcode = headers.barcode ? text(row.getCell(headers.barcode)) || null : null;
      if (!name && !categoryName && !priceText && !costText && !barcode) continue;
      const price = Number(priceText); const cost = costText ? Number(costText) : 0;
      if (!name || !categoryName || !priceText || !Number.isFinite(price) || price < 0 || !Number.isFinite(cost) || cost < 0 || (barcode && barcode.length > 100)) { errors.push(`الصف ${n}: تأكد من الاسم والقسم والسعر والتكلفة.`); continue; }
      const key = `${normalize(categoryName)}\u0000${normalize(name)}`;
      if (seenName.has(key)) { errors.push(`الصف ${n}: الصنف مكرر داخل الملف.`); continue; }
      if (barcode && seenBarcode.has(barcode)) { errors.push(`الصف ${n}: الباركود مكرر داخل الملف.`); continue; }
      seenName.add(key); if (barcode) seenBarcode.add(barcode);
      rows.push({ row: n, name, categoryName, price, cost, barcode });
    }
    if (!rows.length && !errors.length) errors.push('لا توجد أصناف في الملف.');
    const existing = await prisma.item.findMany({ select: { name: true, category: { select: { name: true } } } });
    const existingNames = new Set(existing.map(i => `${normalize(i.category.name)}\u0000${normalize(i.name)}`));
    const barcodeMap = await getBarcodes();
    if (!barcodeMap && rows.some(row => row.barcode)) return NextResponse.json({ error: 'يلزم تجهيز قاعدة البيانات لدعم الباركود أولاً.' }, { status: 503 });
    const existingCodes = new Set(barcodeMap ? Array.from(barcodeMap.values()) : []);
    for (const row of rows) {
      if (existingNames.has(`${normalize(row.categoryName)}\u0000${normalize(row.name)}`)) errors.push(`الصف ${row.row}: الصنف موجود بالفعل في هذا القسم.`);
      if (row.barcode && existingCodes.has(row.barcode)) errors.push(`الصف ${row.row}: الباركود مستخدم لصنف آخر.`);
    }
    if (commit && errors.length) return NextResponse.json({ errors, rows }, { status: 400 });
    if (commit) {
      await prisma.$transaction(async tx => {
        const categoryIds = new Map<string, string>();
        for (const name of new Set(rows.map(row => row.categoryName))) {
          const category = await tx.category.upsert({ where: { name }, update: { isActive: true }, create: { name } });
          categoryIds.set(name, category.id);
        }
        const existingInTransaction = await tx.item.findMany({
          where: { categoryId: { in: Array.from(categoryIds.values()) } },
          select: { name: true, categoryId: true },
        });
        const keys = new Set(existingInTransaction.map(item => `${item.categoryId}\u0000${normalize(item.name)}`));
        const items = rows.map(row => ({ id: randomUUID(), name: row.name, categoryId: categoryIds.get(row.categoryName)!, price: row.price, cost: row.cost }));
        for (const item of items) if (keys.has(`${item.categoryId}\u0000${normalize(item.name)}`)) throw new Error(`الصنف ${item.name} موجود بالفعل.`);
        const barcodes = rows.flatMap((row, index) => row.barcode ? [{ itemId: items[index].id, barcode: row.barcode }] : []);
        for (let start = 0; start < items.length; start += 500) await tx.item.createMany({ data: items.slice(start, start + 500) });
        for (let start = 0; start < barcodes.length; start += 500) await tx.itemBarcode.createMany({ data: barcodes.slice(start, start + 500) });
      }, { timeout: 120000 });
    }
    return NextResponse.json({ rows, errors, imported: commit ? rows.length : 0 });
  } catch (error) {
    console.error('Import items error:', error);
    return NextResponse.json({ error: 'تعذر قراءة أو استيراد الملف. تأكد من صحة الملف وعدم تكرار الباركود.' }, { status: 400 });
  }
}
