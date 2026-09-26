"""FastAPI service and proxy option backtester for ShellHacks '26.

This is a simplified option-price proxy based on daily adjusted closes. It
does not replay historical listed-option quotes or model implied volatility.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

VALID_STRATEGIES = {
    "long_straddle": "long_straddle", "long straddle": "long_straddle",
    "straddle": "long_straddle", "short_strangle": "short_strangle",
    "short strangle": "short_strangle", "strangle": "short_strangle",
}


class BacktestError(ValueError):
    """Invalid backtest parameters or unavailable market data."""


class MarketDataError(RuntimeError):
    """Failure while retrieving data from yfinance."""


def _parse_date(value: str, label: str) -> pd.Timestamp:
    if not value or not value.strip():
        raise BacktestError(f"{label} is required")
    for fmt in ("%Y-%m-%d", "%m%d%y", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return pd.Timestamp(pd.to_datetime(value.strip(), format=fmt)).normalize()
        except (ValueError, TypeError):
            pass
    raise BacktestError(f"Invalid {label}: use YYYY-MM-DD or MMDDYY")


def _normalize_strategy(strategy: str) -> str:
    result = VALID_STRATEGIES.get(strategy.strip().lower())
    if result is None:
        raise BacktestError("strategy must be 'long_straddle' or 'short_strangle'")
    return result


def _close_series(df: pd.DataFrame, ticker: str) -> pd.Series:
    """Extract Close reliably from flat and yfinance MultiIndex columns."""
    if df is None or df.empty:
        return pd.Series(dtype=float)
    try:
        if isinstance(df.columns, pd.MultiIndex):
            close = None
            # yfinance column order can vary: (Price, Ticker) or (Ticker, Price).
            for level in range(df.columns.nlevels):
                if "Close" in df.columns.get_level_values(level):
                    close = df.xs("Close", axis=1, level=level, drop_level=True)
                    break
            if close is None:
                return pd.Series(dtype=float)
            if isinstance(close, pd.DataFrame):
                if ticker in close.columns:
                    close = close[ticker]
                elif close.shape[1] == 1:
                    close = close.iloc[:, 0]
                else:
                    return pd.Series(dtype=float)
        else:
            close = df["Close"]
            if isinstance(close, pd.DataFrame):
                close = close.iloc[:, 0]
        series = pd.to_numeric(close, errors="coerce").dropna()
        series.index = pd.to_datetime(series.index).tz_localize(None).normalize()
        return series[~series.index.duplicated(keep="last")].sort_index()
    except (KeyError, TypeError, ValueError, AttributeError):
        return pd.Series(dtype=float)


def _leg_prices(
    prices: pd.Series,
    expiration: pd.Timestamp,
    premium0: float,
    direction: float,
    strike: float,
    option_type: str,
) -> list[float]:
    """Mark a proxy leg using calendar DTE and an intrinsic-value floor."""
    start_date = prices.index[0]
    initial_dte = max(1, (expiration - start_date).days)
    leverage = 25.0 / np.sqrt(initial_dte)
    current = float(premium0)
    marks: list[float] = []
    previous_spot = float(prices.iloc[0])

    for current_date, raw_spot in prices.items():
        spot = float(raw_spot)
        remaining_dte = max(0, (expiration - current_date).days)
        if current_date >= expiration:
            intrinsic = max(0.0, spot - strike) if option_type == "call" else max(0.0, strike - spot)
            current = intrinsic
        else:
            daily_return = (spot / previous_spot - 1.0) if previous_spot > 0 else 0.0
            theta = premium0 * (0.5 / np.sqrt(initial_dte * (remaining_dte + 1)))
            # The mark can recover from zero when the underlying moves; intrinsic
            # value prevents a call/put from being marked below its exercise value.
            current = max(0.0, current * (1.0 + direction * leverage * daily_return) - theta)
            intrinsic = max(0.0, spot - strike) if option_type == "call" else max(0.0, strike - spot)
            current = max(current, intrinsic)
        marks.append(current)
        previous_spot = spot
    return marks


def run_advanced_option_backtest(
    ticker: str,
    start_date: str,
    end_date: str,
    expiration_date: str,
    total_budget: float,
    strategy: str,
    contract_amount: float | None = None,
    max_contracts: int | None = None,
) -> dict[str, Any]:
    ticker = ticker.strip().upper()
    if not ticker:
        raise BacktestError("ticker is required")
    if not np.isfinite(total_budget) or total_budget <= 0:
        raise BacktestError("total_budget must be greater than 0")
    start_dt = _parse_date(start_date, "start date")
    end_dt = _parse_date(end_date, "end date")
    expiration_dt = _parse_date(expiration_date, "expiration date")
    if end_dt < start_dt:
        raise BacktestError("end date must be on or after start date")
    if expiration_dt <= start_dt:
        raise BacktestError("expiration date must be after the start date")
    if expiration_dt < end_dt:
        raise BacktestError("expiration date must be on or after the end date")
    if max_contracts is not None and max_contracts < 0:
        raise BacktestError("max_contracts cannot be negative")

    allocated = total_budget if contract_amount is None else contract_amount
    if not np.isfinite(allocated) or allocated <= 0 or allocated > total_budget:
        raise BacktestError("contract_amount must be greater than 0 and at most total_budget")
    strategy_key = _normalize_strategy(strategy)
    initial_dte = (expiration_dt - start_dt).days

    # Fetch prior sessions for a reference when the requested start falls on a
    # weekend/holiday. Keep output observations clipped to the requested range.
    fetch_start = start_dt - pd.Timedelta(days=7)
    try:
        raw = yf.download(
            ticker, start=fetch_start.strftime("%Y-%m-%d"),
            end=(end_dt + pd.Timedelta(days=1)).strftime("%Y-%m-%d"),
            auto_adjust=True, progress=False, threads=False,
        )
    except Exception as exc:
        logger.exception("yfinance download failed for %s", ticker)
        raise MarketDataError(f"Unable to retrieve market data for {ticker}") from exc

    closes = _close_series(raw, ticker)
    if closes.empty:
        raise BacktestError(
            f"No valid trading-day close prices found for {ticker} from "
            f"{start_dt.date()} through {end_dt.date()}; check ticker and date range"
        )
    # Start pricing at the first available session on/after requested start.
    selected = closes.loc[(closes.index >= start_dt) & (closes.index <= end_dt)]
    if selected.empty:
        raise BacktestError(
            f"The requested range {start_dt.date()} through {end_dt.date()} "
            f"contains no trading-day prices for {ticker}"
        )
    prices = selected
    spot0 = float(prices.iloc[0])
    atm = spot0 * (0.005 * np.sqrt(initial_dte))
    is_short = strategy_key == "short_strangle"
    if is_short:
        call_strike, put_strike = spot0 * 1.05, spot0 * 0.95
        call_p0 = put_p0 = atm * 0.65
    else:
        call_strike = put_strike = spot0
        call_p0 = put_p0 = atm

    premium_per_structure = (call_p0 + put_p0) * 100.0
    contracts = int(allocated // premium_per_structure) if premium_per_structure else 0
    if max_contracts is not None:
        contracts = min(contracts, max_contracts)
    premium_total = contracts * premium_per_structure

    call_marks = _leg_prices(prices, expiration_dt, call_p0, 1.0, call_strike, "call")
    put_marks = _leg_prices(prices, expiration_dt, put_p0, -1.0, put_strike, "put")
    combo = np.asarray(call_marks) + np.asarray(put_marks)
    sign = -1.0 if is_short else 1.0
    cash = total_budget + premium_total if is_short else total_budget - premium_total
    portfolio = cash + sign * contracts * combo * 100.0
    curve = pd.Series(portfolio, index=prices.index)
    peak = curve.cummax().replace(0, np.nan)
    drawdown = ((peak - curve) / peak).max()
    daily_returns = curve.pct_change()
    days = max(0, len(curve) - 1)
    wins = int((daily_returns > 0).sum())

    return {
        "ticker": ticker, "strategy": strategy_key,
        "start": start_dt.strftime("%Y-%m-%d"), "end": end_dt.strftime("%Y-%m-%d"),
        "expiration_date": expiration_dt.strftime("%Y-%m-%d"),
        "initial_dte_calendar_days": initial_dte, "total_budget": round(total_budget, 2),
        "num_contracts": contracts,
        "capital_spent": round(premium_total if not is_short else 0.0, 2),
        "premium_collected": round(premium_total if is_short else 0.0, 2),
        "uninvested_cash": round(float(cash), 2),
        "total_return_pct": round((float(curve.iloc[-1]) / total_budget - 1) * 100, 2),
        "max_drawdown_pct": round(float(drawdown) * 100 if pd.notna(drawdown) else 0.0, 2),
        "win_rate_pct": round(wins / days * 100 if days else 0.0, 2),
        "pnl_curve": [
            {"date": dt.strftime("%Y-%m-%d"), "value": round(float(value), 2)}
            for dt, value in curve.items()
        ],
    }


app = FastAPI(title="ShellHacks '26 Options Backtest API")
origins = os.getenv("FRONTEND_ORIGINS", "*").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if origins == "*" else [x.strip() for x in origins.split(",") if x.strip()],
    allow_credentials=False, allow_methods=["*"], allow_headers=["*"],
)


class BacktestRequest(BaseModel):
    ticker: str = Field(..., min_length=1, examples=["AAPL"])
    start: str = Field(..., description="YYYY-MM-DD or MMDDYY")
    end: str = Field(..., description="Last date to include, YYYY-MM-DD or MMDDYY")
    expiration_date: str = Field(..., description="Option expiry date, YYYY-MM-DD or MMDDYY")
    strategy: str = Field(..., examples=["long_straddle", "short_strangle"])
    total_budget: float = Field(..., gt=0)
    contract_amount: float | None = Field(default=None, gt=0, description="Optional budget allocation")
    max_contracts: int | None = Field(default=None, ge=0, description="Optional maximum contracts")


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/backtest")
def backtest_endpoint(payload: BacktestRequest) -> dict[str, Any]:
    try:
        return run_advanced_option_backtest(
            ticker=payload.ticker, start_date=payload.start, end_date=payload.end,
            expiration_date=payload.expiration_date, total_budget=payload.total_budget,
            strategy=payload.strategy, contract_amount=payload.contract_amount,
            max_contracts=payload.max_contracts,
        )
    except BacktestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except MarketDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception:
        logger.exception("Unexpected error while running backtest")
        raise HTTPException(status_code=500, detail="Internal backtest error") from None
