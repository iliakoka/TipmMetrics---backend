import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TipsService } from '../tips/tips.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly tipsService: TipsService) {}

  /**
   * STEP 1 — Every day at 00:00 AM UTC
   * Settle yesterday's predictions: mark each tip as WON / LOST
   * and push results into statistics before new tips are generated.
   */
  @Cron('0 0 * * *')
  async handleSettlement() {
    this.logger.log('[CRON 00:00 UTC] Settling yesterday\'s tips...');
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];

      const result = await this.tipsService.settleDailyTips(yesterday);
      this.logger.log(
        `[CRON 00:00 UTC] Settlement done — ${result.settled} settled, ${result.won} WON, ${result.lost} LOST`,
      );
    } catch (err) {
      this.logger.error(`[CRON 00:00 UTC] Settlement error: ${err.message}`);
    }
  }

  /**
   * STEP 2 — Every day at 00:05 AM UTC (5 minutes after settlement)
   * Generate fresh tips for today's matches.
   */
  @Cron('5 0 * * *')
  async handleDailyTipGeneration() {
    this.logger.log('[CRON 00:05 UTC] Generating today\'s tips...');
    try {
      const tips = await this.tipsService.generateDailyTips();
      this.logger.log(`[CRON 00:05 UTC] ${tips.length} tips generated for today.`);
    } catch (err) {
      this.logger.error(`[CRON 00:05 UTC] Generation error: ${err.message}`);
    }
  }


}

