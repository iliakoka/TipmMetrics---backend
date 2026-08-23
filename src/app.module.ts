import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FreeTipModule } from './free-tip/free-tip.module';
import { AuthModule } from './auth/auth.module';
import { User } from './users/user.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get<string>('DATABASE_URL'),
        entities: [User],
        synchronize: true, // auto-creates/updates tables — disable in production later
        ssl: { rejectUnauthorized: false },
      }),
      inject: [ConfigService],
    }),
    FreeTipModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
