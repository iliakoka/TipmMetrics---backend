import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Fixture } from '../fixtures/fixture.entity';

// Top international and domestic first-tier leagues
export const TARGET_LEAGUES = [
  { id: 39, name: 'Premier League', country: 'England' },
  { id: 140, name: 'La Liga', country: 'Spain' },
  { id: 135, name: 'Serie A', country: 'Italy' },
  { id: 78, name: 'Bundesliga', country: 'Germany' },
  { id: 61, name: 'Ligue 1', country: 'France' },
  { id: 2, name: 'UEFA Champions League', country: 'World' },
  { id: 3, name: 'UEFA Europa League', country: 'World' },
  { id: 848, name: 'UEFA Europa Conference League', country: 'World' },
  { id: 88, name: 'Eredivisie', country: 'Netherlands' },
  { id: 94, name: 'Primeira Liga', country: 'Portugal' },
  { id: 40, name: 'Championship', country: 'England' },
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

@Injectable()
export class FootballDataService {
  private readonly logger = new Logger(FootballDataService.name);
  private client: AxiosInstance;

  // In-memory caches to strictly respect rate limits and conserve quota
  private statsCache = new Map<string, any>();
  private h2hCache = new Map<string, any[]>();
  private oddsCache = new Map<number, any>();

  constructor(
    private configService: ConfigService,
    @InjectRepository(Fixture)
    private fixtureRepository: Repository<Fixture>,
  ) {
    const apiKey = this.configService.get<string>('FOOTBALL_API_KEY');
    const baseURL =
      this.configService.get<string>('FOOTBALL_API_BASE_URL') ||
      'https://v3.football.api-sports.io';

    this.client = axios.create({
      baseURL,
      headers: {
        'x-apisports-key': apiKey,
      },
      timeout: 10000,
    });
  }

  /**
   * Fetch and save all fixtures for a given date across target leagues
   */
  async syncFixturesForDate(dateStr: string): Promise<Fixture[]> {
    this.logger.log(`Syncing fixtures for date: ${dateStr}`);

    try {
      const response = await this.client.get('/fixtures', {
        params: {
          date: dateStr,
        },
      });

      const rawFixtures = response.data?.response || [];
      const savedFixtures: Fixture[] = [];

      for (const item of rawFixtures) {
        const leagueId = item.league?.id;
        const isTargetLeague = TARGET_LEAGUES.some((l) => l.id === leagueId);

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
    } catch (error) {
      this.logger.error(
        `Failed to sync fixtures for ${dateStr}: ${error.message}`,
      );
      return this.fixtureRepository.find();
    }
  }

  /**
   * Fetch bookmaker pre-match odds for a specific fixture (with in-memory cache)
   */
  async getOddsForFixture(apiFixtureId: number): Promise<any | null> {
    if (this.oddsCache.has(apiFixtureId)) {
      return this.oddsCache.get(apiFixtureId);
    }

    try {
      const response = await this.client.get('/odds', {
        params: {
          fixture: apiFixtureId,
        },
      });

      const oddsData = response.data?.response?.[0] || null;
      if (oddsData) {
        this.oddsCache.set(apiFixtureId, oddsData);
      }
      return oddsData;
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch Head-to-Head matches between two teams (with cache)
   */
  async getH2H(homeTeamId: number, awayTeamId: number): Promise<any[]> {
    const cacheKey = `${homeTeamId}-${awayTeamId}`;
    if (this.h2hCache.has(cacheKey)) {
      return this.h2hCache.get(cacheKey) || [];
    }

    try {
      const response = await this.client.get('/fixtures/headtohead', {
        params: {
          h2h: cacheKey,
        },
      });

      const data = response.data?.response || [];
      this.h2hCache.set(cacheKey, data);
      return data;
    } catch (error) {
      return [];
    }
  }

  /**
   * Fetch real team statistics with intelligent multi-season fallback & cache
   */
  async getTeamStats(
    teamId: number,
    leagueId: number,
  ): Promise<any | null> {
    const cacheKey = `${teamId}-${leagueId}`;
    if (this.statsCache.has(cacheKey)) {
      return this.statsCache.get(cacheKey);
    }

    // Try current season down to previous seasons (2024, 2023)
    for (const season of [2024, 2023]) {
      try {
        const response = await this.client.get('/teams/statistics', {
          params: {
            team: teamId,
            league: leagueId,
            season,
          },
        });

        const data = response.data?.response;
        const avg = parseFloat(data?.goals?.for?.average?.total || '0');

        if (avg > 0.1) {
          this.statsCache.set(cacheKey, data);
          return data;
        }
      } catch (error) {
        break; // Stop on network or rate limit error
      }
    }

    return null;
  }

  /**
   * Update final scores for finished matches
   */
  async updateFinishedFixtures(dateStr: string): Promise<Fixture[]> {
    try {
      const response = await this.client.get('/fixtures', {
        params: {
          date: dateStr,
          status: 'FT',
        },
      });

      const finishedData = response.data?.response || [];
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
    } catch (error) {
      this.logger.error(`Error updating finished fixtures: ${error.message}`);
      return [];
    }
  }
}
