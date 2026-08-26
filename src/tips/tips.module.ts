import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TipsService } from './tips.service';
import { TipsController } from './tips.controller';
import { Tip } from './tip.entity';
import { FootballDataModule } from '../football-data/football-data.module';
import { MatchAnalysisModule } from '../match-analysis/match-analysis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tip]),
    FootballDataModule,
    MatchAnalysisModule,
  ],
  controllers: [TipsController],
  providers: [TipsService],
  exports: [TipsService],
})
export class TipsModule {}
