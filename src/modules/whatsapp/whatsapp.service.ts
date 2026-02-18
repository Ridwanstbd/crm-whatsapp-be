import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  BadRequestException,
  RequestTimeoutException,
} from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  WASocket,
  WAMessageStatus,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  StartSessionDto,
  SendMessageDto,
  MediaType,
} from './dto/create-session.dto';
import * as qrcode from 'qrcode-terminal';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { SendBulkMessageDto } from './dto/send-bulk.dto';
import { CreateAutoReplyDto } from './dto/auto-reply.dto';

interface IBaileysLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
  trace: (...args: any[]) => void;
  child: (obj: Record<string, unknown>) => IBaileysLogger;
  level: string;
}

class BaileysLoggerAdapter implements IBaileysLogger {
  constructor(
    private readonly nestLogger: Logger,
    private readonly context?: string,
  ) {}

  private getLogContext(): string | undefined {
    return this.context;
  }

  info(...args: any[]) {
    // Kurangi log info agar terminal tidak penuh
    // this.nestLogger.log(args[0], this.getLogContext());
  }

  warn(...args: any[]) {
    this.nestLogger.warn(args[0], this.getLogContext());
  }

  error(...args: any[]) {
    this.nestLogger.error(args[0], this.getLogContext());
  }

  debug(...args: any[]) {}

  trace(...args: any[]) {}

  child(obj: Record<string, unknown>): IBaileysLogger {
    return new BaileysLoggerAdapter(this.nestLogger, this.context);
  }

  get level(): string {
    return 'warn';
  }
}

type BulkMessageResult =
  | { to: string; status: 'SUCCESS'; logId: string | null }
  | { to: string; status: 'FAILED'; error: any };

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private clients = new Map<string, WASocket>();
  private readonly logger = new Logger(WhatsappService.name);
  private readonly baileysLogger = new BaileysLoggerAdapter(this.logger);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.restoreSessions();
  }

  onModuleDestroy() {
    this.clients.forEach((sock) => sock.end(undefined));
  }

  private async restoreSessions() {
    this.logger.log('Mengembalikan sesi WhatsApp yang tersimpan...');
    const activeDevices = await this.prisma.whatsappDevice.findMany({
      where: { status: 'CONNECTED' },
    });

    for (const device of activeDevices) {
      const { userId, sessionId } = device;
      this.logger.log(`Restoring session: ${sessionId}`);
      this.initializeClient(sessionId, userId, false).catch((err) =>
        this.logger.error(`Gagal restore ${sessionId}: ${err.message}`),
      );
    }
  }
  private async initializeClient(
    sessionId: string,
    userId: number,
    waitForQr: boolean = false,
  ): Promise<string | null> {
    return new Promise(async (resolve, reject) => {
      const sessionPath = path.join('wa_sessions', sessionId);

      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger),
        },
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
      });

      this.clients.set(sessionId, sock);

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.logger.log(`QR Generated untuk session ${sessionId}`);
          if (waitForQr) qrcode.generate(qr, { small: true });

          await this.updateDeviceStatus(sessionId, userId, 'WAITING_QR');

          if (waitForQr) resolve(qr);
        }

        if (connection === 'open') {
          this.logger.log(`Session ${sessionId} CONNECTED`);
          const userJid = sock.user?.id;
          const phoneNumber = userJid ? userJid.split(':')[0] : 'Unknown';

          await this.updateDeviceStatus(
            sessionId,
            userId,
            'CONNECTED',
            phoneNumber,
          );

          if (waitForQr) resolve(null);
        }

        if (connection === 'close') {
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          this.logger.warn(
            `Connection closed: ${sessionId}. Reason: ${reason}`,
          );

          await this.updateDeviceStatus(sessionId, userId, 'DISCONNECTED');

          if (reason === DisconnectReason.loggedOut) {
            this.clients.delete(sessionId);
            this.deleteSessionFolder(sessionId);
          } else {
            this.initializeClient(sessionId, userId, false).catch((e) =>
              this.logger.error(`Reconnection failed: ${e.message}`),
            );
          }
        }
      });

      sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
          if (update.update.status && update.key.fromMe) {
            const waMessageId = update.key.id;
            const statusRaw = update.update.status;

            let statusString = 'UNKNOWN';

            switch (statusRaw) {
              case WAMessageStatus.SERVER_ACK:
                statusString = 'SENT';
                break;
              case WAMessageStatus.DELIVERY_ACK:
                statusString = 'DELIVERED';
                break;
              case WAMessageStatus.READ:
              case WAMessageStatus.PLAYED:
                statusString = 'READ';
                break;
              default:
                statusString = 'PENDING';
            }

            this.logger.log(
              `Update Status Pesan [${waMessageId}] -> ${statusString}`,
            );

            await this.prisma.messageLog.updateMany({
              where: { waMessageId: waMessageId },
              data: { status: statusString },
            });
          }
        }
      });

      sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.key.fromMe && msg.message) {
            await this.handleAutoReply(sessionId, msg);
          }
        }
      });
    });
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getRandomDelay(range: string): number {
    let [min, max] = range.split('-').map((val) => parseInt(val.trim()));
    if (isNaN(min)) return 10;
    if (isNaN(max)) max = min;
    if (min > max) [min, max] = [max, min];
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async startSession(dto: StartSessionDto) {
    const { userId } = dto;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User tidak ditemukan!');

    const sessionId = uuidv4();

    await this.prisma.whatsappDevice.create({
      data: {
        sessionId,
        status: 'INITIALIZING',
        user: { connect: { id: userId } },
      },
    });

    try {
      const qrCode = await this.initializeWithTimeout(sessionId, userId);

      if (qrCode === null) {
        return {
          message: 'WhatsApp langsung terhubung (Session Restored)',
          sessionId,
          status: 'CONNECTED',
          qr: null,
        };
      }

      return {
        message: 'Silakan scan QR Code ini',
        sessionId,
        status: 'WAITING_QR',
        qr: qrCode,
      };
    } catch (error) {
      this.clients.delete(sessionId);
      throw new RequestTimeoutException(
        'Gagal generate QR Code: ' + error.message,
      );
    }
  }

  private initializeWithTimeout(
    sessionId: string,
    userId: number,
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timeoutSecs = 60;
      const timer = setTimeout(() => {
        reject(new Error(`Timeout ${timeoutSecs}s waiting for QR`));
      }, timeoutSecs * 1000);

      this.initializeClient(sessionId, userId, true)
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async sendMessage(
    dto: SendMessageDto,
    mediaFile?: Express.Multer.File,
    campaignId?: string,
  ) {
    const { sessionId, to, message, file, mediaType, fileName } = dto;
    const sock = this.clients.get(sessionId);

    if (!sock)
      throw new BadRequestException('Sesi tidak ditemukan atau terputus.');
    let formattedTo = to;

    if (!formattedTo.includes('@')) {
      formattedTo = formattedTo.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    }

    if (formattedTo.endsWith('@s.whatsapp.net')) {
      const result = (await sock.onWhatsApp(formattedTo))?.[0];
      if (!result || !result.exists) {
        throw new BadRequestException(
          `Nomor ${to} tidak terdaftar di WhatsApp.`,
        );
      }
    }
    await sock.sendPresenceUpdate('composing', formattedTo);
    const typingDuration = Math.min(Math.max(message.length * 50, 1000), 4000);
    this.logger.log(
      `Mengetik selama ${typingDuration} detik sebelum mengirim pesan...`,
    );
    await this.sleep(typingDuration);

    const device = await this.prisma.whatsappDevice.findUnique({
      where: { sessionId },
    });
    const ownerId = device ? device.userId : null;

    const hasAttachment = mediaFile || file;

    const log = await this.prisma.messageLog.create({
      data: {
        to: formattedTo,
        body: message + (hasAttachment ? ` [Attachment: ${mediaType}]` : ''),
        status: 'PENDING',
        user: ownerId ? { connect: { id: ownerId } } : undefined,
        campaign: campaignId ? { connect: { id: campaignId } } : undefined,
      },
    });

    try {
      let sentMsg;

      if (!hasAttachment) {
        sentMsg = await sock.sendMessage(formattedTo, {
          text: message,
        });
      } else {
        if (!mediaType)
          throw new BadRequestException(
            'mediaType wajib diisi jika mengirim file',
          );

        let mediaBuffer: Buffer | { url: string };
        let finalMimeType: string;

        if (mediaFile) {
          mediaBuffer = mediaFile.buffer;
          finalMimeType = mediaFile.mimetype;
        } else if (file) {
          if (file.startsWith('http')) {
            mediaBuffer = { url: file };
          } else {
            const base64Data = file.replace(/^data:.*,/, '');
            mediaBuffer = Buffer.from(base64Data, 'base64');
          }
          finalMimeType =
            this.getMimeType(fileName) || 'application/octet-stream';
        } else {
          throw new BadRequestException(
            'Tidak ada media file atau URL yang disediakan untuk pengiriman',
          );
        }

        const caption = message || '';

        switch (mediaType) {
          case MediaType.image:
            sentMsg = await sock.sendMessage(formattedTo, {
              image: mediaBuffer,
              caption: caption,
            });
            break;
          case MediaType.video:
            sentMsg = await sock.sendMessage(formattedTo, {
              video: mediaBuffer,
              caption: caption,
            });
            break;
          case MediaType.document:
            sentMsg = await sock.sendMessage(formattedTo, {
              document: mediaBuffer,
              mimetype: finalMimeType,
              fileName: fileName || mediaFile?.originalname || 'document.bin',
              caption: caption,
            });
            break;
          default:
            throw new BadRequestException('Tipe media tidak didukung');
        }
      }

      const waMessageId = sentMsg?.key?.id;

      await this.prisma.messageLog.update({
        where: { id: log.id },
        data: {
          status: 'SENT',
          waMessageId: waMessageId,
        },
      });

      return { status: 'success', data: log };
    } catch (error) {
      await this.prisma.messageLog.update({
        where: { id: log.id },
        data: { status: 'FAILED' },
      });
      return { status: 'failed', error: error.message };
    }
  }

  async sendBulkMessage(dto: SendBulkMessageDto) {
    const { sessionId, data, delay, title } = dto;

    const sock = this.clients.get(sessionId);
    if (!sock)
      throw new BadRequestException('Sesi tidak ditemukan atau terputus.');

    const campaign = await this.prisma.campaignMessage.create({
      data: {
        title: title,
      },
    });

    this.processBulkMessageBackground(
      sessionId,
      data,
      delay,
      campaign.id,
    ).catch((err) => {
      this.logger.error(`Error pada background bulk send: ${err.message}`);
    });

    return {
      message: 'Proses pengiriman massal telah dimulai di latar belakang',
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      total: data.length,
      status: 'PROCESSING',
    };
  }

  private processSpintax(text: string): string {
    return text.replace(/\{([^{}]+)\}/g, (match, content) => {
      const choices = content.split('|');
      return choices[Math.floor(Math.random() * choices.length)];
    });
  }

  private addInvisibleUnique(text: string): string {
    const zeroWidthSpace = '\u200B';
    const randomCount = Math.floor(Math.random() * 10) + 1;
    return text + zeroWidthSpace.repeat(randomCount);
  }

  private getTimeBasedGreeting(text: string): string {
    const hour = new Date().getHours();
    let timeSpecific = 'Pagi';

    if (hour >= 3 && hour < 11) timeSpecific = 'Pagi';
    else if (hour >= 11 && hour < 15) timeSpecific = 'Siang';
    else if (hour >= 15 && hour < 18) timeSpecific = 'Sore';
    else timeSpecific = 'Malam';
    const variations = [
      `Assalamualaikum, Selamat ${timeSpecific}`,
      `Selamat ${timeSpecific}`,
      `Halo, Selamat ${timeSpecific}`,
      `Assalamualaikum`,
    ];

    const selectedGreeting =
      variations[Math.floor(Math.random() * variations.length)];

    return text.replace(/\{\{salam\}\}/gi, selectedGreeting);
  }
  private applyIndonesianSlang(text: string): string {
    const replacements = {
      yang: ['yg', 'yang'],
      saya: ['sy', 'aku', 'saya'],
      tidak: ['gak', 'enggak', 'tak', 'tidak'],
      bisa: ['bs', 'bisa'],
      'terima kasih': ['makasih', 'trims', 'terima kasih'],
      karena: ['krn', 'karna', 'karena'],
      sudah: ['udh', 'sdh', 'sudah'],
      bagaimana: ['gimana', 'bagaimana'],
      kak: ['ka', 'kak', 'kakak'],
    };

    let newText = text;

    for (const [word, variations] of Object.entries(replacements)) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');

      newText = newText.replace(regex, (match) => {
        if (Math.random() > 0.5) {
          return match;
        }
        const chosen =
          variations[Math.floor(Math.random() * variations.length)];
        return match[0] === match[0].toUpperCase()
          ? chosen.charAt(0).toUpperCase() + chosen.slice(1)
          : chosen;
      });
    }
    return newText;
  }

  private async processBulkMessageBackground(
    sessionId: string,
    data: any[],
    delay: string,
    campaignId: string,
  ) {
    this.logger.log(
      `Memulai pengiriman massal campaign "${campaignId}" ke ${data.length} kontak`,
    );

    for (const [index, item] of data.entries()) {
      if (index > 0) {
        const delayInSeconds = this.getRandomDelay(delay);
        this.logger.log(
          `Menunggu delay selama ${delayInSeconds} detik sebelum pesan berikutnya...`,
        );
        await this.sleep(delayInSeconds * 1000);
      }

      try {
        const processor = (rawText: string) => {
          let txt = this.getTimeBasedGreeting(rawText);
          txt = this.processSpintax(txt);
          txt = this.addInvisibleUnique(txt);
          txt = this.applyIndonesianSlang(txt);
          return txt;
        };
        const finalMessageText = processor(item.message);

        await this.sendMessage(
          {
            sessionId,
            to: item.to,
            message: finalMessageText,
            file: item.file,
            mediaType: item.mediaType as any,
            fileName: item.fileName,
          },
          undefined,
          campaignId,
        );
        this.logger.log(`Pesan ke-${index + 1} (${item.to}) terkirim.`);
      } catch (error) {
        this.logger.error(`Gagal mengirim ke ${item.to}: ${error.message}`);
      }
    }
    this.logger.log('Seluruh proses pengiriman massal selesai.');
  }

  private getMimeType(fileName?: string): string | null {
    if (!fileName) return null;
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case '.pdf':
        return 'application/pdf';
      case '.doc':
      case '.docx':
        return 'application/msword';
      case '.xls':
      case '.xlsx':
        return 'application/vnd.ms-excel';
      case '.zip':
        return 'application/zip';
      case '.txt':
        return 'text/plain';
      default:
        return null;
    }
  }

  async endSession(sessionId: string) {
    const sock = this.clients.get(sessionId);
    if (!sock) throw new BadRequestException('Sesi tidak aktif');
    try {
      await sock.logout();
      return { message: 'Berhasil logout' };
    } catch (e) {
      throw new BadRequestException('Gagal logout: ' + e.message);
    }
  }

  async getGroups(sessionId: string) {
    const sock = this.clients.get(sessionId);
    if (!sock) {
      throw new BadRequestException('Sesi tidak ditemukan atau terputus.');
    }

    try {
      const groups = await sock.groupFetchAllParticipating();

      return {
        status: 'success',
        total: Object.keys(groups).length,
        data: Object.values(groups).map((g) => ({
          id: g.id,
          subject: g.subject,
          participantsCount: g.participants.length,
          creation: g.creation,
        })),
      };
    } catch (error) {
      throw new BadRequestException(
        'Gagal mengambil daftar grup: ' + error.message,
      );
    }
  }

  async scrapeGroupMembers(sessionId: string, groupId: string) {
    const sock = this.clients.get(sessionId);
    if (!sock) {
      throw new BadRequestException('Sesi tidak ditemukan atau terputus.');
    }

    try {
      const metadata = await sock.groupMetadata(groupId);

      const participants = metadata.participants.map((p) => ({
        waId: p.id,
        phoneNumber: p.id.split('@')[0],
        isAdmin: !!p.admin,
        adminType: p.admin,
      }));

      return {
        status: 'success',
        groupName: metadata.subject,
        groupId: metadata.id,
        description: metadata.desc?.toString(),
        totalMembers: participants.length,
        data: participants,
      };
    } catch (error) {
      throw new BadRequestException(
        'Gagal scrape anggota grup: ' + error.message,
      );
    }
  }

  async createAutoReply(dto: CreateAutoReplyDto) {
    const { campaignId, trace_word, body_message, delay_reply } = dto;

    return this.prisma.campaignAutoReply.upsert({
      where: { campaignId },
      update: {
        traceWords: JSON.stringify(trace_word),
        replyMap: JSON.stringify(body_message),
        delayReply: delay_reply,
      },
      create: {
        campaignId,
        traceWords: JSON.stringify(trace_word),
        replyMap: JSON.stringify(body_message),
        delayReply: delay_reply,
      },
    });
  }

  private async handleAutoReply(sessionId: string, msg: any) {
    const remoteJid = msg.key.remoteJid;
    const textBody =
      msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    if (!textBody) return;

    const lastLog = await this.prisma.messageLog.findFirst({
      where: {
        to: remoteJid,
        campaignId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      include: { campaign: { include: { autoReply: true } } },
    });

    if (!lastLog || !lastLog.campaign || !lastLog.campaign.autoReply) return;

    const config = lastLog.campaign.autoReply;
    const traceWords: string[] = JSON.parse(config.traceWords);
    const replyRules: { receive: string; reply: string }[] = JSON.parse(
      config.replyMap,
    );

    const lowerText = textBody.toLowerCase();
    const isMatch = traceWords.some((word) =>
      lowerText.includes(word.toLowerCase()),
    );

    if (!isMatch) return;

    let replyMessage = '';
    const exactMatch = replyRules.find(
      (r) => r.receive.toLowerCase() === lowerText,
    );

    if (exactMatch) {
      replyMessage = exactMatch.reply;
    } else {
      const partialMatch = replyRules.find((r) =>
        lowerText.includes(r.receive.toLowerCase()),
      );
      if (partialMatch) replyMessage = partialMatch.reply;
    }

    if (!replyMessage) return;

    const delaySeconds = this.getRandomDelay(config.delayReply);
    this.logger.log(
      `Auto-reply terpicu untuk ${remoteJid}. Menunggu ${delaySeconds} detik...`,
    );

    await this.sleep(delaySeconds * 1000);

    try {
      await this.sendMessage({
        sessionId,
        to: remoteJid,
        message: replyMessage,
      });
      this.logger.log(`Auto-reply terkirim ke ${remoteJid}`);
    } catch (error) {
      this.logger.error(`Gagal kirim auto-reply: ${error.message}`);
    }
  }

  async logout(sessionId: string) {
    return this.endSession(sessionId);
  }

  private async updateDeviceStatus(
    sessionId: string,
    userId: number,
    status: string,
    phoneNumber?: string,
  ) {
    try {
      await this.prisma.whatsappDevice.upsert({
        where: { sessionId },
        update: { status, phoneNumber },
        create: {
          sessionId,
          status,
          phoneNumber,
          user: { connect: { id: userId } },
        },
      });
    } catch (e) {
      this.logger.error(`Failed to update DB status: ${e.message}`);
    }
  }

  private deleteSessionFolder(sessionId: string) {
    const sessionPath = path.join('wa_sessions', sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      this.logger.log(`Deleted session folder: ${sessionPath}`);
    }
  }
}
