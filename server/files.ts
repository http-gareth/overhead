import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SERVED = new Set(['web', 'src'])
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.ts': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml'
}

export const securityHeaders = (https: boolean): OutgoingHttpHeaders => ({
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https://airport-data.com https://image.airport-data.com https://thespacedevs-prod.nyc3.digitaloceanspaces.com", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
  ].join('; '),
  ...(https && { 'strict-transport-security': 'max-age=31536000' }),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)'
})

export const isHttps = (req: IncomingMessage) => Boolean(process.env.TRUST_PROXY) && req.headers['x-forwarded-proto'] === 'https'

const fail = (res: ServerResponse, headers: OutgoingHttpHeaders, status: number, text: string) => {
  res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end(text)
}

const resolve = (url = '/') => {
  const path = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  if (path.includes('\0')) return null
  const relative = path === '/' ? 'web/index.html' : path.slice(1)
  const top = relative.split(/[\\/]/)[0]
  const file = normalize(join(ROOT, relative))
  return SERVED.has(top) && file.startsWith(join(ROOT, top) + sep) ? file : null
}

export const serveFile = async (req: IncomingMessage, res: ServerResponse) => {
  const headers = { ...securityHeaders(isHttps(req)), 'cache-control': 'no-cache' }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, { ...headers, allow: 'GET, HEAD' }, 405, 'method not allowed')
  let file: string | null
  try {
    file = resolve(req.url)
  } catch {
    return fail(res, headers, 400, 'bad request')
  }
  if (!file) return fail(res, headers, 404, 'not found')
  let raw: Buffer
  try {
    raw = await readFile(file)
  } catch {
    return fail(res, headers, 404, 'not found')
  }
  const ext = extname(file)
  const body = ext === '.ts' ? stripTypeScriptTypes(raw.toString('utf8')) : raw
  res.writeHead(200, { ...headers, 'content-type': `${TYPES[ext] ?? 'application/octet-stream'}; charset=utf-8` })
  res.end(req.method === 'HEAD' ? undefined : body)
}
