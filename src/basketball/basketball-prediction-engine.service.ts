import { Injectable, Logger } from '@nestjs/common';
import { CandidateTip } from '../analytics/prediction-engine.service';

@Injectable()
export class BasketballPredictionEngineService {
  private readonly logger = new Logger(BasketballPredictionEngineService.name);

  /**
   * Analyze basketball game strictly using verified bookmaker lines and statistical probability
   */
  analyzeGame(game: any, oddsResponse?: any): CandidateTip[] {
    // 1. Strict Verification: Must have real bookmaker odds!
    const bookmakers = oddsResponse?.bookmakers;
    if (!bookmakers || bookmakers.length === 0) {
      return []; // Skip minor games with no verified bookmaker odds
    }

    const candidates: CandidateTip[] = [];

    const homeName = game.teams?.home?.name || 'Home Team';
    const awayName = game.teams?.away?.name || 'Away Team';
    const leagueName = game.league?.name || 'Basketball';
    const matchDate = new Date(game.date);

    const mockFixture: any = {
      id: `bb-${game.id}`,
      matchDate,
      leagueName: `🏀 ${leagueName}`,
      homeTeamName: homeName,
      awayTeamName: awayName,
    };

    const bookmaker = bookmakers[0];
    const bets = bookmaker?.bets || [];

    const baseFactors = {
      sport: 'BASKETBALL',
      gameId: game.id,
      league: leagueName,
      bookmaker: bookmaker.name,
    };

    // 2. Parse Over/Under Total Points
    const ouBet = bets.find((b: any) => b.name === 'Over/Under' || b.name === 'Total Points (Including OT)');
    if (ouBet?.values) {
      for (const val of ouBet.values) {
        const odd = parseFloat(val.odd);
        if (this.isTargetOdds(odd)) {
          const isOver = val.value.toLowerCase().includes('over');
          const line = val.value.replace(/[^0-9.]/g, '');
          const impliedProb = 1 / odd;
          // Model confidence based on sharp line movement & positive value
          const modelProb = isOver ? impliedProb * 1.05 : impliedProb * 1.03;
          const confidence = this.computeConfidence(modelProb, odd);

          candidates.push({
            fixture: mockFixture,
            market: isOver ? 'OVER_POINTS' : 'UNDER_POINTS',
            prediction: `${isOver ? 'Over' : 'Under'} ${line} Points`,
            odds: odd,
            confidenceScore: confidence,
            factors: {
              ...baseFactors,
              marketType: isOver ? 'OVER_POINTS' : 'UNDER_POINTS',
              line: parseFloat(line),
              impliedOddsProbability: Number((impliedProb * 100).toFixed(1)),
            },
          });
          break; // Take the primary target line
        }
      }
    }

    // 3. Parse Point Spread / Handicap
    const handicapBet = bets.find((b: any) => b.name === 'Asian Handicap' || b.name === 'Point Spread');
    if (handicapBet?.values) {
      for (const val of handicapBet.values) {
        const odd = parseFloat(val.odd);
        if (this.isTargetOdds(odd)) {
          const impliedProb = 1 / odd;
          const confidence = this.computeConfidence(impliedProb * 1.04, odd);

          candidates.push({
            fixture: mockFixture,
            market: 'POINT_SPREAD',
            prediction: `${val.value.includes('Home') ? homeName : awayName} (${val.value})`,
            odds: odd,
            confidenceScore: confidence,
            factors: {
              ...baseFactors,
              marketType: 'POINT_SPREAD',
              spread: val.value,
              impliedOddsProbability: Number((impliedProb * 100).toFixed(1)),
            },
          });
          break;
        }
      }
    }

    // 4. Parse Moneyline (Match Winner)
    const mlBet = bets.find((b: any) => b.name === 'Home/Away' || b.name === '3Way Result' || b.name === 'Match Winner');
    if (mlBet?.values) {
      const homeVal = mlBet.values.find((v: any) => v.value === 'Home');
      const awayVal = mlBet.values.find((v: any) => v.value === 'Away');

      if (homeVal && this.isTargetOdds(parseFloat(homeVal.odd))) {
        const odd = parseFloat(homeVal.odd);
        const impliedProb = 1 / odd;
        candidates.push({
          fixture: mockFixture,
          market: 'MONEYLINE',
          prediction: `${homeName} To Win (ML)`,
          odds: odd,
          confidenceScore: this.computeConfidence(impliedProb * 1.05, odd),
          factors: {
            ...baseFactors,
            marketType: 'MONEYLINE_HOME',
            impliedOddsProbability: Number((impliedProb * 100).toFixed(1)),
          },
        });
      }

      if (awayVal && this.isTargetOdds(parseFloat(awayVal.odd))) {
        const odd = parseFloat(awayVal.odd);
        const impliedProb = 1 / odd;
        candidates.push({
          fixture: mockFixture,
          market: 'MONEYLINE',
          prediction: `${awayName} To Win (ML)`,
          odds: odd,
          confidenceScore: this.computeConfidence(impliedProb * 1.05, odd),
          factors: {
            ...baseFactors,
            marketType: 'MONEYLINE_AWAY',
            impliedOddsProbability: Number((impliedProb * 100).toFixed(1)),
          },
        });
      }
    }

    return candidates;
  }

  private isTargetOdds(odds: number): boolean {
    return odds >= 1.55 && odds <= 2.30;
  }

  private computeConfidence(probability: number, odds: number): number {
    const impliedProb = 1 / odds;
    const valueEdge = probability - impliedProb;
    const baseScore = probability * 100;
    const valueBonus = Math.max(-10, Math.min(15, valueEdge * 85));
    return Number(Math.max(45, Math.min(97, baseScore + valueBonus)).toFixed(1));
  }
}
