import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Start seeding...');

  // ==========================================================
  // 1. DEFINISI PERMISSION
  // ==========================================================
  const permissionsList = [
    // --- User Management (Operasional Harian) ---
    'create_user',
    'read_user',
    'update_user',
    'delete_user',

    // --- Khusus Super Admin (Proteksi) ---
    'delete_user_super_admin', // Admin tidak boleh hapus Super Admin

    // --- Role Management (Struktur Sistem) ---
    'create_role',
    'read_role',
    'update_role',
    'delete_role',
    'assign_role',

    // --- Permission Management (Struktur Sistem) ---
    'create_permission',
    'read_permission',
    'update_permission',
    'delete_permission',
    'assign_permission',

    'connect_whatsapp',
    'send_whatsapp_message',
    'send_whatsapp_broadcast',
  ];

  // Simpan permission ke database
  console.log('...Creating permissions');
  for (const action of permissionsList) {
    await prisma.permission
      .upsert({
        where: { id: 0, action }, // Hack: search by unique logic later, but for now loop check
        update: {},
        create: { action },
      })
      .catch(async () => {
        // Fallback jika id autoincrement bermasalah, cari manual
        const exist = await prisma.permission.findFirst({ where: { action } });
        if (!exist) await prisma.permission.create({ data: { action } });
      });
  }

  // Ambil semua permission dari DB untuk dipetakan
  const allPermissions = await prisma.permission.findMany();

  // ==========================================================
  // 2. DEFINISI ROLE & ASSIGN PERMISSION
  // ==========================================================

  // --- A. Role: SUPER ADMIN ---
  // Prinsip: Kontrol Penuh (Sistem, Role, Permission, Global)
  console.log('...Creating Super Admin Role');
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'Super Admin' },
    update: {},
    create: {
      name: 'Super Admin',
      permissions: {
        connect: allPermissions.map((p) => ({ id: p.id })), // Ambil SEMUA permission
      },
    },
  });

  // --- B. Role: ADMIN ---
  // Prinsip: Operasional Harian (Data Bisnis). TIDAK BOLEH ubah struktur.
  console.log('...Creating Admin Role');

  // Daftar Permission TERLARANG untuk Admin
  const forbiddenForAdmin = [
    'create_role',
    'update_role',
    'delete_role',
    'create_permission',
    'update_permission',
    'delete_permission',
    'assign_role',
    'assign_permission',
    'delete_user_super_admin',
  ];

  // Filter permission untuk Admin (Ambil semua KECUALI yang terlarang)
  const adminPermissions = allPermissions.filter(
    (p) => !forbiddenForAdmin.includes(p.action),
  );

  const adminRole = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: {
      // Update permission jika seed dijalankan ulang (reset permission admin)
      permissions: {
        set: [], // Clear dulu
        connect: adminPermissions.map((p) => ({ id: p.id })),
      },
    },
    create: {
      name: 'Admin',
      permissions: {
        connect: adminPermissions.map((p) => ({ id: p.id })),
      },
    },
  });

  // --- C. Role: USER (Role ke-3) ---
  // Prinsip: Pengguna Biasa (Hanya view data diri sendiri atau data publik terbatas)
  console.log('...Creating User Role');
  const userPermissions = allPermissions.filter(
    (p) => ['read_user'].includes(p.action), // Sangat terbatas
  );

  const userRole = await prisma.role.upsert({
    where: { name: 'User' },
    update: {},
    create: {
      name: 'User',
      permissions: {
        connect: userPermissions.map((p) => ({ id: p.id })),
      },
    },
  });

  // ==========================================================
  // 3. BUAT USER DEFAULT
  // ==========================================================
  const passwordHash = await bcrypt.hash('password', 10);

  // User Super Admin
  await prisma.user.upsert({
    where: { email: 'super@admin.com' },
    update: { roleId: superAdminRole.id }, // Pastikan role sync
    create: {
      email: 'super@admin.com',
      password: passwordHash,
      roleId: superAdminRole.id,
    },
  });

  // User Admin
  await prisma.user.upsert({
    where: { email: 'admin@admin.com' },
    update: { roleId: adminRole.id },
    create: {
      email: 'admin@admin.com',
      password: passwordHash,
      roleId: adminRole.id,
    },
  });

  // User Biasa
  await prisma.user.upsert({
    where: { email: 'user@gmail.com' },
    update: { roleId: userRole.id },
    create: {
      email: 'user@gmail.com',
      password: passwordHash,
      roleId: userRole.id,
    },
  });

  console.log('✅ Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
