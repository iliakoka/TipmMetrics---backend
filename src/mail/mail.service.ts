import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class MailService {
  private resend: Resend;

  constructor(private configService: ConfigService) {
    this.resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const appUrl = this.configService.get<string>('APP_URL');
    const verificationUrl = `${appUrl}/auth/verify-email?token=${token}`;

    await this.resend.emails.send({
      from: 'TipMetrics <onboarding@resend.dev>',
      to: email,
      subject: 'Confirm your TipMetrics account',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto;">
          <h2 style="color: #333;">Welcome to TipMetrics! 🎯</h2>
          <p>Thank you for registering. Please confirm your email address by clicking the button below:</p>
          <a href="${verificationUrl}"
             style="display: inline-block; background-color: #22c55e; color: white;
                    padding: 12px 24px; text-decoration: none; border-radius: 6px;
                    font-weight: bold; margin: 16px 0;">
            Confirm Email
          </a>
          <p style="color: #666; font-size: 14px;">
            Or copy this link into your browser:<br/>
            <a href="${verificationUrl}">${verificationUrl}</a>
          </p>
          <p style="color: #999; font-size: 12px;">If you did not create an account, you can safely ignore this email.</p>
        </div>
      `,
    });
  }
}
