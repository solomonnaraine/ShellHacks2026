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
    <div className="terminal">
      <header className="topbar">
        <div className="brand">
          <h1>Commodities Map and Backtester</h1>
        </div>
        <div className="topbar-meta">
          <span className="stat-pill">{nodes.length} anchored nodes</span>
          <span className="stat-pill">{Object.keys(typeCounts).length} asset classes</span>
        </div>
      </header>

      <div className="split" ref={splitRef}>
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
                    <div className="popup-card">
                      <strong>{node.name}</strong>
                      <p>{node.type}</p>
                      <p>
                        {node.commodity} · <span className="ticker">{node.ticker}</span>
                      </p>
                      <p>
                        {formatCoordinate(node.lat, 'N', 'S')},{' '}
                        {formatCoordinate(node.lng, 'E', 'W')}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
            <div className="legend">
              <strong>Node types</strong>
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <div className="legend-row" key={type}>
                  <span className="node-swatch" style={{ background: color }} />
                  <span>
                    {type} · {typeCounts[type] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="asset-dock">
            <div className="dock-tools">
              <input
                className="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, commodity, or ticker"
                aria-label="Search commodity nodes"
              />
              <div className="filters" role="tablist" aria-label="Filter by asset type">
                {FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={filter === typeFilter ? 'filter is-active' : 'filter'}
                    onClick={() => setTypeFilter(filter)}
                  >
                    {filter === 'All' ? `All ${nodes.length}` : filter}
                  </button>
                ))}
              </div>
            </div>

            <div className="dock-body">
              <article className="detail">
                {selected ? (
                  <>
                    <p className="detail-kicker">{selected.type}</p>
                    <h2>{selected.name}</h2>
                    <div className="detail-grid">
                      <div>
                        <span>Commodity</span>
                        <strong>{selected.commodity}</strong>
                      </div>
                      <div>
                        <span>Ticker</span>
                        <strong className="ticker">{selected.ticker}</strong>
                      </div>
                      <div>
                        <span>Latitude</span>
                        <strong className="ticker">
                          {formatCoordinate(selected.lat, 'N', 'S')}
                        </strong>
                      </div>
                      <div>
                        <span>Longitude</span>
                        <strong className="ticker">
                          {formatCoordinate(selected.lng, 'E', 'W')}
                        </strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="detail-kicker">Selected asset</p>
                    <h2>Choose a node</h2>
                    <p>
                      Click a map marker or a row in the book to read its physical
                      coordinates, commodity, and benchmark ticker.
                    </p>
                  </>
                )}
              </article>

              <div className="book">
                <div className="book-head">
                  <span>Asset book</span>
                  <span>{filtered.length} shown</span>
                </div>
                {filtered.length === 0 ? (
                  <p className="empty-book">No assets match this search.</p>
                ) : (
                  <ul className="node-list" ref={listRef}>
                    {filtered.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          data-id={node.id}
                          className={
                            node.id === selectedId ? 'node-row is-selected' : 'node-row'
                          }
                          onClick={() => selectNode(node)}
                        >
                          <span
                            className="node-swatch"
                            style={{ background: TYPE_COLORS[node.type] }}
                          />
                          <span>
                            <span className="node-name">{node.name}</span>
                            <span className="node-meta">
                              {node.commodity} · {node.ticker}
                            </span>
                          </span>
                          <span className="node-coord">
                            {node.lat.toFixed(1)}, {node.lng.toFixed(1)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </section>

        <div
          className="divider"
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

        <aside className="right-panel" aria-label="Quantitative options backtester">
          <section className="backtester" ref={backtesterRef}>
            <h2 className="panel-title">Quantitative options backtester</h2>
            <form
              className="intel-card"
              onSubmit={(event) => {
                event.preventDefault()
                runBacktest()
              }}
            >
              <label className="field">
                <span>Target Ticker</span>
                <input
                  ref={tickerInputRef}
                  value={targetTicker}
                  onChange={(event) => setTargetTicker(event.target.value)}
                  placeholder="CL=F"
                  aria-label="Target Ticker"
                />
              </label>
              <label className="field">
                <span>Strategy</span>
                <select
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value)}
                  aria-label="Strategy"
                >
                  {STRATEGIES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-row">
                <label className="field">
                  <span>DTE</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={dte}
                    onChange={(event) => setDte(event.target.value)}
                    placeholder="30"
                    aria-label="DTE"
                  />
                </label>
                <label className="field">
                  <span>Budget ($USD)</span>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    placeholder="10000"
                    aria-label="Budget in USD"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>Start date</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    aria-label="Start date"
                  />
                </label>
                <label className="field">
                  <span>End date</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    aria-label="End date"
                  />
                </label>
              </div>
              {formError ? <p className="form-error">{formError}</p> : null}
              <button type="submit" className="run-button">
                RUN BACKTEST
              </button>
            </form>

            <div className="card-stack">
              {backtestRequest ? (
                <p className="awaiting">
                  Awaiting backend integration for {backtestRequest.ticker} ·{' '}
                  {backtestRequest.strategy} · {backtestRequest.dte} DTE · $
                  {backtestRequest.budget.toLocaleString()}
                  {backtestRequest.startDate
                    ? ` · ${backtestRequest.startDate} to ${backtestRequest.endDate}`
                    : ''}
                  .
                </p>
              ) : null}
              <article className="intel-card">
                <h3>P&L Curve Chart</h3>
                <div className="result-frame">Awaiting backend integration</div>
              </article>
              <article className="intel-card">
                <h3>Win Rate / Max Drawdown</h3>
                <div className="metric-row">
                  <div>
                    <span>Win Rate</span>
                    <strong>—</strong>
                  </div>
                  <div>
                    <span>Max Drawdown</span>
                    <strong>—</strong>
                  </div>
                </div>
              </article>
              <article className="intel-card">
                <h3>Backtest Explanation</h3>
                <textarea
                  readOnly
                  rows={4}
                  aria-label="Backtest Explanation"
                  placeholder="An explanation of the backtest will appear here after the backend returns results."
                />
              </article>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

export default App
