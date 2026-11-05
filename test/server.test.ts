import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'

const fakeUpstream = (answers: (() => [number, string])[]) => new Promise<{ url: string, hits: () => number, close: () => void }>(resolve => {
  let hits = 0
  const server = createServer((_, res) => {
    const [status, body] = answers[Math.min(hits++, answers.length - 1)]()
    res.writeHead(status, { 'content-type': 'application/json' }).end(body)
  }).listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`, hits: () => hits, close: () => server.close() }))
})

const startServer = (env: Record<string, string>) => new Promise<{ port: number, stop: () => void }>((resolve, reject) => {
  const port = 6300 + Math.floor(Math.random() * 2000)
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/index.ts'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, CACHE_DIR: mkdtempSync(join(tmpdir(), 'overhead-')), ...env, PORT: String(port) }
  })
  child.stdout.on('data', chunk => { if (String(chunk).includes('running')) resolve({ port, stop: () => child.kill() }) })
  child.on('error', reject)
})

const get = (port: number, path: string, method = 'GET', headers: Record<string, string> = {}) => new Promise<{ status: number, headers: IncomingHttpHeaders, body: string, raw: Buffer }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
    const chunks: Buffer[] = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => {
      const raw = Buffer.concat(chunks)
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw.toString('utf8'), raw })
    })
  })
  req.on('error', reject)
  req.end()
})

const QUAKES = JSON.stringify({ features: [{ id: 'a', properties: { mag: 4.2, time: 1, place: 'Test' }, geometry: { coordinates: [31, -29, 10] } }] })

test('the server serves only the app, with security headers, and survives bad requests', async () => {
  const usgs = await fakeUpstream([() => [200, QUAKES]])
  const server = await startServer({ QUAKES_URL: usgs.url, MAP_URL: usgs.url })
  try {
    const home = await get(server.port, '/')
    assert.equal(home.status, 200)
    assert.match(String(home.headers['content-security-policy']), /script-src 'self'/)
    assert.match(String(home.headers['content-security-policy']), /frame-ancestors 'none'/)
    assert.equal(home.headers['x-content-type-options'], 'nosniff')
    for (const path of ['/package.json', '/server/feeds.ts', '/test/server.test.ts', '/web/..%2f..%2fpackage.json', '/src/%2e%2e/server/index.ts', '/web/index.html%00', '/__proto__', '/api/__proto__', '/api/constructor']) {
      assert.equal((await get(server.port, path)).status, 404, path)
    }
    assert.equal((await get(server.port, '/%')).status, 400)
    assert.equal((await get(server.port, '/', 'POST')).status, 405)
    assert.equal((await get(server.port, '/web/app.ts')).headers['content-type'], 'text/javascript; charset=utf-8', 'TypeScript arrives as JavaScript')
  } finally {
    server.stop()
    usgs.close()
  }
})

test('live data is cached, and the last good copy is served when the source fails', async () => {
  const usgs = await fakeUpstream([() => [200, QUAKES], () => [500, 'down']])
  const cached = await startServer({ QUAKES_URL: usgs.url, MAP_URL: usgs.url })
  try {
    const first = await get(cached.port, '/api/quakes')
    assert.equal(first.status, 200)
    assert.deepEqual(JSON.parse(first.body), JSON.parse(QUAKES))
    await get(cached.port, '/api/quakes')
    assert.equal(usgs.hits(), 1, 'the second visitor is served from the cache')
  } finally {
    cached.stop()
    usgs.close()
  }

  const flaky = await fakeUpstream([() => [200, QUAKES], () => [500, 'down']])
  const alwaysFresh = await startServer({ QUAKES_URL: flaky.url, MAP_URL: flaky.url, QUAKES_FRESH_MS: '0' })
  try {
    assert.equal((await get(alwaysFresh.port, '/api/quakes')).status, 200)
    const stale = await get(alwaysFresh.port, '/api/quakes')
    assert.equal(stale.status, 200, 'USGS failed, but visitors still get the last data')
    assert.equal(stale.headers['x-overhead-stale'], '1')
  } finally {
    alwaysFresh.stop()
    flaky.close()
  }

  const broken = await fakeUpstream([() => [200, '<html>not json</html>']])
  const strict = await startServer({ QUAKES_URL: broken.url, MAP_URL: broken.url })
  try {
    assert.equal((await get(strict.port, '/api/quakes')).status, 502, 'garbage from upstream is never passed on')
  } finally {
    strict.stop()
    broken.close()
  }
})

const ISS = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26308.36953014  .00005228  00000+0  10236-3 0  9991',
  '2 25544  51.6329 326.3987 0007186 346.7494  13.3304 15.49173979593483'
].join('\r\n')

const SKY = JSON.stringify({
  time: 1_793_800_000,
  states: [
    ['abc123', 'SAA188  ', 'South Africa', 1_793_800_000, 1_793_800_000, 28.2, -26.1, 10000, false, 230, 90, 0, null, 10200, null],
    ['def456', 'PARKED', 'South Africa', 1_793_800_000, 1_793_800_000, 28.2, -26.1, 0, true, 0, 0, 0, null, 0, null]
  ]
})

test('satellites and planes are checked and trimmed before anyone sees them, and travel gzipped', async () => {
  const celestrak = await fakeUpstream([() => [200, ISS]])
  const opensky = await fakeUpstream([() => [200, SKY]])
  const server = await startServer({ SATELLITES_URL: celestrak.url, PLANES_URL: opensky.url })
  try {
    const satellites = await get(server.port, '/api/satellites')
    assert.equal(satellites.status, 200)
    assert.equal(satellites.headers['content-type'], 'text/plain; charset=utf-8')
    assert.match(satellites.body, /ISS \(ZARYA\)/)
    const zipped = await get(server.port, '/api/satellites', 'GET', { 'accept-encoding': 'gzip, br' })
    assert.equal(zipped.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(zipped.raw).toString('utf8'), satellites.body)
    const planes = await get(server.port, '/api/planes')
    assert.equal(planes.status, 200)
    assert.deepEqual(JSON.parse(planes.body), [['abc123', 'SAA188', 'South Africa', -26.1, 28.2, 10200, 230, 90, 0, 1_793_800_000_000]], 'only the plane in the air, in our compact shape')
    assert.equal(celestrak.hits() + opensky.hits(), 2, 'each source was asked once')
  } finally {
    server.stop()
    celestrak.close()
    opensky.close()
  }

  const junk = await fakeUpstream([() => [200, '<html>maintenance</html>']])
  const empty = await fakeUpstream([() => [200, JSON.stringify({ time: 1, states: null })]])
  const strict = await startServer({ SATELLITES_URL: junk.url, PLANES_URL: empty.url })
  try {
    assert.equal((await get(strict.port, '/api/satellites')).status, 502, 'a page with no orbits in it is refused')
    assert.equal((await get(strict.port, '/api/planes')).status, 502, 'an empty sky is treated as a failed download')
  } finally {
    strict.stop()
    junk.close()
    empty.close()
  }
})

test('a restart picks up the last good copy from disk instead of downloading again', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'overhead-'))
  const opensky = await fakeUpstream([() => [200, SKY], () => [503, 'busy']])
  const first = await startServer({ PLANES_URL: opensky.url, CACHE_DIR: cache })
  const fresh = JSON.parse((await get(first.port, '/api/planes')).body)
  first.stop()
  const second = await startServer({ PLANES_URL: opensky.url, CACHE_DIR: cache })
  try {
    const again = await get(second.port, '/api/planes')
    assert.equal(again.status, 200)
    assert.deepEqual(JSON.parse(again.body), fresh, 'the saved planes come back exactly')
    assert.equal(again.headers['x-overhead-stale'], undefined, 'still within its 20 minutes, so not stale')
    assert.equal(opensky.hits(), 1, 'OpenSky was not asked a second time')
  } finally {
    second.stop()
    opensky.close()
  }
})

test('clicking a plane looks up its aircraft, route and path, safely and politely', async () => {
  const asked: string[] = []
  const upstream = createServer((req, res) => {
    asked.push(req.url ?? '')
    const body = req.url?.includes('/aircraft/') ? { response: { aircraft: { type: '747 4R7F', manufacturer: 'Boeing', registration: 'LX-YCV', url_photo_thumbnail: 'https://airport-data.com/a.jpg' } } }
      : req.url?.includes('/callsign/') ? { response: { flightroute: { airline: { name: 'Cargolux' }, origin: { name: 'Findel', latitude: 49.6, longitude: 6.2 }, destination: { name: 'OR Tambo', latitude: -26.1, longitude: 28.2 } } } }
        : { path: [[1, -26.1, 28.2, 1500, 0, false], [2, -26.0, 28.2, 1800, 0, false]] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => upstream.listen(0, resolve))
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const server = await startServer({ ADSBDB_URL: base, OPENSKY_API_URL: base, LOOKUPS_PER_MINUTE: '4' })
  try {
    const first = await get(server.port, '/api/plane?hex=4d010d&callsign=CLX491')
    assert.equal(first.status, 200)
    const plane = JSON.parse(first.body)
    assert.equal(plane.aircraft.registration, 'LX-YCV')
    assert.equal(plane.route.to.name, 'OR Tambo')
    assert.equal(plane.track.length, 2)
    await get(server.port, '/api/plane?hex=4d010d&callsign=CLX491')
    assert.equal(asked.length, 3, 'the second click is answered from memory')
    for (const bad of ['/api/plane?hex=../../x', '/api/plane?hex=4D010D', '/api/plane?hex=4d010d&callsign=clx<b>', '/api/plane']) {
      assert.equal((await get(server.port, bad)).status, 400, bad)
    }
    const busy = JSON.parse((await get(server.port, '/api/plane?hex=aaaaaa&callsign=ABC1')).body)
    assert.equal(asked.length, 4, 'only one more lookup fits in this minute')
    assert.equal(busy.route, null)
  } finally {
    server.stop()
    upstream.close()
  }
})

test('close-up photos are fetched for sane areas only, and cached', async () => {
  const asked: string[] = []
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 7)])
  const nasa = createServer((req, res) => {
    asked.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg)
  })
  await new Promise<void>(resolve => nasa.listen(0, resolve))
  const base = `http://127.0.0.1:${(nasa.address() as AddressInfo).port}/wms`
  const server = await startServer({ GIBS_URL: base, EOX_URL: base })
  const today = new Date().toISOString().slice(0, 10)
  try {
    const good = `/api/detail?layer=today&date=${today}&west=24&south=-34&east=34&north=-24&size=2048`
    const first = await get(server.port, good)
    assert.equal(first.status, 200)
    assert.equal(first.headers['content-type'], 'image/jpeg')
    assert.deepEqual(first.raw, jpeg)
    assert.match(asked[0], /LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor/)
    assert.match(asked[0], /BBOX=24,-34,34,-24&WIDTH=2048&HEIGHT=2048/)
    await get(server.port, good)
    assert.equal(asked.length, 1, 'the same area is served from memory')
    assert.equal((await get(server.port, '/api/detail?layer=ground&west=32&south=-3.625&east=32.25&north=-3.375&size=1024')).status, 200, 'a sharp close-up of a small area')
    assert.match(asked[1], /LAYERS=s2cloudless-2023&SRS=EPSG:4326&BBOX=32,-3.625,32.25,-3.375&WIDTH=1024&HEIGHT=1024/)
    for (const bad of [
      '/api/detail?layer=today&date=2001-01-01&west=24&south=-34&east=34&north=-24&size=2048',
      '/api/detail?layer=evil&west=24&south=-34&east=34&north=-24&size=2048',
      '/api/detail?layer=lights&west=24.01&south=-34&east=34&north=-24&size=2048',
      '/api/detail?layer=ground&west=14&south=-34&east=34&north=-24&size=2048',
      '/api/detail?layer=lights&west=-200&south=-34&east=34&north=-24&size=2048',
      '/api/detail?layer=lights&west=24&south=-34&east=34&north=-24&size=99999',
      '/api/detail?layer=lights&west=34&south=-34&east=24&north=-24&size=1024'
    ]) assert.equal((await get(server.port, bad)).status, 400, bad)
  } finally {
    server.stop()
    nasa.close()
  }
})

test('a slow source never keeps visitors waiting once there is a copy to show', async () => {
  let calls = 0
  const slow = createServer((_, res) => {
    calls++
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(QUAKES), calls === 1 ? 0 : 6000)
  })
  await new Promise<void>(resolve => slow.listen(0, resolve))
  const server = await startServer({ QUAKES_URL: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/feed`, QUAKES_FRESH_MS: '0' })
  try {
    assert.equal((await get(server.port, '/api/quakes')).status, 200)
    const started = Date.now()
    const second = await get(server.port, '/api/quakes')
    assert.equal(second.status, 200)
    assert.ok(Date.now() - started < 3000, `answered in ${Date.now() - started} ms while the refresh carries on`)
    assert.deepEqual(JSON.parse(second.body), JSON.parse(QUAKES))
  } finally {
    server.stop()
    slow.closeAllConnections()
    slow.close()
  }
})

test('street-level tiles: only real tile numbers, missing tiles say so, repeats come from memory', async () => {
  const asked: string[] = []
  const tile = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 3)])
  const esri = createServer((req, res) => {
    asked.push(req.url ?? '')
    if (req.url?.startsWith('/tile/19/1/1')) res.writeHead(404).end()
    else res.writeHead(200, { 'content-type': 'image/jpeg' }).end(tile)
  })
  await new Promise<void>(resolve => esri.listen(0, resolve))
  const server = await startServer({ ESRI_URL: `http://127.0.0.1:${(esri.address() as AddressInfo).port}/tile` })
  try {
    const durban = await get(server.port, '/api/tile?z=19&x=307322&y=307742')
    assert.equal(durban.status, 200)
    assert.deepEqual(durban.raw, tile)
    assert.equal(asked[0], '/tile/19/307742/307322?blankTile=false', 'tiles are asked for as z/y/x, without placeholder images')
    await get(server.port, '/api/tile?z=19&x=307322&y=307742')
    assert.equal(asked.length, 1)
    assert.equal((await get(server.port, '/api/tile?z=19&x=1&y=1')).status, 404)
    for (const bad of ['/api/tile?z=19&x=-1&y=1', '/api/tile?z=25&x=1&y=1', '/api/tile?z=3&x=8&y=1', '/api/tile?z=3&x=1.5&y=1', '/api/tile?z=3&x=1', '/api/tile?z=3&x=&y=']) {
      assert.equal((await get(server.port, bad)).status, 400, bad)
    }
  } finally {
    server.stop()
    esri.close()
  }
})
