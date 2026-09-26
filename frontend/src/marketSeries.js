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

function hashTicker(ticker) {
  let hash = 2166136261
  for (let index = 0; index < ticker.length; index += 1) {
    hash ^= ticker.charCodeAt(index)
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

function sessionDates(count) {
  const dates = []
  const cursor = new Date(Date.UTC(2026, 8, 26))
  while (dates.length < count) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return dates.reverse()
}

function decimalsFor(anchor) {
  if (anchor >= 100) return 2
  if (anchor >= 10) return 2
  return 3
}

function roundTo(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function formatPrice(value) {
  const digits = value >= 100 ? 2 : value >= 10 ? 2 : 3
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function pricePath(ticker) {
  const anchor = ANCHORS[ticker] ?? 100
  const digits = decimalsFor(anchor)
  const random = mulberry32(hashTicker(ticker))
  const dailyVol = 0.008 + random() * 0.014
  let price = anchor * (0.93 + random() * 0.1)
  const closes = sessionDates(90).map((time) => {
    const shock = (random() - 0.48) * dailyVol
    const pull = ((anchor - price) / anchor) * 0.045
    price = Math.max(anchor * 0.55, price * (1 + shock + pull))
    return { time, value: roundTo(price, digits) }
  })

  const upper = []
  const lower = []
  for (let index = 0; index < closes.length; index += 1) {
    const slice = closes.slice(Math.max(0, index - 11), index + 1).map((point) => point.value)
    const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length
    const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length
    const band = Math.sqrt(variance) * 1.65
    upper.push({
      time: closes[index].time,
      value: roundTo(closes[index].value + band, digits),
    })
    lower.push({
      time: closes[index].time,
      value: roundTo(Math.max(closes[index].value - band, anchor * 0.2), digits),
    })
  }

  const returns = []
  for (let index = 1; index < closes.length; index += 1) {
    returns.push(Math.log(closes[index].value / closes[index - 1].value))
  }
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const returnVariance =
    returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / returns.length
  const realizedVol = Math.sqrt(returnVariance) * Math.sqrt(252)

  return {
    closes,
    upper,
    lower,
    last: closes[closes.length - 1].value,
    realizedVol,
  }
}

export function payoffCurve(strategy, spot) {
  const points = []
  const steps = 80
  const min = spot * 0.7
  const max = spot * 1.3
  for (let step = 0; step <= steps; step += 1) {
    const price = min + ((max - min) * step) / steps
    let pnl
    if (strategy === 'Long Straddle') {
      pnl = Math.abs(price - spot) - spot * 0.045
    } else {
      const putStrike = spot * 0.92
      const callStrike = spot * 1.08
      pnl = spot * 0.028 - Math.max(putStrike - price, 0) - Math.max(price - callStrike, 0)
    }
    points.push({ price, pnl })
  }
  return points
}
