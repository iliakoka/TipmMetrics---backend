import { Injectable, Logger } from '@nestjs/common';
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
export class FootballDataOrgService {
  private readonly logger = new Logger(FootballDataOrgService.name);
  private client: AxiosInstance;

  // In-memory standings cache (competition code -> standings table)
  private standingsCache = new Map<string, any>();
  private h2hCache = new Map<number, any>();
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
      timeout: 10000,
    });
  }

  /**
   * Paced request executor respecting X-Requests-Available-Minute headers
   */
  private async rateLimitedGet(endpoint: string, params: any = {}): Promise<any> {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    const minDelay = 650; // Smooth 650ms pacing
    if (timeSinceLast < minDelay) {
      await new Promise((resolve) => setTimeout(resolve, minDelay - timeSinceLast));
    }
    this.lastRequestTime = Date.now();

    try {
      const res = await this.client.get(endpoint, { params });

      // Check throttling headers from Football-Data.org
      const available = parseInt(
        res.headers?.['x-requests-available-minute'] || '10',
        10,
      );
      if (available <= 1) {
        const waitSec = parseInt(
          res.headers?.['x-requestcounter-reset'] || '10',
          10,
        );
        this.logger.warn(`Approaching per-minute limit. Throttling for ${waitSec}s...`);
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      }

      return res.data || null;
    } catch (err) {
      this.logger.warn(
        `Football-Data.org API call to ${endpoint} failed: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Fetch all fixtures for a given date across the 12 competitions
   */
  async syncFixturesForDate(dateStr: string): Promise<Fixture[]> {
    this.logger.log(`Fetching Football-Data.org fixtures for date: ${dateStr}`);

    const data = await this.rateLimitedGet('/matches', {
      dateFrom: dateStr,
      dateTo: dateStr,
    });

    const rawMatches = data?.matches || [];
    const savedFixtures: Fixture[] = [];

    for (const m of rawMatches) {
      const compCode = m.competition?.code;
      const isTarget = FOOTBALL_DATA_COMPETITIONS.some((c) => c.code === compCode);
      if (!isTarget && rawMatches.length > 30) continue;

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

    this.logger.log(
      `Synced ${savedFixtures.length} matches from Football-Data.org for ${dateStr}`,
    );
    return savedFixtures;
  }

  /**
   * Get team performance stats by loading the league table in a single call
   */
  async getTeamStats(
    teamId: number,
    competitionCode: string,
  ): Promise<any | null> {
    if (!competitionCode) return null;

    if (!this.standingsCache.has(competitionCode)) {
      const data = await this.rateLimitedGet(
        `/competitions/${competitionCode}/standings`,
      );
      if (data?.standings) {
        this.standingsCache.set(competitionCode, data.standings);
      }
    }

    const standings = this.standingsCache.get(competitionCode);
    if (!standings) return null;

    // Search total, home, away standings tables
    const totalTable =
      standings.find((s: any) => s.type === 'TOTAL')?.table || [];
    const homeTable =
      standings.find((s: any) => s.type === 'HOME')?.table || [];
    const awayTable =
      standings.find((s: any) => s.type === 'AWAY')?.table || [];

    const teamTotal = totalTable.find((t: any) => t.team?.id === teamId);
    const teamHome = homeTable.find((t: any) => t.team?.id === teamId);
    const teamAway = awayTable.find((t: any) => t.team?.id === teamId);

    if (!teamTotal) return null;

    const playedTotal = teamTotal.playedGames || 1;
    const playedHome =
      teamHome?.playedGames || Math.max(1, Math.floor(playedTotal / 2));
    const playedAway =
      teamAway?.playedGames || Math.max(1, Math.floor(playedTotal / 2));

    const homeGoalsScored = teamHome
      ? teamHome.goalsFor / playedHome
      : teamTotal.goalsFor / playedTotal;
    const homeGoalsConceded = teamHome
      ? teamHome.goalsAgainst / playedHome
      : teamTotal.goalsAgainst / playedTotal;

    const awayGoalsScored = teamAway
      ? teamAway.goalsFor / playedAway
      : teamTotal.goalsFor / playedTotal;
    const awayGoalsConceded = teamAway
      ? teamAway.goalsAgainst / playedAway
      : teamTotal.goalsAgainst / playedTotal;

    return {
      goals: {
        for: {
          average: {
            home: homeGoalsScored.toFixed(2),
            away: awayGoalsScored.toFixed(2),
            total: (teamTotal.goalsFor / playedTotal).toFixed(2),
          },
        },
        against: {
          average: {
            home: homeGoalsConceded.toFixed(2),
            away: awayGoalsConceded.toFixed(2),
            total: (teamTotal.goalsAgainst / playedTotal).toFixed(2),
          },
        },
      },
      form: teamTotal.form?.replace(/,/g, '') || 'WDLWD',
    };
  }

  /**
   * Fetch Head-to-Head matches for a specific match
   */
  async getH2H(matchId: number): Promise<any[]> {
    if (this.h2hCache.has(matchId)) {
      return this.h2hCache.get(matchId) || [];
    }

    const data = await this.rateLimitedGet(`/matches/${matchId}/head2head`, {
      limit: 10,
    });
    const matches = data?.matches || [];
    this.h2hCache.set(matchId, matches);
    return matches;
  }

  /**
   * Update finished match scores
   */
  async updateFinishedFixtures(dateStr: string): Promise<Fixture[]> {
    try {
      const data = await this.rateLimitedGet('/matches', {
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
      (c) =>
        c.id === leagueId ||
        leagueName.toLowerCase().includes(c.name.toLowerCase()),
    );
    return found ? found.code : 'PL';
  }
}
