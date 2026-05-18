require('dotenv').config();
const { createClient } = require('@libsql/client');

async function migrate() {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;

    if (!url || url.startsWith('file:')) {
        console.error("Error: Please make sure TURSO_DATABASE_URL in .env points to your remote libsql:// URL.");
        process.exit(1);
    }

    console.log("Connecting to local sitin.db...");
    const local = createClient({ url: 'file:sitin.db' });

    console.log(`Connecting to remote Turso database: ${url}...`);
    const remote = createClient({ url, authToken: token });

    // 1. Initialize schema on remote database
    console.log("Initializing database schema on remote Turso...");
    
    const tables = [
        `CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            idnumber    TEXT    NOT NULL UNIQUE,
            lastname    TEXT    NOT NULL,
            firstname   TEXT    NOT NULL,
            middlename  TEXT,
            courselevel TEXT    NOT NULL,
            course      TEXT    NOT NULL,
            address     TEXT,
            email       TEXT    NOT NULL UNIQUE,
            password    TEXT    NOT NULL,
            profile_picture TEXT DEFAULT 'images/profile.webp',
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            sessions INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            name TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'normal',
            target_user_id INTEGER,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES admins(id),
            FOREIGN KEY (target_user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS notification_reads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            notification_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            read_at DATETIME,
            FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(notification_id, user_id)
        )`,
        `CREATE TABLE IF NOT EXISTS sitin_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            purpose TEXT NOT NULL,
            lab TEXT NOT NULL,
            pc_number TEXT,
            sessions INTEGER NOT NULL,
            time_in DATETIME DEFAULT CURRENT_TIMESTAMP,
            time_out DATETIME
        )`,
        `CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            purpose TEXT NOT NULL,
            lab TEXT NOT NULL,
            pc_number TEXT,
            preferred_date TEXT NOT NULL,
            preferred_time TEXT,
            status TEXT DEFAULT 'pending',
            admin_notes TEXT,
            handled_by INTEGER,
            handled_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (handled_by) REFERENCES admins(id),
            FOREIGN KEY (student_id) REFERENCES users(idnumber)
        )`,
        `CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            lab TEXT NOT NULL,
            feedback TEXT NOT NULL,
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS laboratory_software (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lab TEXT NOT NULL,
            software_name TEXT NOT NULL,
            version TEXT,
            description TEXT,
            created_at DATETIME
        )`
    ];

    for (let statement of tables) {
        await remote.execute(statement);
    }
    console.log("Schema verified on remote.");

    // List of tables to migrate in order
    const tableNames = [
        'users',
        'user_sessions',
        'admins',
        'announcements',
        'settings',
        'notifications',
        'notification_reads',
        'sitin_records',
        'reservations',
        'feedback',
        'laboratory_software'
    ];

    for (let tableName of tableNames) {
        console.log(`Migrating table: ${tableName}...`);
        
        // Fetch all rows from local table
        const localData = await local.execute(`SELECT * FROM ${tableName}`);
        const rows = localData.rows;
        const columns = localData.columns;

        if (rows.length === 0) {
            console.log(`Table ${tableName} is empty. Skipping.`);
            continue;
        }

        console.log(`Found ${rows.length} rows in local ${tableName}. Copying to remote...`);

        // Clear existing default/seeded data in settings or admins to avoid duplicates
        if (tableName === 'admins' || tableName === 'settings' || tableName === 'announcements' || tableName === 'laboratory_software') {
            await remote.execute(`DELETE FROM ${tableName}`);
        }

        // Insert into remote database
        // Construct query: INSERT OR IGNORE INTO tableName (col1, col2, ...) VALUES (?, ?, ...)
        const columnsList = columns.join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const insertQuery = `INSERT OR IGNORE INTO ${tableName} (${columnsList}) VALUES (${placeholders})`;

        // Batch execution
        const batchStatements = [];
        for (let row of rows) {
            const values = [];
            columns.forEach((col, idx) => {
                values.push(row[idx]);
            });
            batchStatements.push({
                sql: insertQuery,
                args: values
            });
        }

        // LibSQL client supports batch execution!
        await remote.batch(batchStatements, "write");
        console.log(`Successfully migrated ${rows.length} rows for table ${tableName}.`);
    }

    console.log("Migration completed successfully! All data has been copied to your Turso Cloud Database.");
}

migrate().catch(err => {
    console.error("Migration failed with error:", err);
});
