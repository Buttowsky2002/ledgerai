import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Build the OpenAPI document from the app's controllers/DTOs (enriched by the
 * @nestjs/swagger CLI plugin at build time). Shared by the runtime Swagger UI
 * (main.ts) and the spec generator (cli/generate-openapi.ts) so they never drift.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('AgentLedger Control-Plane API')
    .setDescription('Tenant-scoped control plane: resources, auth, and analytics over the MVs.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // Apply the bearer scheme globally (most routes require auth; @Public ones are
  // documented but harmless to mark).
  document.security = [{ bearer: [] }];
  return document;
}
