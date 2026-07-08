import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRange, encodeRange } from './date-range';
import { resolveRangeWithCookie } from './resolve-range';

test('encodeRange / decodeRange round-trip', () => {
  const r = { from: '2025-01-01', to: '2025-03-31' };
  assert.equal(encodeRange(r), '2025-01-01_2025-03-31');
  assert.deepEqual(decodeRange(encodeRange(r)), r);
});

test('decodeRange rejects invalid values', () => {
  assert.equal(decodeRange(undefined), null);
  assert.equal(decodeRange(''), null);
  assert.equal(decodeRange('not-a-date'), null);
  assert.equal(decodeRange('2025-13-01_2025-03-31'), null);
  assert.equal(decodeRange('2025-03-31_2025-01-01'), null);
});

test('resolveRangeWithCookie prefers URL params over cookie', () => {
  const url = { from: '2025-06-01', to: '2025-06-30' };
  const cookie = encodeRange({ from: '2025-01-01', to: '2025-01-31' });
  assert.deepEqual(resolveRangeWithCookie(url, cookie, 90), url);
});

test('resolveRangeWithCookie falls back to cookie when URL invalid', () => {
  const cookie = encodeRange({ from: '2025-02-01', to: '2025-02-28' });
  assert.deepEqual(resolveRangeWithCookie({}, cookie, 90), { from: '2025-02-01', to: '2025-02-28' });
  assert.deepEqual(resolveRangeWithCookie({ from: 'bad', to: '2025-02-28' }, cookie, 90), {
    from: '2025-02-01',
    to: '2025-02-28',
  });
});

test('resolveRangeWithCookie falls back to default when URL and cookie invalid', () => {
  const r = resolveRangeWithCookie({}, undefined, 7);
  assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r.from <= r.to);
});
