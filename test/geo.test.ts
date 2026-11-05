import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearing, greatCircleKm, hidden, project, rotate, toLatLon, toVector, viewMatrix, wrapLon } from '../src/geo.ts'
import { subsolarPoint } from '../src/sun.ts'
import { borders, features, polygons, unwrapRing } from '../src/topojson.ts'
import type { Topology } from '../src/topojson.ts'
import { depthBand, parseQuakes } from '../src/quakes.ts'

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`)

test('latitude and longitude survive a round trip through 3D', () => {
  for (const [lat, lon] of [[0, 0], [-29.86, 31.02], [51.5, -0.13], [-89, 179], [45, -179.5]]) {
    const back = toLatLon(toVector(lat, lon))
    close(back.lat, lat, 1e-9, 'lat')
    close(wrapLon(back.lon - lon), 0, 1e-9, 'lon')
  }
})

test('the view turns the chosen place to face the camera, with north up', () => {
  const view = { lat: -29.86, lon: 31.02, distance: 3 }
  const rows = viewMatrix(view)
  const facing = rotate(rows, toVector(view.lat, view.lon))
  close(facing[0], 0, 1e-9, 'x')
  close(facing[1], 0, 1e-9, 'y')
  close(facing[2], 1, 1e-9, 'z')
  const north = rotate(rows, toVector(view.lat + 10, view.lon))
  assert.ok(north[1] > 0, 'a point further north sits higher on screen')
  const east = rotate(rows, toVector(view.lat, view.lon + 10))
  assert.ok(east[0] > 0, 'a point further east sits to the right')
  assert.deepEqual(project(facing, view.distance, 1), { x: 0, y: 0 })
  assert.equal(project(rotate(rows, toVector(-view.lat, view.lon + 180)), view.distance, 1), null, 'the far side is hidden')
})

test('the sun is overhead where the almanac says', () => {
  close(subsolarPoint(new Date(Date.UTC(2026, 5, 21, 12))).lat, 23.44, 0.1, 'June solstice')
  close(subsolarPoint(new Date(Date.UTC(2026, 11, 21, 12))).lat, -23.44, 0.1, 'December solstice')
  close(subsolarPoint(new Date(Date.UTC(2026, 2, 20, 14, 46))).lat, 0, 0.1, 'March equinox')
  close(subsolarPoint(new Date(Date.UTC(2026, 10, 4, 12))).lon, -4.1, 0.6, 'solar noon offset in early November')
  close(subsolarPoint(new Date(Date.UTC(2026, 10, 4, 0))).lon, 175.9, 0.6, 'midnight UTC puts the sun over the Pacific')
})

test('bearings point the way a plane would fly', () => {
  close(bearing(0, 0, 10, 0), 0, 1e-9, 'due north')
  close(bearing(0, 0, 0, 10), 90, 1e-9, 'due east')
  close(bearing(-26.13, 28.24, -20.43, 57.68), 84.3, 0.1, 'Johannesburg to Mauritius heads just north of east')
})

test('distances follow the curve of the Earth', () => {
  close(greatCircleKm(-29.8587, 31.0218, -26.2041, 28.0473), 500, 25, 'Durban to Johannesburg')
  close(greatCircleKm(0, 0, 0, 180), Math.PI * 6371, 1, 'half way round the equator')
})

test('TopoJSON arcs decode into closed rings, reversed arcs included', () => {
  const topology: Topology = {
    type: 'Topology',
    transform: { scale: [1, 1], translate: [0, 0] },
    arcs: [[[0, 0], [10, 0], [0, 10]], [[10, 10], [-10, 0], [0, -10]]],
    objects: { land: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0, 1]] }, { type: 'MultiPolygon', arcs: [[[~1, ~0]]] }] } }
  }
  const [square, backwards] = polygons(topology, 'land')
  assert.deepEqual(square[0], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])
  assert.deepEqual(backwards[0], [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]])
  assert.throws(() => polygons(topology, 'sea'))
})

test('the USGS feed is parsed defensively, newest first', () => {
  const feature = (id: string, time: number, extra: object = {}) => ({
    id, properties: { mag: 4.6, place: '10 km S of Somewhere', time, tsunami: 0, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, ...extra },
    geometry: { type: 'Point', coordinates: [31, -29, 10] }
  })
  const quakes = parseQuakes({
    features: [
      feature('old', 1),
      feature('new', 2, { tsunami: 1 }),
      feature('evil-link', 3, { url: 'javascript:alert(1)', place: '' }),
      { id: 'no-magnitude', properties: { time: 4 }, geometry: { coordinates: [0, 0, 0] } },
      { id: 'off-the-map', properties: { mag: 3, time: 5 }, geometry: { coordinates: [200, 0, 0] } },
      null
    ]
  })
  assert.deepEqual(quakes.map(q => q.id), ['evil-link', 'new', 'old'])
  assert.equal(quakes[0].url, null, 'only USGS event pages become links')
  assert.equal(quakes[0].place, 'Unnamed location')
  assert.equal(quakes[1].tsunami, true)
  assert.deepEqual(parseQuakes('nonsense'), [])
  assert.deepEqual([10, 150, 600].map(depthBand), ['shallow', 'intermediate', 'deep'])
})

test('outlines that cross the date line are unrolled, and ones round a pole are closed through it', () => {
  const fiji: [number, number][] = [[179, -16], [-179.5, -16.2], [-179, -17], [179.5, -17.1], [179, -16]]
  assert.deepEqual(unwrapRing(fiji).map(([lon]) => lon), [179, 180.5, 181, 179.5, 179], 'no 360-degree jumps')
  const antarctica: [number, number][] = [[-180, -84], [-90, -80], [0, -70], [90, -66], [180, -84]]
  const closed = unwrapRing(antarctica)
  assert.deepEqual(closed.slice(-2), [[180, -90], [-180, -90]], 'closed via the south pole')
  const local: [number, number][] = [[10, 10], [20, 10], [20, 20], [10, 10]]
  assert.deepEqual(unwrapRing(local), local, 'ordinary shapes are untouched')
})

test('things above the surface are hidden only when the Earth is in the way', () => {
  const distance = 3
  assert.equal(hidden([0, 0, 1.07], distance), false, 'a satellite in front of the globe')
  assert.equal(hidden([0, 0, -1.07], distance), true, 'a satellite straight behind it')
  assert.equal(hidden([1.2, 0, -0.3], distance), false, 'a satellite behind but off to the side, peeking past the edge')
  assert.equal(hidden([0, 0, 0], distance), true, 'the centre of the Earth')
  assert.equal(project([0, 0, 3.5], distance, 1), null, 'behind the camera')
})

test('country borders are the lines two countries share, not coastlines', () => {
  const topology: Topology = {
    type: 'Topology',
    arcs: [[[0, 0], [0, 10]], [[0, 10], [-10, 10], [-10, 0], [0, 0]], [[0, 0], [10, 0], [10, 10], [0, 10]]],
    objects: {
      countries: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0, 1]], properties: { name: 'West' } },
          { type: 'MultiPolygon', arcs: [[[2, ~0]]], properties: { name: 'East' } },
          { type: 'Polygon', arcs: [[1]], properties: { name: 42 } }
        ]
      }
    }
  }
  assert.deepEqual(borders(topology, 'countries'), [[[0, 0], [0, 10]], [[0, 10], [-10, 10], [-10, 0], [0, 0]]])
  assert.deepEqual(features(topology, 'countries').map(country => country.name), ['West', 'East', ''])
  assert.deepEqual(features(topology, 'countries')[1].polygons[0][0], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])
})
