export type Satellite = {
  name: string
  id: number
  epoch: number
  inclination: number
  periodMinutes: number
  deepSpace: boolean
  model: Model
}

type Model = {
  ecco: number, inclo: number, nodeo: number, argpo: number, mo: number, bstar: number, no: number
  isimp: boolean, aycof: number, con41: number, cc1: number, cc4: number, cc5: number, d2: number, d3: number, d4: number
  delmo: number, eta: number, argpdot: number, omgcof: number, sinmao: number, t2cof: number, t3cof: number, t4cof: number, t5cof: number
  x1mth2: number, x7thm1: number, mdot: number, nodedot: number, xlcof: number, xmcof: number, nodecf: number
}

const TWO_PI = 2 * Math.PI
const DEG = Math.PI / 180
const MU = 398600.8
const RE = 6378.135
const XKE = 60 / Math.sqrt(RE ** 3 / MU)
const J2 = 0.001082616
const J3 = -0.00000253881
const J4 = -0.00000165597
const J3OJ2 = J3 / J2
const DAY_MS = 86_400_000

const field = (line: string, from: number, to: number) => Number(line.slice(from - 1, to).trim())

const exponent = (text: string) => {
  const trimmed = text.trim()
  const match = /^([+-]?)(\d+)([+-]\d)$/.exec(trimmed)
  return match ? Number(`${match[1]}0.${match[2]}e${match[3]}`) : 0
}

const checksumOk = (line: string) => {
  let sum = 0
  for (const ch of line.slice(0, 68)) sum += ch === '-' ? 1 : /\d/.test(ch) ? Number(ch) : 0
  return sum % 10 === Number(line[68])
}

export const parseTle = (name: string, line1: string, line2: string): Satellite | null => {
  if (line1[0] !== '1' || line2[0] !== '2' || line1.length < 69 || line2.length < 69 || !checksumOk(line1) || !checksumOk(line2)) return null
  const year = field(line1, 19, 20)
  const day = field(line1, 21, 32)
  const epoch = Date.UTC(year < 57 ? 2000 + year : 1900 + year, 0, 1) + (day - 1) * DAY_MS
  const revsPerDay = field(line2, 53, 63)
  const elements = {
    ecco: Number(`0.${line2.slice(26, 33).trim()}`),
    inclo: field(line2, 9, 16) * DEG,
    nodeo: field(line2, 18, 25) * DEG,
    argpo: field(line2, 35, 42) * DEG,
    mo: field(line2, 44, 51) * DEG,
    bstar: exponent(line1.slice(53, 61)),
    noKozai: revsPerDay * TWO_PI / 1440
  }
  if (![...Object.values(elements), epoch].every(Number.isFinite) || elements.noKozai <= 0 || elements.ecco >= 1) return null
  const model = initialise(elements)
  const periodMinutes = TWO_PI / model.no
  return {
    name: name.trim() || `NORAD ${field(line1, 3, 7)}`,
    id: field(line1, 3, 7),
    epoch,
    inclination: field(line2, 9, 16),
    periodMinutes,
    deepSpace: periodMinutes >= 225,
    model
  }
}

const initialise = ({ ecco, inclo, nodeo, argpo, mo, bstar, noKozai }: { ecco: number, inclo: number, nodeo: number, argpo: number, mo: number, bstar: number, noKozai: number }): Model => {
  const eccsq = ecco * ecco
  const omeosq = 1 - eccsq
  const rteosq = Math.sqrt(omeosq)
  const cosio = Math.cos(inclo)
  const cosio2 = cosio * cosio
  const ak = (XKE / noKozai) ** (2 / 3)
  const d1 = 0.75 * J2 * (3 * cosio2 - 1) / (rteosq * omeosq)
  let del = d1 / (ak * ak)
  const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81))
  del = d1 / (adel * adel)
  const no = noKozai / (1 + del)
  const ao = (XKE / no) ** (2 / 3)
  const sinio = Math.sin(inclo)
  const po = ao * omeosq
  const con42 = 1 - 5 * cosio2
  const con41 = -con42 - cosio2 - cosio2
  const posq = po * po
  const rp = ao * (1 - ecco)

  const isimp = rp < 220 / RE + 1
  let sfour = 78 / RE + 1
  let qzms24 = ((120 - 78) / RE) ** 4
  const perigee = (rp - 1) * RE
  if (perigee < 156) {
    sfour = perigee < 98 ? 20 : perigee - 78
    qzms24 = ((120 - sfour) / RE) ** 4
    sfour = sfour / RE + 1
  }
  const pinvsq = 1 / posq
  const tsi = 1 / (ao - sfour)
  const eta = ao * ecco * tsi
  const etasq = eta * eta
  const eeta = ecco * eta
  const psisq = Math.abs(1 - etasq)
  const coef = qzms24 * tsi ** 4
  const coef1 = coef / psisq ** 3.5
  const cc2 = coef1 * no * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) + 0.375 * J2 * tsi / psisq * con41 * (8 + 3 * etasq * (8 + etasq)))
  const cc1 = bstar * cc2
  const cc3 = ecco > 1e-4 ? -2 * coef * tsi * J3OJ2 * no * sinio / ecco : 0
  const x1mth2 = 1 - cosio2
  const cc4 = 2 * no * coef1 * ao * omeosq * (eta * (2 + 0.5 * etasq) + ecco * (0.5 + 2 * etasq) -
    J2 * tsi / (ao * psisq) * (-3 * con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) + 0.75 * x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * argpo)))
  const cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq)
  const cosio4 = cosio2 * cosio2
  const temp1 = 1.5 * J2 * pinvsq * no
  const temp2 = 0.5 * temp1 * J2 * pinvsq
  const temp3 = -0.46875 * J4 * pinvsq * pinvsq * no
  const mdot = no + 0.5 * temp1 * rteosq * con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4)
  const argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) + temp3 * (3 - 36 * cosio2 + 49 * cosio4)
  const xhdot1 = -temp1 * cosio
  const nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio
  const xlcof = -0.25 * J3OJ2 * sinio * (3 + 5 * cosio) / (Math.abs(cosio + 1) > 1.5e-12 ? 1 + cosio : 1.5e-12)

  let d2 = 0, d3 = 0, d4 = 0, t3cof = 0, t4cof = 0, t5cof = 0
  if (!isimp) {
    const cc1sq = cc1 * cc1
    d2 = 4 * ao * tsi * cc1sq
    const temp = d2 * tsi * cc1 / 3
    d3 = (17 * ao + sfour) * temp
    d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * cc1
    t3cof = d2 + 2 * cc1sq
    t4cof = 0.25 * (3 * d3 + cc1 * (12 * d2 + 10 * cc1sq))
    t5cof = 0.2 * (3 * d4 + 12 * cc1 * d3 + 6 * d2 * d2 + 15 * cc1sq * (2 * d2 + cc1sq))
  }

  return {
    ecco, inclo, nodeo, argpo, mo, bstar, no, isimp, con41, cc1, cc4, cc5, d2, d3, d4, eta, argpdot, mdot, nodedot, xlcof, x1mth2,
    aycof: -0.5 * J3OJ2 * sinio,
    delmo: (1 + eta * Math.cos(mo)) ** 3,
    omgcof: bstar * cc3 * Math.cos(argpo),
    sinmao: Math.sin(mo),
    t2cof: 1.5 * cc1,
    t3cof, t4cof, t5cof,
    x7thm1: 7 * cosio2 - 1,
    xmcof: ecco > 1e-4 ? -2 / 3 * coef * bstar / eeta : 0,
    nodecf: 3.5 * omeosq * xhdot1 * cc1
  }
}

const mod2pi = (angle: number) => ((angle % TWO_PI) + TWO_PI) % TWO_PI

export const propagate = (m: Model, minutes: number) => {
  const t = minutes
  const xmdf = m.mo + m.mdot * t
  const argpdf = m.argpo + m.argpdot * t
  const nodedf = m.nodeo + m.nodedot * t
  let argpm = argpdf
  let mm = xmdf
  const t2 = t * t
  let nodem = nodedf + m.nodecf * t2
  let tempa = 1 - m.cc1 * t
  let tempe = m.bstar * m.cc4 * t
  let templ = m.t2cof * t2
  if (!m.isimp) {
    const delomg = m.omgcof * t
    const delm = m.xmcof * ((1 + m.eta * Math.cos(xmdf)) ** 3 - m.delmo)
    mm = xmdf + delomg + delm
    argpm = argpdf - delomg - delm
    const t3 = t2 * t
    const t4 = t3 * t
    tempa = tempa - m.d2 * t2 - m.d3 * t3 - m.d4 * t4
    tempe = tempe + m.bstar * m.cc5 * (Math.sin(mm) - m.sinmao)
    templ = templ + m.t3cof * t3 + t4 * (m.t4cof + t * m.t5cof)
  }
  const am = (XKE / m.no) ** (2 / 3) * tempa * tempa
  const nm = XKE / am ** 1.5
  let em = m.ecco - tempe
  if (em >= 1 || em < -0.001 || am < 0.95) return null
  if (em < 1e-6) em = 1e-6
  mm = mm + m.no * templ
  const xlm = mod2pi(mm + argpm + nodem)
  nodem = mod2pi(nodem)
  argpm = mod2pi(argpm)
  mm = mod2pi(xlm - argpm - nodem)

  const sinip = Math.sin(m.inclo)
  const cosip = Math.cos(m.inclo)
  const axnl = em * Math.cos(argpm)
  let temp = 1 / (am * (1 - em * em))
  const aynl = em * Math.sin(argpm) + temp * m.aycof
  const xl = mm + argpm + nodem + temp * m.xlcof * axnl

  const u = mod2pi(xl - nodem)
  let eo1 = u
  let sineo1 = 0
  let coseo1 = 1
  for (let i = 0, step = 1; i < 10 && Math.abs(step) >= 1e-12; i++) {
    sineo1 = Math.sin(eo1)
    coseo1 = Math.cos(eo1)
    step = (u - aynl * coseo1 + axnl * sineo1 - eo1) / (1 - coseo1 * axnl - sineo1 * aynl)
    step = Math.max(-0.95, Math.min(0.95, step))
    eo1 += step
  }
  sineo1 = Math.sin(eo1)
  coseo1 = Math.cos(eo1)

  const ecose = axnl * coseo1 + aynl * sineo1
  const esine = axnl * sineo1 - aynl * coseo1
  const el2 = axnl * axnl + aynl * aynl
  const pl = am * (1 - el2)
  if (pl < 0) return null
  const rl = am * (1 - ecose)
  const rdotl = Math.sqrt(am) * esine / rl
  const rvdotl = Math.sqrt(pl) / rl
  const betal = Math.sqrt(1 - el2)
  temp = esine / (1 + betal)
  const sinu = am / rl * (sineo1 - aynl - axnl * temp)
  const cosu = am / rl * (coseo1 - axnl + aynl * temp)
  let su = Math.atan2(sinu, cosu)
  const sin2u = (cosu + cosu) * sinu
  const cos2u = 1 - 2 * sinu * sinu
  temp = 1 / pl
  const temp1 = 0.5 * J2 * temp
  const temp2 = temp1 * temp

  const mrt = rl * (1 - 1.5 * temp2 * betal * m.con41) + 0.5 * temp1 * m.x1mth2 * cos2u
  su = su - 0.25 * temp2 * m.x7thm1 * sin2u
  const xnode = nodem + 1.5 * temp2 * cosip * sin2u
  const xinc = m.inclo + 1.5 * temp2 * cosip * sinip * cos2u
  const mvt = rdotl - nm * temp1 * m.x1mth2 * sin2u / XKE
  const rvdot = rvdotl + nm * temp1 * (m.x1mth2 * cos2u + 1.5 * m.con41) / XKE
  if (mrt < 1) return null

  const sinsu = Math.sin(su)
  const cossu = Math.cos(su)
  const snod = Math.sin(xnode)
  const cnod = Math.cos(xnode)
  const sini = Math.sin(xinc)
  const cosi = Math.cos(xinc)
  const xmx = -snod * cosi
  const xmy = cnod * cosi
  const ux = xmx * sinsu + cnod * cossu
  const uy = xmy * sinsu + snod * cossu
  const uz = sini * sinsu
  const vx = xmx * cossu - cnod * sinsu
  const vy = xmy * cossu - snod * sinsu
  const vz = sini * cossu
  const r = mrt * RE
  const v = RE * XKE / 60
  return {
    position: [r * ux, r * uy, r * uz] as [number, number, number],
    velocity: [v * (mvt * ux + rvdot * vx), v * (mvt * uy + rvdot * vy), v * (mvt * uz + rvdot * vz)] as [number, number, number]
  }
}

export const gmst = (time: number) => {
  const jd = time / DAY_MS + 2440587.5
  const tut1 = (jd - 2451545) / 36525
  const seconds = -6.2e-6 * tut1 ** 3 + 0.093104 * tut1 ** 2 + (876600 * 3600 + 8640184.812866) * tut1 + 67310.54841
  return mod2pi(seconds * DEG / 240)
}

export const EARTH_RADIUS_KM = 6371

export const earthFixed = (sat: Satellite, time: number) => {
  const state = propagate(sat.model, (time - sat.epoch) / 60_000)
  if (!state) return null
  const theta = gmst(time)
  const [x, y, z] = state.position
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { position: [x * c + y * s, -x * s + y * c, z] as [number, number, number], speedKmS: Math.hypot(...state.velocity) }
}

export const parseTleText = (text: string) => {
  const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean)
  const satellites: Satellite[] = []
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      const sat = parseTle(lines[i], lines[i + 1], lines[i + 2])
      if (sat) satellites.push(sat)
      i += 2
    }
  }
  return satellites
}
