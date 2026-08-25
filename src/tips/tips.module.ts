import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TipsService } from './tips.service';
import { TipsController } from './tips.controller';
import { Tip } from './tip.entity';
import { Fixture } from '../fixtures/fixture.entity';
import { FootballDataModule } from '../football-data/football-data.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { OddsModule } from '../odds/odds-api.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tip, Fixture]),
    FootballDataModule,
    AnalyticsModule,
    OddsModule,
  ],
  controllers: [TipsController],
  providers: [TipsService],
  exports: [TipsService],
})
export class TipsModule {}
