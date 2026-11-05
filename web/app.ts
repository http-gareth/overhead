import { Globe } from './globe.ts'
import type { Line } from './globe.ts'
import { countryFinder, mapTexture } from './land.ts'
import { altitudeColor, altitudeRgb, ago, button, clockTime, dayName, el, fillCard, fillRows, latLon, link, number } from './views.ts'
import type { Row } from './views.ts'
import { bars, drawSky, lineChart } from './charts.ts'
import { openAr } from './ar.ts'
import type { SkyObject } from './ar.ts'
import type { SkyDot } from './charts.ts'
import { OWNERS, SITES } from './names.ts'
import { RADIANS, TAN_HALF_FOV, bearing, greatCircleKm, project, rotate, toLatLon, toVector, viewMatrix, wrapLon } from '../src/geo.ts'
import type { Vec3, View } from '../src/geo.ts'
import { subsolarPoint } from '../src/sun.ts'
import { borders, features, polygons } from '../src/topojson.ts'
import { depthBand, parseQuakes } from '../src/quakes.ts'
import type { Quake } from '../src/quakes.ts'
import { MAX_ESTIMATE_MS, estimate, fromRows } from '../src/planes.ts'
import type { Plane } from '../src/planes.ts'
import { compass, lookAngles, sunDirection, surface } from '../src/passes.ts'
import type { Pass } from '../src/passes.ts'
import { GROUPS, STATIONS } from '../src/satellites.ts'
import { STARS, horizontal, moon } from '../src/sky.ts'
import type { Aircraft, Launch, Route, TrackPoint, Volcano } from '../src/sources.ts'

type SatInfo = { name: string, id: number, group: number, inclination: number, periodMinutes: number, epoch: number, deepSpace: boolean }
type SatRecord = { owner: string, launch: string, site: string, rcs: number | null, purpose: number }
type Look = { elevation: number, azimuth: number, rangeKm: number }
type Detail = { index: number, speedKmS: number, sunlit: boolean, look: Look, orbit: Float32Array, ground: Float32Array }
type Frame = { time: number, positions: Float32Array }
type PlaneDetail = { aircraft: Aircraft | null, route: Route | null, track: TrackPoint[] | null }
type Selection = { kind: 'quake', quake: Quake } | { kind: 'satellite', index: number } | { kind: 'plane', plane: Plane }
  | { kind: 'launch', launch: Launch } | { kind: 'volcano', volcano: Volcano } | null
type Layer = 'satellites' | 'planes' | 'quakes' | 'volcanoes' | 'launches' | 'aurora'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const PULSE_MS = HOUR
const IDLE_MS = 6_000
const SPIN_DEGREES_PER_SECOND = 2.5
const FLIGHT_MS = 1_200
const PICK_PIXELS = 18
const MIN_DISTANCE = 1 + 300 / 6_371_000
const STREET_FROM = 1.003
const TILE = 256
const TILES = 8
const GROUND_SPAN = 6
const CLEAR_BELOW = 1.07
const DETAIL_FROM = 2.4
const MAX_DISTANCE = 14
const LIST_LIMIT = 100
const NEARBY_KM = 250
const SKY_PLANES_KM = 600
const EARTH_M = 6_371_000
const HUBBLE = 20580
const QUAKE_COLORS: Record<string, Vec3> = { shallow: [1, 0.48, 0.35], intermediate: [1, 0.82, 0.4], deep: [0.48, 0.64, 1] }
const SAT_STYLE = [[8, 1, 1, 1, 1, 0], [1.9, 0.45, 0.55, 0.78, 0, 0], [3.2, 0.37, 0.92, 0.83, 0, 0], [3.2, 0.95, 0.6, 0.95, 0, 0], [2.4, 0.82, 0.85, 0.95, 0, 0]]
const SAT_CLASSES = ['station', 'starlink', 'navigation', 'geo', 'other']
const SAT_COLORS = ['#ffffff', '#738cc7', '#5eebd4', '#f299f2', '#d1d9f2']
const FEATURED = [25544, 48274, 20580, 25994, 27424, 39084, 49260, 43013, 37849, 40697, 41866, 51850]
const MAGNITUDES = [{ label: 'All', min: -Infinity }, { label: 'M2.5+', min: 2.5 }, { label: 'M4.5+', min: 4.5 }]
const LAYER_OF: Record<string, Layer> = { quake: 'quakes', plane: 'planes', satellite: 'satellites', launch: 'launches', volcano: 'volcanoes' }
const DURBAN = { lat: -29.8587, lon: 31.0218, label: 'Durban, South Africa (default)' }
const GROUND = 1 + 30 / 6_371_000
const HOME_KEY = 'overhead-home'
const SMALL = Math.min(screen.width, screen.height) < 700
const DETAIL_SIZE = SMALL ? 1024 : 2048

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T
const canvas = $<HTMLCanvasElement>('#globe')
const sky = $<HTMLCanvasElement>('#sky')
const card = $('#card')
const tag = $('#tag')
const airportTags = [$('#tag-from'), $('#tag-to')]
const youTag = $('#tag-you')
const clock = $('#clock')

const view: View = { lat: -12, lon: 22, distance: 3.4 }
const show: Record<Layer, boolean> = { satellites: true, planes: true, quakes: true, volcanoes: true, launches: true, aurora: true }
const worker = new Worker(new URL('./sky-worker.ts', import.meta.url), { type: 'module' })
let globe: Globe
const remembered = (() => {
  try {
    const home = JSON.parse(localStorage.getItem(HOME_KEY) ?? 'null')
    return home && Number.isFinite(home.lat) && Number.isFinite(home.lon) ? { lat: home.lat, lon: home.lon, label: 'Your location', accuracy: Number(home.accuracy) || 0 } : null
  } catch {
    return null
  }
})()
let observer = remembered ?? { ...DURBAN, accuracy: 0 }
let tab = 'above'
let earthView = 'quakes'
let photo = true
let photoReady = false
let speed = 1
let simTime = Date.now()
let clockBase = { real: simTime, sim: simTime }
let selection: Selection = null
let following = false
let flight: { from: View, to: View, start: number, duration: number } | null = null
let lastInteraction = -Infinity
let velocity = { lat: 0, lon: 0 }
let countryAt: (lat: number, lon: number) => string | null = () => null
let shapes: { land: [number, number][][][], borders: [number, number][][] } | null = null
let earthDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
let detailKey = ''
let detailBox: number[] | null = null
let groundBox: number[] | null = null
const fades = { detail: 0, ground: 0, street: 0, clear: 0 }
let groundBusy = false
let detailBusy = false
let groundKey = ''
let streetKey = ''
let streetWanted = ''
let streetBusy = false
let street: number[] | null = null

let quakes: Quake[] = []
let minMagnitude = 2.5
let quakesAt = 0
let quakesOffline = false

let planes: Plane[] = []
let planeBase = Date.now()
let planesAt = 0
let planesState = 'loading'
let planeDetail: { id: string, data: PlaneDetail | null } | null = null

let catalog: SatInfo[] = []
let satellitesState = 'loading'
let records = new Map<number, SatRecord>()
let purposes: string[] = []
let prev: Frame | null = null
let next: Frame | null = null
let asking = false
let generation = 0
let detail: Detail | null = null
let above: { count: number, top: (Look & { index: number })[], all: Float32Array } = { count: 0, top: [], all: new Float32Array(0) }
let stationPasses: Record<number, Pass[]> = {}
let brightPasses: { index: number, pass: Pass }[] | null = null
let selectedPasses: Pass[] | null = null
let satQuery = ''
let satGroup = -1
let planeQuery = ''

let launches: Launch[] = []
let volcanoes: Volcano[] = []
let aurora: { kp: number | null, kpTime: string, forecast: string, grid: Uint8Array } | null = null
let skyDots: { dot: SkyDot, x: number, y: number }[] = []

const zoom = (distance: number) => Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance))
const clampLat = (lat: number) => Math.max(-85, Math.min(85, lat))
const visibleQuakes = () => quakes.filter(quake => quake.magnitude >= minMagnitude)
const distanceFromYou = (lat: number, lon: number) => greatCircleKm(observer.lat, observer.lon, lat, lon)
const over = (lat: number, lon: number) => `${countryAt(lat, lon) ?? 'Open water'} · ${latLon(lat, lon)}`
const heightKm = (position: Vec3) => (Math.hypot(...position) - 1) * 6371

const blend = () => prev && next && next.time > prev.time ? Math.max(0, Math.min(1, (simTime - prev.time) / (next.time - prev.time))) : 1

const satPosition = (index: number): Vec3 | null => {
  if (!prev || !next) return null
  const i = index * 3
  const a = [prev.positions[i], prev.positions[i + 1], prev.positions[i + 2]]
  const b = [next.positions[i], next.positions[i + 1], next.positions[i + 2]]
  const [ra, rb] = [Math.hypot(...a), Math.hypot(...b)]
  if (ra < 0.5 || rb < 0.5) return null
  const t = blend()
  const mixed = a.map((v, k) => v + (b[k] - v) * t)
  const scale = (ra + (rb - ra) * t) / Math.hypot(...mixed)
  return mixed.map(v => v * scale) as Vec3
}

const planeGround = (plane: Plane) => estimate(plane, simTime)
const planePosition = (plane: Plane) => {
  const { lat, lon } = planeGround(plane)
  return toVector(lat, lon, GROUND + plane.altitudeM / EARTH_M)
}

const positionOf = (chosen: Selection): Vec3 | null => {
  if (!chosen) return null
  if (chosen.kind === 'quake') return toVector(chosen.quake.lat, chosen.quake.lon, GROUND)
  if (chosen.kind === 'plane') return planePosition(chosen.plane)
  if (chosen.kind === 'launch') return toVector(chosen.launch.lat, chosen.launch.lon, GROUND)
  if (chosen.kind === 'volcano') return toVector(chosen.volcano.lat, chosen.volcano.lon, GROUND)
  return satPosition(chosen.index)
}

const groundOf = (chosen: Selection) => {
  const position = positionOf(chosen)
  return position && toLatLon(position)
}

const arc = (from: Vec3, to: Vec3, radius = 1 + 300 / 6_371_000, steps = 64) => {
  const omega = Math.acos(Math.max(-1, Math.min(1, from[0] * to[0] + from[1] * to[1] + from[2] * to[2])))
  const points: number[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const [a, b] = omega < 1e-6 ? [1 - t, t] : [Math.sin((1 - t) * omega) / Math.sin(omega), Math.sin(t * omega) / Math.sin(omega)]
    points.push(...from.map((v, k) => (v * a + to[k] * b) * radius))
  }
  return points
}

const lookText = (look: Look) => look.elevation > 0
  ? `${Math.round(look.elevation)}° up, look ${compass(look.azimuth)}, ${number(look.rangeKm)} km away`
  : `Below your horizon, ${number(look.rangeKm)} km away`

const passText = (pass: Pass) =>
  `${dayName(pass.start)} ${clockTime(pass.start)}, ${Math.round(pass.maxElevation)}° high, ${compass(pass.startAzimuth)} to ${compass(pass.endAzimuth)}${pass.visible ? ', visible to the eye' : ''}`

const periodText = (minutes: number) => minutes < 120 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`

const sizeWord = (rcs: number | null) => rcs === null ? '' : rcs >= 10 ? 'large' : rcs >= 1 ? 'medium' : 'small'

const countdown = (time: number) => {
  const ms = time - Date.now()
  const span = Math.abs(ms)
  const text = span < HOUR ? `${Math.round(span / MINUTE)} min` : span < 48 * HOUR ? `${Math.round(span / HOUR)} h` : `${Math.round(span / 24 / HOUR)} days`
  return ms >= 0 ? `in ${text}` : `${text} ago`
}

const kpWords = (kp: number) => kp < 3 ? 'Quiet. Auroras stay close to the poles.'
  : kp < 5 ? 'Active. Auroras brighten around the polar regions.'
    : kp < 7 ? 'Geomagnetic storm. Auroras reach much further from the poles.'
      : 'Severe storm. Auroras can be seen far from the poles.'

const auroraAt = (lat: number, lon: number) =>
  aurora ? aurora.grid[(Math.round(lat) + 90) * 360 + ((Math.round(lon) % 360) + 360) % 360] : 0

const askFrame = (time: number) => {
  asking = true
  worker.postMessage({ type: 'frame', gen: generation, time, selected: selection?.kind === 'satellite' ? selection.index : -1, observer })
}

const resetFrames = () => {
  generation++
  asking = false
  prev = next = null
}

const askPasses = () => {
  const stations = catalog.flatMap((sat, i) => STATIONS.has(sat.id) ? [i] : [])
  worker.postMessage({ type: 'passes', key: 'stations', indexes: stations, observer, from: Date.now() })
  if (selection?.kind === 'satellite') worker.postMessage({ type: 'passes', key: `sat:${selection.index}`, indexes: [selection.index], observer, from: Date.now() })
  if (!catalog.length || !records.size) return
  const bright = catalog
    .flatMap((sat, i) => {
      const rcs = records.get(sat.id)?.rcs ?? 0
      return sat.group === 0 || sat.id === HUBBLE || (rcs >= 4 && sat.periodMinutes < 130) ? [{ i, rank: sat.group === 0 || sat.id === HUBBLE ? Infinity : rcs }] : []
    })
    .sort((a, b) => b.rank - a.rank).slice(0, 150).map(({ i }) => i)
  worker.postMessage({ type: 'passes', key: 'bright', indexes: bright, observer, from: Date.now(), hours: 24, visibleOnly: true })
}

const pointStyle = (size: number, color: Vec3, pulse: number, shape: number) => [size, ...color, pulse, shape]

const setPoints = (name: string, items: [Vec3, number[]][]) =>
  globe.setPoints(name, new Float32Array(items.flatMap(([p]) => p)), new Float32Array(items.flatMap(([, style]) => style)))

const updateMarkers = () => {
  const now = Date.now()
  setPoints('quakes', visibleQuakes().map(quake => [toVector(quake.lat, quake.lon, GROUND),
    pointStyle(Math.min(26, 3 + 1.9 ** quake.magnitude), QUAKE_COLORS[depthBand(quake.depthKm)], Math.max(0, 1 - (now - quake.time) / PULSE_MS), 0)]))
  setPoints('volcanoes', volcanoes.map(volcano => [toVector(volcano.lat, volcano.lon, GROUND),
    pointStyle(8, [1, 0.32, 0.3], volcano.kind.startsWith('New') ? 1 : 0, 1)]))
  setPoints('launches', launches.map(launch => [toVector(launch.lat, launch.lon, GROUND),
    pointStyle(9, [1, 0.72, 0.25], launch.time - now < 48 * HOUR && launch.time > now - HOUR ? 1 : 0, 2)]))
}

const updateMarks = () => {
  const marks: [Vec3, number[]][] = [[toVector(observer.lat, observer.lon, GROUND), pointStyle(7, [0.3, 1, 0.55], 1, 0)]]
  const route = selection?.kind === 'plane' && planeDetail?.id === selection.plane.id ? planeDetail.data?.route : null
  if (route) for (const airport of [route.from, route.to]) marks.push([toVector(airport.lat, airport.lon, GROUND), pointStyle(6, [1, 1, 1], 0, 2)])
  const position = positionOf(selection)
  if (position) marks.push([position, pointStyle(13, [1, 1, 1], 1, 0)])
  setPoints('marks', marks)
}

const updateLines = () => {
  const lines: Line[] = []
  const position = positionOf(selection)
  if (selection?.kind === 'satellite' && position && detail?.index === selection.index) {
    const [r, g, b] = SAT_STYLE[catalog[selection.index].group].slice(1, 4)
    const length = Math.hypot(...position)
    lines.push({ points: detail.orbit, colors: [r, g, b, 0.18], width: 9 })
    lines.push({ points: detail.orbit, colors: [r, g, b, 0.9], width: 2.5 })
    lines.push({ points: detail.ground, colors: [r, g, b, 0.55], width: 2 })
    lines.push({ points: [...position, ...position.map(v => v / length * GROUND)], colors: [r, g, b, 0.7], width: 1.5 })
  }
  if (selection?.kind === 'plane' && position && planeDetail?.id === selection.plane.id && planeDetail.data) {
    const { track, route } = planeDetail.data
    const { lat, lon } = planeGround(selection.plane)
    const flown: TrackPoint[] = [...(track ?? []), [simTime, lat, lon, selection.plane.altitudeM]]
    if (route) lines.push({ points: arc(position, toVector(route.to.lat, route.to.lon, 1)), colors: [1, 1, 1, 0.8], width: 2.5, dashed: true })
    const first = track?.[0] ?? [simTime, lat, lon, 0]
    if (route && greatCircleKm(route.from.lat, route.from.lon, first[1], first[2]) > 30) {
      lines.push({ points: arc(toVector(route.from.lat, route.from.lon, 1), toVector(first[1], first[2], 1)), colors: [...altitudeRgb(0), 0.5], width: 2.5, dashed: true })
    }
    if (track) {
      const points = flown.flatMap(([, lat, lon, altitude]) => toVector(lat, lon, GROUND + altitude / EARTH_M))
      const colour = (alpha: number) => flown.flatMap(([, , , altitude]) => [...altitudeRgb(altitude / 1000), alpha])
      lines.push({ points, colors: colour(0.28), width: 12 })
      lines.push({ points, colors: colour(1), width: 4 })
    }
  }
  globe.setLines(lines)
}

const updatePlanes = () => {
  const data = new Float32Array(planes.length * 6)
  planes.forEach((plane, i) => data.set([
    plane.lat * RADIANS, plane.lon * RADIANS, plane.track * RADIANS, plane.speedMs / EARTH_M, (plane.time - planeBase) / 1000, plane.altitudeM / 1000
  ], i * 6))
  globe.setPlanes(data)
}

const renderLayers = () => {
  const counts: Record<Layer, string> = {
    satellites: catalog.length ? number(catalog.length) : satellitesState,
    planes: planes.length ? number(planes.length) : planesState,
    quakes: quakes.length ? number(visibleQuakes().length) : '…',
    volcanoes: volcanoes.length ? number(volcanoes.length) : '…',
    launches: launches.length ? number(launches.length) : '…',
    aurora: aurora?.kp != null ? `Kp ${aurora.kp.toFixed(1)}` : '…'
  }
  for (const node of document.querySelectorAll<HTMLButtonElement>('[data-layer]')) {
    const layer = node.dataset.layer as Layer
    node.setAttribute('aria-pressed', String(show[layer]))
    node.querySelector('b')!.textContent = counts[layer]
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-legend]')) node.hidden = !show[node.dataset.legend as Layer]
  for (const node of document.querySelectorAll<HTMLButtonElement>('[data-style]')) node.setAttribute('aria-pressed', String((node.dataset.style === 'photo') === photo))
  $('[data-style="photo"]').textContent = `Photo · ${new Date(earthDate).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })}`
}

const satRow = (index: number, sub?: string): Row => {
  const sat = catalog[index]
  const position = satPosition(index)
  const record = records.get(sat.id)
  return {
    badge: '', badgeClass: `sat ${SAT_CLASSES[sat.group]}`, title: sat.name,
    sub: sub ?? [record && record.purpose >= 0 ? purposes[record.purpose] : GROUPS[sat.group], position ? `${number(heightKm(position))} km up` : '', `every ${periodText(sat.periodMinutes)}`].filter(Boolean).join(' · '),
    current: selection?.kind === 'satellite' && selection.index === index,
    onClick: () => select({ kind: 'satellite', index })
  }
}

const planeRow = (plane: Plane, distance?: number): Row => ({
  badge: `${(plane.altitudeM / 1000).toFixed(1)} km`, badgeColor: altitudeColor(plane.altitudeM / 1000),
  title: plane.callsign || plane.id.toUpperCase(),
  sub: [plane.country, `${number(plane.speedMs * 3.6)} km/h`, distance === undefined ? '' : `${number(distance)} km from you`].filter(Boolean).join(' · '),
  current: selection?.kind === 'plane' && selection.plane.id === plane.id,
  onClick: () => select({ kind: 'plane', plane })
})

const nearestPlanes = (limit: number, list = planes) => list
  .map(plane => {
    const { lat, lon } = planeGround(plane)
    return { plane, distance: distanceFromYou(lat, lon) }
  })
  .sort((a, b) => a.distance - b.distance)
  .slice(0, limit)

const stat = (value: string, label: string) => {
  const tile = el('div', undefined, 'stat')
  tile.append(el('b', value), el('span', label))
  return tile
}

const renderSky = (ranked: { plane: Plane, distance: number }[]) => {
  if (tab !== 'above') return
  const dots: SkyDot[] = []
  for (let i = 0; i < above.all.length; i += 3) {
    const index = above.all[i]
    const sat = catalog[index]
    if (!sat) continue
    dots.push({
      azimuth: above.all[i + 1], elevation: above.all[i + 2], color: SAT_COLORS[sat.group], size: sat.group === 0 ? 4.5 : 1.6,
      label: sat.group === 0 ? sat.name.replace(/ \(.*\)/, '') : undefined, chosen: selection?.kind === 'satellite' && selection.index === index,
      pick: () => select({ kind: 'satellite', index })
    })
  }
  for (const { plane, distance } of ranked.slice(0, 60)) {
    if (distance > SKY_PLANES_KM) break
    const { lat, lon } = planeGround(plane)
    const look = lookAngles(observer, surface(lat, lon, 6371 + plane.altitudeM / 1000))
    if (look.elevation <= 0) continue
    dots.push({
      azimuth: look.azimuth, elevation: look.elevation, color: altitudeColor(plane.altitudeM / 1000), size: 3.5,
      label: look.elevation > 15 ? plane.callsign : undefined, chosen: selection?.kind === 'plane' && selection.plane.id === plane.id,
      pick: () => select({ kind: 'plane', plane })
    })
  }
  const lunar = moon(simTime)
  const moonSky = horizontal(lunar.ra, lunar.dec, observer, simTime)
  if (moonSky.elevation > 0) dots.push({ ...moonSky, color: '#e8e4d8', size: 6, label: 'Moon', pick: () => {} })
  const sunLook = lookAngles(observer, sunDirection(simTime).map(v => v * 1.5e8) as Vec3)
  skyDots = drawSky(sky, dots, sunLook)
}

const renderAbove = () => {
  $('#observer').textContent = observer.accuracy ? `${observer.label} (±${number(observer.accuracy)} m)` : observer.label
  const ranked = nearestPlanes(Infinity)
  const planesClose = ranked.filter(({ distance }) => distance < NEARBY_KM).length
  const nearestQuake = quakes.map(quake => ({ quake, distance: distanceFromYou(quake.lat, quake.lon) })).sort((a, b) => a.distance - b.distance)[0]
  $('#above-stats').replaceChildren(
    stat(catalog.length ? number(above.count) : '…', 'satellites above your horizon'),
    stat(planes.length ? number(planesClose) : '…', `planes within ${NEARBY_KM} km`),
    stat(nearestQuake ? `${number(nearestQuake.distance)} km` : '…', nearestQuake ? `to today's closest quake, M${nearestQuake.quake.magnitude.toFixed(1)}` : 'closest quake today')
  )
  renderSky(ranked)
  const passRows = Object.entries(stationPasses).flatMap(([index, list]) => list.slice(0, 3).map(pass => ({ index: Number(index), pass })))
    .sort((a, b) => a.pass.start - b.pass.start)
    .map(({ index, pass }) => ({ ...satRow(index, passText(pass)), badge: pass.visible ? 'Look up' : '', badgeClass: pass.visible ? 'visible' : `sat ${SAT_CLASSES[0]}` }))
  fillRows($('#above-passes'), passRows, catalog.length ? 'No space station passes over you in the next 2 days.' : 'Loading orbits…')
  const brightRows = (brightPasses ?? []).slice(0, 10).map(({ index, pass }) => {
    const rcs = records.get(catalog[index]?.id)?.rcs ?? null
    return { ...satRow(index, `${dayName(pass.start)} ${clockTime(pass.start)} · ${Math.round(pass.maxElevation)}° high · ${compass(pass.startAzimuth)} to ${compass(pass.endAzimuth)}${rcs === null ? '' : ` · ${sizeWord(rcs)}`}`), badge: 'Look up', badgeClass: 'visible' }
  })
  fillRows($('#above-bright'), brightRows, brightPasses ? 'None bright enough in the next 24 hours.' : 'Working out tonight’s sky…')
  fillRows($('#above-sats'), above.top.map(look => satRow(look.index, `${Math.round(look.elevation)}° up, look ${compass(look.azimuth)} · ${number(look.rangeKm)} km away`)), catalog.length ? 'Working it out…' : 'Loading orbits…')
  fillRows($('#above-planes'), ranked.slice(0, 5).map(({ plane, distance }) => planeRow(plane, distance)), planes.length ? 'No planes nearby.' : 'Loading planes…')
}

const renderSatellites = () => {
  $('#sat-groups').replaceChildren(...[-1, 0, 1, 2, 3, 4].map(group => {
    const total = group < 0 ? catalog.length : catalog.filter(sat => sat.group === group).length
    const chip = button(`${group < 0 ? 'All' : GROUPS[group]} ${number(total)}`, () => {
      satGroup = group
      renderSatellites()
    })
    chip.setAttribute('aria-pressed', String(satGroup === group))
    return chip
  }))
  const query = satQuery.trim().toUpperCase()
  const featured = !query && satGroup < 0
  const matches = featured
    ? FEATURED.map(id => catalog.findIndex(sat => sat.id === id)).filter(i => i >= 0)
    : catalog.flatMap((sat, i) => (satGroup < 0 || sat.group === satGroup) && (!query || sat.name.includes(query) || String(sat.id) === query) ? [i] : [])
  $('#sat-status').textContent = catalog.length
    ? featured ? 'Well-known satellites. Search to find any of them.' : `${number(matches.length)} found${matches.length > LIST_LIMIT ? `, showing ${LIST_LIMIT}` : ''}`
    : satellitesState === 'loading' ? 'Loading orbits from CelesTrak…' : 'CelesTrak is not answering. Retrying…'
  fillRows($('#sat-list'), matches.slice(0, LIST_LIMIT).map(i => satRow(i)), catalog.length ? 'Nothing matches.' : '')
}

const renderPlanes = () => {
  const query = planeQuery.trim().toLowerCase()
  const matches = query ? planes.filter(plane => plane.callsign.toLowerCase().startsWith(query) || plane.country.toLowerCase().includes(query) || plane.id === query) : planes
  const age = planesAt ? ` · radar snapshot ${ago(Date.now() - planesAt)}` : ''
  $('#plane-status').textContent = planes.length
    ? `${number(matches.length)} planes${query ? ' found' : ' in the air, nearest first'}${age}. Positions are estimated between snapshots. Click one for its route and path.`
    : planesState === 'loading' ? 'Loading planes from OpenSky…' : 'OpenSky is not answering. Retrying…'
  fillRows($('#plane-list'), nearestPlanes(LIST_LIMIT, matches).map(({ plane, distance }) => planeRow(plane, distance)), planes.length ? 'Nothing matches.' : '')
}

const renderEarth = () => {
  for (const node of document.querySelectorAll<HTMLButtonElement>('[data-earth]')) node.setAttribute('aria-pressed', String(node.dataset.earth === earthView))
  for (const name of ['quakes', 'volcanoes', 'space']) $(`#earth-${name}`).hidden = name !== earthView
  const status = $('#status')
  status.classList.toggle('offline', quakesOffline)
  status.textContent = quakesOffline ? 'USGS is not answering. Showing the last data, retrying…' : quakesAt ? `Live from USGS · updated ${ago(Date.now() - quakesAt)}` : 'Loading live data…'
  $('#filters').replaceChildren(...MAGNITUDES.map(filter => {
    const chip = button(filter.label, () => {
      minMagnitude = filter.min
      if (selection?.kind === 'quake' && selection.quake.magnitude < minMagnitude) select(null)
      updateMarkers()
      renderAll()
    })
    chip.setAttribute('aria-pressed', String(filter.min === minMagnitude))
    return chip
  }))
  const now = Date.now()
  fillRows($('#quakes'), visibleQuakes().slice(0, 200).map(quake => ({
    badge: quake.magnitude.toFixed(1), badgeClass: `mag ${depthBand(quake.depthKm)}`, title: quake.place,
    sub: `${ago(now - quake.time)} · ${Math.round(quake.depthKm)} km deep · ${number(distanceFromYou(quake.lat, quake.lon))} km from you`,
    current: selection?.kind === 'quake' && selection.quake.id === quake.id,
    onClick: () => select({ kind: 'quake', quake })
  })), quakes.length ? 'No quakes at this size today.' : '')
  $('#volcano-status').textContent = volcanoes.length ? `Smithsonian and USGS weekly report for ${volcanoes[0].week}.` : 'Loading the weekly volcano report…'
  fillRows($('#volcanoes'), volcanoes.map(volcano => ({
    badge: '', badgeClass: `volcano ${volcano.kind.startsWith('New') ? 'new' : ''}`, title: `${volcano.name} (${volcano.country})`,
    sub: `${volcano.kind} · ${number(distanceFromYou(volcano.lat, volcano.lon))} km from you`,
    current: selection?.kind === 'volcano' && selection.volcano.name === volcano.name,
    onClick: () => select({ kind: 'volcano', volcano })
  })), volcanoes.length ? 'No volcanoes in this week’s report.' : '')
  const space = $('#space-weather')
  if (!aurora) {
    space.replaceChildren(el('p', 'Loading space weather from NOAA…', 'status'))
    return
  }
  const here = auroraAt(observer.lat, observer.lon)
  const tiles = el('div', undefined, 'stats')
  tiles.append(
    stat(aurora.kp == null ? '…' : aurora.kp.toFixed(1), 'Kp index, how disturbed Earth’s magnetic field is (0 to 9)'),
    stat(`${here}%`, 'chance of seeing an aurora where you are'),
    stat(aurora.forecast ? clockTime(Date.parse(aurora.forecast)) : '…', 'time this aurora forecast is for')
  )
  space.replaceChildren(tiles, el('p', aurora.kp == null ? '' : kpWords(aurora.kp), 'lead'),
    el('p', 'The green glow on the night side of the globe is NOAA’s aurora forecast for the next half hour. It comes from the solar wind measured a million kilometres away, between us and the Sun.', 'fine'))
}

const renderLaunches = () => {
  $('#launch-status').textContent = launches.length ? 'The next launches worldwide, from The Space Devs’ Launch Library. Times often change.' : 'Loading launches…'
  fillRows($('#launch-list'), launches.map(launch => ({
    badge: launch.time > Date.now() ? countdown(launch.time).replace('in ', '') : 'Gone', badgeClass: 'launch',
    title: launch.name, sub: `${launch.provider || 'Unknown provider'} · ${launch.location || launch.pad} · ${dayName(launch.time)} ${clockTime(launch.time)}`,
    current: selection?.kind === 'launch' && selection.launch.id === launch.id,
    onClick: () => select({ kind: 'launch', launch })
  })), launches.length ? 'No launches listed.' : '')
}

const count = <T>(items: T[], key: (item: T) => string | null) => {
  const totals = new Map<string, number>()
  for (const item of items) {
    const name = key(item)
    if (name) totals.set(name, (totals.get(name) ?? 0) + 1)
  }
  return [...totals].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
}

const renderStats = () => {
  const body = $('#stats-body')
  const heights = catalog.flatMap((_, i) => {
    const position = satPosition(i)
    return position ? [heightKm(position)] : []
  })
  const starlink = catalog.filter(sat => sat.group === 1).length
  const planeHeights = planes.map(plane => plane.altitudeM / 1000)
  const tiles = el('div', undefined, 'stats')
  tiles.append(
    stat(catalog.length ? `${Math.round(starlink / catalog.length * 100)}%` : '…', 'of all working satellites are Starlink'),
    stat(planes.length ? `${number(planeHeights.filter(h => h >= 9).length / planes.length * 100)}%` : '…', 'of planes in the air are cruising above 9 km'),
    stat(quakes.length ? number(quakes.length) : '…', 'earthquakes recorded in the last 24 hours')
  )
  const charts: Node[] = [tiles]
  if (records.size && catalog.length) {
    charts.push(bars('Who owns the satellites', count(catalog, sat => {
      const owner = records.get(sat.id)?.owner
      return owner ? OWNERS[owner] ?? owner : null
    }).slice(0, 8)))
    charts.push(bars('What they are for', count(catalog, sat => {
      const purpose = records.get(sat.id)?.purpose ?? -1
      return purpose >= 0 ? purposes[purpose] : 'Not listed'
    }).slice(0, 8)))
  }
  if (heights.length) {
    charts.push(bars('How high they orbit', [
      { label: 'Low, under 2,000 km', value: heights.filter(h => h < 2000).length },
      { label: 'Middle, 2,000–35,000 km', value: heights.filter(h => h >= 2000 && h < 35_000).length },
      { label: 'Geostationary, 35,786 km', value: heights.filter(h => h >= 35_000 && h < 36_500).length },
      { label: 'Further out', value: heights.filter(h => h >= 36_500).length }
    ]))
  }
  if (planes.length) {
    charts.push(bars('Planes by height', [[0, 3, 'Under 3 km (take-off, landing)'], [3, 6, '3–6 km'], [6, 9, '6–9 km'], [9, 12, '9–12 km (cruising)'], [12, 99, 'Above 12 km']]
      .map(([low, high, label]) => ({ label: label as string, value: planeHeights.filter(h => h >= (low as number) && h < (high as number)).length }))))
    charts.push(bars('Busiest skies right now', count(planes, plane => {
      const { lat, lon } = planeGround(plane)
      return countryAt(lat, lon)
    }).slice(0, 8)))
    charts.push(bars('Where the planes are registered', count(planes, plane => plane.country || null).slice(0, 8)))
  }
  if (quakes.length) {
    charts.push(bars('Earthquakes in the last 24 hours by size', [
      { label: 'Small, under M2.5', value: quakes.filter(q => q.magnitude < 2.5).length },
      { label: 'Light, M2.5–4.5', value: quakes.filter(q => q.magnitude >= 2.5 && q.magnitude < 4.5).length },
      { label: 'Strong, M4.5+', value: quakes.filter(q => q.magnitude >= 4.5).length }
    ]))
  }
  body.replaceChildren(...charts)
}

const renderTab = () => {
  for (const node of document.querySelectorAll<HTMLElement>('[data-tab]')) node.setAttribute('aria-selected', String(node.dataset.tab === tab))
  for (const name of ['above', 'satellites', 'planes', 'earth', 'launches', 'stats']) $(`#tab-${name}`).hidden = name !== tab
  if (tab === 'above') renderAbove()
  if (tab === 'satellites') renderSatellites()
  if (tab === 'planes') renderPlanes()
  if (tab === 'earth') renderEarth()
  if (tab === 'launches') renderLaunches()
  if (tab === 'stats') renderStats()
}

const followButton = () => {
  const toggle = button(following ? 'Following' : 'Follow', () => {
    following = !following
    const ground = following && groundOf(selection)
    if (ground) flyTo(ground.lat, ground.lon)
    renderCard()
  }, 'pill')
  toggle.setAttribute('aria-pressed', String(following))
  return toggle
}

const picture = (src: string, alt: string, credit: string) => {
  const figure = el('figure', undefined, 'photo')
  const image = el('img') as HTMLImageElement
  Object.assign(image, { src, alt, loading: 'lazy', referrerPolicy: 'no-referrer' })
  image.addEventListener('error', () => figure.remove())
  figure.append(image, el('figcaption', credit))
  return figure
}

const progress = (plane: Plane, route: Route) => {
  const { lat, lon } = planeGround(plane)
  const flown = greatCircleKm(route.from.lat, route.from.lon, lat, lon)
  const left = greatCircleKm(lat, lon, route.to.lat, route.to.lon)
  return { flown, left, onRoute: flown + left < greatCircleKm(route.from.lat, route.from.lon, route.to.lat, route.to.lon) * 1.25 + 100 }
}

const flightMedia = (plane: Plane) => {
  const data = planeDetail?.id === plane.id ? planeDetail.data : null
  if (!data) return [el('p', 'Looking up the aircraft, its route and the path it has flown…', 'status')]
  const nodes: Node[] = []
  const { aircraft, route, track } = data
  if (aircraft?.photo) nodes.push(picture(aircraft.photo, `${aircraft.manufacturer} ${aircraft.type}, ${aircraft.registration}`, 'Photo: airport-data.com'))
  if (route) {
    const { flown, left, onRoute } = progress(plane, route)
    const block = el('div', undefined, 'route')
    const ends = el('div', undefined, 'ends')
    for (const airport of [route.from, route.to]) {
      const end = el('div')
      end.append(el('b', airport.iata || '—'), el('span', airport.city || airport.name))
      ends.append(end)
    }
    block.append(ends)
    if (onRoute) {
      const bar = el('div', undefined, 'progress')
      const done = el('span')
      done.style.width = `${Math.min(100, flown / (flown + left) * 100)}%`
      bar.append(done)
      block.append(bar)
    } else block.append(el('p', 'This is the airline’s usual route for this flight number. The plane is off it today, so it may be flying something else.', 'sub'))
    nodes.push(block)
  }
  if (track) {
    nodes.push(lineChart('Height (metres)', track.map(([t, , , altitude]) => [t, altitude]), v => number(v), clockTime))
    const speeds: [number, number][] = []
    let anchor = track[0]
    for (const point of track.slice(1)) {
      const seconds = (point[0] - anchor[0]) / 1000
      if (seconds < 30) continue
      speeds.push([point[0], greatCircleKm(anchor[1], anchor[2], point[1], point[2]) / seconds * 3600])
      anchor = point
    }
    if (speeds.length >= 2) nodes.push(lineChart('Ground speed (km/h)', speeds, v => number(v), clockTime))
  }
  if (!aircraft && !route && !track) nodes.push(el('p', 'No extra records for this aircraft yet.', 'status'))
  return nodes
}

const renderCard = () => {
  if (!selection) {
    card.hidden = true
    return
  }
  const close = () => button('Close', () => select(null), 'pill close')
  if (selection.kind === 'quake') {
    const quake = selection.quake
    const rows: [string, string, string?][] = [
      ['When', `${new Date(quake.time).toLocaleString()} (${ago(Date.now() - quake.time)})`],
      ['Depth', `${quake.depthKm.toFixed(1)} km, ${depthBand(quake.depthKm)}`],
      ['Where', over(quake.lat, quake.lon)],
      ['From you', `${number(distanceFromYou(quake.lat, quake.lon))} km away`]
    ]
    if (quake.tsunami) rows.push(['Tsunami', 'USGS flagged this for tsunami review', 'warning'])
    fillCard(card, `quake:${quake.id}`, `Magnitude ${quake.magnitude.toFixed(1)} earthquake`, quake.place, rows, () => [...(quake.url ? [link('Full report on USGS ↗', quake.url)] : []), close()])
    return
  }
  if (selection.kind === 'volcano') {
    const volcano = selection.volcano
    fillCard(card, `volcano:${volcano.name}`, volcano.name, `${volcano.country} · ${volcano.kind}`, [
      ['Report', `Week of ${volcano.week}`],
      ['Where', latLon(volcano.lat, volcano.lon)],
      ['From you', `${number(distanceFromYou(volcano.lat, volcano.lon))} km away`]
    ], () => [...(volcano.url ? [link('Smithsonian volcano page ↗', volcano.url)] : []), close()], () => [el('p', volcano.summary, 'lead')])
    return
  }
  if (selection.kind === 'launch') {
    const launch = selection.launch
    fillCard(card, `launch:${launch.id}`, launch.name, launch.provider, [
      ['When', `${new Date(launch.time).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, ${countdown(launch.time)}`],
      ['Status', launch.status || 'Unknown'],
      ['Rocket', launch.rocket || 'Unknown'],
      ['Mission', [launch.mission, launch.missionType].filter(Boolean).join(', ') || 'Unknown'],
      ['Orbit', launch.orbit || 'Unknown'],
      ['Pad', [launch.pad, launch.location].filter(Boolean).join(', ')],
      ['From you', `${number(distanceFromYou(launch.lat, launch.lon))} km away`]
    ], () => [close()], () => [
      ...(launch.image ? [picture(launch.image, launch.rocket, 'Image: The Space Devs')] : []),
      ...(launch.description ? [el('p', launch.description, 'lead')] : [])
    ])
    return
  }
  if (selection.kind === 'plane') {
    const plane = selection.plane
    const { lat, lon } = planeGround(plane)
    const age = simTime - plane.time
    const data = planeDetail?.id === plane.id ? planeDetail.data : null
    const aircraft = data?.aircraft
    const route = data?.route
    const rows: [string, string, string?][] = []
    if (aircraft) rows.push(['Aircraft', [aircraft.manufacturer, aircraft.type].filter(Boolean).join(' ') || 'Unknown'], ['Registration', aircraft.registration || 'Unknown'], ['Operator', aircraft.owner || route?.airline || 'Unknown'])
    if (route) {
      const { flown, left, onRoute } = progress(plane, route)
      rows.push(['Route', `${route.from.name} to ${route.to.name}`])
      if (onRoute) rows.push(['Progress', `${number(flown)} km flown, ${number(left)} km to go`])
    }
    rows.push(
      ['Height', `${number(plane.altitudeM)} m · ${number(plane.altitudeM * 3.28084)} ft`],
      ['Speed', `${number(plane.speedMs * 3.6)} km/h · ${number(plane.speedMs * 1.94384)} knots`],
      ['Heading', `${Math.round(plane.track)}°, flying ${compass(plane.track)}`],
      ['Climb', plane.climbMs > 1 ? `Climbing ${plane.climbMs.toFixed(1)} m/s` : plane.climbMs < -1 ? `Descending ${(-plane.climbMs).toFixed(1)} m/s` : 'Level'],
      ['Over', over(lat, lon)],
      ['From you', `${number(distanceFromYou(lat, lon))} km away`],
      ['Position', age <= MAX_ESTIMATE_MS ? `Radar fix ${ago(age)}, estimated since along its heading` : `Last radar fix ${ago(age)}, too old to estimate`]
    )
    const title = [route?.flight || plane.callsign || 'Unnamed flight', route?.airline].filter(Boolean).join(' · ')
    fillCard(card, `plane:${plane.id}:${following}:${data ? 'ready' : 'loading'}`, title, `${plane.callsign || plane.id.toUpperCase()} · registered in ${plane.country || 'an unknown country'}`, rows,
      () => [followButton(), link('Live track on ADS-B Exchange ↗', `https://globe.adsbexchange.com/?icao=${plane.id}`), close()], () => flightMedia(plane))
    return
  }
  const sat = catalog[selection.index]
  const position = satPosition(selection.index)
  const ground = position && toLatLon(position)
  const known = detail?.index === selection.index ? detail : null
  const nextPass = selectedPasses?.[0]
  const record = records.get(sat.id)
  const launched = record?.launch ? Date.parse(record.launch) : NaN
  const years = (Date.now() - launched) / (365.25 * 24 * HOUR)
  fillCard(card, `sat:${sat.id}:${following}`, sat.name, `${record && record.purpose >= 0 ? purposes[record.purpose] : GROUPS[sat.group]} · catalogue number ${sat.id}`, [
    ['Height', position ? `${number(heightKm(position))} km` : '…'],
    ['Speed', known ? `${known.speedKmS.toFixed(2)} km/s · ${number(known.speedKmS * 3600)} km/h` : '…'],
    ['Over', ground ? over(ground.lat, ground.lon) : '…'],
    ['Owner', record ? OWNERS[record.owner] ?? record.owner : records.size ? 'Not listed' : '…'],
    ['Launched', Number.isFinite(launched)
      ? `${new Date(launched).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}, ${years < 1 ? `${Math.max(1, Math.round(years * 12))} months` : `${Math.round(years)} years`} ago, from ${SITES[record!.site] ?? record!.site}`
      : records.size ? 'Not listed' : '…'],
    ['Size', record?.rcs != null ? `${sizeWord(record.rcs)} (radar size ${record.rcs.toFixed(1)} m²)` : records.size ? 'Not published' : '…'],
    ['Orbit', sat.group === 3
      ? `Once a day, so it hangs over the same spot. Tilted ${sat.inclination.toFixed(1)}°`
      : `Every ${periodText(sat.periodMinutes)}, ${(1440 / sat.periodMinutes).toFixed(1)} times a day. Tilted ${sat.inclination.toFixed(1)}°`],
    ['Sunlight', known ? (known.sunlit ? 'In sunlight' : "In Earth's shadow") : '…'],
    ['From you', known ? lookText(known.look) : '…'],
    ['Next pass', selectedPasses ? (nextPass ? passText(nextPass) : 'Not over you in the next 2 days') : 'Working it out…'],
    ['Orbit data', `${ago(Date.now() - sat.epoch)} from CelesTrak${sat.deepSpace ? '. High orbit, so the position is approximate' : ''}`]
  ], () => [followButton(), link('CelesTrak record ↗', `https://celestrak.org/satcat/table-satcat.php?CATNR=${sat.id}`), close()])
}

const renderAll = () => {
  renderLayers()
  renderTab()
  renderCard()
}

const flyTo = (lat: number, lon: number, distance = Math.min(view.distance, 2.7), duration = FLIGHT_MS) => {
  flight = { from: { ...view }, to: { lat: clampLat(lat), lon: view.lon + wrapLon(lon - view.lon), distance }, start: performance.now(), duration }
}

const loadPlaneDetail = async (plane: Plane) => {
  planeDetail = { id: plane.id, data: null }
  let data: PlaneDetail = { aircraft: null, route: null, track: null }
  try {
    const response = await fetch(`/api/plane?hex=${plane.id}&callsign=${encodeURIComponent(plane.callsign)}`)
    if (response.ok) data = await response.json()
  } catch {}
  if (planeDetail?.id !== plane.id) return
  planeDetail = { id: plane.id, data }
  const [before, latest] = data.track?.slice(-2) ?? []
  if (latest && latest[0] > plane.time && selection?.kind === 'plane') {
    const moved = before && greatCircleKm(before[1], before[2], latest[1], latest[2]) > 0.3
    const fresher = { ...plane, time: latest[0], lat: latest[1], lon: latest[2], altitudeM: latest[3] || plane.altitudeM, track: moved ? bearing(before[1], before[2], latest[1], latest[2]) : plane.track }
    planes = planes.map(other => other.id === plane.id ? fresher : other)
    selection = { kind: 'plane', plane: fresher }
    updatePlanes()
  }
  if (data.route && selection?.kind === 'plane') frameRoute(selection.plane, data.route)
  renderCard()
}

const select = (chosen: Selection) => {
  if (chosen && phone.matches && sheet === 0) setSheet(1)
  selection = chosen
  selectedPasses = null
  following = chosen !== null && (chosen.kind === 'satellite' || chosen.kind === 'plane')
  lastInteraction = performance.now()
  const ground = groundOf(chosen)
  const radius = Math.hypot(...(positionOf(chosen) ?? [1, 0, 0]))
  if (ground) flyTo(ground.lat, ground.lon, Math.max(Math.min(view.distance, 2.7), radius * 1.6))
  if (chosen?.kind === 'satellite') {
    resetFrames()
    askPasses()
  }
  if (chosen?.kind === 'plane') loadPlaneDetail(chosen.plane)
  renderAll()
}

const fetchFeed = async (path: string, cache: RequestCache = 'no-store') => {
  const response = await fetch(path, { cache })
  if (!response.ok) throw new Error(`${path}: status ${response.status}`)
  return { response, age: Number(response.headers.get('x-overhead-data-age') ?? 0) * 1000, stale: response.headers.has('x-overhead-stale') }
}

const loadJson = async (path: string) => (await fetchFeed(path)).response.json()
const loadBitmap = async (path: string) => createImageBitmap(await (await fetchFeed(path, 'default')).response.blob())

const groundAt = (ndcX: number, ndcY: number, rows = viewMatrix(view)) => {
  const ray = [ndcX * TAN_HALF_FOV * canvas.clientWidth / canvas.clientHeight, ndcY * TAN_HALF_FOV, -1]
  const length = Math.hypot(...ray)
  const [x, y, z] = ray.map(v => v / length)
  const b = view.distance * z
  const h = b * b - view.distance ** 2 + 1
  if (h < 0) return null
  const t = -b - Math.sqrt(h)
  const hit = [x * t, y * t, view.distance + z * t]
  return toLatLon([0, 1, 2].map(k => rows[0][k] * hit[0] + rows[1][k] * hit[1] + rows[2][k] * hit[2]) as Vec3)
}

const visibleBox = () => {
  if (view.distance > DETAIL_FROM) return null
  const rows = viewMatrix(view)
  const lats: number[] = []
  const lons: number[] = []
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const ground = groundAt(i / 4 - 1, j / 4 - 1, rows)
      if (!ground) continue
      lats.push(ground.lat)
      lons.push(view.lon + wrapLon(ground.lon - view.lon))
    }
  }
  if (lats.length < 81 * 0.6) return null
  const box = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
  return box[0] < -180 || box[2] > 180 || box[2] - box[0] > 100 ? null : box
}

const snapBox = (seen: number[]) => {
  const grow = (low: number, high: number) => [low - Math.max(0, 1 / 16 - (high - low)) / 2, high + Math.max(0, 1 / 16 - (high - low)) / 2]
  const [[west, east], [south, north]] = [grow(seen[0], seen[2]), grow(seen[1], seen[3])]
  const span = Math.max(east - west, north - south)
  const step = Math.max(1 / 32, 2 ** Math.ceil(Math.log2(span * 1.5 / 4)))
  const pad = span / 4
  return [
    Math.max(-180, Math.floor((west - pad) / step) * step), Math.max(-90, Math.floor((south - pad) / step) * step),
    Math.min(180, Math.ceil((east + pad) / step) * step), Math.min(90, Math.ceil((north + pad) / step) * step)
  ]
}

const refreshDetail = async () => {
  if (detailBusy || flight || pointers.size || performance.now() - lastInteraction < 400) return
  const seen = visibleBox()
  if (!seen) return
  const box = snapBox(seen)
  const key = box.join(',')
  const span = (b: number[]) => Math.max(b[2] - b[0], b[3] - b[1])
  const area = `west=${box[0]}&south=${box[1]}&east=${box[2]}&north=${box[3]}&size=${DETAIL_SIZE}`
  const fresh = (have: number[] | null) => !have || coverage(have, seen) < 1 || span(have) > span(box) * 2
  if (!groundBusy && view.distance < CLEAR_BELOW * 1.01 && span(box) <= GROUND_SPAN && groundKey !== key && fresh(groundBox)) {
    groundBusy = true
    groundKey = key
    loadBitmap(`/api/detail?layer=ground&${area}`).then(ground => {
      globe.setImage('detailGround', ground)
      groundBox = box
    }).catch(() => {}).finally(() => { groundBusy = false })
  }
  if (key === detailKey || !fresh(detailBox) || box[2] - box[0] > 120 || box[3] - box[1] > 90) return
  detailBusy = true
  try {
    const [today, lights] = await Promise.all([loadBitmap(`/api/detail?layer=today&date=${earthDate}&${area}`), loadBitmap(`/api/detail?layer=lights&${area}`)])
    globe.setImage('detailToday', today)
    globe.setImage('detailLights', lights)
    if (shapes) globe.setImage('detailMap', mapTexture(shapes.land, shapes.borders, DETAIL_SIZE, DETAIL_SIZE, box))
    detailBox = box
  } catch {
  } finally {
    detailKey = key
    detailBusy = false
  }
}

const loadQuakes = async () => {
  try {
    const { response, age, stale } = await fetchFeed('/api/quakes')
    quakes = parseQuakes(await response.json())
    quakesAt = Date.now() - age
    quakesOffline = stale
    if (selection?.kind === 'quake') {
      const id = selection.quake.id
      selection = { kind: 'quake', quake: quakes.find(quake => quake.id === id) ?? selection.quake }
    }
    updateMarkers()
  } catch {
    quakesOffline = true
  }
  renderAll()
}

const loadPlanes = async () => {
  try {
    planes = fromRows(await loadJson('/api/planes'))
    planesAt = planes.reduce((latest, plane) => Math.max(latest, plane.time), 0)
    planeBase = Date.now()
    if (selection?.kind === 'plane') {
      const id = selection.plane.id
      selection = { kind: 'plane', plane: planes.find(plane => plane.id === id) ?? selection.plane }
    }
    updatePlanes()
  } catch {
    planesState = planes.length ? planesState : 'offline'
  }
  renderAll()
}

const loadSatellites = async () => {
  try {
    const { response } = await fetchFeed('/api/satellites')
    worker.postMessage({ type: 'catalog', text: await response.text() })
  } catch {
    satellitesState = catalog.length ? satellitesState : 'offline'
    renderAll()
  }
}

const loadRecords = async () => {
  try {
    const data = await loadJson('/api/satinfo')
    purposes = Array.isArray(data.purposes) ? data.purposes.map(String) : []
    records = new Map((Array.isArray(data.rows) ? data.rows : []).flatMap((row: unknown[]) => Array.isArray(row) && typeof row[0] === 'number'
      ? [[row[0], { owner: String(row[1]), launch: String(row[2]), site: String(row[3]), rcs: typeof row[4] === 'number' ? row[4] : null, purpose: Number(row[5]) }]] : []))
    askPasses()
    renderAll()
  } catch {}
}

const loadLaunches = async () => {
  try {
    launches = await loadJson('/api/launches')
    updateMarkers()
    renderAll()
  } catch {}
}

const loadVolcanoes = async () => {
  try {
    volcanoes = await loadJson('/api/volcanoes')
    updateMarkers()
    renderAll()
  } catch {}
}

const loadAurora = async () => {
  try {
    const data = await loadJson('/api/aurora')
    const grid = Uint8Array.from(atob(String(data.grid)), c => c.charCodeAt(0))
    if (grid.length !== 360 * 181) return
    aurora = { kp: typeof data.kp === 'number' ? data.kp : null, kpTime: String(data.kpTime ?? ''), forecast: String(data.forecast ?? ''), grid }
    globe.setAurora(grid)
    renderAll()
  } catch {}
}

const loadMap = async () => {
  const topology = (await (await fetchFeed('/api/map', 'default')).response.json())
  shapes = { land: polygons(topology, 'land'), borders: borders(topology, 'countries') }
  globe.setImage('land', SMALL ? mapTexture(shapes.land, shapes.borders, 2048, 1024) : mapTexture(shapes.land, shapes.borders))
  countryAt = countryFinder(features(topology, 'countries'))
  renderAll()
}

const withLights = (marble: ImageBitmap, lights: ImageBitmap) => {
  const pixels = (image: ImageBitmap) => {
    const draw = document.createElement('canvas')
    Object.assign(draw, { width: 2048, height: 1024 })
    const ctx = draw.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(image, 0, 0, 2048, 1024)
    return ctx.getImageData(0, 0, 2048, 1024)
  }
  const base = pixels(marble)
  const glow = pixels(lights).data
  for (let i = 0; i < glow.length; i += 4) base.data[i + 3] = glow[i]
  return base
}

const loadEarth = async () => {
  const [marble, lights] = await Promise.all([loadBitmap('/api/bluemarble'), loadBitmap('/api/lights')])
  globe.setImage('base', withLights(marble, lights))
  photoReady = true
  const { response } = await fetchFeed(SMALL ? '/api/earth-small' : '/api/earth', 'default')
  earthDate = response.headers.get('x-overhead-note') || earthDate
  globe.setImage('today', await createImageBitmap(await response.blob()))
}

worker.onmessage = ({ data }) => {
  if (data.type === 'catalog') {
    const selectedId = selection?.kind === 'satellite' ? catalog[selection.index]?.id : null
    catalog = data.satellites
    globe.setSatelliteStyle(new Float32Array(catalog.flatMap(sat => SAT_STYLE[sat.group])))
    if (selectedId !== null) {
      const index = catalog.findIndex(sat => sat.id === selectedId)
      selection = index >= 0 ? { kind: 'satellite', index } : null
    }
    resetFrames()
    askPasses()
    renderAll()
  }
  if (data.type === 'frame' && data.gen === generation) {
    asking = false
    const frame = { time: data.time, positions: data.positions }
    prev = next && next.time < frame.time ? next : frame
    next = frame
    globe.setSatellites(prev.positions, next.positions)
    if (data.selected) {
      detail = data.selected
      renderCard()
    }
    above = data.above
    if (tab === 'above') renderAbove()
  }
  if (data.type === 'passes') {
    if (data.key === 'stations') stationPasses = data.passes
    else if (data.key === 'bright') {
      const now = Date.now()
      brightPasses = Object.entries(data.passes as Record<string, Pass[]>)
        .flatMap(([index, list]) => list.map(pass => ({ index: Number(index), pass })))
        .filter(({ pass }) => pass.end > now)
        .sort((a, b) => a.pass.start - b.pass.start)
    } else if (selection?.kind === 'satellite' && data.key === `sat:${selection.index}`) selectedPasses = data.passes[selection.index] ?? []
    if (tab === 'above') renderAbove()
    renderCard()
  }
}

const degreesPerPixel = () => (view.distance - 1) * 2 * TAN_HALF_FOV / canvas.clientHeight / RADIANS

const pick = (clientX: number, clientY: number) => {
  const rect = canvas.getBoundingClientRect()
  const rows = viewMatrix(view)
  const aspect = rect.width / rect.height
  let best: Selection = null
  let bestScore = PICK_PIXELS
  const consider = (position: Vec3 | null, weight: number, make: () => Selection) => {
    const point = position && project(rotate(rows, position), view.distance, aspect)
    if (!point) return
    const score = Math.hypot((point.x + 1) / 2 * rect.width + rect.left - clientX, (1 - point.y) / 2 * rect.height + rect.top - clientY) * weight
    if (score < bestScore) [best, bestScore] = [make(), score]
  }
  if (show.launches) for (const launch of launches) consider(toVector(launch.lat, launch.lon, GROUND), 0.7, () => ({ kind: 'launch', launch }))
  if (show.volcanoes) for (const volcano of volcanoes) consider(toVector(volcano.lat, volcano.lon, GROUND), 0.75, () => ({ kind: 'volcano', volcano }))
  if (show.quakes) for (const quake of visibleQuakes()) consider(toVector(quake.lat, quake.lon, GROUND), 0.9, () => ({ kind: 'quake', quake }))
  if (show.planes) for (const plane of planes) consider(planePosition(plane), 1, () => ({ kind: 'plane', plane }))
  if (show.satellites) catalog.forEach((sat, index) => consider(satPosition(index), sat.group === 0 ? 0.5 : 1.3, () => ({ kind: 'satellite', index })))
  select(best)
}

const pointers = new Map<number, { x: number, y: number }>()
let travelled = 0

canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  travelled = 0
  flight = null
  velocity = { lat: 0, lon: 0 }
  lastInteraction = performance.now()
})

canvas.addEventListener('pointermove', event => {
  const previous = pointers.get(event.pointerId)
  if (!previous) return
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const before = Math.hypot(a.x - b.x, a.y - b.y)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const [c, d] = [...pointers.values()]
    const after = Math.hypot(c.x - d.x, c.y - d.y)
    if (before > 0 && after > 0) view.distance = zoom(1 + (view.distance - 1) * before / after)
  } else {
    const dx = event.clientX - previous.x
    const dy = event.clientY - previous.y
    const k = degreesPerPixel()
    velocity = { lat: dy * k, lon: -dx * k }
    view.lon = wrapLon(view.lon + velocity.lon)
    view.lat = clampLat(view.lat + velocity.lat)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    travelled += Math.abs(dx) + Math.abs(dy)
    if (travelled > 6 && following) {
      following = false
      renderCard()
    }
  }
  lastInteraction = performance.now()
})

const release = (event: PointerEvent) => {
  if (!pointers.delete(event.pointerId)) return
  if (event.type === 'pointerup' && pointers.size === 0 && travelled < 6) pick(event.clientX, event.clientY)
}
canvas.addEventListener('pointerup', release)
canvas.addEventListener('pointercancel', release)

canvas.addEventListener('wheel', event => {
  event.preventDefault()
  const factor = Math.exp(event.deltaY * 0.002)
  if (flight) flight.to.distance = zoom(1 + (flight.to.distance - 1) * factor)
  view.distance = zoom(1 + (view.distance - 1) * factor)
  lastInteraction = performance.now()
}, { passive: false })

sky.addEventListener('click', event => {
  const box = sky.getBoundingClientRect()
  const [x, y] = [event.clientX - box.left, event.clientY - box.top]
  const nearest = skyDots.reduce<{ dot: SkyDot, gap: number } | null>((best, placed) => {
    const gap = Math.hypot(placed.x - x, placed.y - y)
    return gap < 14 && (!best || gap < best.gap) ? { dot: placed.dot, gap } : best
  }, null)
  nearest?.dot.pick()
})

for (const node of document.querySelectorAll<HTMLButtonElement>('[data-layer]')) {
  node.addEventListener('click', () => {
    const layer = node.dataset.layer as Layer
    show[layer] = !show[layer]
    if (!show[layer] && selection && LAYER_OF[selection.kind] === layer) select(null)
    renderLayers()
  })
}

for (const node of document.querySelectorAll<HTMLButtonElement>('[data-style]')) {
  node.addEventListener('click', () => {
    photo = node.dataset.style === 'photo'
    renderLayers()
  })
}

for (const node of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  node.addEventListener('click', () => {
    if (phone.matches && sheet === 0) setSheet(1)
    tab = node.dataset.tab!
    renderTab()
  })
}

for (const node of document.querySelectorAll<HTMLButtonElement>('[data-earth]')) {
  node.addEventListener('click', () => {
    earthView = node.dataset.earth!
    renderEarth()
  })
}

for (const node of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
  node.addEventListener('click', () => {
    const now = Date.now()
    const current = clockBase.sim + (now - clockBase.real) * speed
    speed = Number(node.dataset.speed)
    clockBase = { real: now, sim: speed === 1 ? now : current }
    if (speed === 1) resetFrames()
    for (const other of document.querySelectorAll('[data-speed]')) other.setAttribute('aria-pressed', String(other === node))
  })
}

$<HTMLInputElement>('#sat-search').addEventListener('input', event => {
  satQuery = (event.target as HTMLInputElement).value
  renderSatellites()
})

$<HTMLInputElement>('#plane-search').addEventListener('input', event => {
  planeQuery = (event.target as HTMLInputElement).value
  renderPlanes()
})

const locate = (fly: boolean) => {
  $('#observer').textContent = 'Finding you…'
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    observer = { lat: coords.latitude, lon: coords.longitude, label: 'Your location', accuracy: coords.accuracy }
    try {
      localStorage.setItem(HOME_KEY, JSON.stringify({ lat: observer.lat, lon: observer.lon, accuracy: observer.accuracy }))
    } catch {}
    brightPasses = null
    resetFrames()
    askPasses()
    if (fly) {
      select(null)
      flyTo(observer.lat, observer.lon, 1 + Math.max(600, Math.min(observer.accuracy * 6, 20_000)) / EARTH_M, 3_500)
    }
    renderAll()
  }, () => {
    observer = { ...observer, label: observer.accuracy ? 'Your location' : `${DURBAN.label}. Location was not shared` }
    renderAbove()
  }, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 })
}

$('#locate').addEventListener('click', () => locate(true))

const skyObjects = (): SkyObject[] => {
  const items: SkyObject[] = STARS.map(([name, ra, dec]) => ({ ...horizontal(ra * 15, dec, observer, simTime), color: '#fff8e8', size: 2.5, label: name, detail: `${name}, a star` }))
  const lunar = moon(simTime)
  items.push({ ...horizontal(lunar.ra, lunar.dec, observer, simTime), color: '#e8e4d8', size: 14, label: 'Moon', detail: `The Moon, ${Math.round(lunar.lit * 100)}% lit` })
  items.push({ ...lookAngles(observer, sunDirection(simTime).map(v => v * 1.5e8) as Vec3), color: '#ffd166', size: 16, label: 'Sun', detail: 'The Sun. Don’t look straight at it' })
  for (let i = 0; i < above.all.length; i += 3) {
    const sat = catalog[above.all[i]]
    const position = satPosition(above.all[i])
    if (!sat) continue
    items.push({
      azimuth: above.all[i + 1], elevation: above.all[i + 2], color: SAT_COLORS[sat.group], size: sat.group === 0 ? 6 : 2.5,
      label: sat.group === 0 ? sat.name.replace(/ \(.*\)/, '') : undefined,
      detail: `${sat.name}${position ? `, ${number(heightKm(position))} km up` : ''}, ${(purposes[records.get(sat.id)?.purpose ?? -1] ?? GROUPS[sat.group]).toLowerCase()}`
    })
  }
  for (const { plane, distance } of nearestPlanes(80)) {
    if (distance > SKY_PLANES_KM) break
    const { lat, lon } = planeGround(plane)
    const look = lookAngles(observer, surface(lat, lon, 6371 + plane.altitudeM / 1000))
    if (look.elevation > 0) items.push({ ...look, color: altitudeColor(plane.altitudeM / 1000), size: 4, label: plane.callsign || undefined, detail: `${plane.callsign || 'A plane'}, ${number(plane.altitudeM)} m up, ${number(distance)} km away` })
  }
  return items.filter(item => item.elevation > -1)
}

for (const node of document.querySelectorAll('[data-ar]')) {
  node.addEventListener('click', () => {
    if (!observer.accuracy) locate(false)
    openAr(skyObjects)
  })
}

canvas.addEventListener('dblclick', event => {
  const box = canvas.getBoundingClientRect()
  const ground = groundAt((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2)
  if (ground) flyTo(ground.lat, ground.lon, 1 + (view.distance - 1) / 3, 700)
})

const panel = $('.panel')
const phone = matchMedia('(max-width: 760px)')
const SHEETS = [92, 0.45, 0.88]
let sheet = 1
const sheetPixels = (state: number) => state === 0 ? SHEETS[0] : innerHeight * SHEETS[state]
const setSheet = (state: number) => {
  sheet = state
  document.documentElement.style.setProperty('--sheet', `${sheetPixels(state)}px`)
}
let pull: { y: number, height: number, moved: number } | null = null
const handle = $('.handle')
handle.addEventListener('pointerdown', event => {
  handle.setPointerCapture(event.pointerId)
  pull = { y: event.clientY, height: panel.getBoundingClientRect().height, moved: 0 }
})
handle.addEventListener('pointermove', event => {
  if (!pull) return
  pull.moved = Math.max(pull.moved, Math.abs(event.clientY - pull.y))
  const height = Math.max(SHEETS[0], Math.min(innerHeight * 0.92, pull.height - (event.clientY - pull.y)))
  document.documentElement.style.setProperty('--sheet', `${height}px`)
})
handle.addEventListener('pointerup', () => {
  if (!pull) return
  const height = panel.getBoundingClientRect().height
  setSheet(pull.moved < 6 ? (sheet + 1) % 3 : [0, 1, 2].reduce((best, state) => Math.abs(sheetPixels(state) - height) < Math.abs(sheetPixels(best) - height) ? state : best, 0))
  pull = null
})
addEventListener('resize', () => setSheet(sheet))
setSheet(1)
navigator.permissions?.query({ name: 'geolocation' }).then(state => { if (state.state === 'granted') locate(false) }).catch(() => {})

const tileX = (lon: number, z: number) => (lon + 180) / 360 * 2 ** z
const tileY = (lat: number, z: number) => (1 - Math.log(Math.tan(lat * RADIANS) + 1 / Math.cos(lat * RADIANS)) / Math.PI) / 2 * 2 ** z
const tileLon = (x: number, z: number) => x / 2 ** z * 360 - 180
const tileLat = (y: number, z: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / RADIANS

const refreshStreet = async () => {
  if (streetBusy || flight || pointers.size || performance.now() - lastInteraction < 300 || view.distance > STREET_FROM) return
  const across = (view.distance - 1) * EARTH_M * 2 * TAN_HALF_FOV * canvas.clientWidth / canvas.clientHeight
  const wanted = Math.max(3, Math.min(19, Math.floor(Math.log2(TILES * TILE * 156_543.03 * Math.cos(view.lat * RADIANS) / (across * 1.4)))))
  const ask = `${wanted}/${Math.floor(tileX(view.lon, wanted))}/${Math.floor(tileY(view.lat, wanted))}`
  if (ask === streetWanted) return
  streetBusy = true
  streetWanted = ask
  let z = wanted
  while (z > Math.max(3, wanted - 5)) {
    const centre = await fetch(`/api/tile?z=${z}&x=${Math.floor(tileX(view.lon, z))}&y=${Math.floor(tileY(view.lat, z))}`).catch(() => null)
    if (centre?.status !== 404) break
    z--
  }
  const [x0, y0] = [Math.floor(tileX(view.lon, z) - TILES / 2), Math.floor(tileY(view.lat, z) - TILES / 2)]
  const key = `${z}/${x0}/${y0}`
  if (key === streetKey) {
    streetBusy = false
    return
  }
  const mosaic = document.createElement('canvas')
  Object.assign(mosaic, { width: TILES * TILE, height: TILES * TILE })
  const ctx = mosaic.getContext('2d')!
  const jobs: Promise<void>[] = []
  for (let i = 0; i < TILES; i++) {
    for (let j = 0; j < TILES; j++) {
      const [x, y] = [((x0 + i) % 2 ** z + 2 ** z) % 2 ** z, y0 + j]
      if (y < 0 || y >= 2 ** z) continue
      jobs.push(fetch(`/api/tile?z=${z}&x=${x}&y=${y}`)
        .then(async response => { if (response.ok) ctx.drawImage(await createImageBitmap(await response.blob()), i * TILE, j * TILE) })
        .catch(() => {}))
    }
  }
  await Promise.all(jobs)
  globe.setImage('street', mosaic)
  street = [tileLon(x0, z), tileLat(y0 + TILES, z), tileLon(x0 + TILES, z), tileLat(y0, z)]
  streetKey = key
  streetBusy = false
}

const coverage = (box: number[] | null, seen: number[] | null) => {
  if (!box || !seen) return 0
  const width = Math.min(box[2], seen[2]) - Math.max(box[0], seen[0])
  const height = Math.min(box[3], seen[3]) - Math.max(box[1], seen[1])
  return width > 0 && height > 0 ? width * height / ((seen[2] - seen[0]) * (seen[3] - seen[1])) : 0
}
const covers = (box: number[] | null, seen: number[] | null) => coverage(box, seen) >= 0.3

const towards = (value: number, target: number, dt: number) => value + Math.max(-dt * 5, Math.min(dt * 2.5, target - value))

const updatePatches = (dt: number) => {
  const seen = visibleBox()
  fades.detail = towards(fades.detail, covers(detailBox, seen) ? 1 : 0, dt)
  fades.ground = towards(fades.ground, covers(groundBox, seen) ? 1 : 0, dt)
  fades.clear = towards(fades.clear, view.distance < CLEAR_BELOW && coverage(groundBox, seen) > 0.97 ? 1 : 0, dt)
  fades.street = towards(fades.street, view.distance <= STREET_FROM * 1.05 && covers(street, seen) ? 1 : 0, dt)
  globe.setDetail(detailBox, fades.detail)
  globe.setGround(groundBox, fades.ground, fades.clear)
  if (!street || !fades.street) {
    globe.setStreet(null, 0)
    return
  }
  const rows = viewMatrix(view)
  const [west, south, east, north] = street
  const [lat, lon] = [(south + north) / 2, (west + east) / 2]
  const at = (a: number, b: number) => rotate(rows, toVector(a, b))
  globe.setStreet([at(lat, west)[0], at(south, lon)[1], at(lat, east)[0], at(north, lon)[1]], fades.street)
}

const frameRoute = (plane: Plane, route: Route) => {
  const points = [toVector(route.from.lat, route.from.lon), planePosition(plane), toVector(route.to.lat, route.to.lon)]
  const sum = points.reduce((total, p) => total.map((v, k) => v + p[k]) as Vec3)
  const length = Math.hypot(...sum)
  const middle = sum.map(v => v / length) as Vec3
  const spread = Math.max(...points.map(p => Math.acos(Math.min(1, (p[0] * middle[0] + p[1] * middle[1] + p[2] * middle[2]) / Math.hypot(...p)))))
  const box = canvas.getBoundingClientRect()
  const panel = $('.panel').getBoundingClientRect()
  const beside = card.getBoundingClientRect()
  const left = !card.hidden && beside.right < box.left + box.width / 2 ? Math.max(box.left, beside.right) : box.left
  const right = panel.left > box.left + box.width / 2 ? Math.min(box.right, panel.left) : box.right
  const fit = zoom(Math.max(1.15, Math.cos(spread) + Math.sin(spread) / (0.5 * TAN_HALF_FOV * Math.min(1, (right - left) / box.height))))
  const shift = ((left + right) - (box.left + box.right)) / 2 * (fit - 1) * 2 * TAN_HALF_FOV / box.height
  const { lat, lon } = toLatLon(middle)
  following = false
  flyTo(lat, lon - shift / RADIANS / Math.cos(lat * RADIANS), fit)
}

const updateTag = () => {
  const position = positionOf(selection)
  const rect = canvas.getBoundingClientRect()
  const rows = viewMatrix(view)
  const route = selection?.kind === 'plane' && planeDetail?.id === selection.plane.id ? planeDetail.data?.route : null
  airportTags.forEach((label, i) => {
    const airport = route && [route.from, route.to][i]
    const spot = airport && project(rotate(rows, toVector(airport.lat, airport.lon, GROUND)), view.distance, rect.width / rect.height)
    label.hidden = !spot
    if (!spot || !airport) return
    label.textContent = airport.iata || airport.city || airport.name
    label.style.transform = `translate(${(spot.x + 1) / 2 * rect.width + rect.left + 10}px, ${(1 - spot.y) / 2 * rect.height + rect.top - 12}px)`
  })
  const home = project(rotate(rows, toVector(observer.lat, observer.lon, GROUND)), view.distance, rect.width / rect.height)
  youTag.hidden = !home || !observer.accuracy || view.distance > 1.5
  if (home) youTag.style.transform = `translate(${(home.x + 1) / 2 * rect.width + rect.left + 10}px, ${(1 - home.y) / 2 * rect.height + rect.top - 12}px)`
  const point = position && project(rotate(rows, position), view.distance, rect.width / rect.height)
  tag.hidden = !point
  if (!point || !selection) return
  tag.textContent = selection.kind === 'quake' ? `M${selection.quake.magnitude.toFixed(1)}`
    : selection.kind === 'plane' ? `${selection.plane.callsign || selection.plane.id.toUpperCase()} · ${number(selection.plane.altitudeM)} m`
      : selection.kind === 'launch' ? `${selection.launch.rocket || selection.launch.name} · ${countdown(selection.launch.time)}`
        : selection.kind === 'volcano' ? selection.volcano.name
          : `${catalog[selection.index].name} · ${number(heightKm(position))} km`
  tag.style.transform = `translate(${(point.x + 1) / 2 * rect.width + rect.left + 14}px, ${(1 - point.y) / 2 * rect.height + rect.top - 12}px)`
}

const renderClock = () => {
  const ahead = simTime - Date.now()
  const date = new Date(simTime)
  clock.textContent = `${date.toLocaleDateString([], { weekday: 'short' })} ${date.toLocaleTimeString()}${ahead > 60_000 ? ` · ${ahead < HOUR ? `${Math.round(ahead / MINUTE)} min` : `${(ahead / HOUR).toFixed(1)} h`} ahead` : ''}`
}

let last = performance.now()
const frame = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  simTime = clockBase.sim + (Date.now() - clockBase.real) * speed
  if (catalog.length && !asking) {
    if (!next) askFrame(simTime)
    else if (simTime >= next.time - speed * 400) askFrame(Math.max(simTime, next.time) + speed * 1000)
  }
  const ground = following ? groundOf(selection) : null
  if (flight) {
    if (ground) Object.assign(flight.to, { lat: clampLat(ground.lat), lon: flight.from.lon + wrapLon(ground.lon - flight.from.lon) })
    const k = Math.min(1, (now - flight.start) / flight.duration)
    const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
    for (const key of ['lat', 'lon'] as const) view[key] = flight.from[key] + (flight.to[key] - flight.from[key]) * ease
    view.distance = 1 + (flight.from.distance - 1) * ((flight.to.distance - 1) / (flight.from.distance - 1)) ** ease
    if (k === 1) flight = null
  } else if (ground && pointers.size === 0) {
    Object.assign(view, { lat: clampLat(ground.lat), lon: ground.lon })
  } else if (pointers.size === 0) {
    view.lon = wrapLon(view.lon + velocity.lon)
    view.lat = clampLat(view.lat + velocity.lat)
    velocity = { lat: velocity.lat * 0.92, lon: velocity.lon * 0.92 }
    if (now - lastInteraction > IDLE_MS && !selection && view.distance > DETAIL_FROM) view.lon = wrapLon(view.lon - SPIN_DEGREES_PER_SECOND * dt)
  }
  const sun = subsolarPoint(new Date(simTime))
  updateMarks()
  updateLines()
  updatePatches(dt)
  updateTag()
  globe.render({
    view, sun: toVector(sun.lat, sun.lon), time: now / 1000, blend: blend(),
    planeNow: (simTime - planeBase) / 1000, photo: photo && photoReady, show
  })
  requestAnimationFrame(frame)
}

try {
  globe = new Globe(canvas)
  const aspect = canvas.clientWidth / canvas.clientHeight
  if (aspect < 1) view.distance = zoom(Math.sqrt(1 + (1 / (TAN_HALF_FOV * aspect * 0.9)) ** 2))
  renderAll()
  loadMap().catch(() => { $('#status').textContent = 'Could not load the map outline.' })
  loadEarth().catch(() => {})
  loadQuakes()
  loadPlanes()
  loadSatellites()
  loadRecords()
  loadLaunches()
  loadVolcanoes()
  loadAurora()
  setInterval(loadQuakes, MINUTE)
  setInterval(loadPlanes, 2 * MINUTE)
  setInterval(loadSatellites, 2 * HOUR)
  setInterval(loadRecords, 24 * HOUR)
  setInterval(loadLaunches, HOUR)
  setInterval(loadVolcanoes, 6 * HOUR)
  setInterval(loadAurora, 10 * MINUTE)
  setInterval(() => loadEarth().catch(() => {}), 6 * HOUR)
  setInterval(askPasses, 10 * MINUTE)
  setInterval(refreshDetail, 500)
  setInterval(refreshStreet, 400)
  setInterval(renderClock, 250)
  setInterval(() => {
    renderCard()
    renderLayers()
    if (tab === 'planes' || tab === 'earth' || tab === 'launches') renderTab()
  }, 2_000)
  setInterval(() => { if (tab === 'stats') renderStats() }, 15_000)
  setInterval(updateMarkers, 5_000)
  requestAnimationFrame(frame)
} catch (error) {
  tab = 'earth'
  renderTab()
  $('#status').textContent = `This browser can't draw the globe: ${error instanceof Error ? error.message : error}`
}
