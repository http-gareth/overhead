import { el, number } from './views.ts'

const SVG = 'http://www.w3.org/2000/svg'
const svg = (tag: string, attributes: Record<string, string | number> = {}, text?: string) => {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  if (text !== undefined) node.textContent = text
  return node
}

const niceMax = (value: number) => {
  const step = 10 ** Math.floor(Math.log10(Math.max(value, 1)))
  return Math.ceil(value / step / 2) * step * 2
}

export const lineChart = (title: string, points: [number, number][], format: (value: number) => string, time: (t: number) => string) => {
  const [width, height, left, right, top, bottom] = [320, 104, 44, 10, 10, 20]
  const figure = el('figure', undefined, 'chart')
  figure.append(el('figcaption', title))
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${title}, from ${format(points[0][1])} to ${format(points.at(-1)![1])}` })
  const [t0, t1] = [points[0][0], points.at(-1)![0]]
  const top_ = niceMax(Math.max(...points.map(([, v]) => v)))
  const x = (t: number) => left + (t - t0) / Math.max(t1 - t0, 1) * (width - left - right)
  const y = (v: number) => top + (1 - v / top_) * (height - top - bottom)
  for (const tick of [0, top_ / 2, top_]) {
    chart.append(svg('line', { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: 'grid' }))
    chart.append(svg('text', { x: left - 6, y: y(tick) + 3, 'text-anchor': 'end', class: 'tick' }, format(tick)))
  }
  chart.append(svg('text', { x: left, y: height - 4, class: 'tick' }, time(t0)))
  chart.append(svg('text', { x: width - right, y: height - 4, 'text-anchor': 'end', class: 'tick' }, time(t1)))
  chart.append(svg('path', { d: points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(''), class: 'trace' }))
  const [tEnd, vEnd] = points.at(-1)!
  chart.append(svg('circle', { cx: x(tEnd), cy: y(vEnd), r: 4, class: 'end' }))
  const cross = svg('line', { y1: top, y2: height - bottom, class: 'cross', visibility: 'hidden' })
  const readout = svg('text', { x: left + 4, y: top + 9, class: 'readout' })
  const hit = svg('rect', { x: left, y: top, width: width - left - right, height: height - top - bottom, class: 'hit' })
  chart.append(cross, readout, hit)
  hit.addEventListener('pointermove', event => {
    const box = chart.getBoundingClientRect()
    const at = t0 + ((event.clientX - box.left) / box.width * width - left) / (width - left - right) * (t1 - t0)
    const [t, v] = points.reduce((best, point) => Math.abs(point[0] - at) < Math.abs(best[0] - at) ? point : best)
    cross.setAttribute('x1', String(x(t)))
    cross.setAttribute('x2', String(x(t)))
    cross.setAttribute('visibility', 'visible')
    readout.textContent = `${time(t)} · ${format(v)}`
  })
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden')
    readout.textContent = ''
  })
  figure.append(chart)
  return figure
}

export const bars = (title: string, rows: { label: string, value: number }[], unit = '') => {
  const figure = el('figure', undefined, 'chart')
  figure.append(el('figcaption', title))
  const max = Math.max(...rows.map(row => row.value), 1)
  const list = el('div', undefined, 'bars')
  for (const row of rows) {
    const line = el('div', undefined, 'bar')
    line.title = `${row.label}: ${number(row.value)}${unit}`
    const track = el('span', undefined, 'track')
    const fill = el('span', undefined, 'fill')
    fill.style.width = `${Math.max(row.value / max * 100, row.value ? 1.5 : 0)}%`
    track.append(fill)
    line.append(el('span', row.label, 'name'), track, el('span', `${number(row.value)}${unit}`, 'amount'))
    list.append(line)
  }
  figure.append(list)
  return figure
}

export type SkyDot = { azimuth: number, elevation: number, color: string, size: number, label?: string, pick: () => void, chosen?: boolean }

export const drawSky = (canvas: HTMLCanvasElement, dots: SkyDot[], sun: { azimuth: number, elevation: number } | null) => {
  const ratio = Math.min(devicePixelRatio || 1, 2)
  const size = canvas.clientWidth
  if (!size) return []
  if (canvas.width !== Math.round(size * ratio)) Object.assign(canvas, { width: Math.round(size * ratio), height: Math.round(size * ratio) })
  const ctx = canvas.getContext('2d')!
  const css = getComputedStyle(canvas)
  const ink = (name: string) => css.getPropertyValue(name).trim()
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, size, size)
  const centre = size / 2
  const radius = size / 2 - 16
  const at = (azimuth: number, elevation: number) => {
    const r = radius * (90 - elevation) / 90
    const a = azimuth * Math.PI / 180
    return { x: centre + r * Math.sin(a), y: centre - r * Math.cos(a) }
  }
  ctx.fillStyle = ink('--sky')
  ctx.beginPath()
  ctx.arc(centre, centre, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = ink('--edge')
  ctx.lineWidth = 1
  for (const elevation of [0, 30, 60]) {
    ctx.beginPath()
    ctx.arc(centre, centre, radius * (90 - elevation) / 90, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = ink('--muted')
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const [label, azimuth] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
    const p = at(azimuth, -9)
    ctx.fillText(label, p.x, p.y)
  }
  for (const elevation of [30, 60]) ctx.fillText(`${elevation}°`, centre + 12, at(0, elevation).y)
  if (sun && sun.elevation > -2) {
    const p = at(sun.azimuth, Math.max(sun.elevation, 0))
    ctx.fillStyle = ink('--intermediate')
    ctx.beginPath()
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
    ctx.fill()
  }
  const placed = dots.map(dot => ({ dot, ...at(dot.azimuth, dot.elevation) }))
  for (const { dot, x, y } of placed) {
    ctx.fillStyle = dot.color
    ctx.beginPath()
    ctx.arc(x, y, dot.size, 0, Math.PI * 2)
    ctx.fill()
    if (dot.chosen) {
      ctx.strokeStyle = ink('--text')
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(x, y, dot.size + 5, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.fillStyle = ink('--text')
  ctx.textAlign = 'left'
  for (const { dot, x, y } of placed) if (dot.label) ctx.fillText(dot.label, x + dot.size + 4, y)
  return placed
}
