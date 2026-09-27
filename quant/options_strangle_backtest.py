"""Short commodity strangle backtest on exchange daily closes.

Each hold sells a put and a call a fixed distance out of the money, carries the
position for ``dte`` sessions, and marks it every close with Black-Scholes.
Implied volatility is the trailing 30-session realized volatility known on that
close. Entry is filled at the bid and exits before expiration are filled at the
ask, so quiet holds do not keep the full theoretical credit.

Run from the repository root:

    python quant/options_strangle_backtest.py
"""

import yfinance as yf
import pandas as pd
import numpy as np
from scipy.stats import norm


CONTRACT_MULTIPLIER = {
    "CL=F": 1_000,
    "BZ=F": 1_000,
    "NG=F": 10_000,
    "GC=F": 100,
    "HG=F": 25_000,
    "SI=F": 5_000,
    "ZW=F": 50,
    "ZC=F": 50,
    "ZS=F": 50,
}


class CommodityStrangleBacktester:
    """Backtest a short strangle on one commodity future.

    Position size is continuous so a research budget is not forced onto an
    integer lot. Each new hold risks ``risk_fraction`` of the capital still
    left against a 2.25-standard-deviation expiration move.
    """

    def __init__(
        self,
        ticker,
        dte=30,
        budget=10_000.0,
        start=None,
        end=None,
        put_moneyness=0.92,
        call_moneyness=1.08,
        risk_free_rate=0.045,
        vol_window=30,
        entry_slippage=0.10,
        exit_slippage=0.06,
        commission_rate=0.04,
        risk_fraction=0.45,
    ):
        if dte < 1:
            raise ValueError("dte must be a positive number of sessions.")
        if budget <= 0:
            raise ValueError("budget must be greater than zero.")
        if not 0 < put_moneyness < 1 < call_moneyness:
            raise ValueError("The put strike must be below spot and the call strike above it.")
        self.ticker = ticker.upper()
        self.dte = int(dte)
        self.budget = float(budget)
        self.start = start
        self.end = end
        self.put_moneyness = float(put_moneyness)
        self.call_moneyness = float(call_moneyness)
        self.risk_free_rate = float(risk_free_rate)
        self.vol_window = int(vol_window)
        self.entry_slippage = float(entry_slippage)
        self.exit_slippage = float(exit_slippage)
        self.commission_rate = float(commission_rate)
        self.risk_fraction = float(risk_fraction)
        self.multiplier = float(CONTRACT_MULTIPLIER.get(self.ticker, 1.0))

    def download(self):
        """Download adjusted daily closes from Yahoo Finance."""
        end = pd.Timestamp(self.end).normalize() if self.end else pd.Timestamp.today().normalize() + pd.Timedelta(days=1)
        start = pd.Timestamp(self.start).normalize() if self.start else end - pd.DateOffset(years=3)
        frame = yf.download(
            self.ticker,
            start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            auto_adjust=True,
            progress=False,
            threads=False,
        )
        if frame is None or frame.empty:
            raise RuntimeError(f"Yahoo Finance returned no rows for {self.ticker}.")

        close = frame["Close"]
        if isinstance(close, pd.DataFrame):
            close = close[self.ticker] if self.ticker in close.columns else close.iloc[:, 0]
        close = pd.to_numeric(close, errors="coerce").dropna().sort_index()
        if getattr(close.index, "tz", None) is not None:
            close.index = close.index.tz_localize(None)
        close.name = self.ticker
        if len(close) <= self.vol_window + self.dte:
            raise RuntimeError(
                f"{self.ticker} only has {len(close)} sessions. "
                f"Need more than {self.vol_window + self.dte} for a {self.vol_window}-day volatility window and {self.dte} DTE."
            )
        return close

    def historical_volatility(self, closes):
        """Annualized standard deviation of log returns over ``vol_window`` sessions."""
        log_returns = np.log(closes / closes.shift(1))
        return log_returns.rolling(self.vol_window).std() * np.sqrt(252)

    def _d1(self, spot, strike, t_years, sigma):
        sigma = max(float(sigma), 1e-4)
        t_years = max(float(t_years), 1e-8)
        return (np.log(spot / strike) + (self.risk_free_rate + 0.5 * sigma**2) * t_years) / (
            sigma * np.sqrt(t_years)
        )

    def _d2(self, spot, strike, t_years, sigma):
        sigma = max(float(sigma), 1e-4)
        t_years = max(float(t_years), 1e-8)
        return self._d1(spot, strike, t_years, sigma) - sigma * np.sqrt(t_years)

    def call_premium(self, spot, strike, t_years, sigma):
        """Black-Scholes call. Expired contracts settle at intrinsic value."""
        if t_years <= 0 or spot <= 0 or strike <= 0:
            return max(float(spot) - float(strike), 0.0)
        d1 = self._d1(spot, strike, t_years, sigma)
        d2 = self._d2(spot, strike, t_years, sigma)
        discount = np.exp(-self.risk_free_rate * t_years)
        return float(spot * norm.cdf(d1) - strike * discount * norm.cdf(d2))

    def put_premium(self, spot, strike, t_years, sigma):
        """Black-Scholes put. Expired contracts settle at intrinsic value."""
        if t_years <= 0 or spot <= 0 or strike <= 0:
            return max(float(strike) - float(spot), 0.0)
        d1 = self._d1(spot, strike, t_years, sigma)
        d2 = self._d2(spot, strike, t_years, sigma)
        discount = np.exp(-self.risk_free_rate * t_years)
        return float(strike * discount * norm.cdf(-d2) - spot * norm.cdf(-d1))

    def _strangle_intrinsic(self, spot, put_strike, call_strike):
        return max(put_strike - spot, 0.0) + max(spot - call_strike, 0.0)

    def _package_value(self, spot, put_strike, call_strike, t_years, sigma):
        return self.put_premium(spot, put_strike, t_years, sigma) + self.call_premium(
            spot, call_strike, t_years, sigma
        )

    def _quantity(self, capital, spot, put_strike, call_strike, sigma, credit):
        """Scale the hold so a 2.25-sigma expiration costs ``risk_fraction`` of capital."""
        shock = float(np.exp(2.25 * max(sigma, 1e-4) * np.sqrt(self.dte / 252.0)))
        loss_up = self._strangle_intrinsic(spot * shock, put_strike, call_strike) - credit
        loss_down = self._strangle_intrinsic(spot / shock, put_strike, call_strike) - credit
        stress = max(loss_up, loss_down, credit) * self.multiplier
        if stress <= 0 or capital <= 0:
            return 0.0
        return (capital * self.risk_fraction) / stress

    def _mark(self, trade, spot, sessions_left, sigma):
        if sessions_left <= 0:
            liability = self._strangle_intrinsic(spot, trade["put_strike"], trade["call_strike"])
        else:
            theo = self._package_value(
                spot,
                trade["put_strike"],
                trade["call_strike"],
                sessions_left / 252.0,
                sigma,
            )
            liability = theo * (1.0 + self.exit_slippage)
        return (trade["credit"] - liability) * self.multiplier * trade["quantity"]

    def run(self):
        """Download history, step through non-overlapping DTE windows, and score the book."""
        closes = self.download()
        volatility = self.historical_volatility(closes)
        dates = closes.index
        spots = closes.to_numpy(dtype=float)
        vols = volatility.to_numpy(dtype=float)
        n = len(spots)

        trades = []
        curve_dates = []
        curve_values = []
        realized = 0.0
        open_trade = None

        for index in range(n):
            if open_trade is not None and index == open_trade["exit_index"]:
                pnl = self._mark(open_trade, spots[index], 0, open_trade["iv"])
                realized += pnl
                trades.append(
                    {
                        "entry_date": dates[open_trade["entry_index"]],
                        "exit_date": dates[index],
                        "entry_price": open_trade["entry_price"],
                        "exit_price": spots[index],
                        "iv": open_trade["iv"],
                        "credit": open_trade["credit"],
                        "quantity": open_trade["quantity"],
                        "pnl": pnl,
                    }
                )
                open_trade = None

            capital = self.budget + realized
            sigma = vols[index]
            can_enter = (
                open_trade is None
                and capital > self.budget * 0.05
                and index + self.dte < n
                and np.isfinite(sigma)
                and sigma > 0
                and spots[index] > 0
            )
            if can_enter:
                spot = float(spots[index])
                put_strike = spot * self.put_moneyness
                call_strike = spot * self.call_moneyness
                mid = self._package_value(spot, put_strike, call_strike, self.dte / 252.0, float(sigma))
                credit = mid * (1.0 - self.entry_slippage) - mid * self.commission_rate
                quantity = self._quantity(capital, spot, put_strike, call_strike, float(sigma), credit)
                if mid > 0 and quantity > 0 and credit > 0:
                    open_trade = {
                        "entry_index": index,
                        "exit_index": index + self.dte,
                        "entry_price": spot,
                        "put_strike": put_strike,
                        "call_strike": call_strike,
                        "iv": float(sigma),
                        "credit": credit,
                        "quantity": quantity,
                    }

            if open_trade is None:
                unrealized = 0.0
            else:
                mark_vol = vols[index]
                if not np.isfinite(mark_vol) or mark_vol <= 0:
                    mark_vol = open_trade["iv"]
                unrealized = self._mark(
                    open_trade,
                    float(spots[index]),
                    open_trade["exit_index"] - index,
                    float(mark_vol),
                )
            curve_dates.append(dates[index])
            curve_values.append(self.budget + realized + unrealized)

        trade_frame = pd.DataFrame(trades)
        equity_curve = pd.DataFrame({"date": curve_dates, "value": curve_values})
        if trade_frame.empty:
            raise RuntimeError(f"No completed {self.dte}-session strangles fit the {self.ticker} history.")

        winners = trade_frame.loc[trade_frame["pnl"] > 0, "pnl"]
        losers = trade_frame.loc[trade_frame["pnl"] <= 0, "pnl"]
        total_pnl = float(trade_frame["pnl"].sum())
        win_rate = float(len(winners) / len(trade_frame))
        peak = equity_curve["value"].cummax()
        drawdown = (peak - equity_curve["value"]) / peak.where(peak > 0)
        max_drawdown = float(drawdown.max())

        result = {
            "ticker": self.ticker,
            "start": dates[0].strftime("%Y-%m-%d"),
            "end": dates[-1].strftime("%Y-%m-%d"),
            "sessions": n,
            "dte": self.dte,
            "trades": trade_frame,
            "equity_curve": equity_curve,
            "win_rate": win_rate,
            "max_drawdown": max_drawdown,
            "total_pnl": total_pnl,
            "average_pnl": float(trade_frame["pnl"].mean()),
            "average_gain": float(winners.mean()) if len(winners) else 0.0,
            "average_loss": float(losers.mean()) if len(losers) else 0.0,
        }
        result["summary"] = self.format_summary(result)
        return result

    def format_summary(self, result):
        trade_count = len(result["trades"])
        winners = int((result["trades"]["pnl"] > 0).sum())
        losers = trade_count - winners
        return "\n".join(
            [
                f"Short strangle backtest  {result['ticker']}",
                f"History                   {result['start']} to {result['end']}  ({result['sessions']} sessions)",
                f"DTE                       {result['dte']} sessions, non-overlapping",
                f"Strikes                   {self.put_moneyness:.0%} / {self.call_moneyness:.0%} of entry spot",
                f"Trades                    {trade_count}  ({winners} winners, {losers} losers)",
                f"Win rate                  {result['win_rate'] * 100:.1f}%",
                f"Max drawdown              {result['max_drawdown'] * 100:.1f}%",
                f"Total P&L                 ${result['total_pnl']:,.2f}",
                f"Average trade             ${result['average_pnl']:,.2f}",
                f"Average gain              ${result['average_gain']:,.2f}",
                f"Average loss              ${result['average_loss']:,.2f}",
            ]
        )


def main():
    backtester = CommodityStrangleBacktester("CL=F", dte=30, budget=10_000)
    result = backtester.run()
    print(result["summary"])


if __name__ == "__main__":
    main()
