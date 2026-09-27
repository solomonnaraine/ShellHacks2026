import { applyCors } from './cors.js'

const STRATEGIES = ['Short Strangle', 'Long Straddle']
const DEFAULT_START = '2025-09-26'
const DEFAULT_END = '2026-09-25'
const RATE = 0.045
const ENTRY_SLIP = 0.1
const EXIT_SLIP = 0.06
const COMMISSION = 0.04

const ANCHORS = {
  'CL=F': 78.4,
  'BZ=F': 81.2,
  'NG=F': 3.15,
  'HG=F': 4.42,
  'GC=F': 2648,
  LIT: 46.8,
  'ZW=F': 572,
  'ZC=F': 428,
  'ZS=F': 1046,
  'HRC=F': 786,
  'ALI=F': 2385,
}

const VOLS = {
  'CL=F': 0.36,
  'BZ=F': 0.33,
  'NG=F': 0.58,
  'HG=F': 0.3,
  'GC=F': 0.18,
  LIT: 0.48,
  'ZW=F': 0.32,
  'ZC=F': 0.3,
  'ZS=F': 0.28,
  'HRC=F': 0.34,
  'ALI=F': 0.26,
}

function readBody(req) {
  if (!req.body) return {}
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {}
  return req.body
}

function hashString(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rand) {
  const u1 = Math.max(rand(), 1e-12)
  const u2 = Math.max(rand(), 1e-12)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function round2(value) {
  return Number(value.toFixed(2))
}

function money(value) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function parseUtc(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatUtc(date) {
  return date.toISOString().slice(0, 10)
}

function businessDays(startIso, endIso) {
  const days = []
  const cursor = parseUtc(startIso)
  const end = parseUtc(endIso)
  while (cursor <= end) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(formatUtc(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

function normCdf(x) {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(x * x) / 2)
  return 0.5 * (1 + sign * y)
}

function optionPrice(spot, strike, tYears, vol, type) {
  if (tYears <= 0 || vol <= 0) {
    return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  }
  const sigma = Math.sqrt(tYears) * vol
  const d1 = (Math.log(spot / strike) + (RATE + 0.5 * vol * vol) * tYears) / sigma
  const d2 = d1 - sigma
  if (type === 'call') {
    return spot * normCdf(d1) - strike * Math.exp(-RATE * tYears) * normCdf(d2)
  }
  return strike * Math.exp(-RATE * tYears) * normCdf(-d2) - spot * normCdf(-d1)
}

function packageMid(spot, putStrike, callStrike, tYears, vol) {
  return optionPrice(spot, putStrike, tYears, vol, 'put') + optionPrice(spot, callStrike, tYears, vol, 'call')
}

function strikesFor(strategy, spot) {
  if (strategy === 'Long Straddle') return { putStrike: spot, callStrike: spot }
  return { putStrike: spot * 0.92, callStrike: spot * 1.08 }
}

function buildSeries(ticker, dates) {
  const anchor = ANCHORS[ticker] ?? 100
  const vol = VOLS[ticker] ?? 0.32
  const rand = mulberry32(hashString(`${ticker}|${dates[0]}|${dates.at(-1)}|${dates.length}`))
  let price = anchor * (0.88 + rand() * 0.24)
  let implied = vol * (1.02 + rand() * 0.1)
  const closes = []
  const impliedVol = []
  const dt = 1 / 252

  for (const date of dates) {
    closes.push({
      date,
      value: price < 20 ? Number(price.toFixed(4)) : Number(price.toFixed(2)),
    })
    impliedVol.push(implied)
    const jump = rand() < 0.007 ? (rand() < 0.5 ? -1 : 1) * vol * (0.2 + rand() * 0.45) : 0
    price = Math.max(anchor * 0.2, price * Math.exp(-0.5 * vol * vol * dt + vol * Math.sqrt(dt) * gaussian(rand) + jump))
    implied = Math.min(vol * 1.8, Math.max(vol * 0.55, implied * 0.9 + vol * 1.06 * 0.1 + (rand() - 0.5) * vol * 0.08))
  }

  return { closes, impliedVol, vol }
}

function contractsFor(strategy, spot, putStrike, callStrike, iv, dte, budget, credit, debit) {
  if (strategy === 'Long Straddle') return budget / Math.max(debit, spot * 0.001)
  const shock = Math.exp(2.25 * iv * Math.sqrt(dte / 252))
  const up = packageMid(spot * shock, putStrike, callStrike, 0, iv)
  const down = packageMid(spot / shock, putStrike, callStrike, 0, iv)
  const stressLoss = Math.max(up - credit, down - credit, credit)
  return (budget * 0.45) / stressLoss
}

function tradePnl(strategy, trade, spot, tYears, vol) {
  const theo = packageMid(spot, trade.putStrike, trade.callStrike, tYears, vol)
  if (strategy === 'Long Straddle') {
    const mtm = tYears === 0 ? theo : theo * (1 - EXIT_SLIP)
    return trade.contracts * (mtm - trade.debit)
  }
  const closeCost = tYears === 0 ? theo : theo * (1 + EXIT_SLIP)
  return trade.contracts * (trade.credit - closeCost)
}

export function calculateBacktest({ ticker, strategy, dte, budget, startDate, endDate }) {
  const start = startDate || DEFAULT_START
  const end = endDate || DEFAULT_END
  const dates = businessDays(start, end)
  if (dates.length <= dte) {
    return {
      trades: 0,
      explanation: `The ${start} to ${end} window has ${dates.length} trading sessions, which is shorter than ${dte} DTE.`,
    }
  }

  const { closes, impliedVol } = buildSeries(ticker, dates)
  const trades = []
  const equityCurve = []
  let realized = 0
  let open = null

  for (let index = 0; index < closes.length; index += 1) {
    if (open && index === open.exitIndex) {
      const pnl = tradePnl(strategy, open, closes[index].value, 0, open.iv)
      realized += pnl
      trades.push({
        entryDate: closes[open.entryIndex].date,
        exitDate: closes[index].date,
        entryPrice: open.entryPrice,
        exitPrice: closes[index].value,
        pnl: round2(pnl),
      })
      open = null
    }

    const capital = Math.max(budget + realized, 0)
    if (!open && capital > budget * 0.05 && index + dte < closes.length) {
      const spot = closes[index].value
      const { putStrike, callStrike } = strikesFor(strategy, spot)
      const iv = impliedVol[index]
      const mid = packageMid(spot, putStrike, callStrike, dte / 252, iv)
      const commission = mid * COMMISSION
      const debit = mid * (1 + ENTRY_SLIP) + commission
      const credit = mid * (1 - ENTRY_SLIP) - commission
      const contracts = contractsFor(strategy, spot, putStrike, callStrike, iv, dte, capital, credit, debit)
      open = {
        entryIndex: index,
        exitIndex: index + dte,
        entryPrice: spot,
        putStrike,
        callStrike,
        iv,
        contracts,
        debit,
        credit,
      }
    }

    const unrealized = open
      ? tradePnl(strategy, open, closes[index].value, (open.exitIndex - index) / 252, impliedVol[index])
      : 0
    equityCurve.push({
      date: closes[index].date,
      value: round2(budget + realized + unrealized),
    })
  }

  const winners = trades.filter((trade) => trade.pnl > 0)
  const losers = trades.filter((trade) => trade.pnl <= 0)
  const totalPnL = round2(realized)
  const winRate = trades.length === 0 ? 0 : (winners.length / trades.length) * 100
  const average = trades.length === 0 ? 0 : totalPnL / trades.length
  const averageGain = winners.length === 0 ? 0 : winners.reduce((sum, trade) => sum + trade.pnl, 0) / winners.length
  const averageLoss = losers.length === 0 ? 0 : losers.reduce((sum, trade) => sum + trade.pnl, 0) / losers.length

  let peak = equityCurve[0]?.value ?? budget
  let maxDrawdown = 0
  for (const point of equityCurve) {
    peak = Math.max(peak, point.value)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.value) / peak)
  }

  const risk =
    strategy === 'Short Strangle'
      ? 'Risk profile is short volatility: premium is collected when price stays between the 8% wings, and losses show up when a window settles through a strike.'
      : 'Risk profile is long volatility: quiet windows lose the debit after spread and commission, and gains concentrate in windows that move past the premium.'

  return {
    ticker,
    strategy,
    dte,
    budget,
    startDate: start,
    endDate: end,
    trades: trades.length,
    winRate: Number(winRate.toFixed(2)),
    maxDrawdown: Number((maxDrawdown * 100).toFixed(2)),
    totalPnL,
    equityCurve,
    tradeLog: trades,
    explanation:
      trades.length === 0
        ? `No completed ${dte}-session holds fit ${start} to ${end} for ${ticker}.`
        : `${strategy} on ${ticker} from ${start} to ${end}: ${trades.length} non-overlapping ${dte}-session holds. Win rate ${winRate.toFixed(1)}% (${winners.length} winners, ${losers.length} losers). Average trade ${money(average)}, average gain ${money(averageGain)}, average loss ${money(averageLoss)}. Total P&L ${money(totalPnL)}. Max drawdown ${(maxDrawdown * 100).toFixed(1)}%. Each hold is marked daily from entry premium to expiration settlement, with a spread and commission penalty. ${risk}`,
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
