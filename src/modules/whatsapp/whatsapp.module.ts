import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  providers: [WhatsappService, PrismaService],
  controllers: [WhatsappController],
})
export class WhatsappModule {}
