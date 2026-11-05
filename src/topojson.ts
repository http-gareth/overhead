type Position = [number, number]
type Geometry = { type: string, arcs?: unknown, properties?: { name?: unknown } }
export type Topology = {
  type: 'Topology'
  transform?: { scale: Position, translate: Position }
  arcs: Position[][]
  objects: Record<string, { type: string, geometries?: Geometry[] } & Geometry>
}

export const decodeArcs = (topology: Topology): Position[][] => topology.arcs.map(arc => {
  const { scale, translate } = topology.transform ?? { scale: [1, 1], translate: [0, 0] }
  let x = 0
  let y = 0
  return arc.map(([dx, dy]) => {
    if (topology.transform) {
      x += dx
      y += dy
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as Position
    }
    return [dx, dy] as Position
  })
})

const ring = (arcs: Position[][], indexes: number[]) => indexes.flatMap((index, i) => {
  const points = index < 0 ? [...arcs[~index]].reverse() : arcs[index]
  return i === 0 ? points : points.slice(1)
})

export const unwrapRing = (ring: Position[]): Position[] => {
  const out: Position[] = []
  for (const [lon, lat] of ring) {
    let unwrapped = lon
    const previous = out.at(-1)?.[0]
    if (previous !== undefined) {
      while (unwrapped - previous > 180) unwrapped -= 360
      while (unwrapped - previous < -180) unwrapped += 360
    }
    out.push([unwrapped, lat])
  }
  const span = out.length ? out.at(-1)![0] - out[0][0] : 0
  if (Math.abs(span) < 180) return out
  const pole = out.reduce((sum, [, lat]) => sum + lat, 0) < 0 ? -90 : 90
  return [...out, [out.at(-1)![0], pole], [out[0][0], pole]]
}

const geometries = (topology: Topology, name: string) => {
  const object = topology.objects[name]
  if (!object) throw new Error(`no "${name}" in this topology`)
  return object.type === 'GeometryCollection' ? object.geometries ?? [] : [object]
}

const shapes = (arcs: Position[][], geometry: Geometry): Position[][][] => {
  if (geometry.type === 'Polygon') return [(geometry.arcs as number[][]).map(indexes => ring(arcs, indexes))]
  if (geometry.type === 'MultiPolygon') return (geometry.arcs as number[][][]).map(polygon => polygon.map(indexes => ring(arcs, indexes)))
  return []
}

export const polygons = (topology: Topology, name: string) => {
  const arcs = decodeArcs(topology)
  return geometries(topology, name).flatMap(geometry => shapes(arcs, geometry))
}

export const features = (topology: Topology, name: string) => {
  const arcs = decodeArcs(topology)
  return geometries(topology, name).map(geometry => ({
    name: typeof geometry.properties?.name === 'string' ? geometry.properties.name : '',
    polygons: shapes(arcs, geometry)
  }))
}

export const borders = (topology: Topology, name: string) => {
  const owners = new Map<number, Set<number>>()
  geometries(topology, name).forEach((geometry, owner) => {
    for (const index of [geometry.arcs ?? []].flat(3) as number[]) {
      const arc = index < 0 ? ~index : index
      owners.set(arc, (owners.get(arc) ?? new Set()).add(owner))
    }
  })
  const arcs = decodeArcs(topology)
  return [...owners].filter(([, set]) => set.size > 1).map(([arc]) => arcs[arc])
}
