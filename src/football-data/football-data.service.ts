import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Fixture } from '../fixtures/fixture.entity';
import { TeamStat } from './team-stat.entity';

// Top international and domestic first-tier leagues and major cups
export const TARGET_LEAGUES = [
  { id: 39, name: 'Premier League', country: 'England' },
  { id: 48, name: 'League Cup / EFL Cup', country: 'England' },
  { id: 45, name: 'FA Cup', country: 'England' },
  { id: 40, name: 'Championship', country: 'England' },
  { id: 140, name: 'La Liga', country: 'Spain' },
  { id: 143, name: 'Copa del Rey', country: 'Spain' },
  { id: 135, name: 'Serie A', country: 'Italy' },
  { id: 137, name: 'Coppa Italia', country: 'Italy' },
  { id: 78, name: 'Bundesliga', country: 'Germany' },
  { id: 81, name: 'DFB Pokal', country: 'Germany' },
  { id: 61, name: 'Ligue 1', country: 'France' },
  { id: 66, name: 'Coupe de France', country: 'France' },
  { id: 2, name: 'UEFA Champions League', country: 'World' },
  { id: 3, name: 'UEFA Europa League', country: 'World' },
  { id: 848, name: 'UEFA Europa Conference League', country: 'World' },
  { id: 88, name: 'Eredivisie', country: 'Netherlands' },
  { id: 94, name: 'Primeira Liga', country: 'Portugal' },
  { id: 144, name: 'Jupiler Pro League', country: 'Belgium' },
  { id: 179, name: 'Premiership', country: 'Scotland' },
  { id: 203, name: 'Süper Lig', country: 'Turkey' },
  { id: 128, name: 'Liga Profesional Argentina', country: 'Argentina' },
  { id: 71, name: 'Serie A', country: 'Brazil' },
  { id: 262, name: 'Liga MX', country: 'Mexico' },
  { id: 253, name: 'Major League Soccer', country: 'USA' },
  { id: 239, name: 'Primera A', country: 'Colombia' },
  { id: 242, name: 'Liga Pro', country: 'Ecuador' },
  { id: 162, name: 'Primera División', country: 'Costa-Rica' },
  { id: 113, name: 'Allsvenskan', country: 'Sweden' },
  { id: 103, name: 'Eliteserien', country: 'Norway' },
  { id: 119, name: 'Superliga', country: 'Denmark' },
  { id: 207, name: 'Super League', country: 'Switzerland' },
];

const DOMESTIC_LEAGUE_MAP: Record<number, number> = {
  48: 39,   // EFL Cup -> Premier League
  45: 39,   // FA Cup -> Premier League
  143: 140, // Copa del Rey -> La Liga
  137: 135, // Coppa Italia -> Serie A
  81: 78,   // DFB Pokal -> Bundesliga
  66: 61,   // Coupe de France -> Ligue 1
};

@Injectable()
export class FootballDataService {
  private readonly logger = new Logger(FootballDataService.name);
  private client: AxiosInstance;

  private statsCache = new Map<string, any>();
  private h2hCache = new Map<string, any[]>();
  private oddsCache = new Map<number, any>();
  private lastRequestTime = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Fixture)
    private fixtureRepository: Repository<Fixture>,
    @InjectRepository(TeamStat)
    private teamStatRepository: Repository<TeamStat>,
  ) {
    const apiKey = this.configService.get<string>('FOOTBALL_API_KEY');
    if (!apiKey) {
      this.logger.error('CRITICAL: FOOTBALL_API_KEY environment variable is missing or empty!');
    }
    const baseURL =
      this.configService.get<string>('FOOTBALL_API_BASE_URL') ||
      'https://v3.football.api-sports.io';

    this.client = axios.create({
      baseURL,
      headers: {
        'x-apisports-key': apiKey || '',
      },
      timeout: 10000,
    });
  }

  private requestQueue: Promise<any> = Promise.resolve();

  /**
   * Sequential queue executor to strictly stay under API-Football's 10 req/min limit.
   * 6500ms delay guarantees max ~9.2 requests per minute (safely below the 10 req/min hard limit).
   */
  private rateLimitedGet(endpoint: string, params: any = {}): Promise<any> {
    const minDelay = 6500; // 6.5s gap between requests (safely complies with 10 req/min)
    
    // Chain onto the queue so requests execute one by one
    const task = this.requestQueue.then(async () => {
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      if (timeSinceLast < minDelay) {
        await new Promise((resolve) => setTimeout(resolve, minDelay - timeSinceLast));
      }
      this.lastRequestTime = Date.now();

      try {
        const res = await this.client.get(endpoint, { params });
        if (res.data?.errors && (Array.isArray(res.data.errors) ? res.data.errors.length > 0 : Object.keys(res.data.errors).length > 0)) {
          this.logger.error(`API-Football error for ${endpoint}: ${JSON.stringify(res.data.errors)}`);
          return null;
        }
        return res.data?.response || null;
      } catch (err) {
        this.logger.error(`API-Football call ${endpoint} failed: ${err.message}`);
        return null;
      }
    });

    // Update queue pointer
    this.requestQueue = task.catch(() => null);
    return task;
  }

  /**
   * Fetch and save all fixtures for a given date across target leagues
   */
  async syncFixturesForDate(dateStr: string): Promise<Fixture[]> {
    this.logger.log(`Syncing fixtures for date: ${dateStr}`);

    const rawFixtures = (await this.rateLimitedGet('/fixtures', { date: dateStr })) || [];
    const savedFixtures: Fixture[] = [];

    for (const item of rawFixtures) {
      const leagueId = item.league?.id;
      const leagueNameLower = item.league?.name?.toLowerCase() || '';

      const isTargetLeague =
        TARGET_LEAGUES.some((l) => l.id === leagueId) ||
        leagueNameLower.includes('league cup') ||
        leagueNameLower.includes('efl cup') ||
        leagueNameLower.includes('champions league') ||
        leagueNameLower.includes('copa');

      if (!isTargetLeague && rawFixtures.length > 50) {
        continue;
      }

      const apiFixtureId = item.fixture?.id;
      let fixture = await this.fixtureRepository.findOne({
        where: { apiFixtureId },
      });

      if (!fixture) {
        fixture = this.fixtureRepository.create();
      }

      fixture.apiFixtureId = apiFixtureId;
      fixture.leagueId = leagueId;
      fixture.leagueName = item.league?.name || 'Unknown League';
      fixture.leagueCountry = item.league?.country || '';
      fixture.homeTeamId = item.teams?.home?.id;
      fixture.homeTeamName = item.teams?.home?.name;
      fixture.homeTeamLogo = item.teams?.home?.logo;
      fixture.awayTeamId = item.teams?.away?.id;
      fixture.awayTeamName = item.teams?.away?.name;
      fixture.awayTeamLogo = item.teams?.away?.logo;
      fixture.matchDate = new Date(item.fixture?.date);
      fixture.status = item.fixture?.status?.short || 'NS';
      fixture.homeGoals = item.goals?.home ?? null;
      fixture.awayGoals = item.goals?.away ?? null;

      savedFixtures.push(await this.fixtureRepository.save(fixture));
    }

    this.logger.log(
      `Synced ${savedFixtures.length} target fixtures for ${dateStr}`,
    );
    return savedFixtures;
  }

  /**
   * Fetch all pre-match odds for a given date in 1 single API call.
   * Returns a Map of apiFixtureId -> { HOME_WIN, AWAY_WIN, DRAW, OVER_2_5, UNDER_2_5, BTTS_YES, BTTS_NO }
   */
  async getOddsForDate(dateStr: string): Promise<Map<number, Record<string, number>>> {
    const oddsMap = new Map<number, Record<string, number>>();
    try {
      const data = await this.rateLimitedGet('/odds', { date: dateStr });
      if (Array.isArray(data)) {
        for (const item of data) {
          const fixtureId = item.fixture?.id;
          if (!fixtureId || !item.bookmakers?.length) continue;

          // Pick primary bookmaker (Bet365 id 8, 1xBet id 11, Bwin id 6, or first available)
          const bookmaker =
            item.bookmakers.find((b: any) => b.id === 8 || b.id === 11 || b.id === 6) ||
            item.bookmakers[0];

          if (!bookmaker?.bets) continue;

          const odds: Record<string, number> = {};
          for (const bet of bookmaker.bets) {
            const betName = (bet.name || '').toLowerCase();
            const betId = bet.id;

            // 1. Match Winner (1X2)
            if (betId === 1 || betName.includes('match winner')) {
              for (const val of bet.values || []) {
                const v = (val.value || '').toString().toLowerCase();
                const oddNum = parseFloat(val.odd);
                if (!isNaN(oddNum)) {
                  if (v === 'home') odds['HOME_WIN'] = Math.round(oddNum * 100) / 100;
                  else if (v === 'away') odds['AWAY_WIN'] = Math.round(oddNum * 100) / 100;
                  else if (v === 'draw') odds['DRAW'] = Math.round(oddNum * 100) / 100;
                }
              }
            }

            // 2. Goals Over/Under 2.5
            if (betId === 5 || betName.includes('goals over/under') || betName.includes('over/under')) {
              for (const val of bet.values || []) {
                const v = (val.value || '').toString().toLowerCase();
                const oddNum = parseFloat(val.odd);
                if (!isNaN(oddNum)) {
                  if (v === 'over 2.5') odds['OVER_2_5'] = Math.round(oddNum * 100) / 100;
                  else if (v === 'under 2.5') odds['UNDER_2_5'] = Math.round(oddNum * 100) / 100;
                }
              }
            }

            // 3. Both Teams Score
            if (betId === 8 || betName.includes('both teams score') || betName.includes('both teams to score')) {
              for (const val of bet.values || []) {
                const v = (val.value || '').toString().toLowerCase();
                const oddNum = parseFloat(val.odd);
                if (!isNaN(oddNum)) {
                  if (v === 'yes') odds['BTTS_YES'] = Math.round(oddNum * 100) / 100;
                  else if (v === 'no') odds['BTTS_NO'] = Math.round(oddNum * 100) / 100;
                }
              }
            }
          }

          if (Object.keys(odds).length > 0) {
            oddsMap.set(fixtureId, odds);
          }
        }
      }
      this.logger.log(`Fetched API-Football real odds for ${oddsMap.size} fixtures on ${dateStr}`);
    } catch (err) {
      this.logger.warn(`Failed to fetch API-Football odds for ${dateStr}: ${err.message}`);
    }
    return oddsMap;
  }

  /**
   * Fetch bookmaker pre-match odds for a specific fixture (with in-memory cache)
   */
  async getOddsForFixture(apiFixtureId: number): Promise<any | null> {
    if (this.oddsCache.has(apiFixtureId)) {
      return this.oddsCache.get(apiFixtureId);
    }

    const oddsData = (await this.rateLimitedGet('/odds', { fixture: apiFixtureId }))?.[0] || null;
    if (oddsData) {
      this.oddsCache.set(apiFixtureId, oddsData);
    }
    return oddsData;
  }

  /**
   * Fetch Head-to-Head matches between two teams (with cache)
   */
  async getH2H(homeTeamId: number, awayTeamId: number): Promise<any[]> {
    const cacheKey = `${homeTeamId}-${awayTeamId}`;
    if (this.h2hCache.has(cacheKey)) {
      return this.h2hCache.get(cacheKey) || [];
    }

    const data = (await this.rateLimitedGet('/fixtures/headtohead', { h2h: cacheKey })) || [];
    this.h2hCache.set(cacheKey, data);
    return data;
  }

  /**
   * Fetch real team statistics with persistent PostgreSQL cache (Zero Wasted Requests!)
   */
  async getTeamStats(
    teamId: number,
    leagueId: number,
    season?: number,
  ): Promise<any | null> {
    const targetSeason = season || new Date().getFullYear();
    const cacheKey = `${teamId}-${leagueId}-${targetSeason}`;
    if (this.statsCache.has(cacheKey)) {
      return this.statsCache.get(cacheKey);
    }

    // 1. Check persistent PostgreSQL database cache first!
    const dbStat = await this.teamStatRepository.findOne({
      where: { teamId },
    });

    if (dbStat) {
      const formatted = {
        goals: {
          for: {
            average: {
              home: dbStat.goalsForHome.toFixed(1),
              away: dbStat.goalsForAway.toFixed(1),
              total: dbStat.goalsForTotal.toFixed(1),
            },
          },
          against: {
            average: {
              home: dbStat.goalsAgainstHome.toFixed(1),
              away: dbStat.goalsAgainstAway.toFixed(1),
              total: dbStat.goalsAgainstTotal.toFixed(1),
            },
          },
        },
        form: dbStat.form,
      };

      this.statsCache.set(cacheKey, formatted);
      return formatted;
    }

    // 2. If not in PostgreSQL, query API-Sports for this league (max 1 or 2 requests)
    const leaguesToCheck: number[] = [leagueId];
    if (DOMESTIC_LEAGUE_MAP[leagueId] && DOMESTIC_LEAGUE_MAP[leagueId] !== leagueId) {
      leaguesToCheck.push(DOMESTIC_LEAGUE_MAP[leagueId]);
    }

    for (const lId of leaguesToCheck) {
      const data = await this.rateLimitedGet('/teams/statistics', {
        team: teamId,
        league: lId,
        season: targetSeason,
      });

      const avgScored = parseFloat(data?.goals?.for?.average?.total || '0');
      if (avgScored > 0.1) {
        // Persist to PostgreSQL database so we NEVER call API-Sports for this team again!
        try {
          const newStat = this.teamStatRepository.create({
            teamId,
            leagueId: lId,
            season: targetSeason,
            goalsForHome: parseFloat(data.goals?.for?.average?.home || '1.3'),
            goalsForAway: parseFloat(data.goals?.for?.average?.away || '1.1'),
            goalsForTotal: avgScored,
            goalsAgainstHome: parseFloat(data.goals?.against?.average?.home || '1.0'),
            goalsAgainstAway: parseFloat(data.goals?.against?.average?.away || '1.3'),
            goalsAgainstTotal: parseFloat(data.goals?.against?.average?.total || '1.2'),
            form: data.form || 'WDLW',
          });
          await this.teamStatRepository.save(newStat);
        } catch (e) {
          // Ignore duplicate key collision
        }

        const formatted = {
          goals: {
            for: {
              average: {
                home: (data.goals?.for?.average?.home || '1.3'),
                away: (data.goals?.for?.average?.away || '1.1'),
                total: avgScored.toFixed(1),
              },
            },
            against: {
              average: {
                home: (data.goals?.against?.average?.home || '1.0'),
                away: (data.goals?.against?.average?.away || '1.3'),
                total: (data.goals?.against?.average?.total || '1.2'),
              },
            },
          },
          form: data.form || 'WDLW',
        };

        this.statsCache.set(cacheKey, formatted);
        return formatted;
      }
    }

    // Default neutral stats if not available
    const defaultStats = {
      goals: {
        for: { average: { home: '1.3', away: '1.1', total: '1.2' } },
        against: { average: { home: '1.0', away: '1.3', total: '1.2' } },
      },
      form: 'WDLW',
    };
    this.statsCache.set(cacheKey, defaultStats);
    return defaultStats;
  }

  /**
   * Fetch league standings (position, form, points, goal difference)
   */
  async getStandings(leagueId: number, season: number): Promise<any[]> {
    const cacheKey = `standings-${leagueId}-${season}`;
    if (this.statsCache.has(cacheKey)) return this.statsCache.get(cacheKey);

    const data = await this.rateLimitedGet('/standings', { league: leagueId, season });
    const table = data?.[0]?.league?.standings?.[0] || [];
    this.statsCache.set(cacheKey, table);
    return table;
  }

  /**
   * Fetch fixtures for a date (used by match analyzer).
   */
  async getFixturesForDate(dateStr: string): Promise<any[]> {
    return (await this.rateLimitedGet('/fixtures', { date: dateStr })) || [];
  }

  /**
   * Fetch finished (FT) fixtures for a date (used by settlement).
   */
  async getFinishedFixturesForDate(dateStr: string): Promise<any[]> {
    return (await this.rateLimitedGet('/fixtures', { date: dateStr, status: 'FT' })) || [];
  }


  /**
   * Fetch last N finished matches for a team in a league (for recent form analysis)
   */
  async getTeamRecentMatches(teamId: number, leagueId: number, season: number, last = 5): Promise<any[]> {
    const cacheKey = `recent-${teamId}-${leagueId}-${season}-${last}`;
    if (this.statsCache.has(cacheKey)) return this.statsCache.get(cacheKey);

    const data = await this.rateLimitedGet('/fixtures', {
      team: teamId,
      league: leagueId,
      season,
      last,
      status: 'FT',
    });
    const result = data || [];
    this.statsCache.set(cacheKey, result);
    return result;
  }

  /**
   * Update final scores for finished matches
   */
  async updateFinishedFixtures(dateStr: string): Promise<Fixture[]> {
    try {
      const finishedData =
        (await this.rateLimitedGet('/fixtures', { date: dateStr, status: 'FT' })) || [];
      const updated: Fixture[] = [];
      for (const item of finishedData) {
        const fixture = await this.fixtureRepository.findOne({
          where: { apiFixtureId: item.fixture?.id },
        });
        if (fixture) {
          fixture.status = item.fixture?.status?.short;
          fixture.homeGoals = item.goals?.home ?? null;
          fixture.awayGoals = item.goals?.away ?? null;
          updated.push(await this.fixtureRepository.save(fixture));
        }
      }
      return updated;
    } catch {
      return [];
    }
  }
}
