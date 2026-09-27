import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { PayoffDiagram, PriceChart } from './AnalyticsCharts'
import './App.css'

const GlobeViewport = lazy(() => import('./GlobeViewport'))

class GlobeBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="grid h-full place-items-center px-4 text-center text-xs text-slate-600">
          The 3D globe could not be started. The 2D map is still available.
        </div>
      )
    }
    return this.props.children
  }
}

const TRAY_TABS = [
  ['directory', 'Asset Directory'],
  ['price', 'Live Price & Volatility Chart'],
  ['payoff', 'Options Payoff Diagram'],
]

const TYPE_COLORS = {
  'Extraction Site': '#1E3A8A',
  'LNG Terminal': '#0369A1',
  'Grain Hub': '#0F766E',
  Refinery: '#1D4ED8',
  'Choke Point': '#C2410C',
}

const TYPE_BADGES = {
  'Extraction Site':
    'rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700',
  'LNG Terminal':
    'rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700',
  'Grain Hub':
    'rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800',
  Refinery:
    'rounded-md border border-sky-200 bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800',
  'Choke Point':
    'rounded-md border border-amber-200/60 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700',
}

const FILTERS = ['All', ...Object.keys(TYPE_COLORS)]
const STRATEGIES = ['Short Strangle', 'Long Straddle']
const LABEL = 'mb-1 block font-sans text-xs font-semibold text-slate-700'
const VALUE = 'text-xs font-semibold text-slate-800'
const FIELD =
  'w-full border border-slate-200 bg-white rounded-md px-3 py-2 text-xs text-slate-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500'
const HANDLE =
  'shrink-0 bg-slate-200/60 hover:bg-sky-400 transition-colors'

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

function EquityCurve({ curve }) {
  if (!curve || curve.length < 2) return null
  const values = curve.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const width = 280
  const height = 72
  const points = curve
    .map((point, index) => {
      const x = (index / (curve.length - 1)) * width
      const y = height - 8 - ((point.value - min) / span) * (height - 16)
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[72px] w-full" role="img" aria-label="P and L curve">
      <polyline fill="none" stroke="#0284c7" strokeWidth="2" points={points} />
    </svg>
  )
}

function App() {
  const [nodes, setNodes] = useState([])
  const [nodesError, setNodesError] = useState('')
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
  const [backtestPending, setBacktestPending] = useState(false)
  const [backtestResult, setBacktestResult] = useState(null)
  const [tray, setTray] = useState('directory')
  const [projection, setProjection] = useState('2d')
  const [globeReady, setGlobeReady] = useState(false)

  const listRef = useRef(null)
  const tableRef = useRef(null)
  const markerRefs = useRef({})
  const mapRef = useRef(null)
  const tickerInputRef = useRef(null)
  const backtesterRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/nodes', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || 'The node directory could not be loaded.')
        return payload.nodes
      })
      .then((loaded) => {
        setNodes(loaded)
        setNodesError('')
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        setNodesError(error.message || 'The node directory could not be loaded.')
      })
    return () => controller.abort()
  }, [])

  const typeCounts = useMemo(() => {
    const tally = {}
    for (const node of nodes) {
      tally[node.type] = (tally[node.type] ?? 0) + 1
    }
    return tally
  }, [nodes])

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
  }, [nodes, query, typeFilter])

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

  const selectNode = (node, openChart = false) => {
    setSelectedId(node.id)
    setTargetTicker(node.ticker)
    setFormError('')
    if (openChart) setTray('price')
    backtesterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => tickerInputRef.current?.focus(), 250)
  }

  useEffect(() => {
    if (projection !== '2d') return undefined
    const frame = window.requestAnimationFrame(() => mapRef.current?.invalidateSize())
    return () => window.cancelAnimationFrame(frame)
  }, [projection])

  const downloadPythonModel = async () => {
    try {
      const response = await fetch('/quant/options_strangle_backtest.py')
      if (!response.ok) {
        setFormError('The Python model could not be downloaded.')
        return
      }
      const source = await response.text()
      const blob = new Blob([source], { type: 'text/x-python' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'options_strangle_backtest.py'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch {
      setFormError('The Python model could not be downloaded.')
    }
  }

  const runBacktest = async () => {
    const ticker = targetTicker.trim().toUpperCase()
    const dteValue = Number(dte)
    const budgetValue = Number(budget)
    if (!ticker) {
      setFormError('Enter a target ticker before running the backtest.')
      setBacktestResult(null)
      return
    }
    if (!Number.isInteger(dteValue) || dteValue <= 0) {
      setFormError('DTE must be a whole number of days greater than zero.')
      setBacktestResult(null)
      return
    }
    if ((startDate && !endDate) || (!startDate && endDate)) {
      setFormError('Enter both a start date and an end date, or leave both blank.')
      setBacktestResult(null)
      return
    }
    if (startDate && endDate && endDate < startDate) {
      setFormError('The end date must be on or after the start date.')
      setBacktestResult(null)
      return
    }
    if (!Number.isFinite(budgetValue) || budgetValue <= 0) {
      setFormError('Budget must be a USD amount greater than zero.')
      setBacktestResult(null)
      return
    }

    setFormError('')
    setTargetTicker(ticker)
    setBacktestPending(true)
    try {
      const response = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker,
          strategy,
          dte: dteValue,
          budget: budgetValue,
          startDate,
          endDate,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        setBacktestResult(null)
        setFormError(payload.error || 'The backtest could not be completed.')
        return
      }
      setBacktestResult(payload)
    } catch {
      setBacktestResult(null)
      setFormError('The backtest service did not respond.')
    } finally {
      setBacktestPending(false)
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-sky-50/50 font-sans text-slate-900 antialiased">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="font-sans text-sm font-bold text-slate-900">
          HEDGEHACKS
          <span className="font-normal text-slate-500"> / TERMINAL</span>
        </h1>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search assets"
          aria-label="Search commodity nodes"
          className="w-64 border border-slate-200 bg-white rounded-md px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
        />
      </header>

      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" id="terminal-columns" className="h-full w-full">
          <Panel defaultSize={22} minSize={15} maxSize={35} id="filters">
            <section
              className="flex h-full flex-col overflow-hidden bg-white border-r border-slate-200"
              aria-label="Filters and assets"
            >
              <div className="shrink-0 border-b border-slate-200 px-3 py-3">
                <p className="font-sans text-xs font-semibold text-slate-700">Filters</p>
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
                          ? 'rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white'
                          : 'rounded-lg bg-slate-100 px-3.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200/70'
                      }
                    >
                      {filter === 'All' ? `All ${nodes.length}` : filter}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-600">{filtered.length} shown</p>
              </div>
              {nodesError ? (
                <p className="px-3 py-3 text-xs text-rose-600">{nodesError}</p>
              ) : nodes.length === 0 ? (
                <p className="px-3 py-3 text-xs text-slate-600">Loading assets.</p>
              ) : filtered.length === 0 ? (
                <p className="px-3 py-3 text-xs text-slate-600">No assets match this search.</p>
              ) : (
                <ul ref={listRef} className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
                  {filtered.map((node) => (
                    <li key={node.id}>
                      <button
                        type="button"
                        data-id={node.id}
                        onClick={() => selectNode(node, true)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-sky-50/60 ${
                          node.id === selectedId ? 'bg-sky-50' : ''
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-slate-900">
                            {node.name}
                          </span>
                          <span className="block truncate text-xs text-slate-600">
                            {node.commodity}
                          </span>
                        </span>
                        <span className={`shrink-0 ${VALUE}`}>
                          {node.ticker}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Panel>

          <PanelResizeHandle className={`${HANDLE} w-1 cursor-col-resize`} />

          <Panel defaultSize={53} minSize={30} id="workspace">
            <PanelGroup direction="vertical" id="map-table" className="h-full w-full">
              <Panel defaultSize={65} minSize={30} id="map">
                <div className="relative h-full w-full" aria-label="Commodity map">
                  <div
                    className={
                      projection === '2d'
                        ? 'absolute inset-0'
                        : 'pointer-events-none invisible absolute inset-0'
                    }
                  >
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
                          click: () => selectNode(node, true),
                        }}
                      >
                        <Popup>
                          <div className="min-w-[160px]">
                            <strong className="block text-xs font-semibold text-slate-900">
                              {node.name}
                            </strong>
                            <p className="mt-1 text-xs text-slate-600">{node.type}</p>
                            <p className="text-xs font-semibold text-slate-800">
                              {node.commodity} · {node.ticker}
                            </p>
                            <p className="text-xs text-slate-600">
                              {formatCoordinate(node.lat, 'N', 'S')},{' '}
                              {formatCoordinate(node.lng, 'E', 'W')}
                            </p>
                          </div>
                        </Popup>
                      </Marker>
                    ))}
                  </MapContainer>
                  </div>
                  {globeReady ? (
                    <div
                      className={
                        projection === '3d'
                          ? 'pointer-events-auto absolute inset-0 z-0'
                          : 'pointer-events-none invisible absolute inset-0 z-0'
                      }
                    >
                      <GlobeBoundary>
                        <Suspense
                          fallback={
                            <div className="grid h-full place-items-center text-xs text-slate-600">
                              Loading globe…
                            </div>
                          }
                        >
                          <GlobeViewport
                            nodes={filtered}
                            selected={selected}
                            active={projection === '3d'}
                            onSelect={(node) => selectNode(node, true)}
                          />
                        </Suspense>
                      </GlobeBoundary>
                    </div>
                  ) : null}
                  <div className="absolute right-2 top-2 z-[600] flex overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <button
                      type="button"
                      onClick={() => setProjection('2d')}
                      className={
                        projection === '2d'
                          ? 'bg-sky-600 px-3 py-1.5 text-xs font-medium text-white'
                          : 'px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100'
                      }
                    >
                      2D Map
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGlobeReady(true)
                        setProjection('3d')
                      }}
                      className={
                        projection === '3d'
                          ? 'bg-sky-600 px-3 py-1.5 text-xs font-medium text-white'
                          : 'px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100'
                      }
                    >
                      3D Globe
                    </button>
                  </div>
                  {projection === '2d' ? (
                  <div className="absolute bottom-2 left-2 z-[500] rounded-md border border-slate-200 bg-white px-2 py-1.5">
                    <p className={LABEL}>Node types</p>
                    {Object.entries(TYPE_COLORS).map(([type, color]) => (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-600" key={type}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                        <span>
                          {type} · {typeCounts[type] ?? 0}
                        </span>
                      </div>
                    ))}
                  </div>
                  ) : null}
                </div>
              </Panel>

              <PanelResizeHandle className={`${HANDLE} h-1 cursor-row-resize`} />

              <Panel defaultSize={35} minSize={15} id="table">
                <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white" aria-label="Asset analytics">
                  <div className="flex shrink-0 gap-1 border-b border-slate-200 px-2 py-1" role="tablist">
                    {TRAY_TABS.map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tray === id}
                        onClick={() => setTray(id)}
                        className={
                          tray === id
                            ? 'rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white'
                            : 'rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100'
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {filtered.length === 0 ? (
                    <p className={`px-3 py-3 text-xs text-slate-600 ${tray === 'directory' ? '' : 'hidden'}`}>
                      No assets match this search.
                    </p>
                  ) : (
                    <div
                      ref={tableRef}
                      className={tray === 'directory' ? 'min-h-0 flex-1 overflow-auto' : 'hidden'}
                    >
                      <table className="w-full border-collapse text-left">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-slate-200 bg-slate-50">
                            {['Asset', 'Type', 'Commodity', 'Ticker', 'Coordinates'].map((heading) => (
                              <th
                                key={heading}
                                className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-sans text-xs font-semibold text-slate-700"
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
                              className={`cursor-pointer border-b border-slate-100 text-xs transition-colors hover:bg-sky-50/60 ${
                                node.id === selectedId ? 'bg-sky-50' : ''
                              }`}
                            >
                              <td className="px-3 py-2 font-medium text-slate-800">{node.name}</td>
                              <td className="px-3 py-1.5">
                                <span className={TYPE_BADGES[node.type]}>{node.type}</span>
                              </td>
                              <td className="px-3 py-1.5 text-slate-600">{node.commodity}</td>
                              <td className="px-3 py-2 text-xs font-semibold text-slate-800">
                                {node.ticker}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-600">
                                {node.lat.toFixed(2)}, {node.lng.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {tray === 'price' ? (
                    <div className="min-h-0 flex-1">
                      <PriceChart node={selected} />
                    </div>
                  ) : null}
                  {tray === 'payoff' ? (
                    <div className="min-h-0 flex-1">
                      <PayoffDiagram node={selected} strategy={strategy} />
                    </div>
                  ) : null}
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className={`${HANDLE} w-1 cursor-col-resize`} />

          <Panel defaultSize={25} minSize={20} maxSize={40} id="analytics">
            <aside
              className="flex h-full flex-col space-y-4 overflow-y-auto border-l border-slate-200 bg-white p-4"
              aria-label="Analytics and backtester"
            >
              <section>
                <p className="font-sans text-xs font-semibold text-slate-600">
                  {selected ? selected.type : 'Active node'}
                </p>
                <h2 className="mt-1 font-sans text-xl font-semibold text-slate-900">
                  {selected ? selected.name : 'Choose a node'}
                </h2>
                {selected ? (
                  <dl className="mt-4 grid grid-cols-2 gap-3">
                    <div>
                      <dt className={LABEL}>Commodity</dt>
                      <dd className={VALUE}>{selected.commodity}</dd>
                    </div>
                    <div>
                      <dt className={LABEL}>Ticker</dt>
                      <dd className={VALUE}>{selected.ticker}</dd>
                    </div>
                    <div>
                      <dt className={LABEL}>Latitude</dt>
                      <dd className={VALUE}>{formatCoordinate(selected.lat, 'N', 'S')}</dd>
                    </div>
                    <div>
                      <dt className={LABEL}>Longitude</dt>
                      <dd className={VALUE}>{formatCoordinate(selected.lng, 'E', 'W')}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-3 text-xs text-slate-600">
                    Select a directory row, table row, or map marker.
                  </p>
                )}
              </section>

              <section ref={backtesterRef} className="space-y-3 border-t border-slate-200 pt-4">
                <h3 className="font-sans text-xs font-semibold text-slate-700">
                  Options backtester
                </h3>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    runBacktest()
                  }}
                >
                  <label className="block">
                    <span className={LABEL}>Target ticker</span>
                    <input
                      ref={tickerInputRef}
                      value={targetTicker}
                      onChange={(event) => setTargetTicker(event.target.value)}
                      placeholder="CL=F"
                      aria-label="Target Ticker"
                      className={FIELD}
                    />
                  </label>
                  <label className="block">
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
                    <label className="block">
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
                    <label className="block">
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
                    <label className="block">
                      <span className={LABEL}>Start date</span>
                      <input
                        type="date"
                        value={startDate}
                        onChange={(event) => setStartDate(event.target.value)}
                        aria-label="Start date"
                        className={FIELD}
                      />
                    </label>
                    <label className="block">
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
                  <div className="space-y-2">
                    <button
                      type="submit"
                      disabled={backtestPending}
                      className="w-full rounded-md bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white transition-all hover:bg-sky-700 disabled:cursor-wait disabled:bg-sky-400"
                    >
                      {backtestPending ? 'Running backtest' : 'Run backtest'}
                    </button>
                    <button
                      type="button"
                      onClick={downloadPythonModel}
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 transition-all hover:border-sky-500 hover:text-sky-700"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M5 4.5 2.5 8 5 11.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M8.5 11.5h5" strokeLinecap="round" />
                      </svg>
                      Download Python Model (.py)
                    </button>
                  </div>
                </form>

                <div className="space-y-3 border-t border-slate-200 pt-3">
                  <div>
                    <h3 className={LABEL}>P&L curve chart</h3>
                    <div className="grid min-h-[72px] place-items-center rounded-md border border-slate-200 text-xs text-slate-600">
                      {backtestResult ? (
                        <EquityCurve curve={backtestResult.equityCurve} />
                      ) : (
                        'Run a backtest to plot equity.'
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <h3 className={LABEL}>Win rate</h3>
                      <p className={VALUE}>
                        {backtestResult ? `${backtestResult.winRate.toFixed(1)}%` : '—'}
                      </p>
                    </div>
                    <div>
                      <h3 className={LABEL}>Max drawdown</h3>
                      <p className={VALUE}>
                        {backtestResult ? `${backtestResult.maxDrawdown.toFixed(1)}%` : '—'}
                      </p>
                    </div>
                    <div>
                      <h3 className={LABEL}>Total P&L</h3>
                      <p className={VALUE}>
                        {backtestResult
                          ? backtestResult.totalPnL.toLocaleString('en-US', {
                              style: 'currency',
                              currency: 'USD',
                            })
                          : '—'}
                      </p>
                    </div>
                  </div>
                  <div>
                    <h3 className={LABEL}>Backtest explanation</h3>
                    <textarea
                      readOnly
                      rows={6}
                      aria-label="Backtest Explanation"
                      value={backtestResult?.explanation ?? ''}
                      placeholder="An explanation of the backtest will appear here after the backend returns results."
                      className={`${FIELD} resize-none`}
                    />
                  </div>
                </div>
              </section>
            </aside>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  )
}

export default App
