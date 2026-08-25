import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TipsService } from '../tips/tips.service';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly tipsService: TipsService) {}

  /**
   * On startup — generate today's tips in the background.
   * Uses setImmediate so Railway's health check passes instantly.
   */
  onModuleInit() {
    setImmediate(async () => {
      this.logger.log('[Startup] Triggering today\'s tip generation in background...');
      try {
        const tips = await this.tipsService.generateDailyTips();
        this.logger.log(`[Startup] ${tips.length} tips ready for today.`);
      } catch (err) {
        this.logger.error(`[Startup] Tip generation failed: ${err.message}`);
      }
    });
  }

  /**
   * STEP 1 — Every day at 05:55 AM UTC
   * Settle yesterday's predictions: mark each tip as WON / LOST
   * and push results into statistics before new tips are generated.
   */
  @Cron('55 5 * * *')
  async handleSettlement() {
    this.logger.log('[CRON 05:55 UTC] Settling yesterday\'s tips...');
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];

      const result = await this.tipsService.settleDailyTips(yesterday);
      this.logger.log(
        `[CRON 05:55 UTC] Settlement done — ${result.settled} settled, ${result.won} WON, ${result.lost} LOST`,
      );
    } catch (err) {
      this.logger.error(`[CRON 05:55 UTC] Settlement error: ${err.message}`);
    }
  }

  /**
   * STEP 2 — Every day at 06:00 AM UTC (5 minutes after settlement)
   * Generate fresh tips for today's matches.
   */
  @Cron('0 6 * * *')
  async handleDailyTipGeneration() {
    this.logger.log('[CRON 06:00 UTC] Generating today\'s tips...');
    try {
      const tips = await this.tipsService.generateDailyTips();
      this.logger.log(`[CRON 06:00 UTC] ${tips.length} tips generated for today.`);
    } catch (err) {
      this.logger.error(`[CRON 06:00 UTC] Generation error: ${err.message}`);
    }
  }

  /**
   * SAFETY NET — Every day at 09:00 AM UTC
   * If fewer than 5 tips exist (generation failed or API limit was hit),
   * force-regenerate using the Odds API fallback.
   */
  @Cron('0 9 * * *')
  async handleSafetyRetry() {
    this.logger.log('[CRON 09:00 UTC] Checking tip count...');
    try {
      const todayTips = await this.tipsService.getTodayTips();
      if (todayTips.length < 5) {
        this.logger.warn(
          `[CRON 09:00 UTC] Only ${todayTips.length} tips — force-regenerating...`,
        );
        const tips = await this.tipsService.generateDailyTips(undefined, true);
        this.logger.log(`[CRON 09:00 UTC] Safety retry produced ${tips.length} tips.`);
      } else {
        this.logger.log(`[CRON 09:00 UTC] ${todayTips.length} tips OK — no retry needed.`);
      }
    } catch (err) {
      this.logger.error(`[CRON 09:00 UTC] Safety retry error: ${err.message}`);
    }
  }

  /**
   * LATE SETTLEMENT — Every day at 23:45 PM UTC
   * Catch any matches that finished late in the evening.
   */
  @Cron('45 23 * * *')
  async handleLateSettlement() {
    this.logger.log('[CRON 23:45 UTC] Running late settlement check...');
    try {
      const result = await this.tipsService.settleDailyTips();
      this.logger.log(
        `[CRON 23:45 UTC] Late settlement — ${result.settled} settled, ${result.won} WON, ${result.lost} LOST`,
      );
    } catch (err) {
      this.logger.error(`[CRON 23:45 UTC] Late settlement error: ${err.message}`);
    }
  }
}
