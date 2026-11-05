import { unwrapRing } from '../src/topojson.ts'
import { wrapLon } from '../src/geo.ts'

type Position = [number, number]
type Feature = { name: string, polygons: Position[][][] }

const canvas2d = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  Object.assign(canvas, { width, height })
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  return { canvas, ctx }
}

const WORLD = [-180, -90, 180, 90]

const fillPolygons = (ctx: CanvasRenderingContext2D, polygons: Position[][][], width: number, height: number, [west, south, east, north] = WORLD) => {
  for (const polygon of polygons) {
    const rings = polygon.map(unwrapRing)
    for (const shift of [-360, 0, 360]) {
      ctx.beginPath()
      for (const ring of rings) {
        ring.forEach(([lon, lat], i) => {
          const x = (lon + shift - west) / (east - west) * width
          const y = (north - lat) / (north - south) * height
          if (i) ctx.lineTo(x, y)
          else ctx.moveTo(x, y)
        })
        ctx.closePath()
      }
      ctx.fill('evenodd')
    }
  }
}

export const mapTexture = (land: Position[][][], borders: Position[][], width = 4096, height = 2048, box = WORLD) => {
  const [west, south, east, north] = box
  const { canvas, ctx } = canvas2d(width, height)
  ctx.fillStyle = '#f00'
  fillPolygons(ctx, land, width, height, box)
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = '#0f0'
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.beginPath()
  for (const line of borders) {
    line.forEach(([lon, lat], i) => {
      const x = (lon - west) / (east - west) * width
      const y = (north - lat) / (north - south) * height
      if (i && Math.abs(lon - line[i - 1][0]) < 180) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
  }
  ctx.stroke()
  return canvas
}

export const countryFinder = (countries: Feature[], width = 2048, height = 1024) => {
  const { ctx } = canvas2d(width, height)
  countries.forEach((country, i) => {
    ctx.fillStyle = `rgb(${i + 1}, 255, 0)`
    fillPolygons(ctx, country.polygons, width, height)
  })
  const pixels = ctx.getImageData(0, 0, width, height).data
  const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]]
  return (lat: number, lon: number) => {
    const x = Math.floor((wrapLon(lon) + 180) / 360 * width)
    const y = Math.floor((90 - lat) / 180 * height)
    for (const [dx, dy] of near) {
      const at = ((Math.min(height - 1, Math.max(0, y + dy)) * width) + ((x + dx + width) % width)) * 4
      if (pixels[at + 1] === 255 && pixels[at] > 0) return countries[pixels[at] - 1]?.name || null
    }
    return null
  }
}
