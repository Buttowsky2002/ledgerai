import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { env } from '../env';
import { OnboardDesignPartnerDto } from './design-partner.dto';
import { DesignPartnerOnboardingService } from './design-partner.service';

@Controller('v1/design-partner')
export class DesignPartnerController {
  constructor(private readonly onboarding: DesignPartnerOnboardingService) {}

  private assertEnabled(): void {
    if (env('BADGERIQ_DESIGN_PARTNER_ONBOARD_ENABLED') !== 'true') {
      throw new ForbiddenException('design partner onboarding is disabled');
    }
  }

  /** List built-in onboarding presets (e.g. studio-live). */
  @Roles('admin')
  @Get('presets')
  listPresets(): { presets: string[] } {
    this.assertEnabled();
    return { presets: this.onboarding.listPresets() };
  }

  /**
   * One-shot agent + outcome graph setup for design partner demos.
   * Registers agents, seeds bootstrap runs/outcomes, triggers attribution V2,
   * and returns LARI verification for the presentation window.
   */
  @Roles('admin')
  @Post('onboard')
  onboard(@Body() dto: OnboardDesignPartnerDto) {
    this.assertEnabled();
    return this.onboarding.onboard(dto);
  }
}
