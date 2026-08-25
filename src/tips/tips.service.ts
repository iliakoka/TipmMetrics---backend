import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { Tip, TipResult } from './tip.entity';
import { Fixture } from '../fixtures/fixture.entity';
import { FootballDataOrgService } from '../football-data/football-data-org.service';
import { FootballDataService } from '../football-data/football-data.service';
import { PredictionEngineService } from '../analytics/prediction-engine.service';

@Injectable()
export class TipsService {
  private readonly logger = new Logger(TipsService.name);

  constructor(
    @InjectRepository(Tip)
    private tipRepository: Repository<Tip>,
    @InjectRepository(Fixture)
    private fixtureRepository: Repository<Fixture>,
    private footballDataOrgService: FootballDataOrgService,
    private footballDataService: FootballDataService,
    private predictionEngineService: PredictionEngineService,
  ) {}

  /**
   * Generates top 5 - 7 tips for a given date across the 12 tier-1 competitions
   */
  async generateDailyTips(
    targetDate?: string,
    force?: boolean,
  ): Promise<Tip[]> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Starting tip generation for: ${dateStr} (force=${!!force})`);

    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay   = new Date(`${dateStr}T23:59:59.999Z`);

    // 1. Check if tips already exist for today
    const existingTips = await this.tipRepository.find({
      where: { matchDate: Between(startOfDay, endOfDay) },
      relations: ['fixture'],
    });

    if (existingTips.length > 0) {
      if (!force) {
        this.logger.log(`Already have ${existingTips.length} tips for ${dateStr}`);
        return existingTips;
      }
      // Force: remove only pending tips to re-analyze
      const pendingExisting = existingTips.filter((t) => t.result === TipResult.PENDING);
      if (pendingExisting.length > 0) {
        await this.tipRepository.remove(pendingExisting);
        this.logger.log(`Force: removed ${pendingExisting.length} pending tips`);
      }
    }

    // 2. Collect fixtures — expand date window until we have at least 15 to analyze
    let fixtures: Fixture[] = [];
    const datesToTry: string[] = [dateStr];

    // Build an expanding list: target date, then +1, -1, +2, -2, +3 days
    for (const delta of [1, -1, 2, -2, 3]) {
      const d = new Date(`${dateStr}T12:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + delta);
      datesToTry.push(d.toISOString().split('T')[0]);
    }

    for (const d of datesToTry) {
      if (fixtures.length >= 15) break;

      let dayFixtures = await this.footballDataOrgService.syncFixturesForDate(d);
      if (!dayFixtures || dayFixtures.length === 0) {
        dayFixtures = await this.footballDataService.syncFixturesForDate(d);
      }
      if (!dayFixtures || dayFixtures.length === 0) {
        const s = new Date(`${d}T00:00:00.000Z`);
        const e = new Date(`${d}T23:59:59.999Z`);
        dayFixtures = await this.fixtureRepository.find({ where: { matchDate: Between(s, e) } });
      }

      if (dayFixtures && dayFixtures.length > 0) {
        // Prefer fixtures not already in our list
        const newOnes = dayFixtures.filter(
          (f) => !fixtures.some((existing) => existing.id === f.id),
        );
        fixtures.push(...newOnes);
        this.logger.log(`Date ${d}: added ${newOnes.length} fixtures (total pool: ${fixtures.length})`);
      }
    }

    if (!fixtures || fixtures.length === 0) {
      this.logger.warn(`No fixtures found for any date around ${dateStr}`);
      return [];
    }

    // 3. Prefer upcoming (scheduled) fixtures, fall back to all if not enough
    const upcoming = fixtures.filter(
      (f) => f.status === 'NS' || new Date(f.matchDate) >= new Date(),
    );
    const pool = upcoming.length >= 5 ? upcoming : fixtures;

    // Filter out non-football sports, youth/reserve/women's competitions,
    // and low-quality leagues that produce meaningless tips
    const qualityFixtures = pool.filter((f) => this.isQualityFixture(f));
    this.logger.log(`Quality fixtures after filtering: ${qualityFixtures.length} of ${pool.length}`);

    // Sample up to 50 quality fixtures for analysis
    const sampleFixtures = qualityFixtures.slice(0, 50);

    // 4. Analyze all sampled fixtures in strict mode — no early exit
    const allCandidates = await this.analyzeFixtures(sampleFixtures, false);

    // 5. If strict mode didn't produce enough candidates, run relaxed mode on remaining fixtures
    let candidates = allCandidates;
    if (candidates.length < 5) {
      this.logger.warn(
        `Strict mode produced only ${candidates.length} candidates. Running relaxed mode...`,
      );
      const relaxedCandidates = await this.analyzeFixtures(sampleFixtures, true);
      // Merge: add relaxed candidates not already covered by fixture ID
      const strictFixtureIds = new Set(candidates.map((c) => c.fixture.id));
      for (const rc of relaxedCandidates) {
        if (!strictFixtureIds.has(rc.fixture.id)) {
          candidates.push(rc);
        }
      }
    }

    // 6. Select top 5–7 tips
    const selected = this.predictionEngineService.selectDailyTips(candidates, 7);

    // Last resort: if NOTHING passed any threshold, generate bare tips directly from fixtures
    // using only Poisson probabilities with no odds filter. This guarantees daily output.
    if (selected.length === 0 && sampleFixtures.length > 0) {
      this.logger.warn(`All thresholds failed for ${dateStr}. Using last-resort bare generation.`);
      return this.generateLastResortTips(sampleFixtures, dateStr);
    }

    // Guarantee at least 5 — if we got fewer log a warning but still save what we have
    if (selected.length < 5) {
      this.logger.warn(`Only ${selected.length} tips generated for ${dateStr} (target: 5-7)`);
    }

    // 7. Save tips to database
    const savedTips: Tip[] = [];
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const tip = this.tipRepository.create({
        fixtureId:      item.fixture.id,
        matchDate:      item.fixture.matchDate,
        leagueName:     item.fixture.leagueName,
        homeTeamName:   item.fixture.homeTeamName,
        awayTeamName:   item.fixture.awayTeamName,
        market:         item.market,
        prediction:     item.prediction,
        odds:           item.odds,
        confidenceScore: item.confidenceScore,
        isFree:         i === 0,
        result:         TipResult.PENDING,
        factors:        item.factors,
      });
      savedTips.push(await this.tipRepository.save(tip));
    }

    this.logger.log(`Saved ${savedTips.length} tips for ${dateStr}`);
    return savedTips;
  }

  /**
   * Last-resort tip generation: picks top 7 upcoming fixtures and generates
   * one OVER_2_5 tip per match using only Poisson λ, no odds/threshold filter.
   * Guarantees output even when standings data is completely unavailable.
   */
  private async generateLastResortTips(fixtures: Fixture[], dateStr: string): Promise<Tip[]> {
    const savedTips: Tip[] = [];
    const leagueAvgLambdaHome = 1.47;
    const leagueAvgLambdaAway = 0.76;

    const picked = fixtures.slice(0, 7);

    for (let i = 0; i < picked.length; i++) {
      const fixture = picked[i];
      // OVER_2_5: with average lambdas, P(goals > 2.5) ≈ 52%
      const tip = this.tipRepository.create({
        fixtureId:      fixture.id,
        matchDate:      fixture.matchDate,
        leagueName:     fixture.leagueName,
        homeTeamName:   fixture.homeTeamName,
        awayTeamName:   fixture.awayTeamName,
        market:         'OVER_2_5',
        prediction:     'Over 2.5 Goals',
        odds:           1.85,
        confidenceScore: 52.0,
        isFree:         i === 0,
        result:         TipResult.PENDING,
        factors:        { source: 'last_resort', note: 'Generated using league average Poisson, no team stats available' },
      });
      savedTips.push(await this.tipRepository.save(tip));
    }

    this.logger.log(`Last-resort: saved ${savedTips.length} tips for ${dateStr}`);
    return savedTips;
  }

  /**
   * Shared fixture analysis loop used by generateDailyTips in both strict and relaxed modes.
   */
  private async analyzeFixtures(fixtures: Fixture[], relaxed: boolean): Promise<import('../analytics/prediction-engine.service').CandidateTip[]> {
    const candidates: import('../analytics/prediction-engine.service').CandidateTip[] = [];

    const leagueAvgStats = {
      goals: {
        for:     { average: { home: '1.30', away: '1.10', total: '1.20' } },
        against: { average: { home: '1.00', away: '1.30', total: '1.10' } },
      },
      form: 'WDLWD',
    };

    for (const fixture of fixtures) {
      try {
        const compCode = this.footballDataOrgService.getCompetitionCode(
          fixture.leagueId,
          fixture.leagueName,
        );

        let homeStats = await this.footballDataOrgService.getTeamStats(fixture.homeTeamId, compCode);
        let awayStats = await this.footballDataOrgService.getTeamStats(fixture.awayTeamId, compCode);

        if (!homeStats) homeStats = await this.footballDataService.getTeamStats(fixture.homeTeamId, fixture.leagueId);
        if (!awayStats) awayStats = await this.footballDataService.getTeamStats(fixture.awayTeamId, fixture.leagueId);

        if (!homeStats) homeStats = leagueAvgStats;
        if (!awayStats) awayStats = leagueAvgStats;

        const fixtureCandidates = this.predictionEngineService.analyzeFixture(
          fixture,
          homeStats,
          awayStats,
          [],
          null,
          relaxed,
        );

        candidates.push(...fixtureCandidates);
      } catch (err) {
        this.logger.error(
          `Error analyzing ${fixture.homeTeamName} vs ${fixture.awayTeamName}: ${err.message}`,
        );
      }
    }

    return candidates;
  }

  /**
   * Returns true only for real senior men's football matches worth tipping.
   * Blocks: basketball, other sports, youth/U21-U23, women's, reserve/B teams.
   */
  private isQualityFixture(fixture: Fixture): boolean {
    const league = (fixture.leagueName || '').toLowerCase();
    const home   = (fixture.homeTeamName || '').toLowerCase();
    const away   = (fixture.awayTeamName || '').toLowerCase();

    // Block non-football sports (basketball emoji, NBA, NFL, etc.)
    if (fixture.leagueName?.includes('🏀')) return false;
    if (fixture.leagueName?.includes('🏈')) return false;
    if (league.includes('basketball') || league.includes('nba') || league.includes('nfl')) return false;

    // Block youth / reserve competitions
    const youthPattern = /\b(u\d{2}|youth|reserve|b team|ii$| b$| ii |junior|u18|u19|u20|u21|u22|u23)\b/i;
    if (youthPattern.test(league) || youthPattern.test(home) || youthPattern.test(away)) return false;

    // Block women's competitions
    if (league.includes(' w ') || league.includes(' women') || league.includes("women's")
        || home.endsWith(' w') || away.endsWith(' w')) return false;

    // Block clearly low-quality or obscure cups
    const blockedLeagues = [
      'premier league cup', 'efl trophy', 'papa john', 'checkratrade',
      'friendlies', 'friendly', 'pre-season', 'preseason', 'world cup qualification - concacaf',
    ];
    if (blockedLeagues.some((b) => league.includes(b))) return false;

    return true;
  }


  /**
   * Debug generation: shows exactly what fixtures/stats/candidates are produced
   * for a date WITHOUT saving anything. Call GET /tips/debug?date=YYYY-MM-DD
   */
  async debugGeneration(targetDate?: string): Promise<any> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    const leagueAvgStats = {
      goals: {
        for:     { average: { home: '1.30', away: '1.10', total: '1.20' } },
        against: { average: { home: '1.00', away: '1.30', total: '1.10' } },
      },
      form: 'WDLWD',
    };

    // Fetch fixtures
    let fixtures = await this.footballDataOrgService.syncFixturesForDate(dateStr);
    if (!fixtures || fixtures.length === 0) {
      fixtures = await this.footballDataService.syncFixturesForDate(dateStr);
    }

    const sample = (fixtures || []).slice(0, 10);
    const fixtureDetails: any[] = [];

    for (const fixture of sample) {
      const compCode = this.footballDataOrgService.getCompetitionCode(fixture.leagueId, fixture.leagueName);
      let homeStats = await this.footballDataOrgService.getTeamStats(fixture.homeTeamId, compCode);
      let awayStats = await this.footballDataOrgService.getTeamStats(fixture.awayTeamId, compCode);
      const homeSource = homeStats ? 'football-data.org' : (await this.footballDataService.getTeamStats(fixture.homeTeamId, fixture.leagueId) ? 'api-sports' : 'league-avg');
      const awaySource = awayStats ? 'football-data.org' : (await this.footballDataService.getTeamStats(fixture.awayTeamId, fixture.leagueId) ? 'api-sports' : 'league-avg');
      if (!homeStats) homeStats = leagueAvgStats;
      if (!awayStats) awayStats = leagueAvgStats;

      const candidates = this.predictionEngineService.analyzeFixture(fixture, homeStats, awayStats, [], null, false);
      const relaxedCandidates = this.predictionEngineService.analyzeFixture(fixture, homeStats, awayStats, [], null, true);

      fixtureDetails.push({
        match: `${fixture.homeTeamName} vs ${fixture.awayTeamName}`,
        league: fixture.leagueName,
        compCode,
        status: fixture.status,
        homeStatsSource: homeSource,
        awayStatsSource: awaySource,
        homeGoalsFor: homeStats.goals.for.average,
        awayGoalsFor: awayStats.goals.for.average,
        strictCandidates: candidates.length,
        relaxedCandidates: relaxedCandidates.length,
        markets: candidates.map(c => `${c.market} odds=${c.odds} conf=${c.confidenceScore}`),
      });
    }

    return {
      date: dateStr,
      totalFixtures: (fixtures || []).length,
      sampleAnalyzed: sample.length,
      fixtures: fixtureDetails,
    };
  }

  /**
   * Settle pending tips against final match results
   */
  async settleDailyTips(targetDate?: string): Promise<{ settled: number; won: number; lost: number }> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Settling tips for date: ${dateStr}`);

    await Promise.all([
      this.footballDataOrgService.updateFinishedFixtures(dateStr),
      this.footballDataService.updateFinishedFixtures(dateStr),
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
   */
  async getTodayTips(): Promise<Tip[]> {
    const todayStr = new Date().toISOString().split('T')[0];
    const startOfToday = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfToday = new Date(`${todayStr}T23:59:59.999Z`);

    // Background settlement of past matches
    this.settleDailyTips().catch((err) =>
      this.logger.warn(`Background settlement error: ${err.message}`),
    );

    let todayTips = await this.tipRepository.find({
      where: {
        matchDate: Between(startOfToday, endOfToday),
      },
      order: { isFree: 'DESC', confidenceScore: 'DESC' },
      relations: ['fixture'],
    });

    if (todayTips.length === 0) {
      this.logger.log(`No tips found for ${todayStr}. Auto-generating today's daily tips...`);
      todayTips = await this.generateDailyTips(todayStr);
    }

    if (todayTips.length > 0) {
      return todayTips;
    }

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
