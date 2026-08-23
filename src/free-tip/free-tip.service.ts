import { Injectable } from '@nestjs/common';

@Injectable()
export class FreeTipService {
  getFreeTip() {
    return {
      date: '27.08.2026',
      name: 'PSG v. FC Barcelona',
      prediction: 'Both Teams To Score',
    };
  }
}
