import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  ParseFilePipeBuilder,
  UploadedFile,
  HttpStatus,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { StartSessionDto, SendMessageDto } from './dto/create-session.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from 'src/common/guards/permissions.guard';
import { RequirePermissions } from 'src/common/decorators/permissions.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { SendBulkMessageDto } from './dto/send-bulk.dto';

@Controller('whatsapp')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('start')
  @RequirePermissions('connect_whatsapp')
  startSession(@Body() dto: StartSessionDto) {
    return this.whatsappService.startSession(dto);
  }

  @Post('send')
  @RequirePermissions('send_whatsapp_message')
  @UseInterceptors(FileInterceptor('file'))
  sendMessage(
    @Body() dto: SendMessageDto,
    @UploadedFile(
      new ParseFilePipeBuilder().build({
        fileIsRequired: false,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    )
    file?: Express.Multer.File,
  ) {
    return this.whatsappService.sendMessage(dto, file);
  }

  @Post('send-bulk')
  @RequirePermissions('send_whatsapp_message')
  sendBulkMessage(@Body() dto: SendBulkMessageDto) {
    return this.whatsappService.sendBulkMessage(dto);
  }

  @Post('end')
  @RequirePermissions('connect_whatsapp')
  endSession(@Body() body: { sessionId: string }) {
    return this.whatsappService.endSession(body.sessionId);
  }
}
