import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface OddsCandidate {
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date;
  sportKey: string;
  leagueName: string;
  market: string;       // 'HOME_WIN' | 'AWAY_WIN' | 'DRAW' | 'OVER_2_5' | 'UNDER_2_5' | 'BTTS_YES' | 'BTTS_NO'
  prediction: string;   // human-readable
  consensusOdds: number;
  impliedProbability: number; // 0–100
  confidenceScore: number;    // 0–100
  bookmakerCount: number;
}

// Soccer sport keys covered on The Odds API free tier
const SOCCER_SPORT_KEYS = [
  { key: 'soccer_epl',                       name: 'Premier League' },
  { key: 'soccer_spain_la_liga',             name: 'La Liga' },
  { key: 'soccer_germany_bundesliga',        name: 'Bundesliga' },
  { key: 'soccer_italy_serie_a',             name: 'Serie A' },
  { key: 'soccer_france_ligue_one',          name: 'Ligue 1' },
  { key: 'soccer_uefa_champs_league',        name: 'UEFA Champions League' },
  { key: 'soccer_uefa_europa_league',        name: 'UEFA Europa League' },
  { key: 'soccer_england_efl_cup',           name: 'EFL Cup' },
  { key: 'soccer_efl_champ',                 name: 'EFL Championship' },
  { key: 'soccer_netherlands_eredivisie',    name: 'Eredivisie' },
  { key: 'soccer_portugal_primeira_liga',    name: 'Primeira Liga' },
  { key: 'soccer_turkey_super_league',       name: 'Süper Lig' },
];

@Injectable()
export class OddsApiService {
  private readonly logger = new Logger(OddsApiService.name);
  private client: AxiosInstance;
  private apiKey: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('ODDS_API_KEY') || '';
    this.client = axios.create({
      baseURL: 'https://api.the-odds-api.com/v4',
      timeout: 10000,
    });
  }

  /**
   * Fetch bookmaker consensus odds for all soccer matches on a given date
   * and return ranked tip candidates.
   */
  async getCandidatesForDate(dateStr: string): Promise<OddsCandidate[]> {
    if (!this.apiKey) {
      this.logger.warn('ODDS_API_KEY not set — skipping Odds API fetch');
      return [];
    }

    const targetDate = new Date(`${dateStr}T00:00:00.000Z`);
    const nextDay    = new Date(`${dateStr}T23:59:59.999Z`);

    const allCandidates: OddsCandidate[] = [];
    let requestsUsed = 0;

    for (const sport of SOCCER_SPORT_KEYS) {
      try {
        const data = await this.fetchOdds(sport.key);
        if (!data || data.length === 0) continue;

        // Filter to target date only
        const todayEvents = data.filter((event: any) => {
          const t = new Date(event.commence_time);
          return t >= targetDate && t <= nextDay;
        });

        if (todayEvents.length === 0) continue;

        this.logger.log(`${sport.name}: ${todayEvents.length} matches on ${dateStr}`);

        for (const event of todayEvents) {
          const candidates = this.extractCandidates(event, sport.name);
          allCandidates.push(...candidates);
        }

        requestsUsed++;
      } catch (err) {
        this.logger.warn(`Failed to fetch odds for ${sport.key}: ${err.message}`);
      }
    }

    this.logger.log(`Odds API: ${requestsUsed} requests, ${allCandidates.length} raw candidates for ${dateStr}`);
    return allCandidates;
  }

  private async fetchOdds(sportKey: string): Promise<any[]> {
    const res = await this.client.get(`/sports/${sportKey}/odds`, {
      params: {
        apiKey:     this.apiKey,
        regions:    'eu,uk',
        markets:    'h2h,totals',
        oddsFormat: 'decimal',
      },
    });

    // Log remaining quota from headers
    const remaining = res.headers['x-requests-remaining'];
    if (remaining !== undefined) {
      this.logger.log(`Odds API quota remaining: ${remaining}`);
    }

    return res.data || [];
  }

  /**
   * Extract tip candidates from a single event's bookmaker odds.
   * Computes consensus odds by averaging across all bookmakers.
   */
  private extractCandidates(event: any, leagueName: string): OddsCandidate[] {
    const candidates: OddsCandidate[] = [];
    const homeTeam     = event.home_team;
    const awayTeam     = event.away_team;
    const commenceTime = new Date(event.commence_time);

    // Aggregate all bookmaker prices per outcome
    const h2hPrices: { home: number[]; draw: number[]; away: number[] } = {
      home: [], draw: [], away: [],
    };
    const totalsPrices: { over: number[]; under: number[] } = {
      over: [], under: [],
    };

    for (const bookmaker of (event.bookmakers || [])) {
      for (const market of (bookmaker.markets || [])) {
        if (market.key === 'h2h') {
          for (const outcome of market.outcomes) {
            if (outcome.name === homeTeam) h2hPrices.home.push(outcome.price);
            else if (outcome.name === awayTeam) h2hPrices.away.push(outcome.price);
            else h2hPrices.draw.push(outcome.price);
          }
        }
        if (market.key === 'totals') {
          for (const outcome of market.outcomes) {
            if (outcome.name === 'Over')  totalsPrices.over.push(outcome.price);
            if (outcome.name === 'Under') totalsPrices.under.push(outcome.price);
          }
        }
      }
    }

    const bookmakerCount = (event.bookmakers || []).length;

    // Build H2H candidates
    const h2hOutcomes = [
      { prices: h2hPrices.home, market: 'HOME_WIN', prediction: `${homeTeam} To Win` },
      { prices: h2hPrices.away, market: 'AWAY_WIN', prediction: `${awayTeam} To Win` },
      { prices: h2hPrices.draw, market: 'DRAW',     prediction: 'Draw' },
    ];
    for (const o of h2hOutcomes) {
      if (o.prices.length < 2) continue; // Need at least 2 bookmakers
      const avg = this.average(o.prices);
      const implied = (1 / avg) * 100;
      if (implied >= 52 && avg >= 1.30 && avg <= 3.00) {
        candidates.push({
          homeTeam, awayTeam, commenceTime, leagueName,
          sportKey: event.sport_key,
          market: o.market,
          prediction: o.prediction,
          consensusOdds: Math.round(avg * 100) / 100,
          impliedProbability: Math.round(implied * 10) / 10,
          confidenceScore: this.computeConfidence(implied, avg, o.prices),
          bookmakerCount,
        });
      }
    }

    // Build Totals (Over/Under 2.5) candidates
    const totalsOutcomes = [
      { prices: totalsPrices.over,  market: 'OVER_2_5',  prediction: 'Over 2.5 Goals' },
      { prices: totalsPrices.under, market: 'UNDER_2_5', prediction: 'Under 2.5 Goals' },
    ];
    for (const o of totalsOutcomes) {
      if (o.prices.length < 2) continue;
      const avg = this.average(o.prices);
      const implied = (1 / avg) * 100;
      if (implied >= 55 && avg >= 1.40 && avg <= 2.50) {
        candidates.push({
          homeTeam, awayTeam, commenceTime, leagueName,
          sportKey: event.sport_key,
          market: o.market,
          prediction: o.prediction,
          consensusOdds: Math.round(avg * 100) / 100,
          impliedProbability: Math.round(implied * 10) / 10,
          confidenceScore: this.computeConfidence(implied, avg, o.prices),
          bookmakerCount,
        });
      }
    }

    return candidates;
  }

  private average(prices: number[]): number {
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  /**
   * Confidence = implied probability + bonus for bookmaker agreement (low variance)
   * Capped at 95.
   */
  private computeConfidence(implied: number, avgOdds: number, prices: number[]): number {
    // Variance penalty: high spread across bookmakers = lower confidence
    const mean = this.average(prices);
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const agreementBonus = Math.max(0, 5 - stdDev * 10); // up to +5 if books agree tightly

    // Bookmaker count bonus: more books = more liquidity = more reliable
    const countBonus = Math.min(5, prices.length * 0.5);

    const score = implied + agreementBonus + countBonus;
    return Math.min(95, Math.round(score * 10) / 10);
  }
}
