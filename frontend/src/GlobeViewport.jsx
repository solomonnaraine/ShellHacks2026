import { useEffect, useRef, useState } from 'react'
import Globe from 'react-globe.gl'

const SOLID_COLORS = {
  'Extraction Site': '#f59e0b',
  'LNG Terminal': '#0284c7',
  'Grain Hub': '#7c3aed',
  Refinery: '#10b981',
  'Choke Point': '#f43f5e',
}

function getNodeSolidColor(type) {
  return SOLID_COLORS[type] ?? '#0284c7'
}

function getNodeGlowColor(type) {
  return SOLID_COLORS[type] ?? '#0284c7'
}

export default function GlobeViewport({ nodes, selected, active, onSelect }) {
  const wrapRef = useRef(null)
  const globeRef = useRef(null)
  const onSelectRef = useRef(onSelect)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [countries, setCountries] = useState([])

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    const controller = new AbortController()
    fetch(
      'https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson',
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.ok) throw new Error(`Country boundaries returned ${response.status}`)
        return response.json()
      })
      .then((data) => setCountries(data.features ?? []))
      .catch((error) => {
        if (error.name !== 'AbortError') setCountries([])
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return undefined
    const fit = () => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return
    if (active) globe.resumeAnimation()
    else globe.pauseAnimation()
  }, [active, size.width, size.height])

  useEffect(() => {
    if (!active || !selected) return
    globeRef.current?.pointOfView(
      { lat: selected.lat, lng: selected.lng, altitude: 1.5 },
      1000,
    )
  }, [active, selected])

  useEffect(() => () => {
    document.body.style.cursor = 'default'
  }, [])

  return (
    <div ref={wrapRef} className="pointer-events-auto h-full w-full">
      {size.width > 0 && size.height > 0 ? (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="#f8fafc"
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
          bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
          atmosphereColor="#7dd3fc"
          atmosphereAltitude={0.18}
          animateIn={false}
          polygonsData={countries}
          polygonCapColor={() => 'rgba(255, 255, 255, 0.1)'}
          polygonSideColor={() => 'rgba(0, 0, 0, 0.05)'}
          polygonStrokeColor={() => '#0284c7'}
          polygonAltitude={0.006}
          polygonsTransitionDuration={0}
          polygonLabel={({ properties: d }) => `<b>${d.ADMIN} (${d.ISO_A2})</b>`}
          pointsData={nodes}
          pointLat="lat"
          pointLng="lng"
          pointColor={(node) => getNodeSolidColor(node.type)}
          pointRadius={0.8}
          pointAltitude={(node) => (node.id === selected?.id ? 0.05 : 0.02)}
          pointsMerge={false}
          pointsTransitionDuration={0}
          onPointClick={(point) => {
            onSelectRef.current(point)
            globeRef.current?.pointOfView({ lat: point.lat, lng: point.lng, altitude: 1.5 }, 1000)
          }}
          onPointHover={(point) => {
            document.body.style.cursor = point ? 'pointer' : 'default'
          }}
          pointLabel={(node) => `
            <div style="background: #ffffff; color: #0f172a; padding: 6px 10px; border-radius: 6px; font-family: sans-serif; font-size: 12px; border: 1px solid #cbd5e1; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
              <strong style="color: #0284c7;">${node.name}</strong><br/>
              <span style="color: #64748b;">${node.type} • ${node.commodity}</span>
            </div>
          `}
          ringsData={nodes}
          ringLat="lat"
          ringLng="lng"
          ringColor={(node) => getNodeGlowColor(node.type)}
          ringMaxRadius={(node) => (node.id === selected?.id ? 3.5 : 1.8)}
          ringPropagationSpeed={2.5}
          ringRepeatPeriod={1200}
        />
      ) : null}
    </div>
  )
}
