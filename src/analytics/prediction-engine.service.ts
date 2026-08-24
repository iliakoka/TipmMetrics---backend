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
   * Analyze match with real team stats, Poisson distribution, and market value detection
   */
  analyzeFixture(
    fixture: Fixture,
    homeStats: any | null,
    awayStats: any | null,
    h2h: any[],
    bookmakerOdds?: any,
  ): CandidateTip[] {
    const candidates: CandidateTip[] = [];

    // 1. Extract Real Goals Averages
    const homeGoalsScored =
      parseFloat(homeStats?.goals?.for?.average?.home) ||
      parseFloat(homeStats?.goals?.for?.average?.total) ||
      1.4;
    const homeGoalsConceded =
      parseFloat(homeStats?.goals?.against?.average?.home) ||
      parseFloat(homeStats?.goals?.against?.average?.total) ||
      1.2;

    const awayGoalsScored =
      parseFloat(awayStats?.goals?.for?.average?.away) ||
      parseFloat(awayStats?.goals?.for?.average?.total) ||
      1.1;
    const awayGoalsConceded =
      parseFloat(awayStats?.goals?.against?.average?.away) ||
      parseFloat(awayStats?.goals?.against?.average?.total) ||
      1.3;

    // League standard baselines
    const leagueAvgHomeGoals = 1.45;
    const leagueAvgAwayGoals = 1.15;

    // Expected goals (λ) using attack / defense strength
    const lambdaHome = Math.max(
      0.5,
      Math.min(
        3.5,
        (homeGoalsScored * awayGoalsConceded) / leagueAvgAwayGoals,
      ),
    );
    const lambdaAway = Math.max(
      0.4,
      Math.min(
        3.0,
        (awayGoalsScored * homeGoalsConceded) / leagueAvgHomeGoals,
      ),
    );

    // 2. Compute Joint Poisson Matrix (0 to 6 goals)
    let probHomeWin = 0;
    let probDraw = 0;
    let probAwayWin = 0;
    let probBTTS = 0;
    let probOver2_5 = 0;

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
      }
    }

    const prob1X = probHomeWin + probDraw;
    const probX2 = probAwayWin + probDraw;

    // 3. Form & H2H Metrics
    const homeFormString = homeStats?.form?.slice(-6) || 'WDLWDL';
    const awayFormString = awayStats?.form?.slice(-6) || 'LDWLDW';
    const homeFormPts = this.calcFormPoints(homeFormString);
    const awayFormPts = this.calcFormPoints(awayFormString);

    const h2hBttsRate = h2h.length > 0 ? this.calcH2hBtts(h2h) : 0.5;
    const h2hOver25Rate = h2h.length > 0 ? this.calcH2hOver(h2h, 2.5) : 0.5;

    // 4. Extract Real Bookmaker Odds
    const extractedOdds = this.parseOdds(bookmakerOdds);

    const baseFactors = {
      lambdaHome: Number(lambdaHome.toFixed(2)),
      lambdaAway: Number(lambdaAway.toFixed(2)),
      homeFormRecent: homeFormString,
      awayFormRecent: awayFormString,
      homeFormScore: homeFormPts,
      awayFormScore: awayFormPts,
      h2hMatchesAnalyzed: h2h.length,
      h2hBttsRate: Number(h2hBttsRate.toFixed(2)),
      h2hOver25Rate: Number(h2hOver25Rate.toFixed(2)),
    };

    // --- MARKET A: Match Winner (Home Win / Away Win) ---
    const homeWinOdds = extractedOdds.homeWin || Number((1 / (probHomeWin * 0.94)).toFixed(2));
    if (this.isTargetOdds(homeWinOdds) && probHomeWin > 0.45) {
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

    const awayWinOdds = extractedOdds.awayWin || Number((1 / (probAwayWin * 0.94)).toFixed(2));
    if (this.isTargetOdds(awayWinOdds) && probAwayWin > 0.45) {
      const confidence = this.computeConfidence(probAwayWin, awayWinOdds);
      candidates.push({
        fixture,
        market: 'AWAY_WIN',
        prediction: `${fixture.awayTeamName} To Win`,
        odds: awayWinOdds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'AWAY_WIN',
          modelProbability: Number((probAwayWin * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / awayWinOdds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET B: Double Chance (1X or X2) ---
    const dc1XOdds = extractedOdds.doubleChance1X || Number((1 / (prob1X * 0.96)).toFixed(2));
    if (this.isTargetOdds(dc1XOdds) && prob1X > 0.60) {
      const confidence = this.computeConfidence(prob1X, dc1XOdds);
      candidates.push({
        fixture,
        market: 'DOUBLE_CHANCE',
        prediction: `${fixture.homeTeamName} or Draw (1X)`,
        odds: dc1XOdds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: '1X',
          modelProbability: Number((prob1X * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / dc1XOdds) * 100).toFixed(1)),
        },
      });
    }

    const dcX2Odds = extractedOdds.doubleChanceX2 || Number((1 / (probX2 * 0.96)).toFixed(2));
    if (this.isTargetOdds(dcX2Odds) && probX2 > 0.60) {
      const confidence = this.computeConfidence(probX2, dcX2Odds);
      candidates.push({
        fixture,
        market: 'DOUBLE_CHANCE',
        prediction: `${fixture.awayTeamName} or Draw (X2)`,
        odds: dcX2Odds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'X2',
          modelProbability: Number((probX2 * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / dcX2Odds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET C: Goals (Over 2.5 / Under 2.5) ---
    const over25Odds = extractedOdds.over25 || Number((1 / (probOver2_5 * 0.95)).toFixed(2));
    const combinedOverProb = probOver2_5 * 0.7 + h2hOver25Rate * 0.3;
    if (this.isTargetOdds(over25Odds) && combinedOverProb > 0.48) {
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

    const probUnder2_5 = 1 - probOver2_5;
    const under25Odds = extractedOdds.under25 || Number((1 / (probUnder2_5 * 0.95)).toFixed(2));
    const combinedUnderProb = probUnder2_5 * 0.7 + (1 - h2hOver25Rate) * 0.3;
    if (this.isTargetOdds(under25Odds) && combinedUnderProb > 0.48) {
      const confidence = this.computeConfidence(combinedUnderProb, under25Odds);
      candidates.push({
        fixture,
        market: 'UNDER_2_5',
        prediction: 'Under 2.5 Goals',
        odds: under25Odds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'UNDER_2_5',
          modelProbability: Number((probUnder2_5 * 100).toFixed(1)),
          combinedProbability: Number((combinedUnderProb * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / under25Odds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET D: Both Teams To Score (BTTS: Yes / No) ---
    const bttsOdds = extractedOdds.bttsYes || Number((1 / (probBTTS * 0.95)).toFixed(2));
    const combinedBttsProb = probBTTS * 0.7 + h2hBttsRate * 0.3;
    if (this.isTargetOdds(bttsOdds) && combinedBttsProb > 0.48) {
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

    const probBTTSNo = 1 - probBTTS;
    const bttsNoOdds = extractedOdds.bttsNo || Number((1 / (probBTTSNo * 0.95)).toFixed(2));
    const combinedBttsNoProb = probBTTSNo * 0.7 + (1 - h2hBttsRate) * 0.3;
    if (this.isTargetOdds(bttsNoOdds) && combinedBttsNoProb > 0.48) {
      const confidence = this.computeConfidence(combinedBttsNoProb, bttsNoOdds);
      candidates.push({
        fixture,
        market: 'BTTS_NO',
        prediction: 'Both Teams To Score: No',
        odds: bttsNoOdds,
        confidenceScore: confidence,
        factors: {
          ...baseFactors,
          marketType: 'BTTS_NO',
          modelProbability: Number((probBTTSNo * 100).toFixed(1)),
          combinedProbability: Number((combinedBttsNoProb * 100).toFixed(1)),
          impliedOddsProbability: Number(((1 / bttsNoOdds) * 100).toFixed(1)),
        },
      });
    }

    return candidates;
  }

  /**
   * Select top distinct tips purely ranked by highest mathematical confidence and accuracy
   */
  selectDailyTips(candidates: CandidateTip[], targetCount = 6): CandidateTip[] {
    // Sort strictly by highest confidence score
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

  // --- Helper Analytics Functions ---

  private isTargetOdds(odds: number): boolean {
    return odds >= 1.65 && odds <= 2.15;
  }

  private computeConfidence(probability: number, odds: number): number {
    const impliedProb = 1 / odds;
    const valueEdge = probability - impliedProb;
    const baseScore = probability * 100;
    const valueBonus = Math.max(-10, Math.min(15, valueEdge * 85));
    return Number(Math.max(45, Math.min(97, baseScore + valueBonus)).toFixed(1));
  }

  private calcFormPoints(formStr: string): number {
    let pts = 0;
    for (const char of formStr) {
      if (char === 'W') pts += 3;
      else if (char === 'D') pts += 1;
    }
    return pts;
  }

  private calcH2hBtts(h2h: any[]): number {
    let btts = 0;
    let valid = 0;
    for (const m of h2h) {
      if (m.goals?.home !== null && m.goals?.away !== null) {
        if (m.goals.home > 0 && m.goals.away > 0) btts++;
        valid++;
      }
    }
    return valid > 0 ? btts / valid : 0.5;
  }

  private calcH2hOver(h2h: any[], threshold: number): number {
    let over = 0;
    let valid = 0;
    for (const m of h2h) {
      if (m.goals?.home !== null && m.goals?.away !== null) {
        if (m.goals.home + m.goals.away > threshold) over++;
        valid++;
      }
    }
    return valid > 0 ? over / valid : 0.5;
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

        const dcX2 = bet.values?.find(
          (v: any) => v.value === 'Draw/Away',
        )?.odd;
        if (dcX2) odds.doubleChanceX2 = parseFloat(dcX2);
      }
    }

    return odds;
  }
}
