import { useCallback, useEffect, useRef, useState } from 'react'
import Globe from 'react-globe.gl'

const TYPE_COLORS = {
  'Extraction Site': '#1E3A8A',
  'LNG Terminal': '#0369A1',
  'Grain Hub': '#0F766E',
  Refinery: '#1D4ED8',
  'Choke Point': '#C2410C',
}

export default function GlobeViewport({ nodes, selected, active, onSelect }) {
  const wrapRef = useRef(null)
  const globeRef = useRef(null)
  const elements = useRef(new Map())
  const onSelectRef = useRef(onSelect)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

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

  useEffect(() => {
    elements.current.forEach((element, id) => {
      element.classList.toggle('is-active', id === selected?.id)
    })
  }, [selected])

  const htmlElement = useCallback((node) => {
    let element = elements.current.get(node.id)
    if (!element) {
      element = document.createElement('button')
      element.type = 'button'
      element.className = 'globe-node'
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onSelectRef.current(node)
      })
      elements.current.set(node.id, element)
    }
    const color = TYPE_COLORS[node.type] ?? '#0284c7'
    element.style.background = color
    element.style.color = color
    element.setAttribute('aria-label', node.name)
    element.title = `${node.name} · ${node.ticker}`
    return element
  }, [])

  return (
    <div ref={wrapRef} className="h-full w-full">
      {size.width > 0 && size.height > 0 ? (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="#f0f9ff"
          globeImageUrl="/earth-topology.png"
          atmosphereColor="#0284c7"
          atmosphereAltitude={0.16}
          animateIn={false}
          htmlElementsData={nodes}
          htmlLat="lat"
          htmlLng="lng"
          htmlAltitude={0.01}
          htmlElement={htmlElement}
          ringsData={selected ? [selected] : []}
          ringLat="lat"
          ringLng="lng"
          ringColor={() => '#0284c7'}
          ringMaxRadius={4.2}
          ringPropagationSpeed={2}
          ringRepeatPeriod={900}
        />
      ) : null}
    </div>
  )
}
