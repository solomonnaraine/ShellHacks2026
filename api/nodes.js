import { createRequire } from 'node:module'
import { applyCors } from './cors.js'

const require = createRequire(import.meta.url)
const nodes = require('../frontend/src/data/nodes.json')

export default async function handler(req, res) {
  if (applyCors(req, res)) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const type = typeof req.query?.type === 'string' ? req.query.type : ''
  const id = typeof req.query?.id === 'string' ? req.query.id : ''
  const query = typeof req.query?.q === 'string' ? req.query.q.trim().toLowerCase() : ''

  const filtered = nodes.filter((node) => {
    if (id && node.id !== id) return false
    if (type && node.type !== type) return false
    if (!query) return true
    return [node.name, node.commodity, node.ticker, node.type]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })

  return res.status(200).json({
    count: filtered.length,
    nodes: filtered,
  })
}
