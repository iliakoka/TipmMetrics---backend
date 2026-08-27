import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface VenueWeather {
  temperatureCelsius: number;
  precipitationProbability: number; // 0-100
  windSpeedKmh: number;
  condition: 'clear' | 'light_rain' | 'heavy_rain' | 'strong_wind' | 'extreme';
  goalsPenalty: number;   // 0.0-1.0 multiplier applied to goals prediction (heavy rain slows scoring)
  description: string;
}

// Major stadium city coordinates — fallback for unmapped cities
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  'london':      { lat: 51.51, lon: -0.12 },
  'manchester':  { lat: 53.48, lon: -2.24 },
  'liverpool':   { lat: 53.41, lon: -2.98 },
  'madrid':      { lat: 40.42, lon: -3.70 },
  'barcelona':   { lat: 41.38, lon:  2.17 },
  'milan':       { lat: 45.47, lon:  9.19 },
  'rome':        { lat: 41.90, lon: 12.50 },
  'munich':      { lat: 48.14, lon: 11.58 },
  'dortmund':    { lat: 51.51, lon:  7.46 },
  'paris':       { lat: 48.86, lon:  2.35 },
  'amsterdam':   { lat: 52.37, lon:  4.90 },
  'lisbon':      { lat: 38.72, lon: -9.14 },
  'porto':       { lat: 41.16, lon: -8.63 },
  'istanbul':    { lat: 41.01, lon: 28.97 },
  'glasgow':     { lat: 55.86, lon: -4.25 },
  'edinburgh':   { lat: 55.95, lon: -3.19 },
  'brussels':    { lat: 50.85, lon:  4.35 },
  'stockholm':   { lat: 59.33, lon: 18.07 },
  'oslo':        { lat: 59.91, lon: 10.75 },
  'copenhagen':  { lat: 55.68, lon: 12.57 },
  'zurich':      { lat: 47.38, lon:  8.54 },
  'buenos aires':{ lat: -34.61, lon: -58.38 },
  'sao paulo':   { lat: -23.55, lon: -46.63 },
  'rio de janeiro': { lat: -22.91, lon: -43.17 },
  'mexico city': { lat: 19.43, lon: -99.13 },
  'los angeles': { lat: 34.05, lon: -118.24 },
  'salzburg':    { lat: 47.80, lon: 13.04 },
  'vienna':      { lat: 48.20, lon: 16.37 },
  'graz':        { lat: 47.07, lon: 15.43 },
  'aarhus':      { lat: 56.16, lon: 10.20 },
  'prague':      { lat: 50.07, lon: 14.43 },
  'bern':        { lat: 46.94, lon: 7.44 },
  'basel':       { lat: 47.55, lon: 7.58 },
  'athens':      { lat: 37.98, lon: 23.72 },
  'zagreb':      { lat: 45.81, lon: 15.98 },
};

@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);
  private cache = new Map<string, VenueWeather>();

  /**
   * Fetch weather for a venue city at the given kickoff time.
   * Uses Open-Meteo — completely free, no API key required.
   */
  async getWeatherForVenue(city: string, kickoffTime: Date): Promise<VenueWeather> {
    const cityKey = city.toLowerCase().trim();
    const cacheKey = `${cityKey}-${kickoffTime.toISOString().split('T')[0]}`;

    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const coords = this.findCoords(cityKey);
    if (!coords) {
      this.logger.debug(`No coords for city: ${city} — using neutral weather`);
      return this.neutralWeather();
    }

    try {
      const date = kickoffTime.toISOString().split('T')[0];
      const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
          latitude: coords.lat,
          longitude: coords.lon,
          hourly: 'temperature_2m,precipitation_probability,windspeed_10m',
          timezone: 'UTC',
          start_date: date,
          end_date: date,
          forecast_days: 1,
        },
        timeout: 5000,
      });

      const hourly = res.data?.hourly;
      if (!hourly) return this.neutralWeather();

      // Find the hour closest to kickoff
      const kickoffHour = kickoffTime.getUTCHours();
      const hours: string[] = hourly.time || [];
      const idx = hours.findIndex((t) => parseInt(t.split('T')[1]) === kickoffHour) ?? 0;
      const safeIdx = idx >= 0 ? idx : 0;

      const temp   = hourly.temperature_2m?.[safeIdx] ?? 15;
      const precip = hourly.precipitation_probability?.[safeIdx] ?? 0;
      const wind   = hourly.windspeed_10m?.[safeIdx] ?? 0;

      const weather = this.classifyWeather(temp, precip, wind);
      this.cache.set(cacheKey, weather);
      return weather;
    } catch (err) {
      this.logger.warn(`Weather fetch failed for ${city}: ${err.message}`);
      return this.neutralWeather();
    }
  }

  private findCoords(cityKey: string): { lat: number; lon: number } | null {
    // Exact match
    if (CITY_COORDS[cityKey]) return CITY_COORDS[cityKey];
    // Partial match
    for (const [key, coords] of Object.entries(CITY_COORDS)) {
      if (cityKey.includes(key) || key.includes(cityKey)) return coords;
    }
    return null;
  }

  private classifyWeather(temp: number, precip: number, wind: number): VenueWeather {
    let condition: VenueWeather['condition'] = 'clear';
    let goalsPenalty = 1.0;
    let description = `${temp.toFixed(0)}°C, clear`;

    if (precip > 70 || wind > 50) {
      condition = 'extreme';
      goalsPenalty = 0.75;
      description = `${temp.toFixed(0)}°C, extreme conditions (precip ${precip}%, wind ${wind}km/h)`;
    } else if (precip > 50) {
      condition = 'heavy_rain';
      goalsPenalty = 0.85;
      description = `${temp.toFixed(0)}°C, heavy rain likely (${precip}%)`;
    } else if (wind > 35) {
      condition = 'strong_wind';
      goalsPenalty = 0.90;
      description = `${temp.toFixed(0)}°C, strong wind (${wind}km/h)`;
    } else if (precip > 25) {
      condition = 'light_rain';
      goalsPenalty = 0.95;
      description = `${temp.toFixed(0)}°C, light rain possible (${precip}%)`;
    } else {
      description = `${temp.toFixed(0)}°C, ${wind < 15 ? 'calm' : 'breezy'}`;
    }

    return {
      temperatureCelsius: temp,
      precipitationProbability: precip,
      windSpeedKmh: wind,
      condition,
      goalsPenalty,
      description,
    };
  }

  private neutralWeather(): VenueWeather {
    return {
      temperatureCelsius: 15,
      precipitationProbability: 0,
      windSpeedKmh: 10,
      condition: 'clear',
      goalsPenalty: 1.0,
      description: 'Weather data unavailable',
    };
  }
}
