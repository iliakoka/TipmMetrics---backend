import { Module } from '@nestjs/common';
import { FreeTipController } from './free-tip.controller';
import { FreeTipService } from './free-tip.service';

@Module({
  controllers: [FreeTipController],
  providers: [FreeTipService],
})
export class FreeTipModule {}
