import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

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
    const apiKey = this.configService.get<string>('FOOTBALL_API_KEY'); // Same API-Sports key
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
   * Update finished game scores
   */
  async getFinishedGames(dateStr: string): Promise<any[]> {
    try {
      const response = await this.client.get('/games', {
        params: {
          date: dateStr,
        },
      });

      const games = response.data?.response || [];
      return games.filter((g) => g.status?.short === 'FT' || g.status?.short === 'AOT');
    } catch (error) {
      return [];
    }
  }
}
