import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { recordAudit } from '../common/audit';
import { ConnectorDefinition } from './types/connector-definition';

const PRESETS_DIR = join(__dirname, 'presets');

@Injectable()
export class ConnectorDefinitionsService {
  private readonly builtinPresets: Map<string, ConnectorDefinition> = new Map();

  constructor(private readonly prisma: PrismaService) {
    this.loadPresets();
  }

  private loadPresets(): void {
    try {
      const files = readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const raw = JSON.parse(readFileSync(join(PRESETS_DIR, file), 'utf8')) as ConnectorDefinition;
        const id = file.replace('.json', '');
        this.builtinPresets.set(id, { ...raw, id });
      }
    } catch {
      // Presets optional in test environments without compiled assets.
    }
  }

  listBuiltin(): ConnectorDefinition[] {
    return [...this.builtinPresets.values()];
  }

  getBuiltin(id: string): ConnectorDefinition {
    const def = this.builtinPresets.get(id);
    if (!def) throw new NotFoundException(`preset ${id} not found`);
    return def;
  }

  async list(): Promise<unknown[]> {
    const tenantId = getTenantId();
    const custom = tenantId
      ? await this.prisma.withTenant(tenantId, (tx) =>
          tx.connectorDefinition.findMany({ where: { builtIn: false }, orderBy: { name: 'asc' } }),
        )
      : [];
    const builtins = this.listBuiltin().map((d) => ({
      definitionId: d.id,
      name: d.name,
      provider: d.provider,
      category: d.category,
      builtIn: true,
      definitionJson: d,
    }));
    return [...builtins, ...custom];
  }

  async get(id: string): Promise<ConnectorDefinition> {
    if (this.builtinPresets.has(id)) return this.getBuiltin(id);
    const tenantId = getTenantId();
    const row = await this.prisma.withTenant(tenantId!, (tx) =>
      tx.connectorDefinition.findUnique({ where: { definitionId: id } }),
    );
    if (!row) throw new NotFoundException('connector definition not found');
    return row.definitionJson as unknown as ConnectorDefinition;
  }

  async createCustom(definition: ConnectorDefinition): Promise<unknown> {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant in context');
    if (!definition.name || !definition.baseUrl) {
      throw new BadRequestException('name and baseUrl are required');
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const created = await tx.connectorDefinition.create({
        data: {
          tenantId,
          name: definition.name,
          provider: definition.provider ?? 'custom',
          category: definition.category ?? 'custom',
          definitionJson: definition as object,
          builtIn: false,
        },
      });
      await recordAudit(tx, {
        action: 'create',
        object: `connector_definition:${created.definitionId}`,
        before: null,
        after: created,
      });
      return created;
    });
  }
}
