export type Vec3 = [number, number, number]
export type View = { lat: number, lon: number, distance: number }

export const RADIANS = Math.PI / 180
export const FOV = 30 * RADIANS
export const TAN_HALF_FOV = Math.tan(FOV / 2)

export const toVector = (lat: number, lon: number, radius = 1): Vec3 => {
  const phi = lat * RADIANS
  const lambda = lon * RADIANS
  return [radius * Math.cos(phi) * Math.sin(lambda), radius * Math.sin(phi), radius * Math.cos(phi) * Math.cos(lambda)]
}

export const toLatLon = ([x, y, z]: Vec3) => ({
  lat: Math.asin(Math.max(-1, Math.min(1, y / Math.hypot(x, y, z)))) / RADIANS,
  lon: Math.atan2(x, z) / RADIANS
})

export const viewMatrix = (view: View) => {
  const a = -view.lon * RADIANS
  const b = view.lat * RADIANS
  const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)]
  return [
    [ca, 0, sa],
    [sa * sb, cb, -ca * sb],
    [-sa * cb, sb, ca * cb]
  ]
}

export const columnMajor = (rows: number[][]) => new Float32Array([0, 1, 2].flatMap(c => rows.map(row => row[c])))

export const rotate = (rows: number[][], [x, y, z]: Vec3): Vec3 =>
  rows.map(row => row[0] * x + row[1] * y + row[2] * z) as Vec3

export const hidden = (p: Vec3, distance: number) => {
  const length = Math.hypot(p[0], p[1], p[2] - distance)
  const b = distance * (p[2] - distance) / length
  const h = b * b - distance * distance + 1
  if (h < 0) return false
  const s = -b - Math.sqrt(h)
  return s > 0 && s < length * (1 - 1e-6)
}

export const project = (p: Vec3, distance: number, aspect: number) => {
  const depth = distance - p[2]
  if (depth < 0.000001 || hidden(p, distance)) return null
  return { x: p[0] / depth / (TAN_HALF_FOV * aspect), y: p[1] / depth / TAN_HALF_FOV }
}

export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180

export const bearing = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const [a, b, d] = [lat1 * RADIANS, lat2 * RADIANS, (lon2 - lon1) * RADIANS]
  return (Math.atan2(Math.sin(d) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d)) / RADIANS + 360) % 360
}

export const greatCircleKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const h = Math.sin((lat2 - lat1) * RADIANS / 2) ** 2 +
    Math.cos(lat1 * RADIANS) * Math.cos(lat2 * RADIANS) * Math.sin((lon2 - lon1) * RADIANS / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}
