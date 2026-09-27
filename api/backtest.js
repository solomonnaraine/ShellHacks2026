import { pricePath } from '../frontend/src/marketSeries.js'
import { applyCors } from './cors.js'

const STRATEGIES = ['Short Strangle', 'Long Straddle']

function readBody(req) {
  if (!req.body) return {}
  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {}
  }
  return req.body
}

function structurePnl(strategy, spot, exitPrice) {
  if (strategy === 'Long Straddle') {
    return Math.abs(exitPrice - spot) - spot * 0.045
  }
  const putStrike = spot * 0.92
  const callStrike = spot * 1.08
  return spot * 0.028 - Math.max(putStrike - exitPrice, 0) - Math.max(exitPrice - callStrike, 0)
}

function premium(strategy, spot) {
  return strategy === 'Long Straddle' ? spot * 0.045 : spot * 0.028
}

export function calculateBacktest({ ticker, strategy, dte, budget, startDate, endDate }) {
  const series = pricePath(ticker)
  const closes = series.closes.filter((point) => {
    if (startDate && point.time < startDate) return false
    if (endDate && point.time > endDate) return false
    return true
  })

  const trades = []
  for (let index = 0; index + dte < closes.length; index += dte) {
    const entry = closes[index]
    const exit = closes[index + dte]
    const unitPnl = structurePnl(strategy, entry.value, exit.value)
    const contracts = budget / premium(strategy, entry.value)
    trades.push({
      entryDate: entry.time,
      exitDate: exit.time,
      entryPrice: entry.value,
      exitPrice: exit.value,
      pnl: Number((unitPnl * contracts).toFixed(2)),
    })
  }

  let equity = budget
  let peak = budget
  let maxDrawdown = 0
  const curve = [{ time: closes[0]?.time ?? null, equity: budget, pnl: 0 }]
  for (const trade of trades) {
    equity += trade.pnl
    peak = Math.max(peak, equity)
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak
    maxDrawdown = Math.max(maxDrawdown, drawdown)
    curve.push({
      time: trade.exitDate,
      equity: Number(equity.toFixed(2)),
      pnl: trade.pnl,
    })
  }

  const wins = trades.filter((trade) => trade.pnl > 0).length
  const winRate = trades.length === 0 ? 0 : (wins / trades.length) * 100
  const totalPnl = Number((equity - budget).toFixed(2))
  const maxDrawdownPct = Number((maxDrawdown * 100).toFixed(2))

  return {
    ticker,
    strategy,
    dte,
    budget,
    startDate: startDate || null,
    endDate: endDate || null,
    trades: trades.length,
    winRate: Number(winRate.toFixed(2)),
    maxDrawdown: maxDrawdownPct,
    totalPnl,
    endingEquity: Number(equity.toFixed(2)),
    curve,
    tradeLog: trades,
    explanation:
      trades.length === 0
        ? `No completed ${dte}-session holds fit the selected dates for ${ticker}.`
        : `${strategy} on ${ticker} ran ${trades.length} non-overlapping ${dte}-session holds. Win rate ${winRate.toFixed(1)}%, total P&L ${totalPnl.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}, max drawdown ${maxDrawdownPct}%. Prices use the terminal session path for this ticker.`,
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let body
  try {
    body = readBody(req)
  } catch {
    return res.status(400).json({ error: 'Request body must be JSON.' })
  }

  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  const strategy = body.strategy
  const dte = Number(body.dte)
  const budget = Number(body.budget)
  const startDate = body.startDate ? String(body.startDate) : ''
  const endDate = body.endDate ? String(body.endDate) : ''

  if (!ticker) {
    return res.status(400).json({ error: 'Enter a target ticker before running the backtest.' })
  }
  if (!STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: 'Strategy must be Short Strangle or Long Straddle.' })
  }
  if (!Number.isInteger(dte) || dte <= 0) {
    return res.status(400).json({ error: 'DTE must be a whole number of days greater than zero.' })
  }
  if ((startDate && !endDate) || (!startDate && endDate)) {
    return res.status(400).json({ error: 'Enter both a start date and an end date, or leave both blank.' })
  }
  if (startDate && endDate && endDate < startDate) {
    return res.status(400).json({ error: 'The end date must be on or after the start date.' })
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    return res.status(400).json({ error: 'Budget must be a USD amount greater than zero.' })
  }

  const results = calculateBacktest({ ticker, strategy, dte, budget, startDate, endDate })
  if (results.trades === 0) {
    return res.status(400).json({ error: results.explanation })
  }

  return res.status(200).json(results)
}
