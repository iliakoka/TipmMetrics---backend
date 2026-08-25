import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { Tip, TipResult } from './tip.entity';
import { Fixture } from '../fixtures/fixture.entity';
import { FootballDataOrgService } from '../football-data/football-data-org.service';
import { FootballDataService } from '../football-data/football-data.service';
import { PredictionEngineService } from '../analytics/prediction-engine.service';
import { OddsApiService } from '../odds/odds-api.service';
import { MatchAnalyzerService } from '../match-analysis/match-analyzer.service';

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
    private oddsApiService: OddsApiService,
    private matchAnalyzerService: MatchAnalyzerService,
  ) {}

  /**
   * Generates 5–7 smart daily tips.
   *
   * PRIMARY PATH (smart):
   *   1. MatchAnalyzerService: full analysis (form, H2H, standings, weather) via API-Football
   *   2. Cross-reference with The Odds API: pick prediction where odds are in 1.65–2.20
   *   3. Select top 5–7 by analysis score
   *
   * FALLBACK PATH (odds-only):
   *   If analyzer returns nothing → use bookmaker consensus odds directly
   */
  async generateDailyTips(
    targetDate?: string,
    force?: boolean,
  ): Promise<Tip[]> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Starting tip generation for: ${dateStr} (force=${!!force})`);

    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay   = new Date(`${dateStr}T23:59:59.999Z`);

    // 1. Check existing tips
    const existingTips = await this.tipRepository.find({
      where: { matchDate: Between(startOfDay, endOfDay) },
      relations: ['fixture'],
    });
    if (existingTips.length > 0) {
      if (!force) {
        this.logger.log(`Already have ${existingTips.length} tips for ${dateStr}`);
        return existingTips;
      }
      const pending = existingTips.filter((t) => t.result === TipResult.PENDING);
      if (pending.length > 0) {
        await this.tipRepository.remove(pending);
        this.logger.log(`Force: removed ${pending.length} pending tips`);
      }
    }

    // 2. PRIMARY — Smart match analysis + odds cross-reference
    try {
      const analyses = await this.matchAnalyzerService.analyzeMatchesForDate(dateStr);
      if (analyses.length > 0) {
        const tips = await this.selectAndSaveSmartTips(analyses, dateStr);
        if (tips.length >= 3) return tips;
        this.logger.warn(`Smart path produced only ${tips.length} tips — trying fallback`);
      }
    } catch (err) {
      this.logger.error(`Smart analysis failed: ${err.message}`);
    }

    // 3. FALLBACK — Pure bookmaker consensus (Odds API only)
    this.logger.warn(`Falling back to Odds API consensus for ${dateStr}`);
    try {
      const oddsCandidates = await this.oddsApiService.getCandidatesForDate(dateStr);
      if (oddsCandidates.length >= 3) {
        return this.saveOddsCandidates(oddsCandidates, dateStr);
      }
    } catch (err) {
      this.logger.error(`Odds API fallback failed: ${err.message}`);
    }

    this.logger.warn(`No tips generated for ${dateStr}`);
    return [];
  }

  /**
   * Cross-reference match analyses with Odds API 1.65–2.20 range,
   * pick the prediction our model made IF bookmaker agrees and odds fit.
   */
  private async selectAndSaveSmartTips(
    analyses: import('../match-analysis/match-analyzer.service').MatchAnalysis[],
    dateStr: string,
  ): Promise<Tip[]> {
    const ODD_MIN = 1.65;
    const ODD_MAX = 2.20;

    interface SmartCandidate {
      analysis: import('../match-analysis/match-analyzer.service').MatchAnalysis;
      market: string;
      prediction: string;
      odds: number;
      confidence: number;
    }

    const candidates: SmartCandidate[] = [];

    for (const analysis of analyses) {
      const market = analysis.predictedMarket;
      const bookOdds = analysis.bookmakerOdds[market];

      // Check if bookmaker has odds in target range for our prediction
      if (bookOdds && bookOdds >= ODD_MIN && bookOdds <= ODD_MAX) {
        candidates.push({
          analysis,
          market,
          prediction: this.marketToLabel(market, analysis.homeTeam, analysis.awayTeam),
          odds: bookOdds,
          confidence: Math.min(95, analysis.totalScore + analysis.predictedProbability * 0.3),
        });
      }
    }

    if (candidates.length === 0) {
      this.logger.warn('No matches where our prediction aligns with 1.65-2.20 odds');
      return [];
    }

    // Sort by confidence, max 2 per market
    candidates.sort((a, b) => b.confidence - a.confidence);
    const selected: SmartCandidate[] = [];
    const marketCounts: Record<string, number> = {};

    for (const c of candidates) {
      const mc = marketCounts[c.market] ?? 0;
      if (mc >= 2) continue;
      selected.push(c);
      marketCounts[c.market] = mc + 1;
      if (selected.length >= 7) break;
    }

    if (selected.length < 5) {
      this.logger.warn(`Only ${selected.length} smart tips aligned with 1.65-2.20 odds`);
    }

    const savedTips: Tip[] = [];
    for (let i = 0; i < selected.length; i++) {
      const { analysis, market, prediction, odds, confidence } = selected[i];
      const tip = this.tipRepository.create({
        fixtureId:       null,
        matchDate:       analysis.kickoffTime,
        leagueName:      analysis.leagueName,
        homeTeamName:    analysis.homeTeam,
        awayTeamName:    analysis.awayTeam,
        homeTeamLogo:    analysis.homeTeamLogo ?? null,
        awayTeamLogo:    analysis.awayTeamLogo ?? null,
        market,
        prediction,
        odds,
        confidenceScore: Math.round(confidence * 10) / 10,
        isFree:          i === 0,
        result:          TipResult.PENDING,
        factors: {
          source:              'smart-analysis',
          formHome:            analysis.homeFormString,
          formAway:            analysis.awayFormString,
          h2h:                 `${analysis.h2hHomeWins}W-${analysis.h2hDraws}D-${analysis.h2hAwayWins}L`,
          expectedGoals:       analysis.expectedTotalGoals,
          positionHome:        analysis.homePosition,
          positionAway:        analysis.awayPosition,
          motivationHome:      analysis.homeMotivation,
          motivationAway:      analysis.awayMotivation,
          weather:             analysis.weatherDescription,
          predictedProbability: analysis.predictedProbability,
          reasoning:           analysis.reasoning,
        },
      });
      savedTips.push(await this.tipRepository.save(tip));
    }

    this.logger.log(`Saved ${savedTips.length} smart tips for ${dateStr}`);
    return savedTips;
  }

  private marketToLabel(market: string, home: string, away: string): string {
    switch (market) {
      case 'HOME_WIN':  return `${home} To Win`;
      case 'AWAY_WIN':  return `${away} To Win`;
      case 'DRAW':      return 'Draw';
      case 'OVER_2_5':  return 'Over 2.5 Goals';
      case 'UNDER_2_5': return 'Under 2.5 Goals';
      case 'BTTS_YES':  return 'Both Teams To Score';
      case 'BTTS_NO':   return 'Both Teams Not To Score';
      default: return market;
    }
  }

  /**
   * Save Odds API candidates as tips (fallback path — no form/H2H analysis).
   */
  private async saveOddsCandidates(
    candidates: import('../odds/odds-api.service').OddsCandidate[],
    dateStr: string,
  ): Promise<Tip[]> {
    const ODD_MIN = 1.65;
    const ODD_MAX = 2.20;

    // Filter to target odds range
    const inRange = candidates.filter(
      (c) => c.consensusOdds >= ODD_MIN && c.consensusOdds <= ODD_MAX,
    );

    inRange.sort((a, b) => b.confidenceScore - a.confidenceScore);

    const selected: typeof inRange = [];
    const marketCounts: Record<string, number> = {};
    const usedMatches = new Set<string>();

    for (const c of inRange) {
      const matchKey = `${c.homeTeam}|${c.awayTeam}`;
      if (usedMatches.has(matchKey)) continue;
      const mc = marketCounts[c.market] ?? 0;
      if (mc >= 2) continue;

      selected.push(c);
      usedMatches.add(matchKey);
      marketCounts[c.market] = mc + 1;
      if (selected.length >= 7) break;
    }

    if (selected.length < 5) {
      this.logger.warn(`Odds fallback: only ${selected.length} tips in 1.65-2.20 range for ${dateStr}`);
    }

    const savedTips: Tip[] = [];
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i];
      const tip = this.tipRepository.create({
        fixtureId:       null,
        matchDate:       c.commenceTime,
        leagueName:      c.leagueName,
        homeTeamName:    c.homeTeam,
        awayTeamName:    c.awayTeam,
        homeTeamLogo:    null,
        awayTeamLogo:    null,
        market:          c.market,
        prediction:      c.prediction,
        odds:            c.consensusOdds,
        confidenceScore: c.confidenceScore,
        isFree:          i === 0,
        result:          TipResult.PENDING,
        factors: {
          source:             'odds-api-fallback',
          impliedProbability: c.impliedProbability,
          bookmakerCount:     c.bookmakerCount,
        },
      });
      const saved = await this.tipRepository.save(tip);
      savedTips.push(saved);
    }

    this.logger.log(`Saved ${savedTips.length} Odds API fallback tips for ${dateStr}`);
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
        homeTeamLogo:   fixture.homeTeamLogo ?? null,
        awayTeamLogo:   fixture.awayTeamLogo ?? null,
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
   * Settle pending tips against final match results.
   * Handles both fixture-linked tips and fixture-less tips (from Odds API / smart analyzer).
   */
  async settleDailyTips(targetDate?: string): Promise<{ settled: number; won: number; lost: number }> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Settling tips for date: ${dateStr}`);

    // Update fixture scores in DB (for fixture-linked tips)
    await Promise.all([
      this.footballDataOrgService.updateFinishedFixtures(dateStr),
      this.footballDataService.updateFinishedFixtures(dateStr),
    ]);

    // Fetch finished matches from API-Football for fixture-less tip resolution
    const finishedRaw = await this.footballDataService.getFixturesForDate(dateStr)
      .then((all) => all.filter((f) => f.fixture?.status?.short === 'FT'))
      .catch(() => []);

    // Build a lookup: "HomeTeam|AwayTeam" -> { homeGoals, awayGoals }
    const resultMap = new Map<string, { hg: number; ag: number }>();
    for (const f of finishedRaw) {
      const key = `${f.teams?.home?.name}|${f.teams?.away?.name}`;
      resultMap.set(key, {
        hg: f.goals?.home ?? 0,
        ag: f.goals?.away ?? 0,
      });
    }

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
      let hg: number | null = null;
      let ag: number | null = null;

      // Priority 1: DB-linked fixture (old Poisson tips)
      if (tip.fixture && tip.fixture.homeGoals !== null && tip.fixture.awayGoals !== null) {
        hg = tip.fixture.homeGoals;
        ag = tip.fixture.awayGoals;
      } else {
        // Priority 2: API-Football finished match lookup by team name
        const lookupKey = `${tip.homeTeamName}|${tip.awayTeamName}`;
        const found = resultMap.get(lookupKey);
        if (found) {
          hg = found.hg;
          ag = found.ag;
        }
      }

      // Skip if no result available yet (match not finished)
      if (hg === null || ag === null) continue;

      let won = false;
      switch (tip.market) {
        case 'BTTS':
        case 'BTTS_YES':
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
        case 'DRAW':
          won = hg === ag;
          break;
        case 'DOUBLE_CHANCE':
          won = tip.prediction.includes(tip.homeTeamName) ? hg >= ag : ag >= hg;
          break;
        default:
          won = false;
      }

      tip.result    = won ? TipResult.WON : TipResult.LOST;
      tip.resultScore = `${hg}-${ag}`;
      tip.settledAt   = new Date();

      if (won) wonCount++;
      else lostCount++;
      settledCount++;

      await this.tipRepository.save(tip);
    }

    this.logger.log(
      `Settlement: ${settledCount} settled (${wonCount} WON, ${lostCount} LOST) for ${dateStr}`,
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

    return todayTips || [];
  }

  /**
   * Get Tips History (for Statistics table on frontend)
   */
  async getHistory(page = 1, limit = 20): Promise<{ tips: Tip[]; total: number }> {
    const [tips, total] = await this.tipRepository.findAndCount({
      where: [
        { result: TipResult.WON },
        { result: TipResult.LOST },
        { result: TipResult.VOID },
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
    voidTips: number;
    pendingTips: number;
    winRate: number;
    averageOdds: number;
    record: string;
    totalProfitUnits: number;
    roiPercentage: number;
  }> {
    const allTips = await this.tipRepository.find();

    const wonTips = allTips.filter((t) => t.result === TipResult.WON).length;
    const lostTips = allTips.filter((t) => t.result === TipResult.LOST).length;
    const voidTips = allTips.filter((t) => t.result === TipResult.VOID).length;
    const pendingTips = allTips.filter((t) => t.result === TipResult.PENDING).length;
    const settledTips = wonTips + lostTips;

    const winRate =
      settledTips > 0 ? Number(((wonTips / settledTips) * 100).toFixed(1)) : 0;

    let totalOdds = 0;
    let oddsCount = 0;
    let totalProfitUnits = 0;

    for (const tip of allTips) {
      if (tip.odds) {
        totalOdds += Number(tip.odds);
        oddsCount++;
      }
      if (tip.result === TipResult.WON) {
        totalProfitUnits += Number(tip.odds) - 1;
      } else if (tip.result === TipResult.LOST) {
        totalProfitUnits -= 1;
      }
    }

    const averageOdds =
      oddsCount > 0 ? Number((totalOdds / oddsCount).toFixed(2)) : 0;

    const roiPercentage =
      settledTips > 0
        ? Number(((totalProfitUnits / settledTips) * 100).toFixed(1))
        : 0;

    return {
      totalTips: allTips.length,
      wonTips,
      lostTips,
      voidTips,
      pendingTips,
      winRate,
      averageOdds,
      record: `${wonTips}W - ${lostTips}L`,
      totalProfitUnits: Number(totalProfitUnits.toFixed(2)),
      roiPercentage,
    };
  }

  async getAnalyticsStats() {
    return this.getStats();
  }
}
