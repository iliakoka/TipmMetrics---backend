import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { Tip, TipResult } from './tip.entity';
import { Fixture } from '../fixtures/fixture.entity';
import { FootballDataService } from '../football-data/football-data.service';
import { PredictionEngineService, CandidateTip } from '../analytics/prediction-engine.service';

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
  ) {}

  /**
   * Generates top 5 - 7 tips for a given date (defaults to today)
   */
  async generateDailyTips(targetDate?: string): Promise<Tip[]> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Starting automated tip generation for: ${dateStr}`);

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
      this.logger.log(
        `Already generated ${existingTips.length} tips for ${dateStr}`,
      );
      return existingTips;
    }

    // 2. Fetch fixtures for today
    const fixtures =
      await this.footballDataService.syncFixturesForDate(dateStr);
    if (!fixtures || fixtures.length === 0) {
      this.logger.warn(`No fixtures found for ${dateStr}`);
      return [];
    }

    // 3. Filter for upcoming matches (Not Started) or scheduled later today
    const upcomingFixtures = fixtures.filter(
      (f) => f.status === 'NS' || new Date(f.matchDate) >= new Date(),
    );
    const targetFixtures =
      upcomingFixtures.length >= 5 ? upcomingFixtures : fixtures;

    const allCandidates: CandidateTip[] = [];
    const sampleFixtures = targetFixtures.slice(0, 15);

    for (const fixture of sampleFixtures) {
      try {
        const [homeRecent, awayRecent, h2h, odds] = await Promise.all([
          this.footballDataService.getTeamRecentMatches(fixture.homeTeamId, 6),
          this.footballDataService.getTeamRecentMatches(fixture.awayTeamId, 6),
          this.footballDataService.getH2H(
            fixture.homeTeamId,
            fixture.awayTeamId,
          ),
          this.footballDataService.getOddsForFixture(fixture.apiFixtureId),
        ]);

        const candidates = this.predictionEngineService.analyzeFixture(
          fixture,
          homeRecent,
          awayRecent,
          h2h,
          odds,
        );

        allCandidates.push(...candidates);
      } catch (err) {
        this.logger.error(
          `Error analyzing fixture ${fixture.homeTeamName} vs ${fixture.awayTeamName}: ${err.message}`,
        );
      }
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
   * Settle pending tips against final match results
   */
  async settleDailyTips(targetDate?: string): Promise<{ settled: number; won: number; lost: number }> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Settling tips for date: ${dateStr}`);

    // Update finished fixture scores
    await this.footballDataService.updateFinishedFixtures(dateStr);

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
        case 'OVER_2_5':
          won = hg + ag > 2.5;
          break;
        case 'HOME_WIN':
          won = hg > ag;
          break;
        case 'DOUBLE_CHANCE':
          won = hg >= ag;
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
   * Get Today's tips for public or authenticated user
   */
  async getTodayTips(): Promise<Tip[]> {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${today}T00:00:00.000Z`);
    const endOfDay = new Date(`${today}T23:59:59.999Z`);

    let tips = await this.tipRepository.find({
      where: { matchDate: Between(startOfDay, endOfDay) },
      order: { isFree: 'DESC', confidenceScore: 'DESC' },
    });

    if (tips.length === 0) {
      // Auto-trigger generation if none exists
      tips = await this.generateDailyTips(today);
    }

    return tips;
  }

  /**
   * Get tip history with pagination
   */
  async getHistory(page = 1, limit = 20): Promise<{ data: Tip[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.tipRepository.findAndCount({
      where: [
        { result: TipResult.WON },
        { result: TipResult.LOST },
        { result: TipResult.VOID },
      ],
      order: { matchDate: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Compute comprehensive aggregate statistics & performance ROI
   */
  async getStats(): Promise<Record<string, any>> {
    const settledTips = await this.tipRepository.find({
      where: [{ result: TipResult.WON }, { result: TipResult.LOST }],
    });

    const total = settledTips.length;
    if (total === 0) {
      return {
        totalTips: 0,
        wonTips: 0,
        lostTips: 0,
        winRate: '0.00%',
        averageOdds: '0.00',
        profitUnits: '0.00',
        roi: '0.00%',
        marketStats: {},
      };
    }

    const wonTips = settledTips.filter((t) => t.result === TipResult.WON);
    const lostTips = settledTips.filter((t) => t.result === TipResult.LOST);

    const winRate = ((wonTips.length / total) * 100).toFixed(2) + '%';

    const totalOdds = settledTips.reduce((sum, t) => sum + Number(t.odds), 0);
    const averageOdds = (totalOdds / total).toFixed(2);

    // Assuming flat 1 unit stake per tip
    const totalReturn = wonTips.reduce((sum, t) => sum + Number(t.odds), 0);
    const profitUnits = (totalReturn - total).toFixed(2);
    const roi = (((totalReturn - total) / total) * 100).toFixed(2) + '%';

    // Market Breakdown
    const marketStats: Record<string, { total: number; won: number; winRate: string }> = {};
    for (const t of settledTips) {
      if (!marketStats[t.market]) {
        marketStats[t.market] = { total: 0, won: 0, winRate: '0%' };
      }
      marketStats[t.market].total++;
      if (t.result === TipResult.WON) marketStats[t.market].won++;
    }

    for (const m in marketStats) {
      const st = marketStats[m];
      st.winRate = ((st.won / st.total) * 100).toFixed(1) + '%';
    }

    return {
      totalTips: total,
      wonTips: wonTips.length,
      lostTips: lostTips.length,
      winRate,
      averageOdds,
      profitUnits,
      roi,
      marketStats,
    };
  }
}
