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
   * Advanced Match Analysis with:
   * 1. Poisson Goal Expectancy
   * 2. Schedule Fatigue & Rest Days Differential
   * 3. Home vs Away Venue Asymmetry
   * 4. Scoring Consistency (Variance Dampening)
   * 5. Clean Sheet & BTTS Historical Tendencies
   * 6. Target Odds Filtering (1.65 – 2.15)
   */
  analyzeFixture(
    fixture: Fixture,
    homeRecent: any[],
    awayRecent: any[],
    h2h: any[],
    bookmakerOdds?: any,
  ): CandidateTip[] {
    const candidates: CandidateTip[] = [];
    const matchDate = new Date(fixture.matchDate);

    // 1. Calculate Rest Days & Schedule Fatigue
    const homeRestDays = this.calcRestDays(homeRecent, matchDate);
    const awayRestDays = this.calcRestDays(awayRecent, matchDate);

    // Fatigue multiplier: < 3.5 days rest impairs attack by 7%, increases defensive lapses by 8%
    const homeFatigueAttack = homeRestDays < 3.5 ? 0.93 : 1.0;
    const homeFatigueDef = homeRestDays < 3.5 ? 1.08 : 1.0;

    const awayFatigueAttack = awayRestDays < 3.5 ? 0.92 : 1.0;
    const awayFatigueDef = awayRestDays < 3.5 ? 1.08 : 1.0;

    // 2. Strict Venue Asymmetry (70% Venue Specific + 30% Overall)
    const homeVenueGoalsScored = this.avgGoalsVenue(homeRecent, fixture.homeTeamId, true, true);
    const homeVenueGoalsConceded = this.avgGoalsVenue(homeRecent, fixture.homeTeamId, true, false);
    const homeOverallGoalsScored = this.avgGoals(homeRecent, fixture.homeTeamId, true);
    const homeOverallGoalsConceded = this.avgGoals(homeRecent, fixture.homeTeamId, false);

    const effHomeScored = (0.7 * homeVenueGoalsScored + 0.3 * homeOverallGoalsScored) * homeFatigueAttack;
    const effHomeConceded = (0.7 * homeVenueGoalsConceded + 0.3 * homeOverallGoalsConceded) * homeFatigueDef;

    const awayVenueGoalsScored = this.avgGoalsVenue(awayRecent, fixture.awayTeamId, false, true);
    const awayVenueGoalsConceded = this.avgGoalsVenue(awayRecent, fixture.awayTeamId, false, false);
    const awayOverallGoalsScored = this.avgGoals(awayRecent, fixture.awayTeamId, true);
    const awayOverallGoalsConceded = this.avgGoals(awayRecent, fixture.awayTeamId, false);

    const effAwayScored = (0.7 * awayVenueGoalsScored + 0.3 * awayOverallGoalsScored) * awayFatigueAttack;
    const effAwayConceded = (0.7 * awayVenueGoalsConceded + 0.3 * awayOverallGoalsConceded) * awayFatigueDef;

    // Baseline league averages
    const leagueAvgHomeGoals = 1.45;
    const leagueAvgAwayGoals = 1.15;

    // Expected goals (λ)
    const lambdaHome = Math.max(
      0.5,
      Math.min(
        3.6,
        (effHomeScored * effAwayConceded) / leagueAvgAwayGoals,
      ),
    );
    const lambdaAway = Math.max(
      0.4,
      Math.min(
        3.2,
        (effAwayScored * effHomeConceded) / leagueAvgHomeGoals,
      ),
    );

    // 3. Compute Joint Poisson Matrix (0-6 goals each)
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

    // 4. Scoring Consistency & Clean Sheet Rates (Variance Dampening)
    const homeConsistency = this.calcScoringConsistency(homeRecent, fixture.homeTeamId);
    const awayConsistency = this.calcScoringConsistency(awayRecent, fixture.awayTeamId);
    const homeCleanSheetRate = this.calcCleanSheetRate(homeRecent, fixture.homeTeamId);
    const awayCleanSheetRate = this.calcCleanSheetRate(awayRecent, fixture.awayTeamId);

    const homeBttsRate = this.calcBttsRate(homeRecent);
    const awayBttsRate = this.calcBttsRate(awayRecent);
    const h2hBttsRate = h2h.length > 0 ? this.calcBttsRate(h2h) : (homeBttsRate + awayBttsRate) / 2;

    const homeOver25Rate = this.calcOverRate(homeRecent, 2.5);
    const awayOver25Rate = this.calcOverRate(awayRecent, 2.5);
    const h2hOver25Rate = h2h.length > 0 ? this.calcOverRate(h2h, 2.5) : (homeOver25Rate + awayOver25Rate) / 2;

    // 5. Parse Bookmaker Odds
    const extractedOdds = this.parseOdds(bookmakerOdds);

    // Common factor diagnostic payload (saved for 2-3 month backtesting & optimization)
    const baseFactors = {
      lambdaHome: Number(lambdaHome.toFixed(2)),
      lambdaAway: Number(lambdaAway.toFixed(2)),
      homeRestDays,
      awayRestDays,
      homeFatigueApplied: homeRestDays < 3.5,
      awayFatigueApplied: awayRestDays < 3.5,
      homeScoringConsistency: Number((homeConsistency * 100).toFixed(1)),
      awayScoringConsistency: Number((awayConsistency * 100).toFixed(1)),
      homeCleanSheetRate: Number((homeCleanSheetRate * 100).toFixed(1)),
      awayCleanSheetRate: Number((awayCleanSheetRate * 100).toFixed(1)),
      h2hMatchesAnalyzed: h2h.length,
      h2hBttsRate: Number(h2hBttsRate.toFixed(2)),
      h2hOver25Rate: Number(h2hOver25Rate.toFixed(2)),
    };

    // --- MARKET A: Both Teams To Score (BTTS - Yes) ---
    const bttsOdds = extractedOdds.bttsYes || Number((1 / (probBTTS * 0.95)).toFixed(2));
    // Blend: 45% Poisson + 25% Consistency & Clean Sheets + 20% Form BTTS + 10% H2H
    const consistencyBTTSFactor = (homeConsistency * (1 - awayCleanSheetRate) + awayConsistency * (1 - homeCleanSheetRate)) / 2;
    const combinedBttsProb =
      probBTTS * 0.45 +
      consistencyBTTSFactor * 0.25 +
      ((homeBttsRate + awayBttsRate) / 2) * 0.20 +
      h2hBttsRate * 0.10;

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
    const combinedOverProb =
      probOver2_5 * 0.45 +
      ((homeOver25Rate + awayOver25Rate) / 2) * 0.35 +
      h2hOver25Rate * 0.20;

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
   * Select top 5 - 7 distinct tips with highest confidence and balanced league representation
   */
  selectDailyTips(candidates: CandidateTip[], targetCount = 6): CandidateTip[] {
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
    const valueEdge = probability - impliedProb; // Positive Expected Value (EV+)
    const baseScore = probability * 100;
    const valueBonus = Math.max(-10, Math.min(15, valueEdge * 85));
    return Number(Math.max(40, Math.min(97, baseScore + valueBonus)).toFixed(1));
  }

  private calcRestDays(matches: any[], targetMatchDate: Date): number {
    if (!matches || matches.length === 0) return 7;
    const lastMatch = matches[0];
    if (!lastMatch?.fixture?.date) return 7;

    const lastMatchDate = new Date(lastMatch.fixture.date);
    const diffMs = targetMatchDate.getTime() - lastMatchDate.getTime();
    const days = diffMs / (1000 * 60 * 60 * 24);
    return Number(Math.max(1, Math.min(14, days)).toFixed(1));
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

  private avgGoalsVenue(
    matches: any[],
    teamId: number,
    isHomeVenue: boolean,
    isScored: boolean,
  ): number {
    if (!matches || matches.length === 0) return 1.2;
    let total = 0;
    let count = 0;

    for (const m of matches) {
      const isHomeMatch = m.teams?.home?.id === teamId;
      if (isHomeVenue !== isHomeMatch) continue; // Skip matches not at this venue

      const goals = isScored
        ? isHomeMatch
          ? m.goals?.home
          : m.goals?.away
        : isHomeMatch
          ? m.goals?.away
          : m.goals?.home;

      if (goals !== null && goals !== undefined) {
        total += goals;
        count++;
      }
    }

    return count > 0 ? total / count : this.avgGoals(matches, teamId, isScored);
  }

  private calcScoringConsistency(matches: any[], teamId: number): number {
    if (!matches || matches.length === 0) return 0.7;
    let scoredMatches = 0;
    let valid = 0;

    for (const m of matches) {
      const isHome = m.teams?.home?.id === teamId;
      const goals = isHome ? m.goals?.home : m.goals?.away;
      if (goals !== null && goals !== undefined) {
        if (goals > 0) scoredMatches++;
        valid++;
      }
    }

    return valid > 0 ? scoredMatches / valid : 0.7;
  }

  private calcCleanSheetRate(matches: any[], teamId: number): number {
    if (!matches || matches.length === 0) return 0.25;
    let cleanSheets = 0;
    let valid = 0;

    for (const m of matches) {
      const isHome = m.teams?.home?.id === teamId;
      const conceded = isHome ? m.goals?.away : m.goals?.home;
      if (conceded !== null && conceded !== undefined) {
        if (conceded === 0) cleanSheets++;
        valid++;
      }
    }

    return valid > 0 ? cleanSheets / valid : 0.25;
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
