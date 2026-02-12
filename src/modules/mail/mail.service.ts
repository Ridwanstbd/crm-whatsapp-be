import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config'; // 1. Import ConfigService

@Injectable()
export class MailService {
  private transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('MAIL_HOST'),
      port: this.configService.get<number>('MAIL_PORT'),
      auth: {
        user: this.configService.get<string>('MAIL_USER'),
        pass: this.configService.get<string>('MAIL_PASSWORD'),
      },
    });
  }

  async sendResetPasswordEmail(email: string, token: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');

    const resetLink = `${frontendUrl}/auth/reset-password?token=${token}`;

    await this.transporter.sendMail({
      from: `"ERP System" <${this.configService.get<string>('MAIL_FROM')}>`,
      subject: 'Reset Password Request',
      html: `
        <p>Anda menerima email ini karena ada permintaan reset password.</p>
        <p>Silakan klik link di bawah ini untuk mereset password Anda:</p>
        <p>
          <a href="${resetLink}" style="padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">
            Reset Password
          </a>
        </p>
        <p>Link ini akan kadaluarsa dalam 1 jam.</p>
      `,
    });
  }
}
