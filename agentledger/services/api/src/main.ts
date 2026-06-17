import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';

/** Parse a Go-style listen address (":8094") or a bare port; default 8094. */
function resolvePort(): number {
  const addr = process.env.AGENTLEDGER_API_ADDR;
  if (addr) {
    const port = Number(addr.replace(/^.*:/, ''));
    if (Number.isFinite(port) && port > 0) return port;
  }
  return 8094;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Structured JSON logging via pino.
  app.useLogger(app.get(Logger));

  // Reject unknown fields on writes; strip non-whitelisted props (security rule 5).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // RFC 7807 problem+json for every error response.
  app.useGlobalFilters(new ProblemDetailsFilter());

  // Cap request bodies (control-plane writes are small).
  app.use(json({ limit: process.env.AGENTLEDGER_API_BODY_LIMIT ?? '256kb' }));

  app.enableShutdownHooks();

  const port = resolvePort();
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
