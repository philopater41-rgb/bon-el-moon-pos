import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createBarcodeScanner } from '../src/lib/barcode-scanner';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('scan without Enter completes once after the scanner becomes idle', async () => {
  const scans: string[] = [];
  const scanner = createBarcodeScanner(value => scans.push(value));
  for (const key of '0012345678') scanner.feed(key);
  await pause(320);
  assert.deepEqual(scans, ['0012345678']);
  assert.equal(scanner.feed('Enter'), true);
  await pause(300);
  assert.equal(scans.length, 1);
  scanner.cancel();
});

test('scan with Enter completes immediately and does not fire twice', async () => {
  const scans: string[] = [];
  const scanner = createBarcodeScanner(value => scans.push(value));
  for (const key of '123456') scanner.feed(key);
  assert.equal(scanner.feed('Enter'), true);
  assert.deepEqual(scans, ['123456']);
  await pause(320);
  assert.equal(scans.length, 1);
  scanner.cancel();
});

test('slow or cancelled input is not treated as a complete scan', async () => {
  const scans: string[] = [];
  const scanner = createBarcodeScanner(value => scans.push(value));
  scanner.feed('1', 1000);
  scanner.feed('2', 1200);
  scanner.feed('3', 1400);
  await pause(320);
  assert.deepEqual(scans, []);
  for (const key of '12345') scanner.feed(key);
  scanner.cancel();
  await pause(320);
  assert.deepEqual(scans, []);
});

test('back-to-back scans are both kept when the next scan starts before the idle timer', async () => {
  const scans: string[] = [];
  const scanner = createBarcodeScanner(value => scans.push(value));
  for (const key of '12345') scanner.feed(key);
  await pause(130);
  for (const key of '67890') scanner.feed(key);
  await pause(320);
  assert.deepEqual(scans, ['12345', '67890']);
  scanner.cancel();
});
