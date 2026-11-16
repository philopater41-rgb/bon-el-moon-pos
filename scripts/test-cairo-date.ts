import assert from 'node:assert/strict';
import { addCalendarDays, cairoDateKey, cairoDayStart } from '../src/lib/cairo-date';

assert.equal(cairoDayStart('2026-11-12').toISOString(), '2026-11-11T22:00:00.000Z');
assert.equal(cairoDayStart('2026-07-01').toISOString(), '2026-06-30T21:00:00.000Z');
assert.equal(cairoDateKey(new Date('2026-11-11T22:01:00Z')), '2026-11-12');
assert.equal(addCalendarDays('2026-03-01', -1), '2026-02-28');
assert.throws(() => cairoDayStart('2026-02-30'));
console.log('Cairo date boundaries passed');
