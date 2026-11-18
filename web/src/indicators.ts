// Pure indicator math. Output arrays align 1:1 with input; null = not enough data yet.
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number }
type Out = (number | null)[]

export function sma(v: number[], n: number): Out {
  let sum = 0
  return v.map((x, i) => { sum += x; if (i >= n) sum -= v[i - n]; return i >= n - 1 ? sum / n : null })
}

/** EMA seeded with the SMA of the first n values (standard convention). */
export function ema(v: number[], n: number): Out {
  const k = 2 / (n + 1), out: Out = []
  let prev: number | null = null
  v.forEach((x, i) => {
    if (i < n - 1) out.push(null)
    else if (prev === null) out.push(prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n)
    else out.push(prev = x * k + prev * (1 - k))
  })
  return out
}

/** Wilder's RSI. */
export function rsi(c: number[], n = 14): Out {
  const out: Out = [null]
  let g = 0, l = 0
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0)
    if (i <= n) { g += up / n; l += dn / n }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n }
    out.push(i < n ? null : l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l))
  }
  return out.slice(0, c.length)
}

export function macd(c: number[], fast = 12, slow = 26, sig = 9) {
  const f = ema(c, fast), s = ema(c, slow)
  const line: Out = c.map((_, i) => f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null)
  const start = line.findIndex((x) => x !== null)
  const sigPart = start < 0 ? [] : ema(line.slice(start) as number[], sig)
  const signal: Out = line.map((_, i) => (start < 0 || i < start ? null : sigPart[i - start]))
  const hist: Out = line.map((m, i) => (m !== null && signal[i] !== null ? m - signal[i]! : null))
  return { line, signal, hist }
}

/** Trading-session date in New York; +6h rolls the 18:00 ET futures open into the next day. */
const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
export const sessionKey = (t: number) => nyDate.format(new Date((t + 6 * 3600) * 1000))

/** Session-anchored VWAP using typical price (H+L+C)/3. */
export function vwap(bars: Bar[]): Out {
  let key = '', pv = 0, vol = 0
  return bars.map((b) => {
    const k = sessionKey(b.time)
    if (k !== key) { key = k; pv = 0; vol = 0 }
    pv += ((b.high + b.low + b.close) / 3) * b.volume; vol += b.volume
    return vol > 0 ? pv / vol : null
  })
}
