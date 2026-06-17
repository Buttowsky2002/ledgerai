import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppModule } from '../app.module';
import { buildOpenApiDocument } from '../swagger';

/**
 * Writes docs/api/openapi.json (the published spec) without a running server or
 * any datastore: Nest preview mode instantiates the module graph for metadata
 * scanning but runs no providers/lifecycle hooks (so no Postgres/ClickHouse/JWT
 * secret needed). Run after `nest build` so the @nestjs/swagger plugin metadata is
 * baked into the compiled module. Path is resolved from the npm cwd (services/api).
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  const document = buildOpenApiDocument(app);
  const out = resolve(process.cwd(), '../../docs/api/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  process.stdout.write(`wrote ${out}\n`);
}

void main();
