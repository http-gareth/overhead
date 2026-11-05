import { RADIANS } from './geo.ts'
import { gmst } from './sgp4.ts'
import type { Observer } from './passes.ts'

export const STARS: [name: string, raHours: number, decDegrees: number][] = [
  ['Sirius', 6.7525, -16.716], ['Canopus', 6.3992, -52.696], ['Alpha Centauri', 14.66, -60.834], ['Arcturus', 14.261, 19.182],
  ['Vega', 18.6156, 38.784], ['Capella', 5.278, 45.998], ['Rigel', 5.2422, -8.2017], ['Procyon', 7.655, 5.225],
  ['Achernar', 1.6286, -57.237], ['Betelgeuse', 5.9195, 7.407], ['Hadar', 14.0637, -60.373], ['Altair', 19.8464, 8.868],
  ['Acrux (Southern Cross)', 12.4433, -63.099], ['Mimosa (Southern Cross)', 12.7954, -59.689], ['Gacrux (Southern Cross)', 12.5194, -57.113],
  ['Imai (Southern Cross)', 12.2525, -58.749], ['Aldebaran', 4.5987, 16.509], ['Antares', 16.4901, -26.432], ['Spica', 13.4199, -11.161],
  ['Pollux', 7.7553, 28.026], ['Fomalhaut', 22.9608, -29.622], ['Deneb', 20.6905, 45.28], ['Regulus', 10.1395, 11.967], ['Polaris', 2.5303, 89.264]
]

const DAY_MS = 86_400_000
const J2000 = Date.UTC(2000, 0, 1, 12)
const sin = (degrees: number) => Math.sin(degrees * RADIANS)
const cos = (degrees: number) => Math.cos(degrees * RADIANS)

export const horizontal = (raDegrees: number, decDegrees: number, observer: Observer, time: number) => {
  const hourAngle = gmst(time) / RADIANS + observer.lon - raDegrees
  const elevation = Math.asin(sin(decDegrees) * sin(observer.lat) + cos(decDegrees) * cos(observer.lat) * cos(hourAngle)) / RADIANS
  const azimuth = Math.atan2(-cos(decDegrees) * sin(hourAngle), sin(decDegrees) * cos(observer.lat) - cos(decDegrees) * sin(observer.lat) * cos(hourAngle)) / RADIANS
  return { azimuth: (azimuth + 360) % 360, elevation }
}

export const moon = (time: number) => {
  const d = (time - J2000) / DAY_MS
  const anomaly = 134.963 + 13.064993 * d
  const longitude = 218.316 + 13.176396 * d + 6.289 * sin(anomaly)
  const latitude = 5.128 * sin(93.272 + 13.22935 * d)
  const tilt = 23.439
  const ra = Math.atan2(sin(longitude) * cos(tilt) - Math.tan(latitude * RADIANS) * sin(tilt), cos(longitude)) / RADIANS
  const dec = Math.asin(sin(latitude) * cos(tilt) + cos(latitude) * sin(tilt) * sin(longitude)) / RADIANS
  const sunLongitude = 280.46 + 0.9856474 * d + 1.915 * sin(357.528 + 0.9856003 * d)
  const elongation = Math.acos(cos(latitude) * cos(longitude - sunLongitude)) / RADIANS
  return { ra: (ra + 360) % 360, dec, lit: (1 - cos(elongation)) / 2 }
}
