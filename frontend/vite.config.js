import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function vercelResponse(res) {
  const wrapper = {
    statusCode: 200,
    setHeader(name, value) {
      res.setHeader(name, value)
    },
    status(code) {
      this.statusCode = code
      res.statusCode = code
      return this
    },
    json(data) {
      res.statusCode = this.statusCode
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    },
    end() {
      res.statusCode = this.statusCode
      res.end()
    },
  }
  return wrapper
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function apiDevPlugin() {
  const handlers = {
    '/api/backtest': new URL('../api/backtest.js', import.meta.url),
    '/api/nodes': new URL('../api/nodes.js', import.meta.url),
  }

  return {
    name: 'vercel-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0]
        const handlerUrl = handlers[path]
        if (!handlerUrl) {
          next()
          return
        }

        try {
          const mod = await import(handlerUrl.href)
          const url = new URL(req.url, 'http://127.0.0.1')
          const body = req.method === 'POST' ? await readBody(req) : undefined
          await mod.default(
            {
              method: req.method,
              query: Object.fromEntries(url.searchParams),
              body,
            },
            vercelResponse(res),
          )
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: error.message || 'API handler failed.' }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [apiDevPlugin(), react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['frame-ticker', 'tinycolor2', 'h3-js', 'simplesignal', 'prop-types'],
    exclude: ['react-resizable-panels', 'react-globe.gl', 'react-kapsule'],
  },
})
