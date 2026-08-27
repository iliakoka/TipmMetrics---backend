import { Injectable, Logger } from '@nestjs/common';
import { FootballDataService, TARGET_LEAGUES } from '../football-data/football-data.service';
import { WeatherService } from '../weather/weather.service';
import { OddsApiService } from '../odds/odds-api.service';

export interface MatchAnalysis {
  // Match identity
  homeTeam: string;
  awayTeam: string;
  homeTeamLogo?: string | null;
  awayTeamLogo?: string | null;
  homeTeamId: number;
  awayTeamId: number;
  leagueId: number;
  leagueName: string;
  kickoffTime: Date;
  venueCity: string;

  // Form (last 5 matches)
  homeFormPoints: number;    // 0-15 (W=3, D=1, L=0)
  awayFormPoints: number;
  homeFormString: string;    // e.g. "WWDLW"
  awayFormString: string;

  // Goals profile
  homeAvgScored: number;
  homeAvgConceded: number;
  awayAvgScored: number;
  awayAvgConceded: number;
  expectedTotalGoals: number;

  // Set pieces
  homeCornersPerGame: number;
  awayCornersPerGame: number;

  // H2H
  h2hHomeWins: number;
  h2hAwayWins: number;
  h2hDraws: number;
  h2hAvgGoals: number;
  h2hMatches: number;

  // League context
  homePosition: number;
  awayPosition: number;
  homePoints: number;
  awayPoints: number;
  positionGap: number;
  homeMotivation: 'title' | 'europe' | 'normal' | 'nothing' | 'relegation';
  awayMotivation: 'title' | 'europe' | 'normal' | 'nothing' | 'relegation';

  // Home advantage
  homeWinPctAtHome: number;  // 0-100
  awayWinPctAway: number;

  // Weather
  weatherDescription: string;
  weatherGoalsPenalty: number;

  // Computed scores
  formScore: number;         // 0-25
  h2hScore: number;          // 0-20
  positionScore: number;     // 0-15
  motivationScore: number;   // 0-10
  homeAdvantageScore: number; // 0-10
  goalsProfileScore: number; // 0-10 (for over/under)
  weatherPenalty: number;    // -10 to 0
  totalScore: number;        // 0-100

  // Prediction
  predictedMarket: string;
  predictedProbability: number; // 0-100
  reasoning: string[];

  // Bookmaker odds for this match (from The Odds API)
  bookmakerOdds: Record<string, number>; // market -> consensus odds
}

@Injectable()
export class MatchAnalyzerService {
  private readonly logger = new Logger(MatchAnalyzerService.name);

  // In-memory standings cache (populated once per day)
  private standingsCache = new Map<number, any[]>();

  constructor(
    private footballDataService: FootballDataService,
    private weatherService: WeatherService,
    private oddsApiService: OddsApiService,
  ) {}

  /**
   * Main entry point.
   * 1. Fetch today's fixtures from API-Football (1 req)
   * 2. Fetch Odds API events to get bookmaker odds
   * 3. Pre-load standings for relevant leagues (3-5 req)
   * 4. Deep-analyze top candidates (team stats + H2H)
   * 5. Return ranked MatchAnalysis[] for TipsService to select from
   */
  async analyzeMatchesForDate(dateStr: string): Promise<MatchAnalysis[]> {
    this.logger.log(`Starting match analysis for ${dateStr}`);

    // Step 1: Get upcoming fixtures (1 API-Football request)
    const rawFixtures = await this.footballDataService.getFixturesForDate(dateStr);
    if (!rawFixtures.length) {
      this.logger.warn(`No fixtures from API-Football for ${dateStr}`);
      return [];
    }
    this.logger.log(`Found ${rawFixtures.length} raw fixtures`);

    // Filter to target leagues (all 30 supported leagues)
    const targetLeagueIds = new Set(TARGET_LEAGUES.map((l) => l.id));
    let targetFixtures = rawFixtures.filter((f) => targetLeagueIds.has(f.league?.id));
    
    // If no target league matches, fall back to any available fixtures with valid teams
    if (!targetFixtures.length && rawFixtures.length > 0) {
      targetFixtures = rawFixtures.filter((f) => f.teams?.home?.name && f.teams?.away?.name);
    }

    this.logger.log(`${targetFixtures.length} fixtures in target leagues`);
    if (!targetFixtures.length) return [];

    // Step 2: Get live bookmaker odds
    // 2a. Fetch real bookmaker odds for all fixtures from API-Football (1 single request for the entire date)
    const apiOddsMap = await this.footballDataService.getOddsForDate(dateStr);

    // 2b. Fetch Odds API events (major leagues)
    const oddsEvents = await this.oddsApiService.getCandidatesForDate(dateStr);
    // Build a map: "HomeTeam|AwayTeam" -> { market -> odds }
    const oddsMap = new Map<string, Record<string, number>>();
    for (const c of oddsEvents) {
      const key = `${c.homeTeam}|${c.awayTeam}`;
      if (!oddsMap.has(key)) oddsMap.set(key, {});
      oddsMap.get(key)![c.market] = c.consensusOdds;
    }

    // Step 3: Analyze top 8 fixtures (lean request usage + DB cache)
    const results: MatchAnalysis[] = [];
    const toAnalyze = targetFixtures.slice(0, 8);

    for (const fixture of toAnalyze) {
      try {
        const analysis = await this.analyzeOneMatch(fixture, oddsMap, apiOddsMap, dateStr);
        if (analysis) results.push(analysis);
      } catch (err) {
        this.logger.error(`Error analyzing ${fixture.teams?.home?.name} vs ${fixture.teams?.away?.name}: ${err.message}`);
      }
    }

    // Sort by total score descending
    results.sort((a, b) => b.totalScore - a.totalScore);
    this.logger.log(`Analysis complete: ${results.length} matches scored`);
    return results;
  }

  private async analyzeOneMatch(
    fixture: any,
    oddsMap: Map<string, Record<string, number>>,
    apiOddsMap: Map<number, Record<string, number>>,
    dateStr: string,
  ): Promise<MatchAnalysis | null> {
    const homeTeamId   = fixture.teams?.home?.id;
    const awayTeamId   = fixture.teams?.away?.id;
    const homeTeam     = fixture.teams?.home?.name || 'Home';
    const awayTeam     = fixture.teams?.away?.name || 'Away';
    const homeTeamLogo = fixture.teams?.home?.logo || null;
    const awayTeamLogo = fixture.teams?.away?.logo || null;
    const leagueId    = fixture.league?.id;
    const leagueName  = fixture.league?.name || '';
    const kickoffTime = new Date(fixture.fixture?.date);
    const venueCity   = fixture.fixture?.venue?.city || '';
    const season      = fixture.league?.season || new Date().getFullYear();

    // Get team season stats (with DB cache)
    const [homeStats, awayStats] = await Promise.all([
      this.footballDataService.getTeamStats(homeTeamId, leagueId, season),
      this.footballDataService.getTeamStats(awayTeamId, leagueId, season),
    ]);

    // Get H2H (1 API-Football request)
    const h2h = await this.footballDataService.getH2H(homeTeamId, awayTeamId);

    // Get weather (Open-Meteo, free)
    const weather = await this.weatherService.getWeatherForVenue(venueCity, kickoffTime);

    // Get standings for this league
    const standings = this.standingsCache.get(leagueId) || [];

    // Parse all data
    const homeForm   = this.parseForm(homeStats);
    const awayForm   = this.parseForm(awayStats);
    const homeGoals  = this.parseGoals(homeStats);
    const awayGoals  = this.parseGoals(awayStats);
    const h2hStats   = this.parseH2H(h2h, homeTeamId, awayTeamId);
    const homeStanding = this.findStanding(standings, homeTeamId);
    const awayStanding = this.findStanding(standings, awayTeamId);
    const leagueSize   = standings.length || 20;

    // Compute expected total goals (Poisson mean)
    const homeAttack = homeGoals.avgScored   > 0 ? homeGoals.avgScored   : 1.3;
    const homeDef    = homeGoals.avgConceded > 0 ? homeGoals.avgConceded : 1.2;
    const awayAttack = awayGoals.avgScored   > 0 ? awayGoals.avgScored   : 1.0;
    const awayDef    = awayGoals.avgConceded > 0 ? awayGoals.avgConceded : 1.4;
    const lambdaHome = (homeAttack * awayDef)  / 1.35; // 1.35 = league avg goals per team
    const lambdaAway = (awayAttack * homeDef)  / 1.35;
    const expectedTotal = (lambdaHome + lambdaAway) * weather.goalsPenalty;

    // --- Score components ---

    // Form score (0-25): home form advantage
    const homeFormPts = homeForm.points;
    const awayFormPts  = awayForm.points;
    const formDiff = homeFormPts - awayFormPts; // -15 to +15
    const formScore = Math.round(12.5 + formDiff * (12.5 / 15)); // 0-25

    // H2H score (0-20)
    const h2hScore = this.computeH2HScore(h2hStats, homeTeamId);

    // Position score (0-15)
    const homePos = homeStanding?.rank ?? Math.ceil(leagueSize / 2);
    const awayPos  = awayStanding?.rank ?? Math.ceil(leagueSize / 2);
    const posGap   = awayPos - homePos; // positive = home team higher
    const positionScore = Math.min(15, Math.max(0, Math.round(7.5 + posGap * (7.5 / 10))));

    // Motivation score (0-10)
    const homeMotivation = this.classifyMotivation(homeStanding, leagueSize);
    const awayMotivation = this.classifyMotivation(awayStanding, leagueSize);
    const motivationScore = this.computeMotivationScore(homeMotivation, awayMotivation);

    // Home advantage score (0-10)
    const homeWinPct = homeStanding
      ? (homeStanding.home?.win ?? 0) / Math.max(homeStanding.home?.played ?? 1, 1) * 100
      : 45;
    const awayWinPct = awayStanding
      ? (awayStanding.away?.win ?? 0) / Math.max(awayStanding.away?.played ?? 1, 1) * 100
      : 30;
    const homeAdvantageScore = Math.round(Math.min(10, homeWinPct / 10));

    // Goals profile score (0-10): how predictable is the total goals?
    const goalsProfileScore = expectedTotal > 2.8 ? 8 : expectedTotal < 2.2 ? 8 : 4;

    // Weather penalty (0 to -10)
    const weatherPenalty = Math.round((weather.goalsPenalty - 1.0) * 40); // -10 for extreme

    // Total score
    const totalScore = Math.min(100, Math.max(0,
      formScore + h2hScore + positionScore + motivationScore +
      homeAdvantageScore + goalsProfileScore + weatherPenalty
    ));

    // Build odds map: try API-Football direct real odds first, then per-fixture lookup, then The Odds API fallback
    const apiFixtureId = fixture.fixture?.id || fixture.apiFixtureId || fixture.id;
    let bookmakerOdds = (apiFixtureId && apiOddsMap.get(apiFixtureId)) || {};

    if (Object.keys(bookmakerOdds).length === 0 && apiFixtureId) {
      bookmakerOdds = await this.footballDataService.getOddsForFixture(apiFixtureId);
    }

    if (Object.keys(bookmakerOdds).length === 0) {
      bookmakerOdds = this.findOdds(oddsMap, homeTeam, awayTeam);
    }

    // Determine best predicted market + probability
    const prediction = this.makePrediction({
      formScore, h2hStats, homeFormPts, awayFormPts,
      homePos, awayPos, expectedTotal, homeMotivation, awayMotivation,
      homeWinPct, awayWinPct, weather, bookmakerOdds,
    });

    const reasoning = this.buildReasoning({
      homeTeam, awayTeam, homeFormPts, awayFormPts,
      homePos, awayPos, h2hStats, homeMotivation, awayMotivation,
      expectedTotal, weather, prediction,
    });

    return {
      homeTeam, awayTeam, homeTeamLogo, awayTeamLogo, homeTeamId, awayTeamId,
      leagueId, leagueName, kickoffTime, venueCity,
      homeFormPoints: homeFormPts,
      awayFormPoints: awayFormPts,
      homeFormString: homeForm.string,
      awayFormString: awayForm.string,
      homeAvgScored:    homeGoals.avgScored,
      homeAvgConceded:  homeGoals.avgConceded,
      awayAvgScored:    awayGoals.avgScored,
      awayAvgConceded:  awayGoals.avgConceded,
      expectedTotalGoals: Math.round(expectedTotal * 100) / 100,
      homeCornersPerGame: homeGoals.cornersPerGame,
      awayCornersPerGame: awayGoals.cornersPerGame,
      h2hHomeWins: h2hStats.homeWins,
      h2hAwayWins: h2hStats.awayWins,
      h2hDraws:    h2hStats.draws,
      h2hAvgGoals: h2hStats.avgGoals,
      h2hMatches:  h2hStats.total,
      homePosition: homePos,
      awayPosition: awayPos,
      homePoints:   homeStanding?.points ?? 0,
      awayPoints:   awayStanding?.points ?? 0,
      positionGap:  posGap,
      homeMotivation, awayMotivation,
      homeWinPctAtHome: Math.round(homeWinPct),
      awayWinPctAway:   Math.round(awayWinPct),
      weatherDescription: weather.description,
      weatherGoalsPenalty: weather.goalsPenalty,
      formScore, h2hScore, positionScore, motivationScore,
      homeAdvantageScore, goalsProfileScore, weatherPenalty, totalScore,
      predictedMarket: prediction.market,
      predictedProbability: prediction.probability,
      reasoning,
      bookmakerOdds,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private parseForm(stats: any): { points: number; string: string } {
    const form: string = stats?.form || '';
    const last5 = form.slice(-5).toUpperCase();
    let points = 0;
    for (const ch of last5) {
      if (ch === 'W') points += 3;
      else if (ch === 'D') points += 1;
    }
    return { points, string: last5 || 'N/A' };
  }

  private parseGoals(stats: any): {
    avgScored: number; avgConceded: number; cornersPerGame: number;
  } {
    return {
      avgScored:     parseFloat(stats?.goals?.for?.average?.total    || '0'),
      avgConceded:   parseFloat(stats?.goals?.against?.average?.total || '0'),
      cornersPerGame: parseFloat(stats?.cards?.yellow?.total          || '0') * 0.1, // approximation
    };
  }

  private parseH2H(
    h2h: any[],
    homeTeamId: number,
    awayTeamId: number,
  ): { homeWins: number; awayWins: number; draws: number; avgGoals: number; total: number } {
    const last5 = (h2h || []).slice(-5);
    let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;

    for (const match of last5) {
      const hw = match.teams?.home?.id === homeTeamId;
      const winner = match.teams?.home?.winner === true ? match.teams.home.id
        : match.teams?.away?.winner === true ? match.teams.away.id
        : null;
      const goals = (match.goals?.home ?? 0) + (match.goals?.away ?? 0);
      totalGoals += goals;
      if (!winner) draws++;
      else if (winner === homeTeamId) homeWins++;
      else awayWins++;
    }

    return {
      homeWins, awayWins, draws,
      avgGoals: last5.length ? Math.round((totalGoals / last5.length) * 10) / 10 : 2.5,
      total: last5.length,
    };
  }

  private findStanding(standings: any[], teamId: number): any | null {
    return standings.find((s) => s.team?.id === teamId) || null;
  }

  private classifyMotivation(
    standing: any | null,
    leagueSize: number,
  ): MatchAnalysis['homeMotivation'] {
    if (!standing) return 'normal';
    const pos = standing.rank;
    if (pos <= 1) return 'title';
    if (pos <= 4) return 'europe';
    if (pos >= leagueSize - 2) return 'relegation';
    if (pos >= leagueSize - 6) return 'normal';
    return 'nothing';
  }

  private computeMotivationScore(
    home: MatchAnalysis['homeMotivation'],
    away: MatchAnalysis['awayMotivation'],
  ): number {
    const score: Record<string, number> = {
      title: 5, europe: 4, relegation: 4, normal: 3, nothing: 1,
    };
    return score[home] + score[away];
  }

  private computeH2HScore(
    h2h: ReturnType<MatchAnalyzerService['parseH2H']>,
    homeTeamId: number,
  ): number {
    if (h2h.total === 0) return 10; // no data = neutral
    const homeRate = h2h.homeWins / h2h.total;
    // 0-20: 10 is neutral, higher = home dominates H2H
    return Math.round(10 + (homeRate - 0.4) * 25);
  }

  private makePrediction(data: {
    formScore: number;
    h2hStats: any;
    homeFormPts: number;
    awayFormPts: number;
    homePos: number;
    awayPos: number;
    expectedTotal: number;
    homeMotivation: string;
    awayMotivation: string;
    homeWinPct: number;
    awayWinPct: number;
    weather: any;
    bookmakerOdds?: Record<string, number>;
  }): { market: string; probability: number; odds: number } {
    const {
      homeFormPts, awayFormPts, homePos, awayPos,
      expectedTotal, homeWinPct, awayWinPct, bookmakerOdds = {},
    } = data;

    // Home win signals
    const homeStrong =
      (homeFormPts > awayFormPts + 3 && homePos < awayPos && homeWinPct > 50) ||
      (bookmakerOdds['HOME_WIN'] && bookmakerOdds['HOME_WIN'] <= 1.45);

    // Away win signals
    const awayStrong =
      (awayFormPts > homeFormPts + 3 && awayPos < homePos && awayWinPct > 35) ||
      (bookmakerOdds['AWAY_WIN'] && bookmakerOdds['AWAY_WIN'] <= 1.55);

    // Goals signals (verify against real bookmaker odds so we don't bet on high-priced underdogs as low-goal games)
    const bookmakerFavorsOver = bookmakerOdds['OVER_2_5'] && bookmakerOdds['OVER_2_5'] <= 1.65;
    const bookmakerFavorsUnder = bookmakerOdds['UNDER_2_5'] && bookmakerOdds['UNDER_2_5'] <= 1.70;

    const likelyOver = expectedTotal > 2.75 || bookmakerFavorsOver;
    const likelyUnder = expectedTotal < 2.20 && !bookmakerFavorsOver && (bookmakerFavorsUnder || !bookmakerOdds['UNDER_2_5']);

    if (homeStrong) {
      const prob = Math.min(75, 52 + (homeFormPts - awayFormPts) * 2 + (homeWinPct - 50) * 0.5);
      return { market: 'HOME_WIN', probability: Math.round(prob), odds: 0 };
    }
    if (awayStrong) {
      const prob = Math.min(72, 50 + (awayFormPts - homeFormPts) * 2 + awayWinPct * 0.3);
      return { market: 'AWAY_WIN', probability: Math.round(prob), odds: 0 };
    }
    if (likelyOver) {
      return { market: 'OVER_2_5', probability: 64, odds: 0 };
    }
    if (likelyUnder) {
      return { market: 'UNDER_2_5', probability: 62, odds: 0 };
    }

    // Default: home win with average confidence
    return { market: 'HOME_WIN', probability: 54, odds: 0 };
  }

  private buildReasoning(data: any): string[] {
    const reasons: string[] = [];
    const { homeTeam, awayTeam, homeFormPts, awayFormPts, homePos, awayPos,
            h2hStats, homeMotivation, awayMotivation, expectedTotal, weather, prediction } = data;

    reasons.push(`Form: ${homeTeam} ${homeFormPts}pts vs ${awayTeam} ${awayFormPts}pts (last 5)`);
    if (h2hStats.total > 0) {
      reasons.push(`H2H (last ${h2hStats.total}): ${homeTeam} ${h2hStats.homeWins}W-${h2hStats.draws}D-${h2hStats.awayWins}W | avg ${h2hStats.avgGoals} goals`);
    }
    if (homePos && awayPos) {
      reasons.push(`Standings: ${homeTeam} ${homePos}th vs ${awayTeam} ${awayPos}th`);
    }
    reasons.push(`Motivation: ${homeTeam} (${homeMotivation}) vs ${awayTeam} (${awayMotivation})`);
    reasons.push(`Expected goals: ${expectedTotal.toFixed(2)} — ${weather.description}`);
    reasons.push(`Predicted: ${prediction.market} @ ~${prediction.probability}% probability`);

    return reasons;
  }

  // ─── Fuzzy odds lookup ─────────────────────────────────────────────────────

  /**
   * Strip common club suffixes and normalize to lowercase for fuzzy comparison.
   * "Manchester United FC" → "manchester united"
   * "Man Utd"             → "man utd"
   * "Atlético Madrid CF"  → "atletico madrid"
   */
  private normalizeTeamName(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // remove accents: é→e, ü→u
      .replace(/\b(fc|afc|cf|sc|ac|bc|bk|fk|sk|if|rfc|utd|united)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Check whether two team names refer to the same club.
   * Tries exact normalized match first, then checks if one is a substring of the other.
   */
  private teamsMatch(a: string, b: string): boolean {
    const na = this.normalizeTeamName(a);
    const nb = this.normalizeTeamName(b);
    if (na === nb) return true;
    // Substring match: "man city" inside "manchester city" or vice-versa
    if (na.includes(nb) || nb.includes(na)) return true;
    // Token overlap: at least 2 tokens in common (handles "Real Madrid" vs "Real Madrid CF")
    const tokensA = new Set(na.split(' ').filter((t) => t.length > 2));
    const tokensB = nb.split(' ').filter((t) => t.length > 2);
    const overlap = tokensB.filter((t) => tokensA.has(t)).length;
    return overlap >= 2 || (tokensA.size === 1 && overlap >= 1);
  }

  /**
   * Find bookmaker odds for a fixture using fuzzy home+away team name matching.
   * Falls back to {} if no Odds API entry matches.
   */
  private findOdds(
    oddsMap: Map<string, Record<string, number>>,
    homeTeam: string,
    awayTeam: string,
  ): Record<string, number> {
    // 1. Exact match first (fast path)
    const exact = oddsMap.get(`${homeTeam}|${awayTeam}`);
    if (exact) return exact;

    // 2. Fuzzy match
    for (const [key, odds] of oddsMap) {
      const [h, a] = key.split('|');
      if (this.teamsMatch(homeTeam, h) && this.teamsMatch(awayTeam, a)) {
        return odds;
      }
    }

    return {};
  }
}
