import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // allows your frontend to call this backend
  app.useGlobalPipes(new ValidationPipe()); // validates all incoming request bodies
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
