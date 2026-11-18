import { useEffect, useReducer } from 'react'
import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts'
import { timeToLogical } from './timeIndex'

/** Maps (time, price) to pixels in the main price pane and re-renders whenever the viewport can have changed. */
export function useProjection(chart: IChartApi, series: ISeriesApi<SeriesType>, times: number[], layoutKey: string) {
  const [, redraw] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    let raf = 0
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(redraw) }
    const ts = chart.timeScale(), el = chart.chartElement(), ro = new ResizeObserver(schedule)
    ts.subscribeVisibleLogicalRangeChange(schedule); chart.subscribeCrosshairMove(schedule); ro.observe(el)
    el.addEventListener('pointermove', schedule, true); el.addEventListener('wheel', schedule, true)
    return () => { cancelAnimationFrame(raf); ts.unsubscribeVisibleLogicalRangeChange(schedule); chart.unsubscribeCrosshairMove(schedule)
      ro.disconnect(); el.removeEventListener('pointermove', schedule, true); el.removeEventListener('wheel', schedule, true) }
  }, [chart])
  useEffect(() => { requestAnimationFrame(redraw) }, [layoutKey, times.length])

  const ts = chart.timeScale()
  const w = ts.width(), h = chart.panes()[0]?.getHeight() ?? 0
  const xOf = (t: number) => { // the chart only converts whole bar indices; interpolate between neighbours
    const l = timeToLogical(t, times), i = Math.floor(l)
    const c0 = ts.logicalToCoordinate(i as Logical), c1 = ts.logicalToCoordinate((i + 1) as Logical)
    return c0 === null || c1 === null ? -1e4 : c0 + (l - i) * (c1 - c0)
  }
  const yOf = (p: number) => series.priceToCoordinate(p) ?? -1e4
  const barW = Math.max(1, (ts.logicalToCoordinate(1 as Logical) ?? 1) - (ts.logicalToCoordinate(0 as Logical) ?? 0))
  return { ts, w, h, xOf, yOf, barW }
}
