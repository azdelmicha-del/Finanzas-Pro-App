/**
 * Migración: SQLite → MongoDB Atlas
 * Uso: npm run migrate
 * Requisitos: MONGODB_URI en .env
 *
 * Lee data/database.sqlite y migra a MongoDB (finanzas_pro)
 * NO modifica SQLite (backup de seguridad)
 */

const Database = require('better-sqlite3');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI no configurada en .env');
    process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname);
// Buscar SQLite: primero en Render disk (/data), luego local
const CANDIDATES = [
    '/data/database.sqlite',
    path.join(PROJECT_ROOT, 'data', 'database.sqlite'),
];
const SQLITE_PATH = CANDIDATES.find(fs.existsSync);

if (!SQLITE_PATH) {
    console.error('ERROR: BD SQLite no encontrada. Busqué en:');
    CANDIDATES.forEach(p => console.error('   -', p));
    process.exit(1);
}

async function migrate() {
    console.log('=== Migración SQLite → MongoDB ===\n');

    const sqlite = new Database(SQLITE_PATH, { readonly: true });
    console.log('✅ SQLite conectado:', SQLITE_PATH);

    await mongoose.connect(MONGODB_URI, {
        dbName: 'finanzas_pro',
        serverSelectionTimeoutMS: 10000,
    });
    console.log('✅ MongoDB conectado (db: finanzas_pro)\n');
    const db = mongoose.connection;

    let totalMigrated = 0;

    // ── 1. Migrar usuarios ──────────────────────────────────────────
    console.log('📦 Migrando usuarios...');
    const usersExist = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (usersExist) {
        const users = sqlite.prepare('SELECT * FROM users').all();
        console.log(`   Encontrados ${users.length} usuarios en SQLite`);

        for (const user of users) {
            const doc = {
                username: user.username,
                password: user.password,
                is_admin: !!user.is_admin,
                full_name: user.full_name || '',
                phone: user.phone || '',
                notes: user.notes || '',
                suspended: !!user.suspended,
                suspended_reason: user.suspended_reason || '',
                created_at: user.created_at ? new Date(user.created_at) : new Date(),
            };

            await db.collection('users').updateOne(
                { username: user.username },
                { $setOnInsert: doc },
                { upsert: true }
            );
            totalMigrated++;
        }
        console.log(`✅ Usuarios migrados: ${users.length}`);
    } else {
        console.log('⏭️  Tabla users no encontrada');
    }

    // ── 2. Migrar app_state ─────────────────────────────────────────
    console.log('\n📦 Migrando estados financieros...');
    const stateExist = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'").get();
    if (stateExist) {
        const states = sqlite.prepare('SELECT * FROM app_state').all();
        console.log(`   Encontrados ${states.length} estados en SQLite`);

        for (const row of states) {
            let userId = row.key;
            // Mapear claves SQLite → userId MongoDB
            if (userId === 'current_state') userId = 'shared';

            let data = null;
            try { data = JSON.parse(row.value); } catch { data = { raw: row.value }; }

            await db.collection('app_state').updateOne(
                { userId },
                { $set: { userId, data, updatedAt: new Date() } },
                { upsert: true }
            );
            totalMigrated++;
        }
        console.log(`✅ Estados migrados: ${states.length}`);
    } else {
        console.log('⏭️  Tabla app_state no encontrada');
    }

    // ── 3. Crear índices ───────────────────────────────────────────
    console.log('\n📇 Creando índices...');
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('app_state').createIndex({ userId: 1 }, { unique: true });
    console.log('✅ Índices creados');

    // ── 4. Migrar archivos (uploads) ──────────────────────────────
    const DISK_UPLOADS = '/data/uploads';
    const LOCAL_UPLOADS = path.join(PROJECT_ROOT, 'data', 'uploads');
    if (!fs.existsSync(LOCAL_UPLOADS)) fs.mkdirSync(LOCAL_UPLOADS, { recursive: true });

    if (fs.existsSync(DISK_UPLOADS)) {
        const files = fs.readdirSync(DISK_UPLOADS);
        if (files.length > 0) {
            console.log(`\n📁 Copiando ${files.length} archivos de ${DISK_UPLOADS} → ${LOCAL_UPLOADS}...`);
            let copied = 0;
            for (const file of files) {
                const src = path.join(DISK_UPLOADS, file);
                const dst = path.join(LOCAL_UPLOADS, file);
                try {
                    if (fs.statSync(src).isFile()) {
                        fs.copyFileSync(src, dst);
                        copied++;
                    }
                } catch (e) {
                    console.error(`   ⚠️  Error copiando ${file}:`, e.message);
                }
            }
            console.log(`✅ ${copied} archivos copiados a carpeta local (se pierden al dormir el free tier)`);
        }
    } else {
        const localFiles = fs.readdirSync(LOCAL_UPLOADS).filter(f => fs.statSync(path.join(LOCAL_UPLOADS, f)).isFile());
        console.log(`\n📁 Uploads locales: ${localFiles.length} archivos`);
    }

    // ── Resumen ─────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════');
    console.log('✅ Migración completada');
    console.log(`   Documentos migrados: ${totalMigrated}`);
    console.log(`   Base de datos MongoDB: finanzas_pro`);
    console.log(`   Colecciones: users, app_state`);
    console.log('');
    console.log('⚠️  PRÓXIMOS PASOS:');
    console.log('   1. Ve a MongoDB Atlas y verifica que los datos llegaron');
    console.log('   2. Elimina el disk de render.yaml y haz deploy otra vez');
    console.log('   3. Render funcionará en FREE TIER sin disk persistente');
    console.log('═══════════════════════════════════════════════\n');

    sqlite.close();
    await mongoose.disconnect();
    process.exit(0);
}

migrate().catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
});
