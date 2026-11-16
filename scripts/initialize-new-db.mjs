import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const url = process.env.DATABASE_URL || '';
if (!url.startsWith('file:')) throw new Error('Initial setup is restricted to a newly created local SQLite database.');
const filePath = url.slice(5);
if (existsSync(filePath)) throw new Error('Database already exists. Initial setup refused.');
const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('Initial schema file is required.');
const client = createClient({ url });
try { await client.executeMultiple(await readFile(schemaPath, 'utf8')); } finally { client.close(); }
const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
try {
  await prisma.$transaction(async tx => {
    if (await tx.user.count() || await tx.hall.count() || await tx.salesOrder.count()) {
      throw new Error('Database is not empty. Initial setup refused.');
    }
    const hash = password => createHash('sha256').update(password).digest('hex');
    await tx.user.createMany({ data: [
      { username: 'admin', password: hash('admin123'), name: 'BON el MOON Admin', role: 'ADMIN' },
      { username: 'cashier', password: hash('cashier123'), name: 'Cashier', role: 'CASHIER' },
    ] });
    await tx.hall.create({ data: { name: 'Main Hall', tables: { create: [1, 2, 3, 4].map(n => ({ name: `Table ${n}`, status: 'VACANT' })) } } });
  });
} finally { await prisma.$disconnect(); }
