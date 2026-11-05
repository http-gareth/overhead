import { mkdir, writeFile } from 'node:fs/promises'
import { parseTleText } from '../src/sgp4.ts'
import { parseSatcat } from '../src/sources.ts'

const PURPOSES: [string, string][] = [
  ['stations', 'Space station'], ['gnss', 'Navigation'], ['weather', 'Weather'], ['resource', 'Earth imaging'],
  ['sarsat', 'Search and rescue'], ['science', 'Science'], ['geodetic', 'Measuring the Earth'], ['military', 'Military'],
  ['amateur', 'Amateur radio'], ['engineering', 'Technology testing'], ['education', 'Education'],
  ['x-comm', 'Communications'], ['other-comm', 'Communications'], ['geo', 'Communications']
]

const celestrak = (group: string, format: string) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=${format}`

const get = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'Overhead (github.com/http-gareth)' } })
  const body = await response.text()
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${body.slice(0, 200)}`)
  return body
}

const satellites = await get(celestrak('active', 'tle'))
const count = parseTleText(satellites).length
if (count < 1000) throw new Error(`only ${count} satellites in the CelesTrak feed`)
const satcat = await get('https://celestrak.org/pub/satcat.csv')
const groups: [string, string][] = []
for (const [group, purpose] of PURPOSES) groups.push([purpose, await get(celestrak(group, 'csv'))])
const records = parseSatcat(satcat, groups)

await mkdir('orbits', { recursive: true })
await writeFile('orbits/satellites.tle', satellites)
await writeFile('orbits/satinfo.json', JSON.stringify(records))
console.log(`${count} satellites, ${records.rows.length} catalogue records`)
