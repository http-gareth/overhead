export type SkyObject = { azimuth: number, elevation: number, color: string, size: number, label?: string, detail: string }

type Basis = { right: number[], up: number[], look: number[] }

const RAD = Math.PI / 180
const FIELD = 62
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const toward = (azimuth: number, elevation: number) =>
  [Math.sin(azimuth * RAD) * Math.cos(elevation * RAD), Math.cos(azimuth * RAD) * Math.cos(elevation * RAD), Math.sin(elevation * RAD)]

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
  return { right, up: [right[1] * look[2] - right[2] * look[1], right[2] * look[0] - right[0] * look[2], right[0] * look[1] - right[1] * look[0]], look }
}

export const openAr = async (objects: () => SkyObject[]) => {
  const panel = $('#ar')
  const video = $<HTMLVideoElement>('#ar-video')
  const canvas = $<HTMLCanvasElement>('#ar-canvas')
  const status = $('#ar-status')
  const pick = $('#ar-pick')
  panel.hidden = false
  let basis: Basis | null = null
  const aim = { azimuth: 180, elevation: 35 }
  let drag: { x: number, y: number } | null = null
  let frame = 0
  let noCompass = false

  const permission = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission
  if (permission) await permission().catch(() => 'denied')
  const sense = (event: DeviceOrientationEvent) => {
    const heading = (event as unknown as { webkitCompassHeading?: number }).webkitCompassHeading
    if (event.alpha === null || event.beta === null || event.gamma === null || (!event.absolute && heading === undefined)) return
    basis = fromSensors(heading === undefined ? event.alpha : 360 - heading, event.beta, event.gamma, screen.orientation?.angle ?? 0)
  }
  addEventListener('deviceorientationabsolute', sense as EventListener)
  addEventListener('deviceorientation', sense as EventListener)
  const stream = await navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).catch(() => null)
  video.hidden = !stream
  if (stream) video.srcObject = stream
  setTimeout(() => { noCompass = !basis }, 2000)

  const press = (event: PointerEvent) => { drag = { x: event.clientX, y: event.clientY } }
  const move = (event: PointerEvent) => {
    if (!drag) return
    const perPixel = FIELD / canvas.clientHeight
    aim.azimuth = (aim.azimuth - (event.clientX - drag.x) * perPixel + 360) % 360
    aim.elevation = Math.max(-10, Math.min(89, aim.elevation + (event.clientY - drag.y) * perPixel))
    drag = { x: event.clientX, y: event.clientY }
  }
  const lift = () => { drag = null }
  canvas.addEventListener('pointerdown', press)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', lift)

  const draw = () => {
    const ratio = Math.min(devicePixelRatio || 1, 2)
    const [width, height] = [canvas.clientWidth, canvas.clientHeight]
    if (canvas.width !== Math.round(width * ratio)) Object.assign(canvas, { width: Math.round(width * ratio), height: Math.round(height * ratio) })
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const view = basis ?? fromAim(aim.azimuth, aim.elevation)
    const focal = height / 2 / Math.tan(FIELD / 2 * RAD)
    const place = (azimuth: number, elevation: number) => {
      const v = toward(azimuth, elevation)
      const depth = dot(v, view.look)
      return depth < 0.15 ? null : { x: width / 2 + dot(v, view.right) / depth * focal, y: height / 2 - dot(v, view.up) / depth * focal, depth }
    }
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let azimuth = 0, open = false; azimuth <= 360; azimuth += 3) {
      const p = place(azimuth, 0)
      if (p && open) ctx.lineTo(p.x, p.y)
      else if (p) ctx.moveTo(p.x, p.y)
      open = !!p
    }
    ctx.stroke()
    ctx.font = '600 14px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(160, 215, 255, 0.9)'
    COMPASS.forEach((label, i) => {
      const p = place(i * 45, 0)
      if (p) ctx.fillText(label, p.x, p.y - 8)
    })
    let best: { object: SkyObject, angle: number } | null = null
    ctx.textAlign = 'left'
    ctx.font = '12px system-ui, sans-serif'
    for (const object of objects()) {
      const p = place(object.azimuth, object.elevation)
      if (!p) continue
      ctx.fillStyle = object.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, object.size, 0, Math.PI * 2)
      ctx.fill()
      if (object.label) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.fillText(object.label, p.x + object.size + 4, p.y + 4)
      }
      const angle = Math.acos(Math.min(1, dot(toward(object.azimuth, object.elevation), view.look))) / RAD
      if (angle < 6 && (!best || angle < best.angle)) best = { object, angle }
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'
    ctx.beginPath()
    ctx.arc(width / 2, height / 2, 16, 0, Math.PI * 2)
    ctx.stroke()
    const looking = view.look
    const facing = (Math.atan2(looking[0], looking[1]) / RAD + 360) % 360
    status.textContent = `${noCompass && !basis ? 'No compass here, drag to look around. ' : ''}Facing ${COMPASS[Math.round(facing / 45) % 8]}, ${Math.round(Math.asin(looking[2]) / RAD)}° up`
    pick.textContent = best ? best.object.detail : 'Aim the circle at a dot to see what it is'
    frame = requestAnimationFrame(draw)
  }
  draw()

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
