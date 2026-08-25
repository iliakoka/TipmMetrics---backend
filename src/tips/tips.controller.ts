import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { TipsService } from './tips.service';

@Controller('tips')
export class TipsController {
  constructor(private readonly tipsService: TipsService) {}

  /**
   * GET /tips/today — returns today's top 5-7 tips
   */
  @Get('today')
  async getTodayTips() {
    return this.tipsService.getTodayTips();
  }

  /**
   * GET /tips/history — returns verified past tips with outcomes
   */
  @Get('history')
  async getHistory(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.tipsService.getHistory(parseInt(page, 10), parseInt(limit, 10));
  }

  /**
   * GET /tips/stats — returns win rate %, ROI, average odds, and market metrics
   */
  @Get('stats')
  async getStats() {
    return this.tipsService.getStats();
  }

  /**
   * GET /tips/debug — returns diagnostic info for a date without saving tips
   */
  @Get('debug')
  async debugGeneration(@Query('date') date?: string) {
    return this.tipsService.debugGeneration(date);
  }

  /**
   * POST /tips/generate — manually trigger tip generation with optional force refresh
   */
  @Post('generate')
  async generateDailyTips(
    @Body('date') date?: string,
    @Body('force') force?: boolean,
  ) {
    return this.tipsService.generateDailyTips(date, force);
  }

  /**
   * POST /tips/settle — manually trigger settlement of finished match scores
   */
  @Post('settle')
  async settleDailyTips(@Body('date') date?: string) {
    return this.tipsService.settleDailyTips(date);
  }
}
