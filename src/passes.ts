import { RADIANS } from './geo.ts'
import { EARTH_RADIUS_KM, earthFixed } from './sgp4.ts'
import type { Satellite } from './sgp4.ts'
import { subsolarPoint } from './sun.ts'

type Vec = [number, number, number]
export type Observer = { lat: number, lon: number }
export type Pass = {
  start: number, peak: number, end: number
  maxElevation: number, startAzimuth: number, peakAzimuth: number, endAzimuth: number
  visible: boolean
}

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const asinDegrees = (value: number) => Math.asin(Math.max(-1, Math.min(1, value))) / RADIANS

export const surface = (lat: number, lon: number, radius = 1): Vec => {
  const phi = lat * RADIANS
  const lambda = lon * RADIANS
  return [radius * Math.cos(phi) * Math.cos(lambda), radius * Math.cos(phi) * Math.sin(lambda), radius * Math.sin(phi)]
}

export const lookAngles = (observer: Observer, target: Vec) => {
  const phi = observer.lat * RADIANS
  const lambda = observer.lon * RADIANS
  const origin = surface(observer.lat, observer.lon, EARTH_RADIUS_KM)
  const d: Vec = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]]
  const east: Vec = [-Math.sin(lambda), Math.cos(lambda), 0]
  const north: Vec = [-Math.sin(phi) * Math.cos(lambda), -Math.sin(phi) * Math.sin(lambda), Math.cos(phi)]
  const up = surface(observer.lat, observer.lon)
  const rangeKm = Math.hypot(...d)
  return {
    elevation: asinDegrees(dot(d, up) / rangeKm),
    azimuth: (Math.atan2(dot(d, east), dot(d, north)) / RADIANS + 360) % 360,
    rangeKm
  }
}

export const sunDirection = (time: number) => {
  const { lat, lon } = subsolarPoint(new Date(time))
  return surface(lat, lon)
}

export const sunElevation = (observer: Observer, time: number) =>
  asinDegrees(dot(surface(observer.lat, observer.lon), sunDirection(time)))

export const sunlit = (position: Vec, sun: Vec) => {
  const along = dot(position, sun)
  if (along > 0) return true
  return Math.hypot(position[0] - along * sun[0], position[1] - along * sun[1], position[2] - along * sun[2]) > EARTH_RADIUS_KM
}

export const passes = (sat: Satellite, observer: Observer, from: number, hours = 48, stepSeconds = 20, minElevation = 10) => {
  const found: Pass[] = []
  let current: Pass | null = null
  for (let time = from; time <= from + hours * 3_600_000; time += stepSeconds * 1000) {
    const fix = earthFixed(sat, time)
    if (!fix) continue
    const { elevation, azimuth } = lookAngles(observer, fix.position)
    if (elevation < minElevation) {
      if (current) found.push(current)
      current = null
      continue
    }
    const seen = sunElevation(observer, time) < -6 && sunlit(fix.position, sunDirection(time))
    if (!current) {
      current = { start: time, peak: time, end: time, maxElevation: elevation, startAzimuth: azimuth, peakAzimuth: azimuth, endAzimuth: azimuth, visible: seen }
      continue
    }
    current.end = time
    current.endAzimuth = azimuth
    current.visible ||= seen
    if (elevation > current.maxElevation) Object.assign(current, { peak: time, maxElevation: elevation, peakAzimuth: azimuth })
  }
  if (current) found.push(current)
  return found
}

export const compass = (azimuth: number) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(azimuth / 45) % 8]
