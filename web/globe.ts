import { TAN_HALF_FOV, columnMajor, viewMatrix } from '../src/geo.ts'
import type { Vec3, View } from '../src/geo.ts'

export type Scene = {
  view: View
  sun: Vec3
  time: number
  blend: number
  planeNow: number
  photo: boolean
  show: Record<string, boolean>
}

export type Line = { points: ArrayLike<number>, colors: ArrayLike<number>, width: number, dashed?: boolean }

type Layer = { vao: WebGLVertexArrayObject, buffers: WebGLBuffer[], count: number }

const SHARED = `
uniform mat3 view;
uniform float distance;
uniform float tanHalf;
uniform float aspect;
bool offscreen(vec3 p) {
  if (distance - p.z < 0.000001) return true;
  vec3 d = p - vec3(0.0, 0.0, distance);
  float len = length(d);
  float b = distance * d.z / len;
  float h = b * b - distance * distance + 1.0;
  if (h < 0.0) return false;
  float s = -b - sqrt(h);
  return s > 0.0 && s < len * 0.999999;
}
vec4 clip(vec3 p) {
  float depth = distance - p.z;
  return vec4(p.x / depth / (tanHalf * aspect), p.y / depth / tanHalf, 0.0, 1.0);
}
const vec4 AWAY = vec4(2.0, 2.0, 2.0, 1.0);
`

const EARTH_VERTEX = `#version 300 es
in vec2 corner;
out vec2 ndc;
void main() {
  ndc = corner;
  gl_Position = vec4(corner, 0.0, 1.0);
}`

const EARTH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 ndc;
uniform mat3 view;
uniform float distance;
uniform float tanHalf;
uniform float aspect;
uniform vec3 sun;
uniform float photo;
uniform float auroraOn;
uniform sampler2D land;
uniform sampler2D today;
uniform sampler2D base;
uniform sampler2D aurora;
uniform sampler2D detailToday;
uniform sampler2D detailLights;
uniform sampler2D detailMap;
uniform sampler2D detailGround;
uniform vec4 detailBox;
uniform float detailOn;
uniform vec4 groundBox;
uniform float groundOn;
uniform sampler2D street;
uniform vec4 streetRect;
uniform float streetOn;
uniform float altitude;
uniform float clear;
out vec4 color;
const float PI = 3.14159265;
void main() {
  vec3 origin = vec3(0.0, 0.0, distance);
  vec3 ray = normalize(vec3(ndc.x * tanHalf * aspect, ndc.y * tanHalf, -1.0));
  float b = dot(origin, ray);
  float c = altitude * (2.0 + altitude);
  float h = b * b - c;
  if (h < 0.0) {
    vec3 cell = floor(transpose(view) * ray * 260.0);
    float n = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float gap = sqrt(max(c + 1.0 - b * b, 1.0)) - 1.0;
    color = vec4(vec3(0.012, 0.018, 0.04) + smoothstep(0.9965, 1.0, n) * 0.8 + vec3(0.25, 0.5, 1.0) * exp(-gap * 14.0) * 0.55, 1.0);
    return;
  }
  float t = c / (sqrt(h) - b);
  vec3 hit = origin + ray * t;
  vec2 suv = (ray.xy * t - streetRect.xy) / (streetRect.zw - streetRect.xy);
  vec4 photograph = texture(street, vec2(suv.x, 1.0 - suv.y));
  float onStreet = streetOn * photograph.a * smoothstep(0.0, 0.05, min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y)));
  vec3 world = transpose(view) * hit;
  float lat = asin(clamp(world.y, -1.0, 1.0));
  float lon = atan(world.x, world.z);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec4 map = texture(land, uv);
  vec4 marble = texture(base, uv);
  vec3 shot = texture(today, uv).rgb;
  vec2 degrees2 = vec2(lon, lat) * 180.0 / PI;
  vec2 duv = vec2((degrees2.x - detailBox.x) / (detailBox.z - detailBox.x), (detailBox.w - degrees2.y) / (detailBox.w - detailBox.y));
  float near = detailOn * smoothstep(0.0, 0.1, min(min(duv.x, 1.0 - duv.x), min(duv.y, 1.0 - duv.y)));
  vec3 sharp = texture(detailToday, duv).rgb;
  vec4 sharpMap = texture(detailMap, duv);
  float sharpLights = texture(detailLights, duv).r;
  vec2 guv = vec2((degrees2.x - groundBox.x) / (groundBox.z - groundBox.x), (groundBox.w - degrees2.y) / (groundBox.w - groundBox.y));
  float onGround = groundOn * smoothstep(0.0, 0.1, min(min(guv.x, 1.0 - guv.x), min(guv.y, 1.0 - guv.y)));
  vec3 terrain = texture(detailGround, guv).rgb;
  map = mix(map, sharpMap, near);
  shot = mix(shot, sharp, near * step(0.03, max(sharp.r, max(sharp.g, sharp.b))));
  marble.a = mix(marble.a, sharpLights, near);
  float light = dot(world, sun);
  float day = smoothstep(-0.12, 0.18, light);
  vec3 ocean = mix(vec3(0.01, 0.025, 0.06), vec3(0.04, 0.15, 0.3), day);
  vec3 ground = mix(vec3(0.045, 0.07, 0.085), vec3(0.22, 0.37, 0.31), day);
  vec3 drawn = mix(ocean, ground, map.r) + vec3(0.35, 0.65, 1.0) * smoothstep(0.15, 0.9, 1.0 - abs(map.r * 2.0 - 1.0)) * mix(0.22, 0.3, day);
  float missing = 1.0 - smoothstep(0.03, 0.09, max(shot.r, max(shot.g, shot.b)));
  vec3 daylight = mix(mix(mix(shot, marble.rgb, missing), terrain, onGround * clear), photograph.rgb, onStreet);
  drawn = mix(drawn, photograph.rgb * mix(0.3, 1.0, day), onStreet);
  map.g *= 1.0 - onStreet;
  vec3 night = marble.rgb * 0.035 + vec3(1.0, 0.75, 0.42) * smoothstep(0.2, 0.8, marble.a) * 1.3;
  vec3 surface = mix(drawn, mix(night, daylight, day), photo);
  surface = mix(surface, vec3(0.8, 0.86, 1.0), map.g * mix(mix(0.25, 0.4, day), 0.2, photo));
  vec2 degrees = vec2(lat, lon) / PI * 180.0 / 15.0;
  vec2 grid = abs(fract(degrees + 0.5) - 0.5) / max(fwidth(degrees), vec2(1e-4));
  surface += vec3(0.35, 0.55, 0.8) * (1.0 - min(min(grid.x, grid.y), 1.0)) * mix(0.07, 0.03, photo);
  surface += vec3(0.9, 0.45, 0.15) * exp(-pow(light * 9.0, 2.0)) * 0.12;
  vec3 normal = normalize(hit);
  float glint = pow(max(dot(normal, normalize(view * sun - ray)), 0.0), 80.0) * (1.0 - map.r) * day;
  surface += vec3(1.0, 0.92, 0.8) * glint * mix(0.45, 0.25, photo);
  float chance = texture(aurora, vec2(fract(lon / (2.0 * PI) + 0.5 / 360.0), (lat * 180.0 / PI + 90.5) / 181.0)).r * 2.55;
  surface += vec3(0.2, 1.0, 0.55) * smoothstep(0.06, 0.5, chance) * (1.0 - day * 0.85) * auroraOn * 0.75;
  surface += vec3(0.25, 0.5, 1.0) * pow(1.0 - max(dot(normal, -ray), 0.0), 3.0) * 0.55;
  color = vec4(surface, 1.0);
}`

const POINT_VERTEX = `#version 300 es
in vec3 from;
in vec3 to;
in float size;
in vec3 tint;
in float pulse;
in float shape;
uniform float blend;
uniform float scale;
out vec3 vTint;
out float vPulse;
out float vShape;
${SHARED}
void main() {
  float r = mix(length(from), length(to), blend);
  vec3 p = view * (normalize(mix(from, to, blend) + 1e-9) * r);
  if (r < 0.5 || offscreen(p)) {
    gl_Position = AWAY;
    gl_PointSize = 0.0;
    return;
  }
  gl_Position = clip(p);
  gl_PointSize = size * scale * 2.5;
  vTint = tint;
  vPulse = pulse;
  vShape = shape;
}`

const POINT_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vTint;
in float vPulse;
in float vShape;
uniform float time;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y = -c.y;
  float r = vShape < 0.5 ? length(c)
    : vShape < 1.5 ? max(-c.y, max(0.866 * c.x + 0.5 * c.y, -0.866 * c.x + 0.5 * c.y)) * 1.6
    : (abs(c.x) + abs(c.y)) * 0.85;
  if (length(c) > 1.0) discard;
  float core = 1.0 - smoothstep(0.3, 0.42, r);
  float wave = fract(time * 0.5);
  float ring = vPulse * (1.0 - smoothstep(0.0, 0.07, abs(length(c) - 0.4 - wave * 0.6))) * (1.0 - wave);
  float alpha = max(max(core * 0.95, ring), pow(1.0 - length(c), 3.0) * 0.3);
  if (alpha < 0.01) discard;
  color = vec4(mix(vTint, vec3(1.0), core * 0.15), alpha);
}`

const PLANE_VERTEX = `#version 300 es
in vec2 place;
in vec2 motion;
in float fix;
in float altitude;
uniform float now;
uniform float scale;
out vec3 vTint;
out float vAngle;
out float vAlpha;
${SHARED}
void main() {
  float age = now - fix;
  float a = motion.y * clamp(age, 0.0, 1800.0);
  float heading = motion.x;
  float lat = asin(clamp(sin(place.x) * cos(a) + cos(place.x) * sin(a) * cos(heading), -1.0, 1.0));
  float lon = place.y + atan(sin(heading) * sin(a) * cos(place.x), cos(a) - sin(place.x) * sin(lat));
  vec3 up = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  vec3 north = vec3(-sin(lat) * sin(lon), cos(lat), -sin(lat) * cos(lon));
  vec3 east = vec3(cos(lon), 0.0, -sin(lon));
  vec3 p = view * (up * (1.000005 + altitude / 6371.0));
  if (offscreen(p)) {
    gl_Position = AWAY;
    gl_PointSize = 0.0;
    return;
  }
  vec4 here = clip(p);
  vec4 ahead = clip(p + view * (cos(heading) * north + sin(heading) * east) * 0.002);
  vec2 d = (ahead.xy - here.xy) * vec2(aspect, 1.0);
  vAngle = atan(d.x, d.y);
  gl_Position = here;
  gl_PointSize = 10.0 * scale;
  vTint = mix(mix(vec3(0.3, 0.88, 0.5), vec3(0.25, 0.75, 1.0), smoothstep(0.0, 6.0, altitude)), vec3(0.72, 0.6, 1.0), smoothstep(6.0, 12.0, altitude));
  vAlpha = age > 1800.0 ? 0.35 : 0.95;
}`

const PLANE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vTint;
in float vAngle;
in float vAlpha;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  vec2 f = vec2(sin(vAngle), cos(vAngle));
  vec2 q = vec2(c.x * f.y + c.y * f.x, c.x * f.x - c.y * f.y);
  float ax = abs(q.x);
  float body = length(vec2(q.x, q.y - clamp(q.y, -0.7, 0.8))) - 0.11;
  float wing = max(ax - 0.85, abs(q.y + 0.4 * ax - 0.08) - 0.12);
  float tail = max(ax - 0.36, abs(q.y + 0.25 * ax + 0.66) - 0.08);
  float alpha = 1.0 - smoothstep(-0.04, 0.08, min(body, min(wing, tail)));
  if (alpha < 0.02) discard;
  color = vec4(vTint, alpha * vAlpha);
}`

const LINE_VERTEX = `#version 300 es
in vec3 start;
in vec3 end;
in float along;
in float side;
in vec4 tint;
in float width;
in float travel;
in float dashed;
uniform vec2 pixels;
uniform float lineScale;
out vec4 vTint;
out float vAcross;
out float vTravel;
out float vDashed;
${SHARED}
void main() {
  vec3 a = view * start;
  vec3 b = view * end;
  if (offscreen(a) || offscreen(b)) {
    gl_Position = AWAY;
    return;
  }
  vec4 ca = clip(a);
  vec4 cb = clip(b);
  vec2 direction = (cb.xy - ca.xy) * pixels;
  float size = length(direction);
  vec2 normal = size > 0.0 ? vec2(-direction.y, direction.x) / size : vec2(0.0, 1.0);
  vec4 here = mix(ca, cb, along);
  here.xy += normal * side * width * lineScale / pixels;
  gl_Position = here;
  vTint = tint;
  vAcross = side;
  vTravel = travel;
  vDashed = dashed;
}`

const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vTint;
in float vAcross;
in float vTravel;
in float vDashed;
uniform float dashScale;
out vec4 color;
void main() {
  if (vDashed > 0.5 && fract(vTravel * dashScale) > 0.55) discard;
  float alpha = vTint.a * (1.0 - smoothstep(0.45, 1.0, abs(vAcross)));
  if (alpha < 0.01) discard;
  color = vec4(vTint.rgb, alpha);
}`

const compile = (gl: WebGL2RenderingContext, vertex: string, fragment: string) => {
  const program = gl.createProgram()!
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader failed')
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  return program
}

const POINT_LAYOUT: [string, number][][] = [[['from', 3]], [['to', 3]], [['size', 1], ['tint', 3], ['pulse', 1], ['shape', 1]]]
const TEXTURES = ['land', 'today', 'base', 'aurora', 'detailToday', 'detailLights', 'detailMap', 'detailGround', 'street'] as const
const LINE_FLOATS = 15
type Texture = typeof TEXTURES[number]
const CORNERS = [[0, 1], [0, -1], [1, 1], [1, 1], [0, -1], [1, -1]]

export class Globe {
  readonly canvas: HTMLCanvasElement
  readonly #gl: WebGL2RenderingContext
  readonly #earth: WebGLProgram
  readonly #points: WebGLProgram
  readonly #planeProgram: WebGLProgram
  readonly #lineProgram: WebGLProgram
  readonly #quad: Layer
  readonly #satellites: Layer
  readonly #planes: Layer
  readonly #lines: Layer
  readonly #layers = new Map<string, Layer>()
  readonly #textures = new Map<string, WebGLTexture>()
  readonly #anisotropy: EXT_texture_filter_anisotropic | null
  #detail = [0, 0, 1, 1]
  #detailOn = 0
  #ground = [0, 0, 1, 1]
  #groundOn = 0
  #clear = 0
  #street = [0, 0, 1, 1]
  #streetOn = 0

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true })
    if (!gl) throw new Error('This browser has no WebGL2')
    this.canvas = canvas
    this.#gl = gl
    this.#earth = compile(gl, EARTH_VERTEX, EARTH_FRAGMENT)
    this.#points = compile(gl, POINT_VERTEX, POINT_FRAGMENT)
    this.#planeProgram = compile(gl, PLANE_VERTEX, PLANE_FRAGMENT)
    this.#lineProgram = compile(gl, LINE_VERTEX, LINE_FRAGMENT)
    this.#quad = this.#layer(this.#earth, [[['corner', 2]]])
    this.#upload(this.#quad, 0, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]))
    this.#satellites = this.#layer(this.#points, POINT_LAYOUT)
    this.#planes = this.#layer(this.#planeProgram, [[['place', 2], ['motion', 2], ['fix', 1], ['altitude', 1]]])
    this.#lines = this.#layer(this.#lineProgram, [[['start', 3], ['end', 3], ['along', 1], ['side', 1], ['tint', 4], ['width', 1], ['travel', 1], ['dashed', 1]]])
    this.#anisotropy = gl.getExtension('EXT_texture_filter_anisotropic')
    for (const name of TEXTURES) {
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
      this.#textures.set(name, texture)
    }
  }

  #layer(program: WebGLProgram, groups: [string, number][][]): Layer {
    const gl = this.#gl
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buffers = groups.map(attributes => {
      const buffer = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      const stride = attributes.reduce((sum, [, size]) => sum + size, 0) * 4
      let offset = 0
      for (const [name, size] of attributes) {
        const location = gl.getAttribLocation(program, name)
        if (location >= 0) {
          gl.enableVertexAttribArray(location)
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset)
        }
        offset += size * 4
      }
      return buffer
    })
    gl.bindVertexArray(null)
    return { vao, buffers, count: 0 }
  }

  #upload(layer: Layer, index: number, data: Float32Array) {
    this.#gl.bindBuffer(this.#gl.ARRAY_BUFFER, layer.buffers[index])
    this.#gl.bufferData(this.#gl.ARRAY_BUFFER, data, this.#gl.DYNAMIC_DRAW)
  }

  #texture(name: Texture, upload: (gl: WebGL2RenderingContext) => void, mipmaps = true) {
    const gl = this.#gl
    gl.bindTexture(gl.TEXTURE_2D, this.#textures.get(name)!)
    upload(gl)
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (this.#anisotropy && mipmaps) {
      gl.texParameterf(gl.TEXTURE_2D, this.#anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.#anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)))
    }
  }

  setDetail(box: number[] | null, strength: number) {
    this.#detail = box ?? [0, 0, 1, 1]
    this.#detailOn = box ? strength : 0
  }

  setStreet(rect: number[] | null, strength: number) {
    this.#street = rect ?? [0, 0, 1, 1]
    this.#streetOn = rect ? strength : 0
  }

  setGround(box: number[] | null, strength: number, clear: number) {
    this.#ground = box ?? [0, 0, 1, 1]
    this.#groundOn = box ? strength : 0
    this.#clear = clear
  }

  setImage(name: Exclude<Texture, 'aurora'>, image: TexImageSource) {
    this.#texture(name, gl => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image))
  }

  setAurora(grid: Uint8Array) {
    this.#texture('aurora', gl => {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 360, 181, 0, gl.RED, gl.UNSIGNED_BYTE, grid)
    }, false)
  }

  setPoints(name: string, positions: Float32Array, style: Float32Array) {
    if (!this.#layers.has(name)) this.#layers.set(name, this.#layer(this.#points, POINT_LAYOUT))
    const layer = this.#layers.get(name)!
    this.#upload(layer, 0, positions)
    this.#upload(layer, 1, positions)
    this.#upload(layer, 2, style)
    layer.count = positions.length / 3
  }

  setSatelliteStyle(style: Float32Array) {
    this.#upload(this.#satellites, 2, style)
  }

  setSatellites(from: Float32Array, to: Float32Array) {
    this.#upload(this.#satellites, 0, from)
    this.#upload(this.#satellites, 1, to)
    this.#satellites.count = from.length / 3
  }

  setPlanes(data: Float32Array) {
    this.#upload(this.#planes, 0, data)
    this.#planes.count = data.length / 6
  }

  setLines(lines: Line[]) {
    const segments = lines.reduce((sum, line) => sum + Math.max(0, line.points.length / 3 - 1), 0)
    const data = new Float32Array(segments * CORNERS.length * LINE_FLOATS)
    let at = 0
    for (const line of lines) {
      const count = line.points.length / 3
      const perVertex = line.colors.length === count * 4
      const point = (i: number) => [line.points[i * 3], line.points[i * 3 + 1], line.points[i * 3 + 2]]
      const tint = (i: number) => [0, 1, 2, 3].map(k => line.colors[perVertex ? i * 4 + k : k])
      let travelled = 0
      for (let i = 0; i + 1 < count; i++) {
        const [a, b] = [point(i), point(i + 1)]
        const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        for (const [along, side] of CORNERS) {
          data.set([...a, ...b, along, side, ...tint(i + along), line.width, travelled + along * length, line.dashed ? 1 : 0], at)
          at += LINE_FLOATS
        }
        travelled += length
      }
    }
    this.#upload(this.#lines, 0, data)
    this.#lines.count = segments * CORNERS.length
  }

  get aspect() {
    return this.canvas.width / this.canvas.height
  }

  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2)
    const width = Math.round(this.canvas.clientWidth * ratio)
    const height = Math.round(this.canvas.clientHeight * ratio)
    if (this.canvas.width !== width || this.canvas.height !== height) Object.assign(this.canvas, { width, height })
  }

  render(scene: Scene) {
    const gl = this.#gl
    const { view } = scene
    this.resize()
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const matrix = columnMajor(viewMatrix(view))
    const scale = this.canvas.height / 900 * (3.2 / view.distance) ** 0.5
    const use = (program: WebGLProgram, values: Record<string, number | number[]> = {}) => {
      gl.useProgram(program)
      gl.uniformMatrix3fv(gl.getUniformLocation(program, 'view'), false, matrix)
      const all: Record<string, number | number[]> = { distance: view.distance, tanHalf: TAN_HALF_FOV, aspect: this.aspect, ...values }
      for (const [name, value] of Object.entries(all)) {
        const location = gl.getUniformLocation(program, name)
        if (typeof value === 'number') gl.uniform1f(location, value)
        else if (value.length === 2) gl.uniform2fv(location, value)
        else if (value.length === 3) gl.uniform3fv(location, value)
        else gl.uniform4fv(location, value)
      }
    }
    const draw = (layer: Layer, mode: number, first = 0, count = layer.count) => {
      if (count <= 0) return
      gl.bindVertexArray(layer.vao)
      gl.drawArrays(mode, first, count)
    }

    use(this.#earth, { sun: scene.sun, photo: scene.photo ? 1 : 0, auroraOn: scene.show.aurora ? 1 : 0, detailBox: this.#detail, detailOn: this.#detailOn, groundBox: this.#ground, groundOn: this.#groundOn,
      streetRect: this.#street, streetOn: this.#streetOn, altitude: view.distance - 1, clear: this.#clear
    })
    TEXTURES.forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, this.#textures.get(name)!)
      gl.uniform1i(gl.getUniformLocation(this.#earth, name), unit)
    })
    gl.disable(gl.BLEND)
    draw(this.#quad, gl.TRIANGLE_STRIP, 0, 4)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    use(this.#lineProgram, {
      pixels: [this.canvas.width, this.canvas.height], lineScale: this.canvas.width / Math.max(1, this.canvas.clientWidth),
      dashScale: this.canvas.clientHeight / (14 * (view.distance - 1) * 2 * TAN_HALF_FOV)
    })
    draw(this.#lines, gl.TRIANGLES)

    use(this.#points, { scale, time: scene.time, blend: 0 })
    for (const [name, layer] of this.#layers) if (name !== 'marks' && scene.show[name]) draw(layer, gl.POINTS)
    if (scene.show.satellites) {
      use(this.#points, { scale, time: scene.time, blend: scene.blend })
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      draw(this.#satellites, gl.POINTS)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    }
    if (scene.show.planes) {
      use(this.#planeProgram, { scale, now: scene.planeNow })
      draw(this.#planes, gl.POINTS)
    }
    use(this.#points, { scale, time: scene.time, blend: 0 })
    if (this.#layers.has('marks')) draw(this.#layers.get('marks')!, gl.POINTS)
    gl.bindVertexArray(null)
  }
}
