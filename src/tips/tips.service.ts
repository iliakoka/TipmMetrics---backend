import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Tip, TipResult } from './tip.entity';
import { FootballDataService } from '../football-data/football-data.service';
import { MatchAnalyzerService } from '../match-analysis/match-analyzer.service';

@Injectable()
export class TipsService {
  private readonly logger = new Logger(TipsService.name);

  constructor(
    @InjectRepository(Tip)
    private tipRepository: Repository<Tip>,
    private footballDataService: FootballDataService,
    private matchAnalyzerService: MatchAnalyzerService,
  ) {}

  /**
   * Generates 5–7 smart daily tips.
   *
   * FLOW:
   *   1. MatchAnalyzerService: full analysis (form, H2H, standings, weather) via API-Football
   *   2. Cross-reference with The Odds API: pick predictions where bookmaker odds are 1.65–2.20
   *   3. Select top 5–7 by confidence score
   *
   * If analysis produces fewer than 5 tips (API limit, no fixtures, etc.) → return what we have.
   * No fallback generation — all tips must originate from API-Football data so settlement works.
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

    // 2. Smart match analysis + Odds API cross-reference (only path)
    try {
      const analyses = await this.matchAnalyzerService.analyzeMatchesForDate(dateStr);
      if (analyses.length > 0) {
        const tips = await this.selectAndSaveSmartTips(analyses, dateStr);
        if (tips.length > 0) return tips;
      }
      this.logger.warn(`Smart analysis produced 0 tips for ${dateStr} — no fixtures in target leagues or no odds in 1.65-2.20 range`);
    } catch (err) {
      this.logger.error(`Smart analysis failed: ${err.message}`);
    }

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
   * Debug generation: shows what the analyzer produces for a date WITHOUT saving.
   * Call GET /tips/debug?date=YYYY-MM-DD
   */
  async debugGeneration(targetDate?: string): Promise<any> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    const analyses = await this.matchAnalyzerService.analyzeMatchesForDate(dateStr);
    return {
      date: dateStr,
      matchesAnalyzed: analyses.length,
      analyses: analyses.map((a) => ({
        match: `${a.homeTeam} vs ${a.awayTeam}`,
        league: a.leagueName,
        predictedMarket: a.predictedMarket,
        predictedProbability: a.predictedProbability,
        totalScore: a.totalScore,
        bookmakerOdds: a.bookmakerOdds,
        reasoning: a.reasoning,
      })),
    };
  }

  /**
   * Settle pending tips against final match results.
   * All tips originate from API-Football, so team names always match the result lookup.
   */
  async settleDailyTips(targetDate?: string): Promise<{ settled: number; won: number; lost: number }> {
    const dateStr = targetDate || new Date().toISOString().split('T')[0];
    this.logger.log(`Settling tips for date: ${dateStr}`);

    // Update fixture scores in DB then fetch finished matches
    await this.footballDataService.updateFinishedFixtures(dateStr);


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

    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay   = new Date(`${dateStr}T23:59:59.999Z`);

    const pendingTips = await this.tipRepository.find({
      where: {
        result: TipResult.PENDING,
        matchDate: Between(startOfDay, endOfDay),
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
   * Get Active / Today's tips for the Tips page.
   * NOTE: Tips are generated exclusively by the 06:00 UTC cron and onModuleInit.
   * This method only reads from the DB — it never triggers generation or settlement.
   */
  async getTodayTips(): Promise<Tip[]> {
    const todayStr = new Date().toISOString().split('T')[0];
    const startOfToday = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfToday = new Date(`${todayStr}T23:59:59.999Z`);

    const todayTips = await this.tipRepository.find({
      where: {
        matchDate: Between(startOfToday, endOfToday),
      },
      order: { isFree: 'DESC', confidenceScore: 'DESC' },
      relations: ['fixture'],
    });

    if (todayTips.length === 0) {
      this.logger.warn(`No tips found for ${todayStr} — generation runs at 06:00 UTC via cron.`);
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
