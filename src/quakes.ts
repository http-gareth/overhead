export type Quake = {
  id: string
  magnitude: number
  place: string
  time: number
  lat: number
  lon: number
  depthKm: number
  tsunami: boolean
  url: string | null
}

const USGS_EVENT_PAGE = 'https://earthquake.usgs.gov/earthquakes/eventpage/'

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export const parseQuakes = (feed: unknown): Quake[] => {
  const features = (feed as { features?: unknown })?.features
  if (!Array.isArray(features)) return []
  return features.flatMap(feature => {
    const { id, properties: p, geometry } = feature ?? {}
    const [lon, lat, depthKm] = geometry?.coordinates ?? []
    if (typeof id !== 'string' || !isNumber(p?.mag) || !isNumber(p?.time) || !isNumber(lat) || !isNumber(lon) || !isNumber(depthKm)) return []
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return []
    return [{
      id,
      magnitude: p.mag,
      place: typeof p.place === 'string' && p.place ? p.place : 'Unnamed location',
      time: p.time,
      lat,
      lon,
      depthKm,
      tsunami: p.tsunami === 1,
      url: typeof p.url === 'string' && p.url.startsWith(USGS_EVENT_PAGE) ? p.url : null
    }]
  }).sort((a, b) => b.time - a.time)
}

export const depthBand = (depthKm: number) => depthKm < 70 ? 'shallow' : depthKm < 300 ? 'intermediate' : 'deep'
