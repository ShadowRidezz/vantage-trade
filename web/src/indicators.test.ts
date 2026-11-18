// Run: node src/indicators.test.ts
import assert from 'node:assert/strict'
import { sma, ema, rsi, macd, vwap, sessionKey } from './indicators.ts'
import { timeToLogical, logicalToTime } from './timeIndex.ts'

assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
assert.deepEqual(ema([2, 4, 6, 8], 2), [null, 3, 5, 7])

// Wilder RSI, hand-computed for n=2 on alternating +1/-1 moves
assert.deepEqual(rsi([1, 2, 1, 2, 1], 2), [null, null, 50, 75, 37.5])
assert.equal(rsi([1, 2, 3, 4, 5, 6], 3).at(-1), 100)
assert.equal(rsi([6, 5, 4, 3, 2, 1], 3).at(-1), 0)

const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.1)
const m = macd(closes), f = ema(closes, 12), s = ema(closes, 26)
assert.equal(m.line[24], null)
assert.ok(Math.abs(m.line[40]! - (f[40]! - s[40]!)) < 1e-9)
assert.equal(m.signal[32], null) // signal needs 9 MACD values: first at index 25 + 8 = 33
assert.notEqual(m.signal[33], null)
assert.ok(Math.abs(m.hist[50]! - (m.line[50]! - m.signal[50]!)) < 1e-9)

// VWAP: session resets at 18:00 New York (futures open)
const t0 = Date.UTC(2026, 10, 16, 15, 0) / 1000 // 10:00 ET Monday
const b = (time: number, h: number, l: number, c: number, volume: number) => ({ time, open: c, high: h, low: l, close: c, volume })
const v = vwap([b(t0, 3, 1, 2, 1), b(t0 + 60, 6, 2, 4, 3), b(t0 + 9 * 3600, 10, 10, 10, 2)]) // 19:00 ET = new session
assert.deepEqual(v, [2, 3.5, 10])
assert.notEqual(sessionKey(t0), sessionKey(t0 + 9 * 3600))

// time <-> logical index, including extrapolation past the last bar
const times = [100, 200, 300, 500]
assert.equal(timeToLogical(250, times), 1.5)
assert.equal(timeToLogical(700, times), 4)
assert.equal(timeToLogical(0, times), -1)
assert.equal(logicalToTime(1.5, times), 250)
assert.equal(logicalToTime(4, times), 700)

console.log('indicators: all tests passed')
