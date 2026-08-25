import { Injectable } from '@nestjs/common';
import { TipsService } from '../tips/tips.service';

@Injectable()
export class FreeTipService {
  constructor(private readonly tipsService: TipsService) {}

  async getFreeTip() {
    const todayTips = await this.tipsService.getTodayTips();

    // 1. Pick the algorithm's designated free tip of the day
    const freeTip = todayTips.find((t) => t.isFree) || todayTips[0];

    if (freeTip) {
      const matchDateObj = new Date(freeTip.matchDate);
      const formattedDate = matchDateObj.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }); // e.g. "24.08.2026"

      return {
        id: freeTip.id,
        date: formattedDate,
        name: `${freeTip.homeTeamName} v. ${freeTip.awayTeamName}`,
        league: freeTip.leagueName,
        prediction: freeTip.prediction,
        odds: Number(freeTip.odds),
        confidence: Number(freeTip.confidenceScore),
        isFree: true,
      };
    }

    // If no tips exist yet, return null (frontend can display empty state)
    return null;
  }
}
