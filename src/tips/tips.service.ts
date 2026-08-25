import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { Tip, TipResult } from './tip.entity';
import { Fixture } from '../fixtures/fixture.entity';
import { FootballDataService } from '../football-data/football-data.service';
import { PredictionEngineService, CandidateTip } from '../analytics/prediction-engine.service';
import { BasketballDataService } from '../basketball/basketball-data.service';
import { BasketballPredictionEngineService } from '../basketball/basketball-prediction-engine.service';

@Injectable()
export class TipsService {
  private readonly logger = new Logger(TipsService.name);

  constructor(
    @InjectRepository(Tip)
    private tipRepository: Repository<Tip>,
    @InjectRepository(Fixture)
    private fixtureRepository: Repository<Fixture>,
    private footballDataService: FootballDataService,
    private predictionEngineService: PredictionEngineService,
    private basketballDataService: BasketballDataService,
    private basketballPredictionEngineService: BasketballPredictionEngineService,
  ) {}

  /**
   * Generates top 5 - 7 tips for a given date (defaults to today)
   */
  async generateDailyTips(
    targetDate?: string,
    force?: boolean,
  ): Promise<Tip[]> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Starting automated tip generation for: ${dateStr} (force=${!!force})`);

    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    // 1. Check if tips are already generated for today
    const existingTips = await this.tipRepository.find({
      where: {
        matchDate: Between(startOfDay, endOfDay),
      },
      relations: ['fixture'],
    });

    if (existingTips.length > 0) {
      if (!force) {
        this.logger.log(
          `Already generated ${existingTips.length} tips for ${dateStr}`,
        );
        return existingTips;
      }

      // If force is true, remove only the pending ones to re-analyze with enhanced algorithm
      const pendingExisting = existingTips.filter(
        (t) => t.result === TipResult.PENDING,
      );
      if (pendingExisting.length > 0) {
        await this.tipRepository.remove(pendingExisting);
        this.logger.log(
          `Force refresh: Removed ${pendingExisting.length} pending tips to re-calculate with updated engine`,
        );
      }
    }

    const allCandidates: CandidateTip[] = [];

    // 2. Process Football Fixtures (if quota available, or fallback to saved database fixtures)
    try {
      let fixtures = await this.footballDataService.syncFixturesForDate(dateStr);
      if (!fixtures || fixtures.length === 0) {
        fixtures = await this.fixtureRepository.find({
          where: { matchDate: Between(startOfDay, endOfDay) },
        });
      }

      if (fixtures && fixtures.length > 0) {
        const upcomingFixtures = fixtures.filter(
          (f) => f.status === 'NS' || new Date(f.matchDate) >= new Date(),
        );
        const targetFixtures =
          upcomingFixtures.length >= 5 ? upcomingFixtures : fixtures;

        const sampleFixtures = targetFixtures.slice(0, 25);

        for (const fixture of sampleFixtures) {
          try {
            const [homeStats, awayStats, h2h, odds] = await Promise.all([
              this.footballDataService.getTeamStats(
                fixture.homeTeamId,
                fixture.leagueId,
              ),
              this.footballDataService.getTeamStats(
                fixture.awayTeamId,
                fixture.leagueId,
              ),
              this.footballDataService.getH2H(
                fixture.homeTeamId,
                fixture.awayTeamId,
              ),
              this.footballDataService.getOddsForFixture(fixture.apiFixtureId),
            ]);

            const candidates = this.predictionEngineService.analyzeFixture(
              fixture,
              homeStats,
              awayStats,
              h2h,
              odds,
            );

            allCandidates.push(...candidates);

            // Once we have 8+ verified high-confidence candidates, stop querying to save quota
            if (allCandidates.length >= 8) {
              break;
            }

            // Pacing to stay smoothly within API rate limits (10 req/min)
            await new Promise((resolve) => setTimeout(resolve, 300));
          } catch (err) {
            this.logger.error(
              `Error analyzing fixture ${fixture.homeTeamName} vs ${fixture.awayTeamName}: ${err.message}`,
            );
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Football processing skipped: ${err.message}`);
    }

    // 3. Ingest and Analyze Basketball Games (Independent Quota!)
    try {
      const basketballGames =
        await this.basketballDataService.getGamesForDate(dateStr);
      for (const game of basketballGames.slice(0, 10)) {
        if (
          game.status?.short !== 'NS' &&
          new Date(game.date) < new Date()
        ) {
          continue;
        }

        let bFixture = await this.fixtureRepository.findOne({
          where: { apiFixtureId: game.id },
        });

        if (!bFixture) {
          bFixture = this.fixtureRepository.create({
            apiFixtureId: game.id,
            leagueId: game.league?.id || 0,
            leagueName: `🏀 ${game.league?.name || 'Basketball'}`,
            leagueCountry: game.country?.name || '',
            homeTeamId: game.teams?.home?.id || 0,
            homeTeamName: game.teams?.home?.name || 'Home Team',
            awayTeamId: game.teams?.away?.id || 0,
            awayTeamName: game.teams?.away?.name || 'Away Team',
            matchDate: new Date(game.date),
            status: game.status?.short || 'NS',
          });
          bFixture = await this.fixtureRepository.save(bFixture);
        }

        const odds = await this.basketballDataService.getOddsForGame(game.id);
        const bCandidates =
          this.basketballPredictionEngineService.analyzeGame(game, odds);

        for (const bc of bCandidates) {
          bc.fixture = bFixture;
          allCandidates.push(bc);
        }
      }
    } catch (err) {
      this.logger.warn(`Could not analyze basketball games: ${err.message}`);
    }

    // 4. Select top 5-7 tips
    const selected = this.predictionEngineService.selectDailyTips(
      allCandidates,
      6,
    );
    if (selected.length === 0) {
      this.logger.warn(`No candidate tips met the criteria for ${dateStr}`);
      return [];
    }

    // 5. Save tips to database
    const savedTips: Tip[] = [];
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const tip = this.tipRepository.create({
        fixtureId: item.fixture.id,
        matchDate: item.fixture.matchDate,
        leagueName: item.fixture.leagueName,
        homeTeamName: item.fixture.homeTeamName,
        awayTeamName: item.fixture.awayTeamName,
        market: item.market,
        prediction: item.prediction,
        odds: item.odds,
        confidenceScore: item.confidenceScore,
        isFree: i === 0, // Mark #1 confidence tip as free teaser
        result: TipResult.PENDING,
        factors: item.factors,
      });

      savedTips.push(await this.tipRepository.save(tip));
    }

    this.logger.log(
      `Successfully generated and saved ${savedTips.length} tips for ${dateStr}`,
    );
    return savedTips;
  }

  /**
   * Settle pending tips against final match results (Football & Basketball)
   */
  async settleDailyTips(targetDate?: string): Promise<{ settled: number; won: number; lost: number }> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Settling tips for date: ${dateStr}`);

    // Update finished fixture scores for Football & Basketball
    await Promise.all([
      this.footballDataService.updateFinishedFixtures(dateStr),
      this.basketballDataService.updateFinishedGames(dateStr, this.fixtureRepository),
    ]);

    const pendingTips = await this.tipRepository.find({
      where: {
        result: TipResult.PENDING,
        matchDate: LessThanOrEqual(new Date()),
      },
      relations: ['fixture'],
    });

    let wonCount = 0;
    let lostCount = 0;
    let settledCount = 0;

    for (const tip of pendingTips) {
      const fixture = tip.fixture;
      if (!fixture || fixture.homeGoals === null || fixture.awayGoals === null) {
        continue;
      }

      const hg = fixture.homeGoals;
      const ag = fixture.awayGoals;
      let won = false;

      switch (tip.market) {
        case 'BTTS':
          won = hg > 0 && ag > 0;
          break;
        case 'BTTS_NO':
          won = hg === 0 || ag === 0;
          break;
        case 'OVER_2_5':
          won = hg + ag > 2.5;
          break;
        case 'UNDER_2_5':
          won = hg + ag < 2.5;
          break;
        case 'HOME_WIN':
          won = hg > ag;
          break;
        case 'AWAY_WIN':
          won = ag > hg;
          break;
        case 'DOUBLE_CHANCE':
          if (tip.prediction.includes('1X') || tip.prediction.includes(fixture.homeTeamName)) {
            won = hg >= ag;
          } else {
            won = ag >= hg;
          }
          break;
        case 'OVER_POINTS':
        case 'TOTAL_POINTS': {
          const line = tip.factors?.line || parseFloat(tip.prediction.replace(/[^0-9.]/g, '')) || 158.5;
          if (tip.prediction.toLowerCase().includes('under')) {
            won = hg + ag < line;
          } else {
            won = hg + ag > line;
          }
          break;
        }
        case 'UNDER_POINTS': {
          const line = tip.factors?.line || parseFloat(tip.prediction.replace(/[^0-9.]/g, '')) || 158.5;
          won = hg + ag < line;
          break;
        }
        case 'MONEYLINE':
          if (tip.prediction.includes(fixture.homeTeamName)) {
            won = hg > ag;
          } else {
            won = ag > hg;
          }
          break;
        default:
          won = false;
      }

      tip.result = won ? TipResult.WON : TipResult.LOST;
      tip.resultScore = `${hg}-${ag}`;
      tip.settledAt = new Date();

      if (won) wonCount++;
      else lostCount++;
      settledCount++;

      await this.tipRepository.save(tip);
    }

    this.logger.log(
      `Settlement completed: ${settledCount} settled (${wonCount} won, ${lostCount} lost)`,
    );

    return { settled: settledCount, won: wonCount, lost: lostCount };
  }

  /**
   * Get Active / Today's tips for the Tips page
   * Auto-generates today's tips if none exist yet!
   */
  async getTodayTips(): Promise<Tip[]> {
    const todayStr = new Date().toISOString().split('T')[0];
    const startOfToday = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfToday = new Date(`${todayStr}T23:59:59.999Z`);

    // 1. Settle past finished matches in the background
    this.settleDailyTips().catch((err) =>
      this.logger.warn(`Background settlement error: ${err.message}`),
    );

    // 2. Fetch today's generated tips
    let todayTips = await this.tipRepository.find({
      where: {
        matchDate: Between(startOfToday, endOfToday),
      },
      order: { isFree: 'DESC', confidenceScore: 'DESC' },
      relations: ['fixture'],
    });

    // 3. If no tips exist for today yet, auto-generate them!
    if (todayTips.length === 0) {
      this.logger.log(`No tips found for ${todayStr}. Auto-generating today's daily tips...`);
      todayTips = await this.generateDailyTips(todayStr);
    }

    if (todayTips.length > 0) {
      return todayTips;
    }

    // 4. Fallback to any pending tips
    return this.tipRepository.find({
      where: { result: TipResult.PENDING },
      order: { matchDate: 'ASC', isFree: 'DESC' },
      relations: ['fixture'],
    });
  }

  /**
   * Get Tips History (for Statistics table on frontend)
   */
  async getHistory(page = 1, limit = 20): Promise<{ tips: Tip[]; total: number }> {
    const [tips, total] = await this.tipRepository.findAndCount({
      where: [
        { result: TipResult.WON },
        { result: TipResult.LOST },
      ],
      order: { matchDate: 'DESC', settledAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
      relations: ['fixture'],
    });

    return { tips, total };
  }

  async getTipsHistory(limit = 50, page = 1): Promise<{ tips: Tip[]; total: number }> {
    return this.getHistory(page, limit);
  }

  /**
   * Get Aggregated Analytics & ROI Performance Stats
   */
  async getStats(): Promise<{
    totalTips: number;
    wonTips: number;
    lostTips: number;
    pendingTips: number;
    winRate: number;
    totalProfitUnits: number;
    roiPercentage: number;
  }> {
    const allTips = await this.tipRepository.find();

    const wonTips = allTips.filter((t) => t.result === TipResult.WON).length;
    const lostTips = allTips.filter((t) => t.result === TipResult.LOST).length;
    const pendingTips = allTips.filter((t) => t.result === TipResult.PENDING).length;
    const settledTips = wonTips + lostTips;

    const winRate =
      settledTips > 0 ? Number(((wonTips / settledTips) * 100).toFixed(1)) : 0;

    let totalProfitUnits = 0;
    for (const tip of allTips) {
      if (tip.result === TipResult.WON) {
        totalProfitUnits += tip.odds - 1;
      } else if (tip.result === TipResult.LOST) {
        totalProfitUnits -= 1;
      }
    }

    const roiPercentage =
      settledTips > 0
        ? Number(((totalProfitUnits / settledTips) * 100).toFixed(1))
        : 0;

    return {
      totalTips: allTips.length,
      wonTips,
      lostTips,
      pendingTips,
      winRate,
      totalProfitUnits: Number(totalProfitUnits.toFixed(2)),
      roiPercentage,
    };
  }

  async getAnalyticsStats() {
    return this.getStats();
  }
}
