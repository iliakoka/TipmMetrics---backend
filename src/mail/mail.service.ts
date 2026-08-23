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

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const appUrl = this.configService.get<string>('APP_URL');
    const resetUrl = `${appUrl}/auth/reset-password?token=${token}`;

    await this.resend.emails.send({
      from: 'TipMetrics <onboarding@resend.dev>',
      to: email,
      subject: 'Reset your TipMetrics password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto;">
          <h2 style="color: #333;">Reset Your Password 🔐</h2>
          <p>We received a request to reset your TipMetrics password. Click the button below:</p>
          <a href="${resetUrl}"
             style="display: inline-block; background-color: #ef4444; color: white;
                    padding: 12px 24px; text-decoration: none; border-radius: 6px;
                    font-weight: bold; margin: 16px 0;">
            Reset Password
          </a>
          <p style="color: #666; font-size: 14px;">
            Or copy this link into your browser:<br/>
            <a href="${resetUrl}">${resetUrl}</a>
          </p>
          <p style="color: #f97316; font-size: 14px;"><strong>This link expires in 1 hour.</strong></p>
          <p style="color: #999; font-size: 12px;">If you did not request a password reset, ignore this email.</p>
        </div>
      `,
    });
  }
}
