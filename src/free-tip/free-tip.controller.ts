import { Controller, Get } from '@nestjs/common';
import { FreeTipService } from './free-tip.service';

@Controller()
export class FreeTipController {
  constructor(private readonly freeTipService: FreeTipService) {}

  @Get('free-tip-test')
  getFreeTip() {
    return this.freeTipService.getFreeTip();
  }
}
