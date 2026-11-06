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

const FEET = 0.3048
const KNOTS = 0.514444
const FEET_PER_MINUTE = 0.00508

const BLOCKS: [number, number, string][] = [
  [0x004000, 0x0043ff, 'Zimbabwe'], [0x006000, 0x006fff, 'Mozambique'], [0x008000, 0x00ffff, 'South Africa'], [0x010000, 0x017fff, 'Egypt'],
  [0x018000, 0x01ffff, 'Libya'], [0x020000, 0x027fff, 'Morocco'], [0x028000, 0x02ffff, 'Tunisia'], [0x030000, 0x0303ff, 'Botswana'],
  [0x040000, 0x040fff, 'Ethiopia'], [0x04c000, 0x04cfff, 'Kenya'], [0x064000, 0x064fff, 'Nigeria'], [0x06a000, 0x06a3ff, 'Qatar'],
  [0x080000, 0x080fff, 'Tanzania'], [0x0a0000, 0x0a7fff, 'Algeria'], [0x0ac000, 0x0acfff, 'Colombia'], [0x0d0000, 0x0d7fff, 'Mexico'],
  [0x0d8000, 0x0dffff, 'Venezuela'], [0x100000, 0x1fffff, 'Russia'], [0x300000, 0x33ffff, 'Italy'], [0x340000, 0x37ffff, 'Spain'],
  [0x380000, 0x3bffff, 'France'], [0x3c0000, 0x3fffff, 'Germany'], [0x400000, 0x43ffff, 'United Kingdom'], [0x440000, 0x447fff, 'Austria'],
  [0x448000, 0x44ffff, 'Belgium'], [0x450000, 0x457fff, 'Bulgaria'], [0x458000, 0x45ffff, 'Denmark'], [0x460000, 0x467fff, 'Finland'],
  [0x468000, 0x46ffff, 'Greece'], [0x470000, 0x477fff, 'Hungary'], [0x478000, 0x47ffff, 'Norway'], [0x480000, 0x487fff, 'Netherlands'],
  [0x488000, 0x48ffff, 'Poland'], [0x490000, 0x497fff, 'Portugal'], [0x498000, 0x49ffff, 'Czechia'], [0x4a0000, 0x4a7fff, 'Romania'],
  [0x4a8000, 0x4affff, 'Sweden'], [0x4b0000, 0x4b7fff, 'Switzerland'], [0x4b8000, 0x4bffff, 'Turkey'], [0x4ca000, 0x4cafff, 'Ireland'],
  [0x4cc000, 0x4ccfff, 'Iceland'], [0x4d0000, 0x4d03ff, 'Luxembourg'], [0x4d2000, 0x4d23ff, 'Malta'], [0x508000, 0x50ffff, 'Ukraine'],
  [0x702000, 0x702fff, 'Bangladesh'], [0x706000, 0x706fff, 'Kuwait'], [0x70c000, 0x70c3ff, 'Oman'], [0x710000, 0x717fff, 'Saudi Arabia'],
  [0x718000, 0x71ffff, 'South Korea'], [0x728000, 0x72ffff, 'Iraq'], [0x730000, 0x737fff, 'Iran'], [0x738000, 0x73ffff, 'Israel'],
  [0x740000, 0x747fff, 'Jordan'], [0x748000, 0x74ffff, 'Lebanon'], [0x750000, 0x757fff, 'Malaysia'], [0x758000, 0x75ffff, 'Philippines'],
  [0x760000, 0x767fff, 'Pakistan'], [0x768000, 0x76ffff, 'Singapore'], [0x770000, 0x777fff, 'Sri Lanka'], [0x780000, 0x7bffff, 'China'],
  [0x7c0000, 0x7fffff, 'Australia'], [0x800000, 0x83ffff, 'India'], [0x840000, 0x87ffff, 'Japan'], [0x880000, 0x887fff, 'Thailand'],
  [0x888000, 0x88ffff, 'Vietnam'], [0x894000, 0x894fff, 'Bahrain'], [0x896000, 0x896fff, 'United Arab Emirates'], [0x899000, 0x8993ff, 'Taiwan'],
  [0x8a0000, 0x8a7fff, 'Indonesia'], [0xa00000, 0xafffff, 'United States'], [0xc00000, 0xc3ffff, 'Canada'], [0xc80000, 0xc87fff, 'New Zealand'],
  [0xe00000, 0xe3ffff, 'Argentina'], [0xe40000, 0xe7ffff, 'Brazil'], [0xe80000, 0xe80fff, 'Chile'], [0xe84000, 0xe84fff, 'Ecuador'],
  [0xe8c000, 0xe8cfff, 'Peru']
]

export const countryOf = (hex: string) => {
  const code = parseInt(hex, 16)
  return BLOCKS.find(([start, end]) => code >= start && code <= end)?.[2] ?? ''
}

export const fromAdsbLol = (feed: unknown): Plane[] => {
  const { ac, now } = (feed ?? {}) as { ac?: unknown, now?: unknown }
  if (!Array.isArray(ac) || !finite(now)) return []
  return ac.flatMap(plane => {
    const { hex, flight, lat, lon, alt_baro: baro, alt_geom: geom, gs, track, baro_rate: baroRate, geom_rate: geomRate, seen_pos: seen } = (plane ?? {}) as Record<string, unknown>
    if (typeof hex !== 'string' || !/^[0-9a-f]{6}$/.test(hex) || !finite(lat) || !finite(lon) || !finite(baro) || !finite(gs) || !finite(track)) return []
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return []
    return [{
      id: hex,
      callsign: text(flight, 8, /[^A-Z0-9]/g),
      country: countryOf(hex),
      lat,
      lon,
      altitudeM: (finite(geom) ? geom : baro) * FEET,
      speedMs: gs * KNOTS,
      track,
      climbMs: (finite(geomRate) ? geomRate : finite(baroRate) ? baroRate : 0) * FEET_PER_MINUTE,
      time: now - (finite(seen) ? seen : 0) * 1000
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
