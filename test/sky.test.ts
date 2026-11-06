import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EARTH_RADIUS_KM, parseTle } from '../src/sgp4.ts'
import { compass, lookAngles, passes, sunElevation, sunlit, surface } from '../src/passes.ts'
import { MAX_ESTIMATE_MS, countryOf, estimate, fromAdsbLol, fromOpenSky, fromRows, toRows } from '../src/planes.ts'
import { greatCircleKm, toLatLon, toVector } from '../src/geo.ts'
import { GROUPS, groupOf, orbit, overhead, positions } from '../src/satellites.ts'
import { earthFixed } from '../src/sgp4.ts'

const DURBAN = { lat: -29.8587, lon: 31.0218 }
const ISS = parseTle('ISS (ZARYA)',
  '1 25544U 98067A   26308.36953014  .00005228  00000+0  10236-3 0  9991',
  '2 25544  51.6329 326.3987 0007186 346.7494  13.3304 15.49173979593483')!

test('look angles: straight up is 90 degrees, and the compass points the right way', () => {
  const above = surface(DURBAN.lat, DURBAN.lon, EARTH_RADIUS_KM + 400)
  assert.ok(Math.abs(lookAngles(DURBAN, above).elevation - 90) < 1e-4)
  const north = surface(DURBAN.lat + 5, DURBAN.lon, EARTH_RADIUS_KM + 400)
  assert.equal(compass(lookAngles(DURBAN, north).azimuth), 'north')
  const west = surface(DURBAN.lat, DURBAN.lon - 5, EARTH_RADIUS_KM + 400)
  assert.equal(compass(lookAngles(DURBAN, west).azimuth), 'west')
})

test('night, day and Earth shadow are worked out from the real sun', () => {
  assert.ok(sunElevation(DURBAN, Date.UTC(2026, 10, 4, 10)) > 30, 'mid-morning in Durban, sun well up')
  assert.ok(sunElevation(DURBAN, Date.UTC(2026, 10, 4, 20)) < -20, '10 pm in Durban is dark')
  const sun = [1, 0, 0] as [number, number, number]
  assert.equal(sunlit([-7000, 0, 0], sun), false, 'directly behind the Earth is in shadow')
  assert.equal(sunlit([-7000, 7000, 0], sun), true, 'off to the side is still in sunlight')
})

test('the ISS passes over Durban several times in two days, and some passes are visible', () => {
  const found = passes(ISS, DURBAN, ISS.epoch, 48)
  assert.ok(found.length >= 3, `${found.length} passes`)
  for (const pass of found) {
    assert.ok(pass.end - pass.start < 12 * 60_000, 'a pass lasts minutes, not hours')
    assert.ok(pass.maxElevation >= 10 && pass.maxElevation <= 90)
    assert.ok(pass.start <= pass.peak && pass.peak <= pass.end)
  }
  for (const pass of found.filter(p => p.visible)) assert.ok(sunElevation(DURBAN, pass.peak) < 0, 'visible passes happen around dark')
})

test('OpenSky data is filtered to clean airborne planes and survives the round trip', () => {
  const now = 1_793_800_000
  const planes = fromOpenSky({
    states: [
      ['abc123', 'SAA188  ', 'South Africa', now, now, 28.2, -26.1, 10000, false, 230, 90, 0, null, 10200, null],
      ['def456', 'GROUND', 'South Africa', now, now, 28.2, -26.1, 0, true, 5, 0, 0, null, 0, null],
      ['bad', 'X', 'Y', now, now, 28.2, -26.1, 1, false, 1, 1, 0, null, 1, null],
      ['aaa111', '<b>', 'Evil<script>', now, now, 999, 0, 1, false, 1, 1, 0, null, 1, null],
      ['bbb222', '<script>', 'Ok land', null, now, 10, 10, 1, false, 100, 45, 2, null, null, null],
      'not a state'
    ]
  })
  assert.deepEqual(planes.map(p => p.id), ['abc123', 'bbb222'])
  assert.equal(planes[0].callsign, 'SAA188')
  assert.equal(planes[0].altitudeM, 10200)
  assert.equal(planes[1].callsign, '', 'anything but letters and digits is stripped')
  assert.deepEqual(fromRows(JSON.parse(JSON.stringify(toRows(planes)))), planes)
  assert.deepEqual(fromRows('nonsense'), [])
})

test('adsb.lol data is converted to metres and seconds, and the registration country comes from the transponder code', () => {
  const planes = fromAdsbLol({
    now: 1_793_800_000_000,
    ac: [
      { hex: 'ac0f93', flight: 'SWA3261 ', lat: 33.7, lon: -125.8, alt_baro: 36000, gs: 432, track: 77, baro_rate: -1000, seen_pos: 2.5 },
      { hex: '00ae17', flight: 'SFR161', lat: -29.8, lon: 31, alt_baro: 'ground', gs: 0, track: 0 },
      { hex: '~2a01b3', lat: 1, lon: 1, alt_baro: 1000, gs: 100, track: 10 },
      { hex: '4ca87c', lat: 999, lon: 1, alt_baro: 1000, gs: 100, track: 10 },
      'not a plane'
    ]
  })
  assert.deepEqual(planes.map(p => p.id), ['ac0f93'], 'ground, non-ICAO and impossible positions are dropped')
  const [plane] = planes
  assert.equal(plane.callsign, 'SWA3261')
  assert.equal(plane.country, 'United States')
  assert.ok(Math.abs(plane.altitudeM - 10972.8) < 0.01)
  assert.ok(Math.abs(plane.speedMs - 222.24) < 0.01)
  assert.ok(Math.abs(plane.climbMs + 5.08) < 0.001)
  assert.equal(plane.time, 1_793_800_000_000 - 2500)
  assert.deepEqual(['00ae17', '4ca87c', '400a1b', '896123', '76cd03', '000001'].map(countryOf), ['South Africa', 'Ireland', 'United Kingdom', 'United Arab Emirates', 'Singapore', ''])
})

test('planes glide along their heading between radar fixes, but not forever', () => {
  const plane = fromOpenSky({ states: [['abc123', 'TEST', 'Nowhere', 0, 0, 0, 0, 10000, false, 250, 90, 0, null, 10000, null]] })[0]
  const later = estimate(plane, 10 * 60_000)
  assert.ok(Math.abs(later.lat) < 1e-9, 'flying due east stays on the equator')
  assert.ok(Math.abs(greatCircleKm(0, 0, later.lat, later.lon) - 150) < 0.5, '250 m/s for 10 minutes is 150 km')
  const capped = estimate(plane, MAX_ESTIMATE_MS * 5)
  assert.deepEqual(capped, estimate(plane, MAX_ESTIMATE_MS), 'stops guessing after 30 minutes')
})

test('satellites land on the globe where SGP4 says, and the sky above you is worked out from them', () => {
  const time = ISS.epoch + 3_600_000
  const frame = positions([ISS], time)
  const [x, y, z] = earthFixed(ISS, time)!.position
  const onGlobe = toLatLon([frame[0], frame[1], frame[2]])
  assert.ok(Math.abs(onGlobe.lat - Math.asin(z / Math.hypot(x, y, z)) * 180 / Math.PI) < 1e-4)
  assert.ok(Math.abs(onGlobe.lon - Math.atan2(y, x) * 180 / Math.PI) < 1e-4)
  const ring = orbit(ISS, time)
  assert.equal(ring.length, 181 * 3)
  assert.ok(Math.hypot(ring[0] - frame[0], ring[1] - frame[1], ring[2] - frame[2]) < 1e-5, 'the orbit line starts at the satellite')
  const sky = new Float32Array([...toVector(DURBAN.lat, DURBAN.lon, 1 + 400 / EARTH_RADIUS_KM), ...toVector(-DURBAN.lat, DURBAN.lon + 180, 1.07), 0, 0, 0])
  const found = overhead(sky, DURBAN)
  assert.deepEqual(found.map(f => f.index), [0], 'the one straight up counts, the far side and the decayed one do not')
  assert.ok(Math.abs(found[0].elevation - 90) < 0.01)
})

test('satellites are sorted into groups people recognise', () => {
  const kind = (name: string, period = 95, inclination = 53) => GROUPS[groupOf({ ...ISS, id: 1, name, periodMinutes: period, inclination })]
  assert.equal(GROUPS[groupOf(ISS)], 'Space stations')
  assert.equal(kind('STARLINK-1007'), 'Starlink')
  assert.equal(kind('GPS BIIR-2  (PRN 13)', 718, 55), 'Navigation')
  assert.equal(kind('INTELSAT 901', 1436, 0.1), 'Geostationary')
  assert.equal(kind('HST'), 'Other')
})

test('the Moon and stars are where the almanac puts them', async () => {
  const { STARS, horizontal, moon } = await import('../src/sky.ts')
  assert.ok(moon(Date.UTC(2024, 3, 8, 18, 21)).lit < 0.02, 'new Moon on the day of the April 2024 eclipse')
  assert.ok(moon(Date.UTC(2024, 3, 23, 23, 49)).lit > 0.98, 'full Moon two weeks later')
  const polaris = STARS.find(([name]) => name === 'Polaris')!
  const london = { lat: 51.5, lon: -0.13 }
  for (const hour of [0, 6, 12, 18]) {
    const { elevation } = horizontal(polaris[1] * 15, polaris[2], london, Date.UTC(2026, 10, 5, hour))
    assert.ok(Math.abs(elevation - london.lat) < 1, `Polaris sits at your latitude: ${elevation}`)
  }
  const acrux = STARS.find(([name]) => name.startsWith('Acrux'))!
  const sky = horizontal(acrux[1] * 15, acrux[2], DURBAN, Date.UTC(2026, 4, 1, 20))
  assert.ok(sky.elevation > 30 && sky.azimuth > 120 && sky.azimuth < 240, `Southern Cross high in the south on a May evening: ${JSON.stringify(sky)}`)
})
