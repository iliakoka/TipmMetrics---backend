import { Module } from '@nestjs/common';
import { MatchAnalyzerService } from './match-analyzer.service';
import { FootballDataModule } from '../football-data/football-data.module';
import { WeatherModule } from '../weather/weather.module';
import { OddsModule } from '../odds/odds-api.module';

@Module({
  imports: [FootballDataModule, WeatherModule, OddsModule],
  providers: [MatchAnalyzerService],
  exports: [MatchAnalyzerService],
})
export class MatchAnalysisModule {}
