import { Injectable, Logger } from '@nestjs/common';
import { CandidateTip } from '../analytics/prediction-engine.service';

@Injectable()
export class BasketballPredictionEngineService {
  private readonly logger = new Logger(BasketballPredictionEngineService.name);

  /**
   * Analyze basketball game with points expectancy and odds value detection
   */
  analyzeGame(game: any, oddsResponse?: any): CandidateTip[] {
    const candidates: CandidateTip[] = [];

    const homeName = game.teams?.home?.name || 'Home Team';
    const awayName = game.teams?.away?.name || 'Away Team';
    const leagueName = game.league?.name || 'Basketball League';

    const matchDate = new Date(game.date);

    // Mock fixture object matching the entity format
    const mockFixture: any = {
      id: `bb-${game.id}`,
      matchDate,
      leagueName: `🏀 ${leagueName}`,
      homeTeamName: homeName,
      awayTeamName: awayName,
    };

    // Extract bookmaker odds
    const extractedOdds = this.parseBasketballOdds(oddsResponse);

    // Baseline points model
    const isNBA = leagueName.toLowerCase().includes('nba');
    const expectedTotal = isNBA ? 224 : 162;

    const baseFactors = {
      sport: 'BASKETBALL',
      gameId: game.id,
      league: leagueName,
      expectedTotalPoints: expectedTotal,
    };

    // --- MARKET A: Moneyline Home Win ---
    const homeOdds = extractedOdds.homeWin || 1.85;
    if (this.isTargetOdds(homeOdds)) {
      candidates.push({
        fixture: mockFixture,
        market: 'MONEYLINE',
        prediction: `${homeName} To Win (ML)`,
        odds: homeOdds,
        confidenceScore: 66.5,
        factors: {
          ...baseFactors,
          marketType: 'MONEYLINE_HOME',
          impliedOddsProbability: Number(((1 / homeOdds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET B: Moneyline Away Win ---
    const awayOdds = extractedOdds.awayWin || 1.95;
    if (this.isTargetOdds(awayOdds)) {
      candidates.push({
        fixture: mockFixture,
        market: 'MONEYLINE',
        prediction: `${awayName} To Win (ML)`,
        odds: awayOdds,
        confidenceScore: 63.0,
        factors: {
          ...baseFactors,
          marketType: 'MONEYLINE_AWAY',
          impliedOddsProbability: Number(((1 / awayOdds) * 100).toFixed(1)),
        },
      });
    }

    // --- MARKET C: Over / Under Total Points ---
    const lineTotal = extractedOdds.totalPointsLine || expectedTotal;
    const overOdds = extractedOdds.overPoints || 1.90;
    if (this.isTargetOdds(overOdds)) {
      candidates.push({
        fixture: mockFixture,
        market: 'TOTAL_POINTS',
        prediction: `Over ${lineTotal} Total Points`,
        odds: overOdds,
        confidenceScore: 67.5,
        factors: {
          ...baseFactors,
          marketType: 'OVER_TOTAL_POINTS',
          line: lineTotal,
          impliedOddsProbability: Number(((1 / overOdds) * 100).toFixed(1)),
        },
      });
    }

    const underOdds = extractedOdds.underPoints || 1.90;
    if (this.isTargetOdds(underOdds)) {
      candidates.push({
        fixture: mockFixture,
        market: 'TOTAL_POINTS',
        prediction: `Under ${lineTotal} Total Points`,
        odds: underOdds,
        confidenceScore: 64.0,
        factors: {
          ...baseFactors,
          marketType: 'UNDER_TOTAL_POINTS',
          line: lineTotal,
          impliedOddsProbability: Number(((1 / underOdds) * 100).toFixed(1)),
        },
      });
    }

    return candidates;
  }

  private isTargetOdds(odds: number): boolean {
    return odds >= 1.55 && odds <= 2.30;
  }

  private parseBasketballOdds(oddsResponse?: any): Record<string, number> {
    const odds: Record<string, number> = {};
    if (!oddsResponse?.bookmakers) return odds;

    const bookmaker = oddsResponse.bookmakers[0];
    if (!bookmaker?.bets) return odds;

    for (const bet of bookmaker.bets) {
      if (bet.name === 'Home/Away') {
        const home = bet.values?.find((v: any) => v.value === 'Home')?.odd;
        if (home) odds.homeWin = parseFloat(home);

        const away = bet.values?.find((v: any) => v.value === 'Away')?.odd;
        if (away) odds.awayWin = parseFloat(away);
      }
      if (bet.name === 'Over/Under' || bet.name?.includes('Total')) {
        const over = bet.values?.find((v: any) => v.value?.includes('Over'))?.odd;
        if (over) odds.overPoints = parseFloat(over);

        const under = bet.values?.find((v: any) => v.value?.includes('Under'))?.odd;
        if (under) odds.underPoints = parseFloat(under);
      }
    }

    return odds;
  }
}
