import { createServer } from 'node:http'
import { FEEDS, serveFeed } from './feeds.ts'
import { serveFile } from './files.ts'
import { serveDetail, servePlane, serveTile } from './lookups.ts'

const port = Number(process.env.PORT ?? 5200)
const LOOKUPS = new Map([['/api/plane', servePlane], ['/api/detail', serveDetail], ['/api/tile', serveTile]])

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const feed = req.method === 'GET' ? FEEDS.get(path) : undefined
  const lookup = req.method === 'GET' ? LOOKUPS.get(path) : undefined
  const served = feed ? serveFeed(feed, req, res) : lookup ? lookup(req, res) : serveFile(req, res)
  served.catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
}).on('clientError', (_, socket) => socket.destroy()).listen(port, () => {
  console.log(`Overhead running at http://localhost:${port}`)
})
