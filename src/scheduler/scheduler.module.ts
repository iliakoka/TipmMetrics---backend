import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { TipsModule } from '../tips/tips.module';

@Module({
  imports: [ScheduleModule.forRoot(), TipsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
