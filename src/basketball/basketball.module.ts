import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BasketballDataService } from './basketball-data.service';
import { BasketballPredictionEngineService } from './basketball-prediction-engine.service';

@Module({
  imports: [ConfigModule],
  providers: [BasketballDataService, BasketballPredictionEngineService],
  exports: [BasketballDataService, BasketballPredictionEngineService],
})
export class BasketballModule {}
