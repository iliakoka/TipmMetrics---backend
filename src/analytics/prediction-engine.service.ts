import { Injectable, Logger } from '@nestjs/common';
import { Fixture } from '../fixtures/fixture.entity';

export interface CandidateTip {
  fixture: Fixture;
  market: string;
  prediction: string;
  odds: number;
  confidenceScore: number;
  factors: Record<string, any>;
}

@Injectable()
export class PredictionEngineService {
  private readonly logger = new Logger(PredictionEngineService.name);

  /**
   * Poisson Probability Mass Function: P(k; λ) = (λ^k * e^-λ) / k!
   */
  private poissonProbability(k: number, lambda: number): number {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / this.factorial(k);
  }

  private factorial(n: number): number {
    if (n <= 1) return 1;
    let res = 1;
    for (let i = 2; i <= n; i++) res *= i;
    return res;
  }

  /**
   * Analyze a match using historical data, Poisson goals model, and form metrics
   */
  analyzeFixture(
    fixture: Fixture,
    homeRecent: any[],
    awayRecent: any[],
    h2h: any[],
    bookmakerOdds?: any,
  ): CandidateTip[] {
    const candidates: CandidateTip[] = [];

    // 1. Calculate Goals Averages
    const homeGoalsScored = this.avgGoals(homeRecent, fixture.homeTeamId, true);
    const homeGoalsConceded = this.avgGoals(
      homeRecent,
      fixture.homeTeamId,
      false,
    );
    const awayGoalsScored = this.avgGoals(awayRecent, fixture.awayTeamId, true);
    const awayGoalsConceded = this.avgGoals(
      awayRecent,
      fixture.awayTeamId,
      false,
    );

    // League standard baselines
    const leagueAvgHomeGoals = 1.45;
    const leagueAvgAwayGoals = 1.15;

    // Expected goals (λ) using attack / defense strength
    const lambdaHome = Math.max(
      0.6,
      Math.min(
        3.5,
        ((homeGoalsScored || 1.4) * (awayGoalsConceded || 1.2)) /
          leagueAvgAwayGoals,
      ),
    );
    const lambdaAway = Math.max(
      0.5,
      Math.min(
        3.0,
        ((awayGoalsScored || 1.1) * (homeGoalsConceded || 1.2)) /
          leagueAvgHomeGoals,
      ),
    );

    // 2. Compute Joint Probability Matrix (0 to 6 goals)
    let probHomeWin = 0;
    let probDraw = 0;
    let probAwayWin = 0;
    let probBTTS = 0;
    let probOver2_5 = 0;
    let probUnder2_5 = 0;

    for (let h = 0; h <= 6; h++) {
      for (let a = 0; a <= 6; a++) {
        const pScore =
          this.poissonProbability(h, lambdaHome) *
          this.poissonProbability(a, lambdaAway);

        if (h > a) probHomeWin += pScore;
        else if (h === a) probDraw += pScore;
        else probAwayWin += pScore;

        if (h > 0 && a > 0) probBTTS += pScore;
        if (h + a > 2.5) probOver2_5 += pScore;
        else probUnder2_5 += pScore;
      }
    }

    const prob1X = probHomeWin + probDraw;
    const probX2 = probAwayWin + probDraw;

    // 3. Empirical Form Metrics
    const homeBttsRate = this.calcBttsRate(homeRecent);
    const awayBttsRate = this.calcBttsRate(awayRecent);
    const h2hBttsRate = h2h.length > 0 ? this.calcBttsRate(h2h) : (homeBttsRate + awayBttsRate) / 2;

    const homeOver25Rate = this.calcOverRate(homeRecent, 2.5);
    const awayOver25Rate = this.calcOverRate(awayRecent, 2.5);

    // 4. Extract Real Bookmaker Odds or Estimate Realistic Odds
    const extractedOdds = this.parseOdds(bookmakerOdds);

    // Common factor diagnostic payload (saved for 2-3 month backtesting)
    const baseFactors = {
      lambdaHome: Number(lambdaHome.toFixed(2)),
      lambdaAway: Number(lambdaAway.toFixed(2)),
      homeRecentGames: homeRecent.length,
      awayRecentGames: awayRecent.length,
      h2hMatches: h2h.length,
      homeBttsRateLast10: Number(homeBttsRate.toFixed(2)),
      awayBttsRateLast10: Number(awayBttsRate.toFixed(2)),
      h2hBttsRate: Number(h2hBttsRate.toFixed(2)),
      homeOver25Rate: Number(homeOver25Rate.toFixed(2)),
      awayOver25Rate: Number(awayOver25Rate.toFixed(2)),
    };

    // --- MARKET A: Both Teams To Score (BTTS - Yes) ---
    const bttsOdds = extractedOdds.bttsYes || Number((1 / (probBTTS * 0.95)).toFixed(2));
    const combinedBttsProb = probBTTS * 0.5 + homeBttsRate * 0.25 + awayBttsRate * 0.25;
    if (this.isTargetOdds(bttsOdds)) {
      const confidence = this.computeConfidence(combinedBttsProb, bttsOdds);
      candidates.push({
        fixture,
        market: 'BTTS',
        prediction: 'Both Teams To Score: Yes',
        odds: bttsOdds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'BTTS_YES',
          modelProbability: Number((probBTTS * 100).toFixed(1)),
          combinedProbability: Number((combinedBttsProb * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / bttsOdds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET B: Over 2.5 Goals ---
    const over25Odds = extractedOdds.over25 || Number((1 / (probOver2_5 * 0.95)).toFixed(2));
    const combinedOverProb = probOver2_5 * 0.5 + homeOver25Rate * 0.25 + awayOver25Rate * 0.25;
    if (this.isTargetOdds(over25Odds)) {
      const confidence = this.computeConfidence(combinedOverProb, over25Odds);
      candidates.push({
        fixture,
        market: 'OVER_2_5',
        prediction: 'Over 2.5 Goals',
        odds: over25Odds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'OVER_2_5',
          modelProbability: Number((probOver2_5 * 100).toFixed(1)),
          combinedProbability: Number((combinedOverProb * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / over25Odds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET C: Home Win (1X2) ---
    const homeWinOdds = extractedOdds.homeWin || Number((1 / (probHomeWin * 0.94)).toFixed(2));
    if (this.isTargetOdds(homeWinOdds) && probHomeWin > 0.48) {
      const confidence = this.computeConfidence(probHomeWin, homeWinOdds);
      candidates.push({
        fixture,
        market: 'HOME_WIN',
        prediction: `${fixture.homeTeamName} To Win`,
        odds: homeWinOdds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'HOME_WIN',
          modelProbability: Number((probHomeWin * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / homeWinOdds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET D: Double Chance 1X (Home or Draw) ---
    const doubleChance1XOdds = extractedOdds.doubleChance1X || Number((1 / (prob1X * 0.96)).toFixed(2));
    if (this.isTargetOdds(doubleChance1XOdds) && prob1X > 0.65) {
      const confidence = this.computeConfidence(prob1X, doubleChance1XOdds);
      candidates.push({
        fixture,
        market: 'DOUBLE_CHANCE',
        prediction: `${fixture.homeTeamName} or Draw (1X)`,
        odds: doubleChance1XOdds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: '1X',
          modelProbability: Number((prob1X * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / doubleChance1XOdds) * 100).toFixed(1)),
        },
      });
    }

    return candidates;
  }

  /**
   * Filter top 5 - 7 distinct tips with highest confidence and best distribution
   */
  selectDailyTips(candidates: CandidateTip[], targetCount = 6): CandidateTip[] {
    // Sort descending by confidence score
    candidates.sort((a, b) => b.confidenceScore - a.confidenceScore);

    const selected: CandidateTip[] = [];
    const usedFixtureIds = new Set<string>();

    for (const cand of candidates) {
      if (!usedFixtureIds.has(cand.fixture.id)) {
        selected.push(cand);
        usedFixtureIds.add(cand.fixture.id);

        if (selected.length >= targetCount) break;
      }
    }

    return selected;
  }

  // --- Helper Methods ---

  private isTargetOdds(odds: number): boolean {
    return odds >= 1.65 && odds <= 2.15;
  }

  private computeConfidence(probability: number, odds: number): number {
    const impliedProb = 1 / odds;
    const valueEdge = probability - impliedProb; // Expected value margin
    const baseScore = probability * 100;
    const valueBonus = Math.max(-10, Math.min(15, valueEdge * 80));
    return Number(Math.max(40, Math.min(96, baseScore + valueBonus)).toFixed(1));
  }

  private avgGoals(matches: any[], teamId: number, isScored: boolean): number {
    if (!matches || matches.length === 0) return 1.2;
    let total = 0;
    let count = 0;

    for (const m of matches) {
      const isHome = m.teams?.home?.id === teamId;
      const goals = isScored
        ? isHome
          ? m.goals?.home
          : m.goals?.away
        : isHome
          ? m.goals?.away
          : m.goals?.home;

      if (goals !== null && goals !== undefined) {
        total += goals;
        count++;
      }
    }

    return count > 0 ? total / count : 1.2;
  }

  private calcBttsRate(matches: any[]): number {
    if (!matches || matches.length === 0) return 0.5;
    let bttsCount = 0;
    let valid = 0;

    for (const m of matches) {
      if (m.goals?.home !== null && m.goals?.away !== null) {
        if (m.goals.home > 0 && m.goals.away > 0) bttsCount++;
        valid++;
      }
    }

    return valid > 0 ? bttsCount / valid : 0.5;
  }

  private calcOverRate(matches: any[], threshold: number): number {
    if (!matches || matches.length === 0) return 0.5;
    let overCount = 0;
    let valid = 0;

    for (const m of matches) {
      if (m.goals?.home !== null && m.goals?.away !== null) {
        if (m.goals.home + m.goals.away > threshold) overCount++;
        valid++;
      }
    }

    return valid > 0 ? overCount / valid : 0.5;
  }

  private parseOdds(oddsResponse?: any): Record<string, number> {
    const odds: Record<string, number> = {};
    if (!oddsResponse?.bookmakers) return odds;

    const bookmaker = oddsResponse.bookmakers[0];
    if (!bookmaker?.bets) return odds;

    for (const bet of bookmaker.bets) {
      if (bet.name === 'Match Winner') {
        const home = bet.values?.find((v: any) => v.value === 'Home')?.odd;
        if (home) odds.homeWin = parseFloat(home);
      }
      if (bet.name === 'Both Teams Score') {
        const yes = bet.values?.find((v: any) => v.value === 'Yes')?.odd;
        if (yes) odds.bttsYes = parseFloat(yes);
      }
      if (bet.name === 'Goals Over/Under') {
        const over = bet.values?.find((v: any) => v.value === 'Over 2.5')?.odd;
        if (over) odds.over25 = parseFloat(over);
      }
      if (bet.name === 'Double Chance') {
        const dc1x = bet.values?.find(
          (v: any) => v.value === 'Home/Draw',
        )?.odd;
        if (dc1x) odds.doubleChance1X = parseFloat(dc1x);
      }
    }

    return odds;
  }
}
