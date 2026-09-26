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
  'Extraction Site':
    'bg-sky-50 text-sky-700 border border-sky-200/60 rounded-full text-[10px] px-2 py-0.5 font-medium',
  'LNG Terminal':
    'bg-blue-50 text-blue-700 border border-blue-200/60 rounded-full text-[10px] px-2 py-0.5 font-medium',
  'Grain Hub':
    'bg-lime-50 text-lime-700 border border-lime-200/60 rounded-full text-[10px] px-2 py-0.5 font-medium',
  Refinery:
    'bg-violet-50 text-violet-700 border border-violet-200/60 rounded-full text-[10px] px-2 py-0.5 font-medium',
  'Choke Point':
    'bg-amber-50 text-amber-700 border border-amber-200/60 rounded-full text-[10px] px-2 py-0.5 font-medium',
}

const FILTERS = ['All', ...Object.keys(TYPE_COLORS)]
const STRATEGIES = ['Short Strangle', 'Long Straddle']
const LABEL = 'text-[10px] font-mono tracking-wider text-slate-400 uppercase'
const FIELD =
  'w-full bg-white border border-slate-200 text-xs px-2.5 py-1.5 rounded-md focus:ring-1 focus:ring-slate-900 outline-none'

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
  const [targetTicker, setTargetTicker] = useState('')
  const [strategy, setStrategy] = useState(STRATEGIES[0])
  const [dte, setDte] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [budget, setBudget] = useState('')
  const [formError, setFormError] = useState('')
  const [backtestRequest, setBacktestRequest] = useState(null)

  const listRef = useRef(null)
  const tableRef = useRef(null)
  const markerRefs = useRef({})
  const mapRef = useRef(null)
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
    if (!selected) return
    listRef.current
      ?.querySelector(`[data-id="${selected.id}"]`)
      ?.scrollIntoView({ block: 'nearest' })
    tableRef.current
      ?.querySelector(`[data-id="${selected.id}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  useEffect(() => {
    if (!selected) return
    markerRefs.current[selected.id]?.openPopup()
  }, [selected])

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
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-slate-100 text-slate-900 font-sans antialiased">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200/80 bg-white px-4 py-2">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.85)]" />
          <h1 className="text-xs font-semibold tracking-[0.14em] text-slate-900">
            HEDGEHACKS / TERMINAL
          </h1>
        </div>
        <p className={LABEL}>
          {nodes.length} nodes · {Object.keys(typeCounts).length} classes
        </p>
      </header>

      <div className="flex-1 grid grid-cols-12 gap-2 p-2 overflow-hidden min-h-0">
        <section
          className="col-span-3 min-h-0 bg-white border border-slate-200/80 rounded-xl shadow-sm flex flex-col p-3 overflow-hidden"
          aria-label="Filters and assets"
        >
          <p className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
            Filters & assets
          </p>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, commodity, or ticker"
            aria-label="Search commodity nodes"
            className="mt-2 bg-slate-50 border border-slate-200 text-xs py-1.5 px-3 rounded-lg outline-none focus:ring-1 focus:ring-slate-900"
          />
          <div
            className="mt-2 flex flex-wrap gap-1.5"
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
                    ? 'bg-slate-900 text-white font-medium text-xs py-1 px-3 rounded-md'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 text-xs py-1 px-3 rounded-md transition-all'
                }
              >
                {filter === 'All' ? `All ${nodes.length}` : filter}
              </button>
            ))}
          </div>
          <p className={`${LABEL} mt-3`}>
            {filtered.length} shown
          </p>
          {filtered.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">No assets match this search.</p>
          ) : (
            <ul ref={listRef} className="mt-1 min-h-0 flex-1 overflow-y-auto divide-y divide-slate-100">
              {filtered.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    data-id={node.id}
                    onClick={() => selectNode(node)}
                    className={`flex w-full items-center justify-between gap-2 py-1.5 text-left transition-colors hover:bg-slate-50 ${
                      node.id === selectedId ? 'bg-slate-50' : ''
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-slate-900">
                        {node.name}
                      </span>
                      <span className="block truncate text-[10px] text-slate-500">
                        {node.commodity}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] font-semibold text-emerald-600">
                      {node.ticker}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="center-col col-span-6" aria-label="Map and asset table">
          <div className="map-frame bg-white border border-slate-200/80 rounded-xl shadow-sm overflow-hidden relative">
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
                attribution="Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
              />
              <MapBridge mapRef={mapRef} />
              <FocusNode node={selected} />
              {filtered.map((node) => (
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
                    <div className="min-w-[160px]">
                      <strong className="block text-xs font-semibold text-slate-900">
                        {node.name}
                      </strong>
                      <p className="mt-1 text-[10px] text-slate-500">{node.type}</p>
                      <p className="font-mono text-xs font-semibold text-emerald-600">
                        {node.commodity} · {node.ticker}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {formatCoordinate(node.lat, 'N', 'S')},{' '}
                        {formatCoordinate(node.lng, 'E', 'W')}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
            <div className="absolute bottom-2 left-2 z-[500] rounded-lg border border-slate-200/80 bg-white/95 px-2 py-1.5 shadow-sm">
              <p className={LABEL}>Node types</p>
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-600" key={type}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                  <span>
                    {type} · {typeCounts[type] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="table-frame bg-white border border-slate-200/80 rounded-xl shadow-sm overflow-hidden flex flex-col">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500">No assets match this search.</p>
            ) : (
              <div ref={tableRef} className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-left">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-50/80 border-b border-slate-200">
                      {['Asset', 'Type', 'Commodity', 'Ticker', 'Coordinates'].map((heading) => (
                        <th
                          key={heading}
                          className="bg-slate-50/80 border-b border-slate-200 text-[10px] font-mono uppercase tracking-wider text-slate-500 py-1.5 px-3 text-left font-medium"
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
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
                        className={`text-xs py-1.5 px-3 border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer ${
                          node.id === selectedId ? 'bg-slate-50' : ''
                        }`}
                      >
                        <td className="py-1.5 px-3 font-medium text-slate-900">{node.name}</td>
                        <td className="py-1.5 px-3">
                          <span className={TYPE_BADGES[node.type]}>{node.type}</span>
                        </td>
                        <td className="py-1.5 px-3 text-slate-600">{node.commodity}</td>
                        <td className="py-1.5 px-3 font-mono text-[10px] font-semibold text-emerald-600">
                          {node.ticker}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-[10px] text-slate-500">
                          {node.lat.toFixed(2)}, {node.lng.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <aside
          className="col-span-3 min-h-0 bg-white border border-slate-200/80 rounded-xl shadow-sm p-4 flex flex-col overflow-y-auto space-y-4"
          aria-label="Analytics and backtester"
        >
          <section>
            <p className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
              {selected ? selected.type : 'Active node'}
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
              {selected ? selected.name : 'Choose a node'}
            </h2>
            {selected ? (
              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <dt className={LABEL}>Commodity</dt>
                  <dd className="mt-1 text-xs font-semibold text-slate-900">{selected.commodity}</dd>
                </div>
                <div>
                  <dt className={LABEL}>Ticker</dt>
                  <dd className="mt-1 font-mono text-xs font-semibold text-emerald-600">
                    {selected.ticker}
                  </dd>
                </div>
                <div>
                  <dt className={LABEL}>Latitude</dt>
                  <dd className="mt-1 font-mono text-xs font-semibold text-emerald-600">
                    {formatCoordinate(selected.lat, 'N', 'S')}
                  </dd>
                </div>
                <div>
                  <dt className={LABEL}>Longitude</dt>
                  <dd className="mt-1 font-mono text-xs font-semibold text-emerald-600">
                    {formatCoordinate(selected.lng, 'E', 'W')}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-xs text-slate-500">
                Select a directory row, table row, or map marker.
              </p>
            )}
          </section>

          <section ref={backtesterRef} className="space-y-3 border-t border-slate-200/80 pt-4">
            <h3 className="text-[10px] font-mono tracking-widest text-slate-400 uppercase">
              Quantitative options backtester
            </h3>
            <form
              className="bg-slate-50 border border-slate-200/80 p-3 rounded-lg space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                runBacktest()
              }}
            >
              <label className="block space-y-1">
                <span className={LABEL}>Target ticker</span>
                <input
                  ref={tickerInputRef}
                  value={targetTicker}
                  onChange={(event) => setTargetTicker(event.target.value)}
                  placeholder="CL=F"
                  aria-label="Target Ticker"
                  className={`${FIELD} font-mono font-semibold text-emerald-600`}
                />
              </label>
              <label className="block space-y-1">
                <span className={LABEL}>Strategy</span>
                <select
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value)}
                  aria-label="Strategy"
                  className={FIELD}
                >
                  {STRATEGIES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className={LABEL}>DTE</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={dte}
                    onChange={(event) => setDte(event.target.value)}
                    placeholder="30"
                    aria-label="DTE"
                    className={FIELD}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>Budget ($USD)</span>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    placeholder="10000"
                    aria-label="Budget in USD"
                    className={FIELD}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className={LABEL}>Start date</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    aria-label="Start date"
                    className={FIELD}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>End date</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    aria-label="End date"
                    className={FIELD}
                  />
                </label>
              </div>
              {formError ? <p className="text-xs text-rose-600">{formError}</p> : null}
              <button
                type="submit"
                className="w-full bg-slate-900 text-white font-medium text-xs py-1.5 px-3 rounded-md"
              >
                Run backtest
              </button>
            </form>

            {backtestRequest ? (
              <p className="text-xs text-slate-600">
                Awaiting backend integration for{' '}
                <span className="font-mono font-semibold text-emerald-600">
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

            <div className="space-y-3 border-t border-slate-200/80 pt-3">
              <div>
                <h3 className={LABEL}>P&L curve chart</h3>
                <div className="mt-2 grid min-h-[72px] place-items-center rounded-md border border-slate-200/80 text-[10px] text-slate-400">
                  Awaiting backend integration
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <h3 className={LABEL}>Win rate</h3>
                  <p className="mt-1 font-mono text-xs font-semibold text-emerald-600">—</p>
                </div>
                <div>
                  <h3 className={LABEL}>Max drawdown</h3>
                  <p className="mt-1 font-mono text-xs font-semibold text-emerald-600">—</p>
                </div>
              </div>
              <div>
                <h3 className={LABEL}>Backtest explanation</h3>
                <textarea
                  readOnly
                  rows={3}
                  aria-label="Backtest Explanation"
                  placeholder="An explanation of the backtest will appear here after the backend returns results."
                  className={`${FIELD} mt-2 resize-none`}
                />
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

export default App
