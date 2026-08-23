import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: this.configService.get<string>('MAIL_USER'),
        pass: this.configService.get<string>('MAIL_PASS'),
      },
    });
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const appUrl = this.configService.get<string>('APP_URL');
    const verificationUrl = `${appUrl}/auth/verify-email?token=${token}`;

    await this.transporter.sendMail({
      from: `"TipMetrics" <${this.configService.get<string>('MAIL_USER')}>`,
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
