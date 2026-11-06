import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { isHttps, securityHeaders } from './files.ts'
import { EOX, GIBS, USER_AGENT, gibsUrl, jpeg, noteRejected, openskyHeaders, reach } from './feeds.ts'
import { parseAircraft, parseRoute, parseTrack } from '../src/sources.ts'

const ADSBDB = process.env.ADSBDB_URL ?? 'https://api.adsbdb.com/v0'
const OPENSKY = process.env.OPENSKY_API_URL ?? 'https://opensky-network.org/api'
const DAY = 86_400_000
const TRACK_MS = 2 * 60_000
const PER_MINUTE = Number(process.env.LOOKUPS_PER_MINUTE ?? 60)
const TILES_PER_MINUTE = Number(process.env.TILES_PER_MINUTE ?? 1500)
const ESRI = process.env.ESRI_URL ?? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'
const DETAIL_LAYERS = new Map([
  ['today', { layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', base: GIBS }],
  ['lights', { layer: 'VIIRS_Black_Marble', base: GIBS }],
  ['ground', { layer: 's2cloudless-2023', base: EOX }]
])

const memory = (max: number, perMinute: number) => {
  const remembered = new Map<string, { at: number, value: Promise<unknown> }>()
  let window = { minute: 0, used: 0 }
  return (key: string, ttl: number, make: () => Promise<unknown>) => {
    const hit = remembered.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.value
    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== window.minute) window = { minute, used: 0 }
    if (window.used++ >= perMinute) return Promise.resolve(null)
    if (remembered.size >= max) remembered.delete(remembered.keys().next().value!)
    const value = make().catch(() => {
      remembered.delete(key)
      return null
    })
    remembered.set(key, { at: Date.now(), value })
    return value
  }
}

const remember = memory(3000, PER_MINUTE)
const rememberPhoto = memory(40, PER_MINUTE)
const rememberTile = memory(3000, TILES_PER_MINUTE)

const fail = (res: ServerResponse, headers: OutgoingHttpHeaders, status: number, text: string) => {
  res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end(text)
}

const getJson = async (url: string, headers: Record<string, string> = USER_AGENT) => {
  const response = await reach(url, { signal: AbortSignal.timeout(10_000), headers })
  noteRejected(response.status, headers)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const body = await response.text()
  if (body.length > 2_000_000) throw new Error(`${url} is too big`)
  return JSON.parse(body)
}

export const servePlane = async (req: IncomingMessage, res: ServerResponse) => {
  const headers = { ...securityHeaders(isHttps(req)), 'cache-control': 'no-cache' }
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const hex = query.get('hex') ?? ''
  const callsign = query.get('callsign') ?? ''
  if (!/^[0-9a-f]{6}$/.test(hex) || !/^[A-Z0-9]{0,8}$/.test(callsign)) return fail(res, headers, 400, 'bad aircraft')
  const [aircraft, route, track] = await Promise.all([
    remember(`aircraft:${hex}`, DAY, () => getJson(`${ADSBDB}/aircraft/${hex}`).then(parseAircraft)),
    callsign ? remember(`route:${callsign}`, DAY, () => getJson(`${ADSBDB}/callsign/${callsign}`).then(parseRoute)) : null,
    remember(`track:${hex}`, TRACK_MS, () => openskyHeaders().then(auth => getJson(`${OPENSKY}/tracks/all?icao24=${hex}&time=0`, auth)).then(parseTrack))
  ])
  res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ aircraft, route, track }))
}

export const serveDetail = async (req: IncomingMessage, res: ServerResponse) => {
  const headers = securityHeaders(isHttps(req))
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const name = query.get('layer') ?? ''
  const source = DETAIL_LAYERS.get(name)
  const box = ['west', 'south', 'east', 'north'].map(key => Number(query.get(key) || NaN))
  const [west, south, east, north] = box
  const size = Number(query.get('size'))
  const date = name === 'today' ? query.get('date') ?? '' : ''
  const recent = /^\d{4}-\d{2}-\d{2}$/.test(date) && Math.abs(Date.now() - Date.parse(date)) < 15 * DAY
  const valid = source && box.every(v => Number.isInteger(v * 64)) && west >= -180 && east <= 180 && south >= -90 && north <= 90 &&
    east - west >= 0.05 && east - west <= 120 && north - south >= 0.05 && north - south <= 90 && (size === 1024 || size === 2048) &&
    (name !== 'today' || recent) && (name !== 'ground' || Math.max(east - west, north - south) <= 8)
  if (!valid) return fail(res, headers, 400, 'bad area')
  const ratio = (east - west) / (north - south)
  const [width, height] = ratio >= 1 ? [size, Math.max(64, Math.round(size / ratio))] : [Math.max(64, Math.round(size * ratio)), size]
  const photo = await rememberPhoto(`${name}:${date}:${box.join(',')}:${size}`, DAY, async () => {
    const response = await fetch(gibsUrl(source!.layer, box, width, height, date || undefined, source!.base), { signal: AbortSignal.timeout(45_000), headers: USER_AGENT })
    if (!response.ok) throw new Error(`imagery answered ${response.status}`)
    return jpeg(1000)([Buffer.from(await response.arrayBuffer())])
  }) as Buffer | null
  if (!photo) return fail(res, headers, 502, 'the imagery service is busy, try again shortly')
  res.writeHead(200, { ...headers, 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' }).end(photo)
}

export const serveTile = async (req: IncomingMessage, res: ServerResponse) => {
  const headers = securityHeaders(isHttps(req))
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const [z, x, y] = ['z', 'x', 'y'].map(key => Number(query.get(key) || NaN))
  if (![z, x, y].every(Number.isInteger) || z < 1 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return fail(res, headers, 400, 'bad tile')
  const tile = await rememberTile(`${z}/${y}/${x}`, DAY, async () => {
    const response = await fetch(`${ESRI}/${z}/${y}/${x}?blankTile=false`, { signal: AbortSignal.timeout(15_000), headers: USER_AGENT })
    if (response.status === 404) return 'missing'
    if (!response.ok) throw new Error(`imagery answered ${response.status}`)
    return jpeg(100)([Buffer.from(await response.arrayBuffer())])
  })
  if (tile === 'missing') return fail(res, { ...headers, 'cache-control': 'public, max-age=86400' }, 404, 'no imagery here')
  if (!tile) return fail(res, headers, 503, 'busy, try again shortly')
  res.writeHead(200, { ...headers, 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' }).end(tile as Buffer)
}
