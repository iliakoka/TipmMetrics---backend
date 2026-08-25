import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Fixture } from '../fixtures/fixture.entity';

// 12 Free Competitions on Football-Data.org
export const FOOTBALL_DATA_COMPETITIONS = [
  { code: 'PL', id: 2021, name: 'Premier League', country: 'England' },
  { code: 'CL', id: 2001, name: 'UEFA Champions League', country: 'Europe' },
  { code: 'PD', id: 2014, name: 'La Liga', country: 'Spain' },
  { code: 'SA', id: 2019, name: 'Serie A', country: 'Italy' },
  { code: 'BL1', id: 2002, name: 'Bundesliga', country: 'Germany' },
  { code: 'FL1', id: 2015, name: 'Ligue 1', country: 'France' },
  { code: 'DED', id: 2003, name: 'Eredivisie', country: 'Netherlands' },
  { code: 'PPL', id: 2017, name: 'Primeira Liga', country: 'Portugal' },
  { code: 'ELC', id: 2016, name: 'Championship', country: 'England' },
  { code: 'BSA', id: 2013, name: 'Serie A', country: 'Brazil' },
  { code: 'CLI', id: 2152, name: 'Copa Libertadores', country: 'South America' },
  { code: 'EC', id: 2018, name: 'European Championship', country: 'Europe' },
];

@Injectable()
export class FootballDataOrgService implements OnModuleInit {
  private readonly logger = new Logger(FootballDataOrgService.name);
  private client: AxiosInstance;

  // In-memory cache for standings
  private standingsCache = new Map<string, any>();
  private lastRequestTime = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Fixture)
    private fixtureRepository: Repository<Fixture>,
  ) {
    const apiToken =
      this.configService.get<string>('FOOTBALL_DATA_ORG_TOKEN') ||
      this.configService.get<string>('FOOTBALL_DATA_TOKEN') ||
      '3e4dc0d2c0cc4325976cb4f2ab627168';

    this.client = axios.create({
      baseURL: 'https://api.football-data.org/v4',
      headers: {
        'X-Auth-Token': apiToken,
      },
      timeout: 8000,
    });
  }

  /**
   * Pre-warm standings cache for all 12 competitions on startup.
   * This ensures getTeamStats never returns null due to a cold cache
   * on the first request after a deploy or restart.
   */
  onModuleInit() {
    setImmediate(async () => {
      this.logger.log('Pre-warming standings cache for all 12 competitions...');
      try {
        await this.warmStandingsCache();
        this.logger.log(`Standings cache warmed: ${this.standingsCache.size} competitions loaded.`);
      } catch (err) {
        this.logger.warn(`Standings cache warm-up failed (non-fatal): ${err.message}`);
      }
    });
  }

  async warmStandingsCache(): Promise<void> {
    await Promise.all(
      FOOTBALL_DATA_COMPETITIONS.map(async (comp) => {
        try {
          const data = await this.fastGet(`/competitions/${comp.code}/standings`);
          if (data?.standings) {
            this.standingsCache.set(comp.code, data.standings);
          }
        } catch {
          // Individual competition failures are non-fatal
        }
      }),
    );
  }


  /**
   * Fast request executor with lightweight rate limiter
   */
  private async fastGet(endpoint: string, params: any = {}): Promise<any> {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    const minDelay = 200; // Fast 200ms pacing
    if (timeSinceLast < minDelay) {
      await new Promise((resolve) => setTimeout(resolve, minDelay - timeSinceLast));
    }
    this.lastRequestTime = Date.now();

    try {
      const res = await this.client.get(endpoint, { params });
      return res.data || null;
    } catch (err) {
      this.logger.warn(`Football-Data.org call to ${endpoint} failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch all fixtures for a given date across the 12 competitions
   */
  async syncFixturesForDate(dateStr: string): Promise<Fixture[]> {
    this.logger.log(`Fetching Football-Data.org fixtures for date: ${dateStr}`);

    const data = await this.fastGet('/matches', {
      dateFrom: dateStr,
      dateTo: dateStr,
    });

    const rawMatches = data?.matches || [];
    const savedFixtures: Fixture[] = [];

    for (const m of rawMatches) {
      const apiFixtureId = m.id;
      let fixture = await this.fixtureRepository.findOne({
        where: { apiFixtureId },
      });

      if (!fixture) {
        fixture = this.fixtureRepository.create();
      }

      fixture.apiFixtureId = apiFixtureId;
      fixture.leagueId = m.competition?.id || 0;
      fixture.leagueName = m.competition?.name || 'League';
      fixture.leagueCountry = m.area?.name || '';
      fixture.homeTeamId = m.homeTeam?.id || 0;
      fixture.homeTeamName = m.homeTeam?.name || 'Home Team';
      fixture.homeTeamLogo = m.homeTeam?.crest || '';
      fixture.awayTeamId = m.awayTeam?.id || 0;
      fixture.awayTeamName = m.awayTeam?.name || 'Away Team';
      fixture.awayTeamLogo = m.awayTeam?.crest || '';
      fixture.matchDate = new Date(m.utcDate);
      fixture.status =
        m.status === 'FINISHED'
          ? 'FT'
          : m.status === 'TIMED' || m.status === 'SCHEDULED'
          ? 'NS'
          : m.status;
      fixture.homeGoals = m.score?.fullTime?.home ?? null;
      fixture.awayGoals = m.score?.fullTime?.away ?? null;

      savedFixtures.push(await this.fixtureRepository.save(fixture));
    }

    // Pre-fetch standings for all active competitions in parallel (super fast!)
    const activeCodes = Array.from(new Set(rawMatches.map((m: any) => m.competition?.code).filter(Boolean)));
    await Promise.all(
      activeCodes.map(async (code: string) => {
        if (!this.standingsCache.has(code)) {
          const sData = await this.fastGet(`/competitions/${code}/standings`);
          if (sData?.standings) {
            this.standingsCache.set(code, sData.standings);
          }
        }
      }),
    );

    this.logger.log(`Synced ${savedFixtures.length} matches from Football-Data.org for ${dateStr}`);
    return savedFixtures;
  }

  /**
   * Get team performance stats instantly from in-memory pre-fetched standings (0ms latency!)
   */
  async getTeamStats(teamId: number, competitionCode: string): Promise<any | null> {
    if (!competitionCode) return null;

    if (!this.standingsCache.has(competitionCode)) {
      const data = await this.fastGet(`/competitions/${competitionCode}/standings`);
      if (data?.standings) {
        this.standingsCache.set(competitionCode, data.standings);
      }
    }

    const standings = this.standingsCache.get(competitionCode);
    if (!standings) return null;

    const totalTable = standings.find((s: any) => s.type === 'TOTAL')?.table || [];
    const homeTable = standings.find((s: any) => s.type === 'HOME')?.table || [];
    const awayTable = standings.find((s: any) => s.type === 'AWAY')?.table || [];

    const teamTotal = totalTable.find((t: any) => t.team?.id === teamId);
    const teamHome = homeTable.find((t: any) => t.team?.id === teamId);
    const teamAway = awayTable.find((t: any) => t.team?.id === teamId);

    if (!teamTotal) return null;

    const playedTotal = teamTotal.playedGames || 1;
    const playedHome = teamHome?.playedGames || Math.max(1, Math.floor(playedTotal / 2));
    const playedAway = teamAway?.playedGames || Math.max(1, Math.floor(playedTotal / 2));

    // Raw averages — may be 0 at the start of a season when no games have been played yet
    const rawHomeScored = teamHome ? teamHome.goalsFor / playedHome : teamTotal.goalsFor / playedTotal;
    const rawHomeConceded = teamHome ? teamHome.goalsAgainst / playedHome : teamTotal.goalsAgainst / playedTotal;
    const rawAwayScored = teamAway ? teamAway.goalsFor / playedAway : teamTotal.goalsFor / playedTotal;
    const rawAwayConceded = teamAway ? teamAway.goalsAgainst / playedAway : teamTotal.goalsAgainst / playedTotal;
    const rawTotalScored = teamTotal.goalsFor / playedTotal;
    const rawTotalConceded = teamTotal.goalsAgainst / playedTotal;

    // Apply league-average fallbacks BEFORE toFixed() so zero-game teams still produce valid stats.
    // (0).toFixed(2) === "0.00" which is truthy, so `|| 1.3` after toFixed never fires.)
    const homeGoalsScored   = rawHomeScored   > 0 ? rawHomeScored   : 1.30;
    const homeGoalsConceded = rawHomeConceded > 0 ? rawHomeConceded : 1.00;
    const awayGoalsScored   = rawAwayScored   > 0 ? rawAwayScored   : 1.10;
    const awayGoalsConceded = rawAwayConceded > 0 ? rawAwayConceded : 1.30;
    const totalScored       = rawTotalScored  > 0 ? rawTotalScored  : 1.20;
    const totalConceded     = rawTotalConceded > 0 ? rawTotalConceded : 1.10;

    return {
      goals: {
        for: {
          average: {
            home: homeGoalsScored.toFixed(2),
            away: awayGoalsScored.toFixed(2),
            total: totalScored.toFixed(2),
          },
        },
        against: {
          average: {
            home: homeGoalsConceded.toFixed(2),
            away: awayGoalsConceded.toFixed(2),
            total: totalConceded.toFixed(2),
          },
        },
      },
      form: teamTotal.form?.replace(/,/g, '') || 'WDLWD',
    };
  }

  /**
   * Update finished match scores
   */
  async updateFinishedFixtures(dateStr: string): Promise<Fixture[]> {
    try {
      const data = await this.fastGet('/matches', {
        dateFrom: dateStr,
        dateTo: dateStr,
        status: 'FINISHED',
      });

      const finished = data?.matches || [];
      const updated: Fixture[] = [];

      for (const m of finished) {
        const fixture = await this.fixtureRepository.findOne({
          where: { apiFixtureId: m.id },
        });

        if (fixture) {
          fixture.status = 'FT';
          fixture.homeGoals = m.score?.fullTime?.home ?? null;
          fixture.awayGoals = m.score?.fullTime?.away ?? null;
          updated.push(await this.fixtureRepository.save(fixture));
        }
      }

      return updated;
    } catch (err) {
      return [];
    }
  }

  /**
   * Convert competition ID/name to Football-Data.org competition code
   */
  getCompetitionCode(leagueId: number, leagueName: string): string {
    const found = FOOTBALL_DATA_COMPETITIONS.find(
      (c) => c.id === leagueId || leagueName.toLowerCase().includes(c.name.toLowerCase()),
    );
    return found ? found.code : 'PD';
  }
}
