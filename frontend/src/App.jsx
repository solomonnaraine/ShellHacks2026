import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import nodes from './data/nodes.json'
import './App.css'

const TYPE_COLORS = {
  'Extraction Site': '#1E3A8A',
  'LNG Terminal': '#0369A1',
  'Grain Hub': '#0F766E',
  Refinery: '#1D4ED8',
  'Choke Point': '#C2410C',
}

const TYPE_BADGES = {
  'Extraction Site': 'bg-sky-50 text-sky-700 border border-sky-200/60',
  'LNG Terminal': 'bg-cyan-50 text-cyan-700 border border-cyan-200/60',
  'Grain Hub': 'bg-lime-50 text-lime-700 border border-lime-200/60',
  Refinery: 'bg-violet-50 text-violet-700 border border-violet-200/60',
  'Choke Point': 'bg-amber-50 text-amber-700 border border-amber-200/60',
}

const FILTERS = ['All', ...Object.keys(TYPE_COLORS)]
const STRATEGIES = ['Short Strangle', 'Long Straddle']

const iconCache = new Map()

function markerIcon(type, active) {
  const color = TYPE_COLORS[type] ?? '#1E3A8A'
  const key = `${color}:${active ? 'on' : 'off'}`
  const cached = iconCache.get(key)
  if (cached) return cached

  const size = active ? 18 : 12
  const icon = L.divIcon({
    className: 'node-marker',
    html: `<span class="node-marker__dot${active ? ' is-active' : ''}" style="background:${color};width:${size}px;height:${size}px"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2) - 2],
  })
  iconCache.set(key, icon)
  return icon
}

function formatCoordinate(value, positive, negative) {
  const hemisphere = value >= 0 ? positive : negative
  return `${Math.abs(value).toFixed(2)}° ${hemisphere}`
}

function FocusNode({ node }) {
  const map = useMap()

  useEffect(() => {
    if (!node) return
    const zoom = Math.max(map.getZoom(), 4)
    map.flyTo([node.lat, node.lng], zoom, { duration: 0.65 })
  }, [map, node])

  return null
}

function MapBridge({ mapRef }) {
  const map = useMap()

  useEffect(() => {
    mapRef.current = map
    const parent = map.getContainer().parentElement
    const fit = () => {
      const container = map.getContainer()
      if (!parent) return
      container.style.width = `${parent.clientWidth}px`
      container.style.height = `${parent.clientHeight}px`
      map.invalidateSize()
    }
    fit()
    const observer = new ResizeObserver(fit)
    if (parent) observer.observe(parent)
    return () => observer.disconnect()
  }, [map, mapRef])

  return null
}

function App() {
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('All')
  const [selectedId, setSelectedId] = useState(null)
  const [leftPct, setLeftPct] = useState(70)
  const [targetTicker, setTargetTicker] = useState('')
  const [strategy, setStrategy] = useState(STRATEGIES[0])
  const [dte, setDte] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [budget, setBudget] = useState('')
  const [formError, setFormError] = useState('')
  const [backtestRequest, setBacktestRequest] = useState(null)

  const listRef = useRef(null)
  const markerRefs = useRef({})
  const splitRef = useRef(null)
  const mapRef = useRef(null)
  const dragging = useRef(false)
  const leftPctRef = useRef(70)
  const tickerInputRef = useRef(null)
  const backtesterRef = useRef(null)

  const typeCounts = useMemo(() => {
    const tally = {}
    for (const node of nodes) {
      tally[node.type] = (tally[node.type] ?? 0) + 1
    }
    return tally
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return nodes.filter((node) => {
      if (typeFilter !== 'All' && node.type !== typeFilter) return false
      if (!needle) return true
      return [node.name, node.commodity, node.ticker, node.type]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [query, typeFilter])

  const selected = nodes.find((node) => node.id === selectedId) ?? null

  useEffect(() => {
    if (!selected || !listRef.current) return
    const row = listRef.current.querySelector(`[data-id="${selected.id}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  useEffect(() => {
    if (!selected) return
    markerRefs.current[selected.id]?.openPopup()
  }, [selected])

  const applySplit = (clientX) => {
    const split = splitRef.current
    if (!split) return
    const rect = split.getBoundingClientRect()
    const divider = 10
    const minLeft = Math.min(480, rect.width * 0.45)
    const maxLeft = rect.width - 300 - divider
    const nextPx = Math.min(maxLeft, Math.max(minLeft, clientX - rect.left))
    const nextPct = (nextPx / rect.width) * 100
    leftPctRef.current = nextPct
    split.style.setProperty('--left', `${nextPct}%`)
    mapRef.current?.invalidateSize()
  }

  const selectNode = (node) => {
    setSelectedId(node.id)
    setTargetTicker(node.ticker)
    setFormError('')
    backtesterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => tickerInputRef.current?.focus(), 250)
  }

  const runBacktest = () => {
    const ticker = targetTicker.trim().toUpperCase()
    const dteValue = Number(dte)
    const budgetValue = Number(budget)
    if (!ticker) {
      setFormError('Enter a target ticker before running the backtest.')
      setBacktestRequest(null)
      return
    }
    if (!Number.isInteger(dteValue) || dteValue <= 0) {
      setFormError('DTE must be a whole number of days greater than zero.')
      setBacktestRequest(null)
      return
    }
    if ((startDate && !endDate) || (!startDate && endDate)) {
      setFormError('Enter both a start date and an end date, or leave both blank.')
      setBacktestRequest(null)
      return
    }
    if (startDate && endDate && endDate < startDate) {
      setFormError('The end date must be on or after the start date.')
      setBacktestRequest(null)
      return
    }
    if (!Number.isFinite(budgetValue) || budgetValue <= 0) {
      setFormError('Budget must be a USD amount greater than zero.')
      setBacktestRequest(null)
      return
    }
    setFormError('')
    setTargetTicker(ticker)
    setBacktestRequest({
      ticker,
      strategy,
      dte: dteValue,
      startDate,
      endDate,
      budget: budgetValue,
    })
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between bg-white border-b border-slate-200/80 px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="bg-emerald-500 animate-pulse h-2 w-2 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.85)]" />
          <h1 className="text-sm font-semibold tracking-[0.14em] text-slate-900">
            HEDGEHACKS / TERMINAL
          </h1>
        </div>
        <p className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
          {nodes.length} nodes · {Object.keys(typeCounts).length} classes
        </p>
      </header>

      <div className="split flex min-h-0 flex-1" ref={splitRef}>
        <section className="left-panel" aria-label="Map and asset book">
          <div className="map-stage">
            <MapContainer
              center={[20, 10]}
              zoom={2}
              minZoom={2}
              worldCopyJump
              zoomControl
              className="commodity-map"
              style={{ width: '100%', height: '100%' }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapBridge mapRef={mapRef} />
              <FocusNode node={selected} />
              {nodes.map((node) => (
                <Marker
                  key={node.id}
                  position={[node.lat, node.lng]}
                  icon={markerIcon(node.type, node.id === selectedId)}
                  zIndexOffset={node.id === selectedId ? 1000 : 0}
                  ref={(instance) => {
                    if (instance) markerRefs.current[node.id] = instance
                  }}
                  eventHandlers={{
                    click: () => selectNode(node),
                  }}
                >
                  <Popup>
                    <div className="min-w-[180px]">
                      <strong className="block text-sm font-semibold text-slate-900">
                        {node.name}
                      </strong>
                      <p className="mt-1 text-xs text-slate-500">{node.type}</p>
                      <p className="text-emerald-600 font-mono text-sm font-semibold">
                        {node.commodity} · {node.ticker}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatCoordinate(node.lat, 'N', 'S')},{' '}
                        {formatCoordinate(node.lng, 'E', 'W')}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
            <div className="absolute bottom-3 left-3 z-[500] flex flex-col gap-1.5 rounded-2xl border border-slate-200/80 bg-white/90 p-3 shadow-sm backdrop-blur-sm">
              <p className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                Node types
              </p>
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <div className="flex items-center gap-2 text-xs text-slate-700" key={type}>
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: color }}
                  />
                  <span>
                    {type} · {typeCounts[type] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="asset-dock flex min-h-0 flex-col px-3 pb-3 pt-2">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              <div className="flex flex-col gap-2.5 border-b border-slate-100 px-3 py-3">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name, commodity, or ticker"
                  aria-label="Search commodity nodes"
                  className="h-9 w-full rounded-full border border-slate-200/80 bg-slate-50 px-4 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
                />
                <div
                  className="flex items-center gap-1 overflow-x-auto bg-slate-100/80 p-1 rounded-full border border-slate-200/80"
                  role="tablist"
                  aria-label="Filter by asset type"
                >
                  {FILTERS.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setTypeFilter(filter)}
                      className={
                        filter === typeFilter
                          ? 'bg-slate-900 text-white shadow-sm rounded-full px-4 py-1.5 text-xs font-medium whitespace-nowrap'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 rounded-full px-4 py-1.5 text-xs font-medium transition-all whitespace-nowrap'
                      }
                    >
                      {filter === 'All' ? `All ${nodes.length}` : filter}
                    </button>
                  ))}
                </div>
              </div>

              {filtered.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-500">No assets match this search.</p>
              ) : (
                <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
                  <table className="w-full border-collapse text-left">
                    <thead className="sticky top-0 bg-white">
                      <tr>
                        {['Asset', 'Type', 'Commodity', 'Ticker', 'Coordinates'].map((heading) => (
                          <th
                            key={heading}
                            className="text-[11px] font-mono uppercase tracking-wider text-slate-400 py-3 px-4 text-left font-medium"
                          >
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filtered.map((node) => (
                        <tr
                          key={node.id}
                          data-id={node.id}
                          tabIndex={0}
                          onClick={() => selectNode(node)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              selectNode(node)
                            }
                          }}
                          className={`hover:bg-slate-50/80 transition-colors cursor-pointer ${
                            node.id === selectedId ? 'bg-emerald-50/60' : ''
                          }`}
                        >
                          <td className="py-3 px-4 text-sm font-medium text-slate-900">
                            {node.name}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`rounded-full text-[11px] px-2 py-0.5 ${TYPE_BADGES[node.type] ?? ''}`}
                            >
                              {node.type}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-sm text-slate-600">{node.commodity}</td>
                          <td className="py-3 px-4 text-emerald-600 font-mono text-sm font-semibold">
                            {node.ticker}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-500">
                            {node.lat.toFixed(2)}, {node.lng.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          className="divider relative w-2.5 shrink-0 cursor-col-resize bg-slate-200/80"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={45}
          aria-valuemax={80}
          aria-valuenow={Math.round(leftPct)}
          aria-label="Resize map and backtester panels"
          tabIndex={0}
          onPointerDown={(event) => {
            dragging.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            document.body.style.userSelect = 'none'
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return
            applySplit(event.clientX)
          }}
          onPointerUp={(event) => {
            if (!dragging.current) return
            dragging.current = false
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            document.body.style.userSelect = ''
            setLeftPct(leftPctRef.current)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            const delta = event.key === 'ArrowLeft' ? -2 : 2
            const split = splitRef.current
            if (!split) return
            const rect = split.getBoundingClientRect()
            const next = leftPctRef.current + delta
            applySplit(rect.left + (next / 100) * rect.width)
            setLeftPct(leftPctRef.current)
          }}
        />

        <aside className="right-panel overflow-auto bg-slate-50 p-4" aria-label="Active node and backtester">
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <p className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
              {selected ? selected.type : 'Active node'}
            </p>
            <h2 className="mt-1 text-2xl font-bold text-slate-900 tracking-tight">
              {selected ? selected.name : 'Choose a node'}
            </h2>
            {selected ? (
              <dl className="mt-5 grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Commodity
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-slate-900">{selected.commodity}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Ticker
                  </dt>
                  <dd className="mt-1 text-emerald-600 font-mono text-sm font-semibold">
                    {selected.ticker}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Latitude
                  </dt>
                  <dd className="mt-1 text-emerald-600 font-mono text-sm font-semibold">
                    {formatCoordinate(selected.lat, 'N', 'S')}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Longitude
                  </dt>
                  <dd className="mt-1 text-emerald-600 font-mono text-sm font-semibold">
                    {formatCoordinate(selected.lng, 'E', 'W')}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-slate-500">
                Select a marker or a table row to load coordinates and the benchmark ticker.
              </p>
            )}
          </section>

          <section className="mt-4 flex flex-col gap-3" ref={backtesterRef}>
            <h2 className="px-1 text-[10px] font-mono tracking-widest text-slate-400 uppercase">
              Quantitative options backtester
            </h2>
            <form
              className="flex flex-col gap-3 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"
              onSubmit={(event) => {
                event.preventDefault()
                runBacktest()
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                  Target ticker
                </span>
                <input
                  ref={tickerInputRef}
                  value={targetTicker}
                  onChange={(event) => setTargetTicker(event.target.value)}
                  placeholder="CL=F"
                  aria-label="Target Ticker"
                  className="h-10 rounded-xl border border-slate-200/80 bg-slate-50 px-3 text-emerald-600 font-mono text-sm font-semibold outline-none focus:border-slate-300 focus:bg-white"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                  Strategy
                </span>
                <select
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value)}
                  aria-label="Strategy"
                  className="h-10 rounded-xl border border-slate-200/80 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                >
                  {STRATEGIES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    DTE
                  </span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={dte}
                    onChange={(event) => setDte(event.target.value)}
                    placeholder="30"
                    aria-label="DTE"
                    className="h-10 rounded-xl border border-slate-200/80 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Budget ($USD)
                  </span>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    placeholder="10000"
                    aria-label="Budget in USD"
                    className="h-10 rounded-xl border border-slate-200/80 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Start date
                  </span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    aria-label="Start date"
                    className="h-10 rounded-xl border border-slate-200/80 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    End date
                  </span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    aria-label="End date"
                    className="h-10 rounded-xl border border-slate-200/80 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-slate-300 focus:bg-white"
                  />
                </label>
              </div>
              {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}
              <button
                type="submit"
                className="h-11 rounded-full bg-slate-900 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-800"
              >
                Run backtest
              </button>
            </form>

            {backtestRequest ? (
              <p className="rounded-2xl border border-slate-200/80 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                Awaiting backend integration for{' '}
                <span className="text-emerald-600 font-mono text-sm font-semibold">
                  {backtestRequest.ticker}
                </span>{' '}
                · {backtestRequest.strategy} · {backtestRequest.dte} DTE · $
                {backtestRequest.budget.toLocaleString()}
                {backtestRequest.startDate
                  ? ` · ${backtestRequest.startDate} to ${backtestRequest.endDate}`
                  : ''}
                .
              </p>
            ) : null}

            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
              <h3 className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                P&L curve chart
              </h3>
              <div className="mt-3 grid min-h-[96px] place-items-center rounded-xl bg-slate-50 text-sm text-slate-400">
                Awaiting backend integration
              </div>
            </article>
            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
              <h3 className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                Win rate / max drawdown
              </h3>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-50 px-3 py-3">
                  <p className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Win rate
                  </p>
                  <p className="mt-1 text-emerald-600 font-mono text-sm font-semibold">—</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-3">
                  <p className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                    Max drawdown
                  </p>
                  <p className="mt-1 text-emerald-600 font-mono text-sm font-semibold">—</p>
                </div>
              </div>
            </article>
            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
              <h3 className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
                Backtest explanation
              </h3>
              <textarea
                readOnly
                rows={4}
                aria-label="Backtest Explanation"
                placeholder="An explanation of the backtest will appear here after the backend returns results."
                className="mt-3 w-full resize-y rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none"
              />
            </article>
          </section>
        </aside>
      </div>
    </div>
  )
}

export default App
