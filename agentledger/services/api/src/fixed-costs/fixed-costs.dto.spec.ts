import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateFixedCostDto } from './fixed-costs.dto';

describe('CreateFixedCostDto', () => {
  const valid = {
    periodMonth: '2026-06-01',
    vendor: 'openai',
    costType: 'seat_license',
    costUsd: 600,
    lineItem: 'ChatGPT Team',
  };

  it('accepts a valid manual fixed-cost row', async () => {
    const dto = plainToInstance(CreateFixedCostDto, valid);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects non-month-start periodMonth', async () => {
    const dto = plainToInstance(CreateFixedCostDto, { ...valid, periodMonth: '2026-06-15' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'periodMonth')).toBe(true);
  });

  it('rejects invalid vendor enum', async () => {
    const dto = plainToInstance(CreateFixedCostDto, { ...valid, vendor: 'azure' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'vendor')).toBe(true);
  });

  it('rejects negative costUsd', async () => {
    const dto = plainToInstance(CreateFixedCostDto, { ...valid, costUsd: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'costUsd')).toBe(true);
  });
});
