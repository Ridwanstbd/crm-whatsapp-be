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
  | { to: string; status: 'SUCCESS'; logId: string | null; }
  | { to: string; status: 'FAILED'; error: any; };

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

  async sendMessage(dto: SendMessageDto, mediaFile?: Express.Multer.File) {
    const { sessionId, to, message, file, mediaType, fileName } = dto;
    const sock = this.clients.get(sessionId);

    if (!sock)
      throw new BadRequestException('Sesi tidak ditemukan atau terputus.');

    let formattedTo = to.replace(/[^0-9]/g, '');
    if (!formattedTo.endsWith('@s.whatsapp.net')) {
      formattedTo = `${formattedTo}@s.whatsapp.net`;
    }

    const device = await this.prisma.whatsappDevice.findUnique({
      where: { sessionId },
    });
    const ownerId = device ? device.userId : null;

    // Tentukan sumber file (Upload Binary ATAU String URL/Base64)
    const hasAttachment = mediaFile || file;

    const log = await this.prisma.messageLog.create({
      data: {
        to: formattedTo,
        body: message + (hasAttachment ? ` [Attachment: ${mediaType}]` : ''),
        status: 'PENDING',
        user: ownerId ? { connect: { id: ownerId } } : undefined,
      },
    });

    try {
      let sentMsg;

      if (!hasAttachment) {
        sentMsg = await sock.sendMessage(formattedTo, { text: message });
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
    const { sessionId, data, delay } = dto;
    const results: BulkMessageResult[] = [];

    const sock = this.clients.get(sessionId);
    if (!sock)
      throw new BadRequestException('Sesi tidak ditemukan atau terputus.');

    this.logger.log(
      `Memulai pengiriman massal ke ${data.length} kontak dengan delay range: ${delay} detik`,
    );

    for (const [index, item] of data.entries()) {
      // Jika bukan pesan pertama, lakukan delay sebelum mengirim
      if (index > 0) {
        const delayInSeconds = this.getRandomDelay(delay);
        this.logger.log(
          `Menunggu ${delayInSeconds} detik sebelum mengirim pesan ke-${index + 1}...`,
        );
        await this.sleep(delayInSeconds * 1000);
      }

      try {
        const result = await this.sendMessage({
          sessionId,
          to: item.to,
          message: item.message,
          file: item.file,
          mediaType: item.mediaType as any,
          fileName: item.fileName,
        });

        results.push({
          to: item.to,
          status: 'SUCCESS',
          logId: result.status === 'success' ? result.data!.id : null,
        });

        this.logger.log(`Pesan ke-${index + 1} (${item.to}) terkirim.`);
      } catch (error) {
        this.logger.error(`Gagal mengirim ke ${item.to}: ${error.message}`);
        results.push({ to: item.to, status: 'FAILED', error: error.message });
      }
    }

    return {
      message: 'Proses pengiriman massal selesai',
      total: data.length,
      results,
    };
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
