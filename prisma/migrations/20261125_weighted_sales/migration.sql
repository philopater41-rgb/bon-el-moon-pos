ALTER TABLE "SalesOrderItem" ALTER COLUMN "qty" TYPE DOUBLE PRECISION USING "qty"::double precision;
ALTER TABLE "OrderReturnItem" ALTER COLUMN "quantity" TYPE DOUBLE PRECISION USING "quantity"::double precision;
