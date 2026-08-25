import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FreeTipModule } from './free-tip/free-tip.module';
import { AuthModule } from './auth/auth.module';
import { FootballDataModule } from './football-data/football-data.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TipsModule } from './tips/tips.module';
import { SchedulerModule } from './scheduler/scheduler.module';

import { User } from './users/user.entity';
import { Fixture } from './fixtures/fixture.entity';
import { Tip } from './tips/tip.entity';
import { TeamStat } from './football-data/team-stat.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get<string>('DATABASE_URL'),
        entities: [User, Fixture, Tip, TeamStat],
        synchronize: true, // auto-creates/updates tables in PostgreSQL
        ssl: { rejectUnauthorized: false },
      }),
      inject: [ConfigService],
    }),
    FreeTipModule,
    AuthModule,
    FootballDataModule,
    AnalyticsModule,
    TipsModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
