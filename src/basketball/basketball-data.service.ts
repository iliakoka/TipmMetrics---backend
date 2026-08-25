import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Fixture } from '../fixtures/fixture.entity';

export const TARGET_BASKETBALL_LEAGUES = [
  { id: 12, name: 'NBA', country: 'USA' },
  { id: 120, name: 'EuroLeague', country: 'Europe' },
  { id: 117, name: 'Liga ACB', country: 'Spain' },
  { id: 2, name: 'Lega Basket Serie A', country: 'Italy' },
  { id: 197, name: 'BBL', country: 'Germany' },
  { id: 194, name: 'LNB Pro A', country: 'France' },
  { id: 128, name: 'EuroCup', country: 'Europe' },
  { id: 147, name: 'NBL', country: 'Australia' },
  { id: 104, name: 'CBA', country: 'China' },
  { id: 11, name: 'WNBA', country: 'USA' },
];

@Injectable()
export class BasketballDataService {
  private readonly logger = new Logger(BasketballDataService.name);
  private client: AxiosInstance;

  private gamesCache = new Map<string, any[]>();
  private oddsCache = new Map<number, any>();

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('FOOTBALL_API_KEY');
    const baseURL = 'https://v1.basketball.api-sports.io';

    this.client = axios.create({
      baseURL,
      headers: {
        'x-apisports-key': apiKey,
      },
      timeout: 10000,
    });
  }

  /**
   * Fetch today's basketball games
   */
  async getGamesForDate(dateStr: string): Promise<any[]> {
    if (this.gamesCache.has(dateStr)) {
      return this.gamesCache.get(dateStr) || [];
    }

    try {
      this.logger.log(`Fetching basketball games for date: ${dateStr}`);
      const response = await this.client.get('/games', {
        params: {
          date: dateStr,
        },
      });

      const games = response.data?.response || [];
      this.gamesCache.set(dateStr, games);
      return games;
    } catch (error) {
      this.logger.error(`Failed to fetch basketball games: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch odds for a basketball game
   */
  async getOddsForGame(gameId: number): Promise<any | null> {
    if (this.oddsCache.has(gameId)) {
      return this.oddsCache.get(gameId);
    }

    try {
      const response = await this.client.get('/odds', {
        params: {
          game: gameId,
        },
      });

      const odds = response.data?.response?.[0] || null;
      if (odds) {
        this.oddsCache.set(gameId, odds);
      }
      return odds;
    } catch (error) {
      return null;
    }
  }

  /**
   * Update finished game scores in database
   */
  async updateFinishedGames(
    dateStr: string,
    fixtureRepository: Repository<Fixture>,
  ): Promise<void> {
    try {
      const response = await this.client.get('/games', {
        params: {
          date: dateStr,
        },
      });

      const finishedGames = response.data?.response || [];
      for (const item of finishedGames) {
        if (item.status?.short === 'FT' || item.status?.short === 'AOT') {
          const fixture = await fixtureRepository.findOne({
            where: { apiFixtureId: item.id },
          });

          if (fixture) {
            fixture.status = item.status?.short;
            fixture.homeGoals = item.scores?.home?.total ?? null;
            fixture.awayGoals = item.scores?.away?.total ?? null;
            await fixtureRepository.save(fixture);
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Error updating finished basketball games: ${error.message}`,
      );
    }
  }
}
