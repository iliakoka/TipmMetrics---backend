import { Module } from '@nestjs/common';
import { OddsApiService } from './odds-api.service';

@Module({
  providers: [OddsApiService],
  exports: [OddsApiService],
})
export class OddsModule {}
