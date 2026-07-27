import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const API_ROLES = ['viewer', 'analyst', 'admin'] as const;
export type ApiRole = (typeof API_ROLES)[number];

export class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsIn(API_ROLES)
  apiRole!: ApiRole;
}

export class AcceptInviteDto {
  @IsString()
  @MinLength(40) // raw token is 40 hex chars (20 random bytes)
  @MaxLength(80)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}
