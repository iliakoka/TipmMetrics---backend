import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FreeTipModule } from './free-tip/free-tip.module';

@Module({
  imports: [FreeTipModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
