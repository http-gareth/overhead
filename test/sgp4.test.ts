import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EARTH_RADIUS_KM, earthFixed, parseTle, parseTleText, propagate } from '../src/sgp4.ts'

const VANGUARD = [
  'VANGUARD 1',
  '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
  '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667'
]

const ISS = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26308.36953014  .00005228  00000+0  10236-3 0  9991',
  '2 25544  51.6329 326.3987 0007186 346.7494  13.3304 15.49173979593483'
]

const near = (actual: number[], expected: number[], tolerance: number, what: string) =>
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${what}[${i}]: ${value} vs ${expected[i]}`))

test('SGP4 matches the official verification results for Vanguard 1', () => {
  const sat = parseTle(VANGUARD[0], VANGUARD[1], VANGUARD[2])
  assert.ok(sat, 'the reference TLE parses, checksums included')
  const start = propagate(sat.model, 0)!
  near(start.position, [7022.46529266, -1400.08296755, 0.03995155], 1e-3, 'position at epoch')
  near(start.velocity, [1.893841015, 6.405893759, 4.53480725], 1e-6, 'velocity at epoch')
  const later = propagate(sat.model, 360)!
  near(later.position, [-7154.03120202, -3783.17682504, -3536.19412294], 1e-3, 'position after 6 hours')
  near(later.velocity, [4.741887409, -4.151817765, -2.093935425], 1e-6, 'velocity after 6 hours')
})

test('the ISS flies where the ISS flies', () => {
  const sat = parseTle(ISS[0], ISS[1], ISS[2])!
  assert.equal(sat.id, 25544)
  assert.equal(sat.deepSpace, false)
  assert.ok(sat.periodMinutes > 92 && sat.periodMinutes < 93.5, `period ${sat.periodMinutes}`)
  for (const hours of [0, 1, 6, 24]) {
    const fix = earthFixed(sat, sat.epoch + hours * 3_600_000)!
    const altitude = Math.hypot(...fix.position) - EARTH_RADIUS_KM
    assert.ok(altitude > 380 && altitude < 440, `altitude ${altitude} km after ${hours} h`)
    assert.ok(fix.speedKmS > 7.6 && fix.speedKmS < 7.75, `speed ${fix.speedKmS} km/s`)
    const latitude = Math.asin(fix.position[2] / Math.hypot(...fix.position)) * 180 / Math.PI
    assert.ok(Math.abs(latitude) <= 51.7, 'never further north or south than its inclination')
  }
})

test('TLE text is read defensively', () => {
  const broken = ISS[1].slice(0, 68) + '0'
  const satellites = parseTleText([...ISS, 'NO CHECKSUM', broken, ISS[2], ...VANGUARD, 'garbage'].join('\r\n'))
  assert.deepEqual(satellites.map(sat => sat.name), ['ISS (ZARYA)', 'VANGUARD 1'])
  assert.equal(parseTle('X', 'nonsense', 'more nonsense'), null)
})
