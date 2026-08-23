import { Module } from '@nestjs/common';
import { PredictionEngineService } from './prediction-engine.service';

@Module({
  providers: [PredictionEngineService],
  exports: [PredictionEngineService],
})
export class AnalyticsModule {}
