import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // allows your frontend to call this backend
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
