import { IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  identifier: string; // accepts email OR username

  @IsString()
  password: string;
}
