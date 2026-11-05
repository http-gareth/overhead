import { RADIANS } from './geo.ts'

export type Plane = {
  id: string
  callsign: string
  country: string
  lat: number
  lon: number
  altitudeM: number
  speedMs: number
  track: number
  climbMs: number
  time: number
}

export const MAX_ESTIMATE_MS = 30 * 60_000
const EARTH_RADIUS_M = 6_371_000

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown, max: number, pattern: RegExp) =>
  typeof value === 'string' ? value.trim().slice(0, max).replace(pattern, '') : ''

export const fromOpenSky = (feed: unknown): Plane[] => {
  const states = (feed as { states?: unknown })?.states
  if (!Array.isArray(states)) return []
  return states.flatMap(state => {
    if (!Array.isArray(state)) return []
    const [icao24, callsign, country, timePosition, lastContact, lon, lat, baroAltitude, onGround, velocity, track, verticalRate, , geoAltitude] = state
    const time = finite(timePosition) ? timePosition : lastContact
    if (onGround !== false || !finite(lat) || !finite(lon) || !finite(velocity) || !finite(track) || !finite(time)) return []
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || typeof icao24 !== 'string' || !/^[0-9a-f]{6}$/.test(icao24)) return []
    return [{
      id: icao24,
      callsign: text(callsign, 8, /[^A-Z0-9]/g),
      country: text(country, 60, /[^\p{L}\p{N} ,.()'-]/gu),
      lat,
      lon,
      altitudeM: finite(geoAltitude) ? geoAltitude : finite(baroAltitude) ? baroAltitude : 0,
      speedMs: velocity,
      track,
      climbMs: finite(verticalRate) ? verticalRate : 0,
      time: time * 1000
    }]
  })
}

export const toRows = (planes: Plane[]) => planes.map(p => [p.id, p.callsign, p.country, p.lat, p.lon, Math.round(p.altitudeM), p.speedMs, p.track, p.climbMs, p.time])

export const fromRows = (rows: unknown): Plane[] => Array.isArray(rows)
  ? rows.flatMap(row => fromOpenSky({
    states: [Array.isArray(row) ? [row[0], row[1], row[2], row[9] / 1000, row[9] / 1000, row[4], row[3], row[5], false, row[6], row[7], row[8], null, row[5]] : null]
  }))
  : []

export const estimate = (plane: Plane, time: number) => {
  const seconds = Math.max(0, Math.min(time - plane.time, MAX_ESTIMATE_MS)) / 1000
  const angular = plane.speedMs * seconds / EARTH_RADIUS_M
  const heading = plane.track * RADIANS
  const lat1 = plane.lat * RADIANS
  const lon1 = plane.lon * RADIANS
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(heading))
  const lon2 = lon1 + Math.atan2(Math.sin(heading) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2))
  return { lat: lat2 / RADIANS, lon: ((lon2 / RADIANS + 540) % 360 + 360) % 360 - 180 }
}
