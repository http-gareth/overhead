import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { isHttps, securityHeaders } from './files.ts'
import { parseTleText } from '../src/sgp4.ts'
import { fromOpenSky, toRows } from '../src/planes.ts'
import { parseAurora, parseLaunches, parseSatcat, parseVolcanoes } from '../src/sources.ts'

type Feed = {
  name: string
  sources: () => string[]
  firstOnly: boolean
  freshMs: number
  type: string
  prepare: (bodies: Buffer[]) => Buffer | string
  body?: Buffer
  gzip?: Buffer
  fetchedAt?: number
  note?: string
  failed?: boolean
  pending?: Promise<void>
  restored?: Promise<void>
}

const MAX_BYTES = 20 * 1024 * 1024
const TIMEOUT_MS = 60_000
const WAIT_MS = 1_500
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'
const JPEG_TYPE = 'image/jpeg'
const CACHE = process.env.CACHE_DIR ?? fileURLToPath(new URL('../.cache/', import.meta.url))
export const USER_AGENT = { 'user-agent': 'Overhead (github.com/http-gareth)' }

const PURPOSES: [string, string][] = [
  ['stations', 'Space station'], ['gnss', 'Navigation'], ['weather', 'Weather'], ['resource', 'Earth imaging'],
  ['sarsat', 'Search and rescue'], ['science', 'Science'], ['geodetic', 'Measuring the Earth'], ['military', 'Military'],
  ['amateur', 'Amateur radio'], ['engineering', 'Technology testing'], ['education', 'Education'],
  ['x-comm', 'Communications'], ['other-comm', 'Communications'], ['geo', 'Communications']
]

const celestrak = (group: string, format: string) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=${format}`
export const GIBS = process.env.GIBS_URL ?? 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
export const EOX = process.env.EOX_URL ?? 'https://tiles.maps.eox.at/wms'
export const gibsUrl = (layer: string, box: number[], width: number, height: number, date?: string, base = GIBS) =>
  `${base}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${layer}` +
  `${date ? `&TIME=${date}` : ''}&SRS=EPSG:4326&BBOX=${box.join(',')}&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/jpeg`
const gibs = (layer: string, width: number, day?: number) =>
  gibsUrl(layer, [-180, -90, 180, 90], width, width / 2, day === undefined ? undefined : new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10))

const utf8 = (bodies: Buffer[]) => bodies.map(body => body.toString('utf8'))
const json = ([body]: Buffer[]) => (JSON.parse(body.toString('utf8')), body)
export const jpeg = (minBytes: number) => ([body]: Buffer[]) => {
  if (body[0] !== 0xff || body[1] !== 0xd8 || body.length < minBytes) throw new Error('not a usable photo')
  return body
}

const feed = (name: string, freshMs: number, sources: () => string[], prepare: Feed['prepare'], type = JSON_TYPE, firstOnly = false): [string, Feed] => {
  const env = name.toUpperCase().replaceAll('-', '_')
  const override = process.env[`${env}_URL`]
  return [`/api/${name}`, {
    name, freshMs: Number(process.env[`${env}_FRESH_MS`] ?? freshMs), type, prepare, firstOnly,
    sources: override ? () => override.split(' ') : sources
  }]
}

export const FEEDS = new Map<string, Feed>([
  feed('quakes', MINUTE, () => ['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'], json),
  feed('map', Infinity, () => ['https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json'], json),
  feed('satellites', 2 * HOUR, () => [celestrak('active', 'tle')], ([body]) => {
    if (!parseTleText(body.toString('utf8')).length) throw new Error('no satellites in the feed')
    return body
  }, TEXT_TYPE),
  feed('satinfo', 24 * HOUR, () => ['https://celestrak.org/pub/satcat.csv', ...PURPOSES.map(([group]) => celestrak(group, 'csv'))], bodies => {
    const [satcat, ...groups] = utf8(bodies)
    return JSON.stringify(parseSatcat(satcat, groups.map((csv, i) => [PURPOSES[i][1], csv])))
  }),
  feed('planes', 20 * MINUTE, () => ['https://opensky-network.org/api/states/all'], ([body]) => {
    const rows = toRows(fromOpenSky(JSON.parse(body.toString('utf8'))))
    if (!rows.length) throw new Error('no planes in the feed')
    return JSON.stringify(rows)
  }),
  feed('earth', 6 * HOUR, () => [1, 2].map(day => gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor', 4096, day)), jpeg(600_000), JPEG_TYPE, true),
  feed('earth-small', 6 * HOUR, () => [1, 2].map(day => gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor', 2048, day)), jpeg(200_000), JPEG_TYPE, true),
  feed('bluemarble', Infinity, () => [gibs('BlueMarble_NextGeneration', 2048)], jpeg(100_000), JPEG_TYPE),
  feed('lights', Infinity, () => [gibs('VIIRS_Black_Marble', 2048)], jpeg(50_000), JPEG_TYPE),
  feed('launches', HOUR, () => ['https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=20'], ([body]) =>
    JSON.stringify(parseLaunches(JSON.parse(body.toString('utf8'))))),
  feed('aurora', 10 * MINUTE, () => ['https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'], bodies => {
    const [ovation, kp] = utf8(bodies).map(body => JSON.parse(body))
    return JSON.stringify(parseAurora(ovation, kp))
  }),
  feed('volcanoes', 6 * HOUR, () => ['https://volcano.si.edu/news/WeeklyVolcanoRSS.xml'], ([body]) => {
    const volcanoes = parseVolcanoes(body.toString('latin1'))
    if (!volcanoes.length) throw new Error('no volcanoes in the report')
    return JSON.stringify(volcanoes)
  })
])

const fetchBody = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: USER_AGENT })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error(`${url} is too big`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MAX_BYTES) throw new Error(`${url} sent more than ${MAX_BYTES} bytes`)
  return body
}

const store = (feed: Feed, prepared: Buffer | string, fetchedAt: number) => {
  const body = Buffer.from(prepared)
  Object.assign(feed, { body, gzip: feed.type === JPEG_TYPE ? body : gzipSync(body), fetchedAt })
  return body
}

const download = async (feed: Feed) => {
  let prepared: Buffer | string | undefined
  if (feed.firstOnly) {
    let failure: unknown
    for (const url of feed.sources()) {
      try {
        prepared = feed.prepare([await fetchBody(url)])
        feed.note = new URL(url).searchParams.get('TIME') ?? ''
        break
      } catch (error) {
        failure = error
      }
    }
    if (prepared === undefined) throw failure ?? new Error(`${feed.name} has no sources`)
  } else {
    const bodies: Buffer[] = []
    for (const url of feed.sources()) bodies.push(await fetchBody(url))
    prepared = feed.prepare(bodies)
  }
  const body = store(feed, prepared, Date.now())
  await mkdir(CACHE, { recursive: true })
    .then(() => Promise.all([writeFile(join(CACHE, feed.name), body), feed.note ? writeFile(join(CACHE, `${feed.name}.note`), feed.note) : null]))
    .catch(() => {})
}

const usable = (feed: Feed, body: Buffer) => {
  if (feed.type === JSON_TYPE) JSON.parse(body.toString('utf8'))
  else if (feed.type === TEXT_TYPE) feed.prepare([body])
  else jpeg(1)([body])
}

const restore = async (feed: Feed) => {
  try {
    const file = join(CACHE, feed.name)
    const [body, info] = await Promise.all([readFile(file), stat(file)])
    usable(feed, body)
    store(feed, body, info.mtimeMs)
    feed.note = await readFile(`${file}.note`, 'utf8').catch(() => undefined)
  } catch {}
}

const load = async (feed: Feed) => {
  await (feed.restored ??= restore(feed))
  if (feed.body && Date.now() - feed.fetchedAt! < feed.freshMs) return false
  feed.pending ??= download(feed).then(() => { feed.failed = false }, error => {
    feed.failed = true
    throw error
  }).finally(() => { feed.pending = undefined })
  if (!feed.body) {
    await feed.pending
    return false
  }
  const outcome = await Promise.race([
    feed.pending.then(() => 'fresh', () => 'failed'),
    new Promise(resolve => setTimeout(resolve, WAIT_MS, 'slow'))
  ])
  return outcome === 'failed' || (outcome === 'slow' && Boolean(feed.failed))
}

export const serveFeed = async (feed: Feed, req: IncomingMessage, res: ServerResponse) => {
  const headers = securityHeaders(isHttps(req))
  try {
    const stale = await load(feed)
    const gzip = feed.type !== JPEG_TYPE && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    res.writeHead(200, {
      ...headers,
      'content-type': feed.type,
      'cache-control': feed.freshMs === Infinity ? 'public, max-age=86400' : 'no-cache',
      vary: 'accept-encoding',
      'x-overhead-data-age': String(Math.round((Date.now() - feed.fetchedAt!) / 1000)),
      ...(gzip && { 'content-encoding': 'gzip' }),
      ...(feed.note && { 'x-overhead-note': feed.note }),
      ...(stale && { 'x-overhead-stale': '1' })
    })
    res.end(gzip ? feed.gzip : feed.body)
  } catch {
    res.writeHead(502, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('the data source is not answering right now')
  }
}
