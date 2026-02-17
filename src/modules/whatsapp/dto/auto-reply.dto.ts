import { IsNotEmpty, IsString, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ReplyRule {
  @IsNotEmpty()
  @IsString()
  receive: string;

  @IsNotEmpty()
  @IsString()
  reply: string;
}

export class CreateAutoReplyDto {
  @IsNotEmpty()
  @IsString()
  campaignId: string;

  @IsArray()
  @IsString({ each: true })
  trace_word: string[];

  @IsNotEmpty()
  @IsString()
  delay_reply: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReplyRule)
  body_message: ReplyRule[];
}
