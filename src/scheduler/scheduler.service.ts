import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TipsService } from '../tips/tips.service';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly tipsService: TipsService) {}

  /**
   * On startup — generate today's tips immediately so a fresh deploy never
   * serves an empty slate.
   */
  async onModuleInit() {
    this.logger.log('Startup: triggering today\'s tip generation...');
    try {
      const tips = await this.tipsService.generateDailyTips();
      this.logger.log(`Startup: ${tips.length} tips ready for today.`);
    } catch (err) {
      this.logger.error(`Startup tip generation failed: ${err.message}`);
    }
  }

  /**
   * Daily at 06:00 AM UTC — Generate the Top 5-7 Tips for Today
   */
  @Cron('0 6 * * *')
  async handleDailyTipGeneration() {
    this.logger.log('CRON 06:00 UTC: Running morning tip generation...');
    try {
      const tips = await this.tipsService.generateDailyTips();
      this.logger.log(`CRON 06:00 UTC: ${tips.length} tips generated.`);
    } catch (err) {
      this.logger.error(`CRON 06:00 UTC: Error: ${err.message}`);
    }
  }

  /**
   * Daily at 10:00 AM UTC — Safety retry: if fewer than 5 tips exist for
   * today (e.g. 06:00 generation failed or produced too few), force-regenerate.
   */
  @Cron('0 10 * * *')
  async handleDailyTipRetry() {
    this.logger.log('CRON 10:00 UTC: Checking today\'s tip count...');
    try {
      const todayTips = await this.tipsService.getTodayTips();
      if (todayTips.length < 5) {
        this.logger.warn(
          `CRON 10:00 UTC: Only ${todayTips.length} tips found — force-regenerating...`,
        );
        const tips = await this.tipsService.generateDailyTips(undefined, true);
        this.logger.log(`CRON 10:00 UTC: Retry produced ${tips.length} tips.`);
      } else {
        this.logger.log(`CRON 10:00 UTC: ${todayTips.length} tips OK — no retry needed.`);
      }
    } catch (err) {
      this.logger.error(`CRON 10:00 UTC: Retry error: ${err.message}`);
    }
  }

  /**
   * Daily at 23:30 PM UTC — Settle Match Results and Calculate Won/Lost Status
   */
  @Cron('30 23 * * *')
  async handleDailySettlementNight() {
    this.logger.log('CRON 23:30 UTC: Running night settlement check...');
    try {
      await this.tipsService.settleDailyTips();
    } catch (err) {
      this.logger.error(`CRON 23:30 UTC: Settlement error: ${err.message}`);
    }
  }

  /**
   * Daily at 02:00 AM UTC — Final Settlement pass for late/overseas matches
   */
  @Cron('0 2 * * *')
  async handleDailySettlementLate() {
    this.logger.log('CRON 02:00 UTC: Running late settlement check...');
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
      await this.tipsService.settleDailyTips(yesterday);
    } catch (err) {
      this.logger.error(`CRON 02:00 UTC: Late settlement error: ${err.message}`);
    }
  }
}
