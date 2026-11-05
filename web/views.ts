export type Row = {
  badge: string
  badgeClass?: string
  badgeColor?: string
  title: string
  sub?: string
  current?: boolean
  onClick: () => void
}

export const el = (tag: string, text?: string, className?: string) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

export const button = (text: string, onClick: () => void, className?: string) => {
  const node = el('button', text, className) as HTMLButtonElement
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

export const link = (text: string, href: string) => {
  const node = el('a', text) as HTMLAnchorElement
  Object.assign(node, { href, target: '_blank', rel: 'noopener noreferrer' })
  return node
}

export const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

export const number = (value: number, digits = 0) =>
  value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const latLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`

export const clockTime = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export const dayName = (time: number) => {
  const days = Math.round((new Date(time).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : new Date(time).toLocaleDateString([], { weekday: 'long' })
}

export const altitudeRgb = (km: number) => {
  const stops = [[0, [77, 224, 128]], [6, [64, 191, 255]], [12, [184, 153, 255]]] as const
  const k = Math.max(0, Math.min(12, km))
  const [[k0, a], [k1, b]] = k <= 6 ? [stops[0], stops[1]] : [stops[1], stops[2]]
  const t = (k - k0) / (k1 - k0)
  return a.map((v, i) => (v + (b[i] - v) * t) / 255)
}

export const altitudeColor = (km: number) => `rgb(${altitudeRgb(km).map(v => Math.round(v * 255)).join(', ')})`

const rowItem = () => {
  const item = el('li')
  const target = el('button', undefined, 'row') as HTMLButtonElement
  target.type = 'button'
  const text = el('span', undefined, 'text')
  text.append(el('span', undefined, 'title'), el('span', undefined, 'sub'))
  target.append(el('span'), text)
  item.append(target)
  return item
}

export const fillRows = (list: HTMLElement, rows: Row[], empty: string) => {
  if (!rows.length) {
    const item = el('li')
    item.append(el('p', empty, 'empty'))
    list.replaceChildren(item)
    return
  }
  if (list.querySelector('.empty')) list.replaceChildren()
  while (list.children.length > rows.length) list.lastElementChild!.remove()
  while (list.children.length < rows.length) list.append(rowItem())
  rows.forEach((row, i) => {
    const target = list.children[i].firstElementChild as HTMLButtonElement
    const badge = target.firstElementChild as HTMLElement
    const [title, sub] = target.lastElementChild!.children as unknown as HTMLElement[]
    target.onclick = row.onClick
    if (row.current) target.setAttribute('aria-current', 'true')
    else target.removeAttribute('aria-current')
    badge.textContent = row.badge
    badge.className = `badge ${row.badgeClass ?? ''}`
    badge.style.background = row.badgeColor ?? ''
    title.textContent = row.title
    sub.textContent = row.sub ?? ''
    sub.hidden = !row.sub
  })
}

export const fillCard = (card: HTMLElement, key: string, title: string, subtitle: string, rows: [string, string, string?][], actions: () => Node[], media: () => Node[] = () => []) => {
  if (card.dataset.key !== key) {
    const footer = el('div', undefined, 'actions')
    footer.append(...actions())
    const extra = el('div', undefined, 'media')
    extra.append(...media())
    card.replaceChildren(el('h3'), el('p', undefined, 'place'), extra, el('dl'), footer)
    card.dataset.key = key
  }
  const [heading, place, , list] = card.children as unknown as HTMLElement[]
  heading.textContent = title
  place.textContent = subtitle
  list.replaceChildren(...rows.flatMap(([label, value, className]) => [el('dt', label), el('dd', value, className)]))
  card.hidden = false
}
