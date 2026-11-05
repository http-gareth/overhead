export type SkyObject = {
  azimuth: number
  elevation: number
  color: string
  size: number
  name: string
  detail: string
  label?: boolean
  important?: boolean
  anchor?: boolean
  ahead?: { azimuth: number, elevation: number }
}

type Basis = { right: number[], up: number[], look: number[] }

const RAD = Math.PI / 180
const FIELD = 64
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const ALIGN_KEY = 'overhead-compass'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: number[]) => a.map(v => v / Math.hypot(...a))
const toward = (azimuth: number, elevation: number) =>
  [Math.sin(azimuth * RAD) * Math.cos(elevation * RAD), Math.cos(azimuth * RAD) * Math.cos(elevation * RAD), Math.sin(elevation * RAD)]
const turn = (v: number[], degrees: number) =>
  [v[0] * Math.cos(degrees * RAD) + v[1] * Math.sin(degrees * RAD), -v[0] * Math.sin(degrees * RAD) + v[1] * Math.cos(degrees * RAD), v[2]]
const compass = (azimuth: number) => COMPASS[Math.round(azimuth / 45) % 8]

const fromSensors = (alpha: number, beta: number, gamma: number, screen: number): Basis => {
  const [cA, sA, cB, sB, cG, sG] = [alpha, beta, gamma].flatMap(v => [Math.cos(v * RAD), Math.sin(v * RAD)])
  const x = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG]
  const y = [-cB * sA, cA * cB, sB]
  const z = [cA * sG + cG * sA * sB, sA * sG - cA * cG * sB, cB * cG]
  const [c, s] = [Math.cos(screen * RAD), Math.sin(screen * RAD)]
  return { right: x.map((v, i) => v * c - y[i] * s), up: x.map((v, i) => v * s + y[i] * c), look: z.map(v => -v) }
}

const fromAim = (azimuth: number, elevation: number): Basis => {
  const look = toward(azimuth, elevation)
  const right = [Math.cos(azimuth * RAD), -Math.sin(azimuth * RAD), 0]
  return { right, up: cross(right, look), look }
}

const blend = (from: Basis, to: Basis, k: number): Basis => {
  const look = unit(from.look.map((v, i) => v + (to.look[i] - v) * k))
  const rough = from.up.map((v, i) => v + (to.up[i] - v) * k)
  const up = unit(rough.map((v, i) => v - dot(rough, look) * look[i]))
  return { right: cross(look, up), up, look }
}

const stored = () => {
  try {
    return Number(localStorage.getItem(ALIGN_KEY)) || 0
  } catch {
    return 0
  }
}

export const openAr = async (objects: () => SkyObject[]) => {
  const panel = $('#ar')
  const video = $<HTMLVideoElement>('#ar-video')
  const canvas = $<HTMLCanvasElement>('#ar-canvas')
  const title = $('#ar-title')
  const info = $('#ar-detail')
  const align = $<HTMLButtonElement>('#ar-align')
  panel.hidden = false
  let target: Basis | null = null
  let view: Basis = fromAim(180, 35)
  const aim = { azimuth: 180, elevation: 35 }
  let offset = stored()
  let drag: { x: number, y: number } | null = null
  let frame = 0
  let last = performance.now()
  let shown = ''
  let anchor: SkyObject | null = null

  const permission = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission
  if (permission) await permission().catch(() => 'denied')
  const sense = (event: DeviceOrientationEvent) => {
    const heading = (event as unknown as { webkitCompassHeading?: number }).webkitCompassHeading
    if (event.alpha === null || event.beta === null || event.gamma === null || (!event.absolute && heading === undefined)) return
    target = fromSensors(heading === undefined ? event.alpha : 360 - heading, event.beta, event.gamma, screen.orientation?.angle ?? 0)
  }
  addEventListener('deviceorientationabsolute', sense as EventListener)
  addEventListener('deviceorientation', sense as EventListener)
  const stream = await navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).catch(() => null)
  video.hidden = !stream
  if (stream) video.srcObject = stream

  const press = (event: PointerEvent) => { drag = { x: event.clientX, y: event.clientY } }
  const move = (event: PointerEvent) => {
    if (!drag || target) return
    const perPixel = FIELD / canvas.clientHeight
    aim.azimuth = (aim.azimuth - (event.clientX - drag.x) * perPixel + 360) % 360
    aim.elevation = Math.max(-10, Math.min(89, aim.elevation + (event.clientY - drag.y) * perPixel))
    drag = { x: event.clientX, y: event.clientY }
  }
  const lift = () => { drag = null }
  canvas.addEventListener('pointerdown', press)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', lift)

  align.onclick = () => {
    if (!anchor) return
    const facing = Math.atan2(view.look[0], view.look[1]) / RAD
    offset = ((offset + anchor.azimuth - facing + 540) % 360) - 180
    try {
      localStorage.setItem(ALIGN_KEY, String(offset))
    } catch {}
  }

  const pill = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, strong: boolean) => {
    ctx.font = `${strong ? 600 : 500} ${strong ? 13 : 11}px system-ui, sans-serif`
    const width = ctx.measureText(text).width + 12
    ctx.fillStyle = strong ? 'rgba(4, 8, 18, 0.78)' : 'rgba(4, 8, 18, 0.6)'
    ctx.beginPath()
    ctx.roundRect(x, y - 10, width, 20, 10)
    ctx.fill()
    ctx.fillStyle = strong ? '#ffffff' : 'rgba(225, 235, 255, 0.85)'
    ctx.fillText(text, x + 6, y + 4)
    return { x, y: y - 10, width, height: 20 }
  }

  const draw = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const ratio = Math.min(devicePixelRatio || 1, 2)
    const [width, height] = [canvas.clientWidth, canvas.clientHeight]
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      Object.assign(canvas, { width: Math.round(width * ratio), height: Math.round(height * ratio) })
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const raw = target ?? fromAim(aim.azimuth, aim.elevation)
    const aimed = { right: turn(raw.right, offset), up: turn(raw.up, offset), look: turn(raw.look, offset) }
    view = target ? blend(view, aimed, 1 - Math.exp(-dt * 9)) : aimed
    const focal = height / 2 / Math.tan(FIELD / 2 * RAD)
    const place = (azimuth: number, elevation: number) => {
      const v = toward(azimuth, elevation)
      const depth = dot(v, view.look)
      return { x: width / 2 + dot(v, view.right) / Math.max(depth, 1e-3) * focal, y: height / 2 - dot(v, view.up) / Math.max(depth, 1e-3) * focal, front: depth > 0.12, v }
    }
    const inside = (p: { x: number, y: number, front: boolean }) => p.front && p.x > -40 && p.x < width + 40 && p.y > -40 && p.y < height + 40

    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(140, 200, 255, 0.55)'
    ctx.beginPath()
    for (let azimuth = 0, open = false; azimuth <= 360; azimuth += 2) {
      const p = place(azimuth, 0)
      if (p.front && open) ctx.lineTo(p.x, p.y)
      else if (p.front) ctx.moveTo(p.x, p.y)
      open = p.front
    }
    ctx.stroke()

    const items = objects().sort((a, b) => Number(!!a.important) - Number(!!b.important))
    const taken: { x: number, y: number, width: number, height: number }[] = []
    const free = (r: { x: number, y: number, width: number, height: number }) =>
      taken.every(t => r.x > t.x + t.width || r.x + r.width < t.x || r.y > t.y + t.height || r.y + r.height < t.y)
    let best: { object: SkyObject, angle: number } | null = null
    anchor = null
    let anchorAngle = 15
    const labels: { object: SkyObject, x: number, y: number }[] = []
    for (const object of items) {
      const p = place(object.azimuth, object.elevation)
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(p.v, view.look)))) / RAD
      const score = angle * (object.important ? 0.6 : 1)
      if (score < 7 && (!best || score < best.angle)) best = { object, angle: score }
      if (object.anchor && angle < anchorAngle) [anchor, anchorAngle] = [object, angle]
      if (!inside(p)) {
        if (object.important && p.v[2] > -0.05) {
          const dx = dot(p.v, view.right)
          const dy = dot(p.v, view.up)
          const k = Math.min((width / 2 - 34) / Math.abs(dx || 1e-6), (height / 2 - 70) / Math.abs(dy || 1e-6))
          const [x, y] = [width / 2 + dx * k, height / 2 - dy * k]
          ctx.fillStyle = object.color
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(Math.atan2(dx, dy))
          ctx.beginPath()
          ctx.moveTo(0, -11)
          ctx.lineTo(8, 6)
          ctx.lineTo(-8, 6)
          ctx.fill()
          ctx.restore()
          labels.push({ object, x: Math.min(width - 90, Math.max(8, x - 20)), y: y + (y > height / 2 ? -22 : 24) })
        }
        continue
      }
      if (object.ahead) {
        const q = place(object.ahead.azimuth, object.ahead.elevation)
        if (q.front) {
          const gradient = ctx.createLinearGradient(p.x, p.y, q.x, q.y)
          gradient.addColorStop(0, object.color)
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
          ctx.strokeStyle = gradient
          ctx.lineWidth = object.important ? 2.5 : 1.5
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(q.x, q.y)
          ctx.stroke()
        }
      }
      ctx.fillStyle = object.color
      ctx.globalAlpha = object.important || object.label ? 1 : 0.7
      ctx.beginPath()
      ctx.arc(p.x, p.y, object.size, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      if (object.label || object.important) labels.push({ object, x: p.x + object.size + 6, y: p.y })
    }
    for (const label of labels.reverse()) {
      ctx.font = `${label.object.important ? 600 : 500} ${label.object.important ? 13 : 11}px system-ui, sans-serif`
      const rect = { x: label.x, y: label.y - 10, width: ctx.measureText(label.object.name).width + 12, height: 20 }
      if (!label.object.important && !free(rect)) continue
      taken.push(pill(ctx, label.object.name, label.x, label.y, !!label.object.important))
    }

    const facing = (Math.atan2(view.look[0], view.look[1]) / RAD + 360) % 360
    const tilt = Math.asin(Math.max(-1, Math.min(1, view.look[2]))) / RAD
    ctx.fillStyle = 'rgba(4, 8, 18, 0.55)'
    ctx.fillRect(0, 0, width, 54)
    ctx.textAlign = 'center'
    ctx.font = '600 11px system-ui, sans-serif'
    for (let degrees = Math.ceil((facing - 60) / 5) * 5; degrees <= facing + 60; degrees += 5) {
      const x = width / 2 + (degrees - facing) / 60 * (width / 2 - 20)
      const major = degrees % 45 === 0
      ctx.fillStyle = major ? '#ffffff' : 'rgba(200, 220, 255, 0.55)'
      ctx.fillRect(x - 0.5, 40, 1, major ? 12 : degrees % 15 === 0 ? 8 : 5)
      if (major) ctx.fillText(compass(((degrees % 360) + 360) % 360), x, 34)
    }
    ctx.font = '700 15px system-ui, sans-serif'
    ctx.fillStyle = '#8ab4ff'
    ctx.fillText(`${Math.round(facing)}° ${compass(facing)}`, width / 2, 18)
    ctx.textAlign = 'left'
    pill(ctx, `${Math.round(tilt)}° up`, 10, 76, false)

    ctx.strokeStyle = best ? '#8ab4ff' : 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(width / 2, height / 2, 22, 0, Math.PI * 2)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(width / 2 + dx * 28, height / 2 + dy * 28)
      ctx.lineTo(width / 2 + dx * 36, height / 2 + dy * 36)
    }
    ctx.stroke()

    const key = `${best?.object.name ?? ''}|${anchor?.name ?? ''}|${!!target}`
    if (key !== shown) {
      shown = key
      title.textContent = best ? best.object.name : 'Aim the circle at a dot'
      info.textContent = best ? best.object.detail : target ? 'Move your phone around the sky' : 'No compass here, so drag to look around'
      align.hidden = !target || !anchor
      align.textContent = anchor ? `Line up the ${anchor.name} in the circle, then tap to align` : ''
    }
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)

  $('#ar-close').onclick = () => {
    cancelAnimationFrame(frame)
    removeEventListener('deviceorientationabsolute', sense as EventListener)
    removeEventListener('deviceorientation', sense as EventListener)
    canvas.removeEventListener('pointerdown', press)
    canvas.removeEventListener('pointermove', move)
    canvas.removeEventListener('pointerup', lift)
    stream?.getTracks().forEach(track => track.stop())
    video.srcObject = null
    panel.hidden = true
  }
}

export const arOpen = () => !$('#ar').hidden
