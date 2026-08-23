import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { FootballDataService } from './football-data.service';
import { Fixture } from '../fixtures/fixture.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Fixture]), ConfigModule],
  providers: [FootballDataService],
  exports: [FootballDataService],
})
export class FootballDataModule {}
