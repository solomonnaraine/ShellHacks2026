import { useEffect, useMemo, useRef } from 'react'
import { ColorType, LineStyle, createChart } from 'lightweight-charts'
import { formatPrice, payoffCurve, pricePath } from './marketSeries'

export function PriceChart({ node }) {
  const wrapRef = useRef(null)
  const series = useMemo(() => (node ? pricePath(node.ticker) : null), [node])

  useEffect(() => {
    const element = wrapRef.current
    if (!element || !series) return undefined
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#334155',
        fontSize: 12,
        fontFamily: 'Inter, Segoe UI, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: '#f1f5f9' },
        horzLines: { color: '#f1f5f9' },
      },
      rightPriceScale: { borderColor: '#e2e8f0' },
      timeScale: { borderColor: '#e2e8f0', fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        vertLine: { color: '#0284c7', labelBackgroundColor: '#0284c7' },
        horzLine: { color: '#0284c7', labelBackgroundColor: '#0284c7' },
      },
    })
    const price = chart.addAreaSeries({
      lineColor: '#0284c7',
      topColor: 'rgba(2, 132, 199, 0.28)',
      bottomColor: 'rgba(2, 132, 199, 0.02)',
      lineWidth: 2,
      priceLineColor: '#0284c7',
    })
    const bandOptions = {
      color: 'rgba(2, 132, 199, 0.55)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }
    const upper = chart.addLineSeries(bandOptions)
    const lower = chart.addLineSeries(bandOptions)
    price.setData(series.closes)
    upper.setData(series.upper)
    lower.setData(series.lower)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [series])

  if (!node || !series) {
    return (
      <div className="grid h-full place-items-center px-4 text-xs text-slate-600">
        Select a node to plot its price path and volatility band.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline justify-between gap-3 px-3 py-1.5">
        <p className="font-sans text-xs font-semibold text-slate-700">
          {node.ticker} · {node.commodity}
        </p>
        <p className="text-xs font-semibold text-slate-800">
          {formatPrice(series.last)} · vol {(series.realizedVol * 100).toFixed(1)}%
        </p>
      </div>
      <div ref={wrapRef} className="min-h-0 flex-1" />
    </div>
  )
}

export function PayoffDiagram({ node, strategy }) {
  const series = useMemo(() => (node ? pricePath(node.ticker) : null), [node])
  if (!node || !series) {
    return (
      <div className="grid h-full place-items-center px-4 text-xs text-slate-600">
        Select a node to plot the options payoff.
      </div>
    )
  }

  const points = payoffCurve(strategy, series.last)
  const width = 720
  const height = 240
  const pad = { left: 56, right: 16, top: 16, bottom: 28 }
  const prices = points.map((point) => point.price)
  const pnls = points.map((point) => point.pnl)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const minPnl = Math.min(...pnls, 0)
  const maxPnl = Math.max(...pnls, 0)
  const xFor = (price) =>
    pad.left + ((price - minPrice) / (maxPrice - minPrice)) * (width - pad.left - pad.right)
  const yFor = (pnl) =>
    pad.top + ((maxPnl - pnl) / (maxPnl - minPnl || 1)) * (height - pad.top - pad.bottom)
  const path = points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L'
      return `${command}${xFor(point.price).toFixed(1)},${yFor(point.pnl).toFixed(1)}`
    })
    .join(' ')
  const zero = yFor(0)
  const spotX = xFor(series.last)
  const strikeNote =
    strategy === 'Long Straddle'
      ? `ATM ${formatPrice(series.last)}`
      : `${formatPrice(series.last * 0.92)} / ${formatPrice(series.last * 1.08)}`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline justify-between gap-3 px-3 py-1.5">
        <p className="font-sans text-xs font-semibold text-slate-700">
          {strategy} · {node.ticker}
        </p>
        <p className="text-xs font-semibold text-slate-800">{strikeNote}</p>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-h-0 w-full flex-1"
        role="img"
        aria-label={`${strategy} payoff for ${node.ticker}`}
      >
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={zero}
          y2={zero}
          stroke="#e2e8f0"
        />
        <line
          x1={spotX}
          x2={spotX}
          y1={pad.top}
          y2={height - pad.bottom}
          stroke="#bae6fd"
          strokeDasharray="4 3"
        />
        <path d={path} fill="none" stroke="#0284c7" strokeWidth="2.25" />
        <text x={pad.left} y={height - 8} fill="#475569" fontSize="10" fontFamily="Inter, Segoe UI, sans-serif">
          {formatPrice(minPrice)}
        </text>
        <text
          x={spotX}
          y={height - 8}
          fill="#0284c7"
          fontSize="10"
          fontFamily="Inter, Segoe UI, sans-serif"
          textAnchor="middle"
        >
          spot
        </text>
        <text
          x={width - pad.right}
          y={height - 8}
          fill="#475569"
          fontSize="10"
          fontFamily="Inter, Segoe UI, sans-serif"
          textAnchor="end"
        >
          {formatPrice(maxPrice)}
        </text>
        <text x={4} y={pad.top + 8} fill="#475569" fontSize="10" fontFamily="Inter, Segoe UI, sans-serif">
          {formatPrice(maxPnl)}
        </text>
        <text x={4} y={zero + 4} fill="#475569" fontSize="10" fontFamily="Inter, Segoe UI, sans-serif">
          0
        </text>
      </svg>
    </div>
  )
}
