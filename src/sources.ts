export type Aircraft = { type: string, manufacturer: string, registration: string, owner: string, ownerCountry: string, photo: string | null }
export type Airport = { name: string, city: string, country: string, iata: string, lat: number, lon: number }
export type Route = { flight: string, airline: string, from: Airport, to: Airport }
export type TrackPoint = [time: number, lat: number, lon: number, altitudeM: number]
export type Launch = {
  id: string, name: string, time: number, status: string, provider: string, rocket: string, mission: string,
  missionType: string, orbit: string, description: string, pad: string, location: string, lat: number, lon: number, image: string | null
}
export type Volcano = { name: string, country: string, week: string, kind: string, summary: string, lat: number, lon: number, url: string | null }

const text = (value: unknown, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
const number = (value: unknown) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const place = (lat: unknown, lon: unknown) => {
  const [a, b] = [number(lat), number(lon)]
  return a !== null && b !== null && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { lat: a, lon: b } : null
}
const link = (value: unknown, prefixes: string[]) =>
  typeof value === 'string' && prefixes.some(prefix => value.startsWith(prefix)) && !/["'<>\s\\]/.test(value) ? value : null
const field = (value: unknown, ...path: string[]) => path.reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), value)

export const PHOTO_HOSTS = ['https://airport-data.com/', 'https://image.airport-data.com/']
export const LAUNCH_IMAGE_HOSTS = ['https://thespacedevs-prod.nyc3.digitaloceanspaces.com/']

export const parseAircraft = (json: unknown): Aircraft | null => {
  const a = field(json, 'response', 'aircraft')
  if (!a || typeof a !== 'object') return null
  return {
    type: text(field(a, 'type'), 60), manufacturer: text(field(a, 'manufacturer'), 60), registration: text(field(a, 'registration'), 12),
    owner: text(field(a, 'registered_owner'), 80), ownerCountry: text(field(a, 'registered_owner_country_name'), 60),
    photo: link(field(a, 'url_photo'), PHOTO_HOSTS) ?? link(field(a, 'url_photo_thumbnail'), PHOTO_HOSTS)
  }
}

const airport = (value: unknown): Airport | null => {
  const at = place(field(value, 'latitude'), field(value, 'longitude'))
  return at && {
    name: text(field(value, 'name'), 80), city: text(field(value, 'municipality'), 60),
    country: text(field(value, 'country_name'), 60), iata: text(field(value, 'iata_code'), 4), ...at
  }
}

export const parseRoute = (json: unknown): Route | null => {
  const route = field(json, 'response', 'flightroute')
  const [from, to] = [airport(field(route, 'origin')), airport(field(route, 'destination'))]
  return from && to ? { flight: text(field(route, 'callsign_iata'), 10), airline: text(field(route, 'airline', 'name'), 80), from, to } : null
}

export const parseTrack = (json: unknown): TrackPoint[] | null => {
  const path = field(json, 'path')
  if (!Array.isArray(path)) return null
  const points = path.flatMap((point): TrackPoint[] => {
    if (!Array.isArray(point)) return []
    const time = number(point[0])
    const at = place(point[1], point[2])
    return time !== null && at ? [[time * 1000, at.lat, at.lon, number(point[3]) ?? 0]] : []
  })
  return points.length >= 2 ? points : null
}

export const csvRows = (csv: string) => csv.split(/\r?\n/).filter(Boolean).map(line => {
  const cells: string[] = []
  for (const match of line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)) {
    const cell = match[1]
    cells.push(cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell)
  }
  return cells
})

const columns = (rows: string[][]) => Object.fromEntries((rows[0] ?? []).map((name, i) => [name.trim(), i]))

export const parseSatcat = (satcat: string, groups: [purpose: string, csv: string][]) => {
  const rows = csvRows(satcat)
  const at = columns(rows)
  if ([at.NORAD_CAT_ID, at.OWNER, at.LAUNCH_DATE, at.DECAY_DATE, at.OBJECT_TYPE].some(i => i === undefined)) throw new Error('not a satellite catalogue')
  const purposes = [...new Set(groups.map(([purpose]) => purpose)), 'Internet from space', 'Communications']
  const purposeOf = new Map<number, number>()
  for (const [purpose, csv] of groups) {
    const list = csvRows(csv)
    const id = columns(list).NORAD_CAT_ID
    if (id === undefined) continue
    for (const row of list.slice(1)) {
      const norad = Number(row[id])
      if (!purposeOf.has(norad)) purposeOf.set(norad, purposes.indexOf(purpose))
    }
  }
  const out = rows.slice(1).flatMap(row => {
    if (row[at.DECAY_DATE] || row[at.OBJECT_TYPE] !== 'PAY') return []
    const id = Number(row[at.NORAD_CAT_ID])
    if (!Number.isInteger(id)) return []
    const name = row[at.OBJECT_NAME] ?? ''
    const named = /^(STARLINK|ONEWEB|KUIPER|QIANFAN|HULIANWANG)/.test(name) ? purposes.indexOf('Internet from space')
      : /IRIDIUM|GLOBALSTAR|ORBCOMM|INTELSAT|EUTELSAT|SES-|ASTRA|INMARSAT|VIASAT|TELSTAR|ECHOSTAR|SKYNET/.test(name) ? purposes.indexOf('Communications') : -1
    const rcs = number(row[at.RCS])
    return [[id, text(row[at.OWNER], 8), text(row[at.LAUNCH_DATE], 10), text(row[at.LAUNCH_SITE], 8), rcs, purposeOf.get(id) ?? named]]
  })
  if (out.length < 100) throw new Error('too few satellites in the catalogue')
  return { purposes, rows: out }
}

export const parseLaunches = (json: unknown): Launch[] => {
  const results = field(json, 'results')
  if (!Array.isArray(results)) throw new Error('no launches')
  return results.flatMap(r => {
    const at = place(field(r, 'pad', 'latitude'), field(r, 'pad', 'longitude'))
    const time = Date.parse(String(field(r, 'net')))
    if (!at || !Number.isFinite(time)) return []
    return [{
      id: text(field(r, 'id'), 40), name: text(field(r, 'name')), time, status: text(field(r, 'status', 'name'), 60),
      provider: text(field(r, 'launch_service_provider', 'name'), 80),
      rocket: text(field(r, 'rocket', 'configuration', 'full_name') || field(r, 'rocket', 'configuration', 'name'), 60),
      mission: text(field(r, 'mission', 'name'), 80), missionType: text(field(r, 'mission', 'type'), 40),
      orbit: text(field(r, 'mission', 'orbit', 'name'), 40), description: text(field(r, 'mission', 'description'), 600),
      pad: text(field(r, 'pad', 'name'), 80), location: text(field(r, 'pad', 'location', 'name'), 100), ...at,
      image: link(field(r, 'image', 'image_url') ?? field(r, 'image'), LAUNCH_IMAGE_HOSTS)
    }]
  }).sort((a, b) => a.time - b.time)
}

export const parseAurora = (ovation: unknown, kp: unknown) => {
  const coordinates = field(ovation, 'coordinates')
  if (!Array.isArray(coordinates) || coordinates.length < 1000) throw new Error('no aurora grid')
  const grid = new Uint8Array(360 * 181)
  for (const point of coordinates) {
    if (!Array.isArray(point)) continue
    const [lon, lat, chance] = point.map(number)
    if (lon === null || lat === null || chance === null || Math.abs(lat) > 90) continue
    grid[(Math.round(lat) + 90) * 360 + ((Math.round(lon) % 360) + 360) % 360] = Math.max(0, Math.min(100, chance))
  }
  const latest = Array.isArray(kp) ? kp.at(-1) : null
  const index = Array.isArray(latest) ? number(latest[1]) : number(field(latest, 'Kp') ?? field(latest, 'kp_index'))
  return {
    observed: text(field(ovation, 'Observation Time'), 30), forecast: text(field(ovation, 'Forecast Time'), 30),
    kp: index, kpTime: text(Array.isArray(latest) ? latest[0] : field(latest, 'time_tag'), 30),
    grid: Buffer.from(grid).toString('base64')
  }
}

const decode = (html: string) => html
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&(lt|gt|quot|apos|nbsp|amp);/g, (_, name) => ({ lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' })[name as string]!)

export const parseVolcanoes = (xml: string): Volcano[] => {
  if (!xml.includes('<rss')) throw new Error('not a volcano report')
  return xml.split('<item>').slice(1).flatMap(item => {
    const tag = (name: string) => item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? ''
    const [lat, lon] = tag('georss:point').trim().split(/\s+/)
    const at = place(lat, lon)
    const title = text(decode(tag('title')), 200).match(/^(.*?) \((.*?)\) - Report for (.*?) - (.*)$/)
    if (!at || !title) return []
    return [{
      name: title[1], country: title[2], week: title[3], kind: title[4],
      summary: text(decode(decode(tag('description')).replace(/<[^>]*>/g, ' ')), 700),
      ...at, url: link(decode(tag('link')).trim().replace(/^http:/, 'https:'), ['https://volcano.si.edu/'])
    }]
  })
}
