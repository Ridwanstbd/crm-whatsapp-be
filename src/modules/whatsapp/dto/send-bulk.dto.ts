import {
  IsArray,
  IsNotEmpty,
  IsString,
  ValidateNested,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BulkMessageData {
  @IsNotEmpty()
  @IsString()
  to: string;

  @IsNotEmpty()
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  file?: string;

  @IsOptional()
  @IsString()
  mediaType?: 'image' | 'video' | 'document';

  @IsOptional()
  @IsString()
  fileName?: string;
}

export class SendBulkMessageDto {
  @IsNotEmpty()
  @IsString()
  sessionId: string;

  @IsNotEmpty()
  @IsString()
  delay: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkMessageData)
  data: BulkMessageData[];
}
