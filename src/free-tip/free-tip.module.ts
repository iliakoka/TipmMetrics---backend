import { Module } from '@nestjs/common';
import { FreeTipController } from './free-tip.controller';
import { FreeTipService } from './free-tip.service';
import { TipsModule } from '../tips/tips.module';

@Module({
  imports: [TipsModule],
  controllers: [FreeTipController],
  providers: [FreeTipService],
})
export class FreeTipModule {}
