import { EARTH_RADIUS_KM, earthFixed, gmst, propagate } from './sgp4.ts'
import type { Satellite } from './sgp4.ts'
import { lookAngles } from './passes.ts'
import type { Observer } from './passes.ts'

export const GROUPS = ['Space stations', 'Starlink', 'Navigation', 'Geostationary', 'Other'] as const
export const STATIONS = new Set([25544, 48274])

export const groupOf = (sat: Satellite) =>
  STATIONS.has(sat.id) ? 0
    : /^STARLINK/.test(sat.name) ? 1
      : /GPS|NAVSTAR|GLONASS|GALILEO|BEIDOU|IRNSS|NAVIC|QZS/.test(sat.name) ? 2
        : sat.periodMinutes > 1300 && sat.periodMinutes < 1600 && sat.inclination < 20 ? 3
          : 4

export const toGlobe = ([x, y, z]: number[]) => [y / EARTH_RADIUS_KM, z / EARTH_RADIUS_KM, x / EARTH_RADIUS_KM]
export const fromGlobe = (globe: ArrayLike<number>, i = 0) =>
  [globe[i + 2] * EARTH_RADIUS_KM, globe[i] * EARTH_RADIUS_KM, globe[i + 1] * EARTH_RADIUS_KM] as [number, number, number]

export const positions = (sats: Satellite[], time: number) => {
  const out = new Float32Array(sats.length * 3)
  sats.forEach((sat, i) => {
    const fix = earthFixed(sat, time)
    if (fix) out.set(toGlobe(fix.position), i * 3)
  })
  return out
}

export const orbit = (sat: Satellite, time: number, samples = 180) => {
  const theta = gmst(time)
  const [c, s] = [Math.cos(theta), Math.sin(theta)]
  const minutes = (time - sat.epoch) / 60_000
  const points: number[] = []
  for (let i = 0; i <= samples; i++) {
    const state = propagate(sat.model, minutes + sat.periodMinutes * i / samples)
    if (!state) break
    const [x, y, z] = state.position
    points.push(...toGlobe([x * c + y * s, -x * s + y * c, z]))
  }
  return new Float32Array(points)
}

export const overhead = (frame: Float32Array, observer: Observer) => {
  const found: { index: number, elevation: number, azimuth: number, rangeKm: number }[] = []
  for (let i = 0; i < frame.length; i += 3) {
    if (!frame[i] && !frame[i + 1] && !frame[i + 2]) continue
    const look = lookAngles(observer, fromGlobe(frame, i))
    if (look.elevation > 0) found.push({ index: i / 3, ...look })
  }
  return found.sort((a, b) => b.elevation - a.elevation)
}
