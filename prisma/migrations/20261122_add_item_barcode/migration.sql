CREATE TABLE "ItemBarcode" (
  "itemId" TEXT NOT NULL PRIMARY KEY,
  "barcode" TEXT NOT NULL,
  CONSTRAINT "ItemBarcode_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ItemBarcode_barcode_key" ON "ItemBarcode"("barcode");
