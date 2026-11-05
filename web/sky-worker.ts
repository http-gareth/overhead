import { earthFixed, parseTleText } from '../src/sgp4.ts'
import type { Satellite } from '../src/sgp4.ts'
import { lookAngles, passes, sunDirection, sunlit } from '../src/passes.ts'
import type { Observer, Pass } from '../src/passes.ts'
import { groupOf, orbit, overhead, positions, toGlobe } from '../src/satellites.ts'

let sats: Satellite[] = []
let queue: { key: string, indexes: number[], observer: Observer, from: number, hours: number, visibleOnly: boolean, found: Record<number, Pass[]> } | null = null

const groundTrack = (sat: Satellite, time: number, samples = 240) => {
  const points: number[] = []
  for (let i = 0; i <= samples; i++) {
    const fix = earthFixed(sat, time + (i / samples * 1.5 - 0.5) * sat.periodMinutes * 60_000)
    if (!fix) continue
    const p = toGlobe(fix.position)
    const length = Math.hypot(...p)
    points.push(...p.map(v => v / length * 1.002))
  }
  return new Float32Array(points)
}

const detail = (index: number, time: number, observer: Observer) => {
  const sat = sats[index]
  const fix = sat && earthFixed(sat, time)
  if (!fix) return null
  return {
    index,
    speedKmS: fix.speedKmS,
    sunlit: sunlit(fix.position, sunDirection(time)),
    look: lookAngles(observer, fix.position),
    orbit: orbit(sat, time),
    ground: groundTrack(sat, time)
  }
}

const pump = () => {
  if (!queue) return
  const job = queue
  for (const index of job.indexes.splice(0, 8)) {
    if (!sats[index]) continue
    const found = passes(sats[index], job.observer, job.from, job.hours)
    job.found[index] = job.visibleOnly ? found.filter(pass => pass.visible) : found
  }
  if (job.indexes.length) {
    setTimeout(pump, 0)
    return
  }
  queue = null
  postMessage({ type: 'passes', key: job.key, passes: job.found })
}

onmessage = ({ data }) => {
  if (data.type === 'catalog') {
    sats = parseTleText(data.text)
    postMessage({
      type: 'catalog',
      satellites: sats.map(sat => ({
        name: sat.name, id: sat.id, group: groupOf(sat), inclination: sat.inclination,
        periodMinutes: sat.periodMinutes, epoch: sat.epoch, deepSpace: sat.deepSpace
      }))
    })
  }
  if (data.type === 'frame') {
    const frame = positions(sats, data.time)
    const above = overhead(frame, data.observer)
    const all = new Float32Array(above.flatMap(look => [look.index, look.azimuth, look.elevation]))
    const selected = detail(data.selected, data.time, data.observer)
    postMessage({
      type: 'frame', gen: data.gen, time: data.time, positions: frame, selected,
      above: { count: above.length, top: above.slice(0, 8), all }
    }, [frame.buffer, all.buffer, ...(selected ? [selected.orbit.buffer, selected.ground.buffer] : [])])
  }
  if (data.type === 'passes') {
    if (data.visibleOnly) {
      queue = { key: data.key, indexes: [...data.indexes], observer: data.observer, from: data.from, hours: data.hours, visibleOnly: true, found: {} }
      setTimeout(pump, 0)
      return
    }
    const found = Object.fromEntries((data.indexes as number[]).filter(i => sats[i]).map(i => [i, passes(sats[i], data.observer, data.from)]))
    postMessage({ type: 'passes', key: data.key, passes: found })
  }
}
