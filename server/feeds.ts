import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { isHttps, securityHeaders } from './files.ts'
import { parseTleText } from '../src/sgp4.ts'
import { fromAdsbLol, toRows } from '../src/planes.ts'
import { parseAurora, parseLaunches, parseVolcanoes } from '../src/sources.ts'

type Feed = {
  name: string
  sources: () => string[]
  firstOnly: boolean
  freshMs: number
  type: string
  prepare: (bodies: Buffer[]) => Buffer | string
  gapMs: number
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

const OPENSKY_TOKEN_URL = process.env.OPENSKY_TOKEN_URL ?? 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
export const reach = async (url: string, init: RequestInit) => {
  try {
    return await fetch(url, init)
  } catch (error) {
    const cause = (error as { cause?: { code?: string, message?: string } }).cause
    throw new Error(`${new URL(url).host} could not be reached (${cause?.code ?? cause?.message ?? (error as Error).message})`)
  }
}

let openskyToken = { value: '', expiresAt: 0 }
let openskyLogin: Promise<void> | undefined

const logIn = async (id: string, secret: string) => {
  const response = await reach(OPENSKY_TOKEN_URL, {
    method: 'POST', headers: USER_AGENT, signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  })
  if (!response.ok) throw new Error(`OpenSky login answered ${response.status}`)
  const { access_token: value, expires_in: seconds } = await response.json() as { access_token: string, expires_in: number }
  openskyToken = { value, expiresAt: Date.now() + (seconds - 60) * 1000 }
}

export const openskyHeaders = async (): Promise<Record<string, string>> => {
  const { OPENSKY_CLIENT_ID: id, OPENSKY_CLIENT_SECRET: secret } = process.env
  if (!id || !secret) return USER_AGENT
  if (Date.now() >= openskyToken.expiresAt) await (openskyLogin ??= logIn(id, secret).finally(() => { openskyLogin = undefined }))
  return { ...USER_AGENT, authorization: `Bearer ${openskyToken.value}` }
}

export const noteRejected = (status: number, headers: Record<string, string>) => {
  if (status === 401 && headers.authorization) openskyToken.expiresAt = 0
}

const ORBITS = 'https://raw.githubusercontent.com/http-gareth/overhead/data'
const ADSBLOL = process.env.ADSBLOL_URL ?? 'https://api.adsb.lol'
const PLANE_TYPES = [
  'B738', 'A320', 'A20N', 'B38M', 'A321', 'A21N', 'B737', 'A319', 'B77W', 'B789', 'E75L', 'E190', 'A359', 'A333', 'B788', 'CRJ9',
  'AT76', 'DH8D', 'B763', 'B772', 'A332', 'E195', 'BCS3', 'B739', 'A388', 'B744', 'B748', 'CRJ7', 'B752', 'B78X', 'A339', 'A35K'
]
export const GIBS = process.env.GIBS_URL ?? 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
export const EOX = process.env.EOX_URL ?? 'https://tiles.maps.eox.at/wms'
export const gibsUrl = (layer: string, box: number[], width: number, height: number, date?: string, base = GIBS) =>
  `${base}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${layer}` +
  `${date ? `&TIME=${date}` : ''}&SRS=EPSG:4326&BBOX=${box.join(',')}&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/jpeg`
const gibs = (layer: string, width: number, day?: number) =>
  gibsUrl(layer, [-180, -90, 180, 90], width, width / 2, day === undefined ? undefined : new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10))

const json = ([body]: Buffer[]) => (JSON.parse(body.toString('utf8')), body)
export const jpeg = (minBytes: number) => ([body]: Buffer[]) => {
  if (body[0] !== 0xff || body[1] !== 0xd8 || body.length < minBytes) throw new Error('not a usable photo')
  return body
}

const feed = (name: string, freshMs: number, sources: () => string[], prepare: Feed['prepare'], type = JSON_TYPE, firstOnly = false, gapMs = 0): [string, Feed] => {
  const env = name.toUpperCase().replaceAll('-', '_')
  const override = process.env[`${env}_URL`]
  return [`/api/${name}`, {
    name, freshMs: Number(process.env[`${env}_FRESH_MS`] ?? freshMs), type, prepare, firstOnly, gapMs,
    sources: override ? () => override.split(' ') : sources
  }]
}

export const FEEDS = new Map<string, Feed>([
  feed('quakes', MINUTE, () => ['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'], json),
  feed('map', Infinity, () => ['https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json'], json),
  feed('satellites', 2 * HOUR, () => [`${ORBITS}/satellites.tle`, 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle'], ([body]) => {
    if (!parseTleText(body.toString('utf8')).length) throw new Error('no satellites in the feed')
    return body
  }, TEXT_TYPE, true),
  feed('satinfo', 6 * HOUR, () => [`${ORBITS}/satinfo.json`], json),
  feed('planes', 20 * MINUTE, () => PLANE_TYPES.map(type => `${ADSBLOL}/v2/type/${type}`), bodies => {
    const read = (body: Buffer) => {
      try {
        return fromAdsbLol(JSON.parse(body.toString('utf8')))
      } catch {
        return []
      }
    }
    const planes = new Map(bodies.flatMap(read).map(plane => [plane.id, plane]))
    if (!planes.size) throw new Error('no planes in the feed')
    return JSON.stringify(toRows([...planes.values()]))
  }, JSON_TYPE, false, 4_000),
  feed('earth', 6 * HOUR, () => [1, 2].map(day => gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor', 4096, day)), jpeg(600_000), JPEG_TYPE, true),
  feed('earth-small', 6 * HOUR, () => [1, 2].map(day => gibs('VIIRS_NOAA20_CorrectedReflectance_TrueColor', 2048, day)), jpeg(200_000), JPEG_TYPE, true),
  feed('bluemarble', Infinity, () => [gibs('BlueMarble_NextGeneration', 2048)], jpeg(100_000), JPEG_TYPE),
  feed('lights', Infinity, () => [gibs('VIIRS_Black_Marble', 2048)], jpeg(50_000), JPEG_TYPE),
  feed('launches', HOUR, () => ['https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=20'], ([body]) =>
    JSON.stringify(parseLaunches(JSON.parse(body.toString('utf8'))))),
  feed('aurora', 10 * MINUTE, () => ['https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'], bodies => {
    const [ovation, kp] = bodies.map(body => JSON.parse(body.toString('utf8')))
    return JSON.stringify(parseAurora(ovation, kp))
  }),
  feed('volcanoes', 6 * HOUR, () => ['https://volcano.si.edu/news/WeeklyVolcanoRSS.xml'], ([body]) => {
    const volcanoes = parseVolcanoes(body.toString('latin1'))
    if (!volcanoes.length) throw new Error('no volcanoes in the report')
    return JSON.stringify(volcanoes)
  })
])

const fetchBody = async (url: string) => {
  const response = await reach(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: USER_AGENT })
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
    let failure: unknown
    for (const [index, url] of feed.sources().entries()) {
      if (index) await sleep(feed.gapMs)
      try {
        bodies.push(await fetchBody(url))
      } catch (error) {
        failure = error
      }
    }
    if (!bodies.length) throw failure ?? new Error(`${feed.name} has no sources`)
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`${feed.name} feed failed: ${reason}`)
    res.writeHead(502, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end(`the data source is not answering right now (${reason})`)
  }
}
