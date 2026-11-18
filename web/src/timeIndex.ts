// Drawings store real timestamps; the chart works in bar indices. These map between the two,
// interpolating inside the data and extrapolating with the edge bar spacing outside it.
export function timeToLogical(t: number, times: number[]): number {
  const n = times.length
  if (n < 2) return 0
  if (t <= times[0]) return (t - times[0]) / (times[1] - times[0])
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / (times[n - 1] - times[n - 2])
  let lo = 0, hi = n - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid }
  return lo + (t - times[lo]) / (times[hi] - times[lo])
}

export function logicalToTime(l: number, times: number[]): number {
  const n = times.length
  if (n < 2) return times[0] ?? 0
  if (l <= 0) return times[0] + l * (times[1] - times[0])
  if (l >= n - 1) return times[n - 1] + (l - n + 1) * (times[n - 1] - times[n - 2])
  const i = Math.floor(l)
  return times[i] + (l - i) * (times[i + 1] - times[i])
}
