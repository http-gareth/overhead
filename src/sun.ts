import { RADIANS, wrapLon } from './geo.ts'

const J2000 = Date.UTC(2000, 0, 1, 12)
const DAY_MS = 86_400_000

export const subsolarPoint = (date: Date) => {
  const d = (date.getTime() - J2000) / DAY_MS
  const meanAnomaly = (357.529 + 0.98560028 * d) * RADIANS
  const meanLongitude = 280.459 + 0.98564736 * d
  const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * RADIANS
  const obliquity = (23.439 - 0.00000036 * d) * RADIANS
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) / RADIANS
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude)) / RADIANS
  const siderealDegrees = (18.697374558 + 24.06570982441908 * d) * 15
  return { lat: declination, lon: wrapLon(rightAscension - siderealDegrees) }
}
