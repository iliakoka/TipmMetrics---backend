import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TipsService } from '../tips/tips.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly tipsService: TipsService) {}

  /**
   * Daily at 06:00 AM UTC — Generate the Top 5-7 Tips for Today
   */
  @Cron('0 6 * * *')
  async handleDailyTipGeneration() {
    this.logger.log('CRON: Running morning automated tip generation (06:00 UTC)...');
    try {
      await this.tipsService.generateDailyTips();
      this.logger.log('CRON: Morning tip generation finished successfully.');
    } catch (err) {
      this.logger.error(`CRON: Error in daily tip generation: ${err.message}`);
    }
  }

  /**
   * Daily at 23:30 PM UTC — Settle Match Results and Calculate Won/Lost Status
   */
  @Cron('30 23 * * *')
  async handleDailySettlementNight() {
    this.logger.log('CRON: Running night settlement check (23:30 UTC)...');
    try {
      await this.tipsService.settleDailyTips();
    } catch (err) {
      this.logger.error(`CRON: Error in night settlement: ${err.message}`);
    }
  }

  /**
   * Daily at 02:00 AM UTC — Final Settlement pass for late/overseas matches
   */
  @Cron('0 2 * * *')
  async handleDailySettlementLate() {
    this.logger.log('CRON: Running late settlement check (02:00 UTC)...');
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
      await this.tipsService.settleDailyTips(yesterday);
    } catch (err) {
      this.logger.error(`CRON: Error in late settlement: ${err.message}`);
    }
  }
}
