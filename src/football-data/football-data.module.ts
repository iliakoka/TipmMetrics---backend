import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { FootballDataService } from './football-data.service';
import { FootballDataOrgService } from './football-data-org.service';
import { Fixture } from '../fixtures/fixture.entity';
import { TeamStat } from './team-stat.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Fixture, TeamStat]), ConfigModule],
  providers: [FootballDataService, FootballDataOrgService],
  exports: [FootballDataService, FootballDataOrgService],
})
export class FootballDataModule {}
