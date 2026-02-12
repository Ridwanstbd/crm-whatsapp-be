import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { MailModule } from './modules/mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        PORT: Joi.number().default(3000),

        DATABASE_URL: Joi.string().required().messages({
          'any.required': 'DATABASE_URL is required for Prisma connection',
        }),

        JWT_SECRET: Joi.string().required().messages({
          'any.required': 'JWT_SECRET is required to sign tokens',
        }),
        JWT_EXPIRATION: Joi.string().default('1d'),

        MAIL_HOST: Joi.string().required(),
        MAIL_PORT: Joi.number().default(587),
        MAIL_USER: Joi.string().required(),
        MAIL_PASSWORD: Joi.string().required(),
        MAIL_FROM: Joi.string().email().required(),

        FRONTEND_URL: Joi.string().uri().required().messages({
          'any.required':
            'FRONTEND_URL is required for email redirection links',
          'string.uri': 'FRONTEND_URL must be a valid URL',
        }),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),

    PrismaModule,
    AuthModule,
    UsersModule,
    RolesModule,
    MailModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
