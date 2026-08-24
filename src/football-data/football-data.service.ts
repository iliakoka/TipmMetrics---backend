import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Fixture } from '../fixtures/fixture.entity';

// Top leagues to track for high-quality data
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
];

@Injectable()
export class FootballDataService {
  private readonly logger = new Logger(FootballDataService.name);
  private client: AxiosInstance;

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
      timeout: 15000,
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
      return [];
    }
  }

  /**
   * Fetch bookmaker pre-match odds for a specific fixture
   */
  async getOddsForFixture(apiFixtureId: number): Promise<any | null> {
    try {
      const response = await this.client.get('/odds', {
        params: {
          fixture: apiFixtureId,
        },
      });

      const oddsData = response.data?.response?.[0];
      return oddsData || null;
    } catch (error) {
      this.logger.warn(
        `Could not fetch odds for fixture ${apiFixtureId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Fetch Head-to-Head matches between two teams
   */
  async getH2H(homeTeamId: number, awayTeamId: number): Promise<any[]> {
    try {
      const response = await this.client.get('/fixtures/headtohead', {
        params: {
          h2h: `${homeTeamId}-${awayTeamId}`,
        },
      });

      return response.data?.response || [];
    } catch (error) {
      this.logger.warn(`Could not fetch H2H for ${homeTeamId} vs ${awayTeamId}`);
      return [];
    }
  }

  /**
   * Fetch real team statistics from API-Sports
   */
  async getTeamStats(
    teamId: number,
    leagueId: number,
    season = 2024,
  ): Promise<any | null> {
    try {
      const response = await this.client.get('/teams/statistics', {
        params: {
          team: teamId,
          league: leagueId,
          season,
        },
      });

      return response.data?.response || null;
    } catch (error) {
      this.logger.warn(
        `Could not fetch team statistics for team ${teamId}: ${error.message}`,
      );
      return null;
    }
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
