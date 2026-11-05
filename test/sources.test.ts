import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvRows, parseAircraft, parseAurora, parseLaunches, parseRoute, parseSatcat, parseTrack, parseVolcanoes } from '../src/sources.ts'

test('aircraft and routes keep only clean fields, and photos only from the known host', () => {
  const aircraft = parseAircraft({ response: { aircraft: {
    type: '747 4R7F', manufacturer: 'Boeing', registration: 'LX-YCV', registered_owner: 'Cargolux\nItalia',
    registered_owner_country_name: 'Luxembourg', url_photo_thumbnail: 'https://airport-data.com/images/aircraft/thumbnails/001/650/001650774.jpg'
  } } })
  assert.deepEqual(aircraft, {
    type: '747 4R7F', manufacturer: 'Boeing', registration: 'LX-YCV', owner: 'Cargolux Italia', ownerCountry: 'Luxembourg',
    photo: 'https://airport-data.com/images/aircraft/thumbnails/001/650/001650774.jpg'
  })
  assert.equal(parseAircraft({ response: { aircraft: { url_photo_thumbnail: 'https://evil.example/x.jpg' } } })!.photo, null)
  assert.equal(parseAircraft({ response: { aircraft: { url_photo_thumbnail: 'https://airport-data.com/x.jpg" onerror="alert(1)' } } })!.photo, null)
  assert.equal(parseAircraft({ response: 'unknown aircraft' }), null)

  const airport = (name: string, lat: number, lon: number) => ({ name, municipality: name, country_name: 'Somewhere', iata_code: name.slice(0, 3).toUpperCase(), latitude: lat, longitude: lon })
  const route = parseRoute({ response: { flightroute: { callsign_iata: 'CV491', airline: { name: 'Cargolux' }, origin: airport('Luxembourg', 49.6, 6.2), destination: airport('Johannesburg', -26.1, 28.2) } } })
  assert.equal(route!.from.iata, 'LUX')
  assert.equal(route!.to.lat, -26.1)
  assert.equal(parseRoute({ response: { flightroute: { origin: airport('Nowhere', 999, 0), destination: airport('Johannesburg', -26.1, 28.2) } } }), null)
})

test('a flight path keeps real points only, in milliseconds', () => {
  const track = parseTrack({ path: [[1793863332, -26.1, 28.2, 1524, 14, false], [1793863336, -26.0, 28.3, null, 12, false], [1793863340, 300, 28, 1, 1, false], 'junk'] })
  assert.deepEqual(track, [[1793863332000, -26.1, 28.2, 1524], [1793863336000, -26.0, 28.3, 0]])
  assert.equal(parseTrack({ path: [[1, 0, 0, 0]] }), null, 'one point is not a path')
  assert.equal(parseTrack(null), null)
})

test('the satellite catalogue keeps working payloads and gives each a purpose', () => {
  const satcat = [
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE',
    'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.9,51.6,420,415,399.05,,EA,ORB',
    'SL-1 R/B,1957-001A,1,R/B,D,CIS,1957-10-04,TYMSC,1957-12-01,96.19,65.10,938,214,20.42,,EA,IMP',
    'STARLINK-1007,2019-074A,44713,PAY,+,US,2019-11-11,AFETR,,95,53,550,550,,,EA,ORB',
    '"WEIRD, NAME",2020-001A,45000,PAY,+,PRC,2020-01-01,JSC,,95,97,500,500,1.5,,EA,ORB',
    ...Array.from({ length: 100 }, (_, i) => `FILLER ${i},2021-001A,${50000 + i},PAY,+,US,2021-01-01,AFETR,,95,53,550,550,,,EA,ORB`)
  ].join('\n')
  const stations = 'OBJECT_NAME,NORAD_CAT_ID\nISS (ZARYA),25544'
  const weather = 'OBJECT_NAME,NORAD_CAT_ID\nWEIRD,45000'
  const { purposes, rows } = parseSatcat(satcat, [['Space station', stations], ['Weather', weather]])
  const byId = new Map(rows.map(row => [row[0], row]))
  assert.equal(byId.has(1), false, 'rocket bodies and decayed objects are dropped')
  assert.deepEqual(byId.get(25544), [25544, 'ISS', '1998-11-20', 'TYMSC', 399.05, purposes.indexOf('Space station')])
  assert.equal(purposes[byId.get(44713)![5] as number], 'Internet from space', 'Starlink is recognised by name')
  assert.equal(purposes[byId.get(45000)![5] as number], 'Weather', 'quoted commas do not shift the columns')
  assert.deepEqual(csvRows('a,"b ""c"", d",e'), [['a', 'b "c", d', 'e']])
  assert.throws(() => parseSatcat('<html>busy</html>', []))
})

test('launches, aurora and volcano reports are read safely', () => {
  const launches = parseLaunches({ results: [
    { id: 'b', name: 'Later', net: '2026-11-07T10:00:00Z', pad: { latitude: '28.5', longitude: '-80.6', name: 'LC-39A', location: { name: 'Florida' } }, image: { image_url: 'https://evil.example/x.png' } },
    { id: 'a', name: 'Sooner', net: '2026-11-05T16:00:00Z', pad: { latitude: 28.2, longitude: 102.0 }, rocket: { configuration: { full_name: 'Long March 2C' } } },
    { id: 'c', name: 'No pad', net: '2026-11-06T00:00:00Z' }
  ] })
  assert.deepEqual(launches.map(l => l.name), ['Sooner', 'Later'])
  assert.equal(launches[1].lat, 28.5)
  assert.equal(launches[1].image, null)
  assert.equal(launches[0].rocket, 'Long March 2C')

  const coordinates = Array.from({ length: 1200 }, (_, i) => [i % 360, -90 + Math.floor(i / 360), 0])
  coordinates.push([359, 67, 85], [10, 300, 99])
  const aurora = parseAurora({ 'Observation Time': '2026-11-05T07:52:00Z', coordinates }, [{ time_tag: '2026-11-05T03:00:00', Kp: 1.67 }])
  const grid = Buffer.from(aurora.grid, 'base64')
  assert.equal(grid.length, 360 * 181)
  assert.equal(grid[(67 + 90) * 360 + 359], 85)
  assert.equal(aurora.kp, 1.67)
  assert.equal(parseAurora({ coordinates }, [['time_tag', 'Kp'], ['2026-11-05 03:00:00.000', '2.33']]).kp, 2.33, 'the older Kp format works too')
  assert.throws(() => parseAurora({}, []))

  const volcanoes = parseVolcanoes(`<rss><channel><item>
    <title>Krakatau (Indonesia) - Report for 8 October-14 October 2026 - New Eruptive Activity</title>
    <link>http://volcano.si.edu/volcano.cfm?vn=262000</link>
    <description>&lt;p&gt;Ash plumes rose 1&amp;nbsp;km &amp;amp; drifted &lt;b&gt;N&lt;/b&gt;.&lt;/p&gt;&lt;script&gt;x&lt;/script&gt;</description>
    <georss:point>-6.1009 105.4233</georss:point>
  </item><item><title>No place</title><georss:point>bad</georss:point></item></channel></rss>`)
  assert.equal(volcanoes.length, 1)
  assert.deepEqual({ ...volcanoes[0], summary: undefined }, {
    name: 'Krakatau', country: 'Indonesia', week: '8 October-14 October 2026', kind: 'New Eruptive Activity',
    summary: undefined, lat: -6.1009, lon: 105.4233, url: 'https://volcano.si.edu/volcano.cfm?vn=262000'
  })
  assert.equal(volcanoes[0].summary.includes('<'), false, 'no markup survives')
  assert.match(volcanoes[0].summary, /Ash plumes rose 1 km & drifted N/)
  assert.throws(() => parseVolcanoes('not xml'))
})
