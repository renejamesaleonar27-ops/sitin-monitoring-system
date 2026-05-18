require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// In-memory session store
const sessions = {};

// --- Middleware ---
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize Turso/LibSQL Client
const client = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:sitin.db',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

// Helper SQL runner functions
async function run(sql, params = []) {
    return await client.execute({ sql, args: params });
}

async function all(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return res.rows.map(row => {
        const obj = {};
        res.columns.forEach((col, idx) => {
            obj[col] = row[idx];
        });
        return obj;
    });
}

async function get(sql, params = []) {
    const rows = await all(sql, params);
    return rows[0] || null;
}

// Function to get current Philippine Time (UTC+8 / Cebu City) formatted for SQLite
function getPhilippineTimeISO() {
    const options = {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const second = parts.find(p => p.type === 'second').value;
    
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

// --- Initialize Database & Seed data ---
async function initDb() {
    // 1. users table
    await run(`
        CREATE TABLE IF NOT EXISTS users (
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
        )
    `);

    // Migration: Add profile_picture column if it doesn't exist
    try {
        await run("ALTER TABLE users ADD COLUMN profile_picture TEXT DEFAULT 'images/profile.webp'");
    } catch (e) {}

    // Set fallback default profile picture
    try {
        await run("UPDATE users SET profile_picture = 'images/profile.webp' WHERE profile_picture IS NULL OR profile_picture = ''");
    } catch (e) {}

    // 2. user_sessions table
    await run(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            sessions INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // 3. admins table
    await run(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            name TEXT NOT NULL
        )
    `);

    // Check default admin
    const adminCheck = await get('SELECT COUNT(*) as count FROM admins');
    if (!adminCheck || adminCheck.count === 0) {
        const hashedAdminPassword = bcrypt.hashSync('admin123', 10);
        await run('INSERT INTO admins (username, password, name) VALUES (?, ?, ?)', 
            ['admin', hashedAdminPassword, 'Administrator']);
        console.log('Default admin created (username: admin, password: admin123)');
    }

    // 4. announcements table
    await run(`
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 5. settings table
    await run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    // Seed default settings
    try {
        const settingCheck = await get("SELECT COUNT(*) as count FROM settings WHERE key = 'reservations_enabled'");
        if (!settingCheck || settingCheck.count === 0) {
            await run("INSERT INTO settings (key, value) VALUES ('reservations_enabled', 'true')");
        }
    } catch (e) {}

    // Seed announcements
    const annCheck = await get('SELECT COUNT(*) as count FROM announcements');
    if (!annCheck || annCheck.count === 0) {
        await run('INSERT INTO announcements (title, content, date) VALUES (?, ?, ?)', 
            ['Welcome to UCLICS!', 'Welcome to the UC College of Information & Computer Studies Sit-in Monitoring System. Please reserve your workstations online.', getPhilippineTimeISO()]);
        await run('INSERT INTO announcements (title, content, date) VALUES (?, ?, ?)', 
            ['Laboratory Dress Code', 'Strictly no wearing of sleeveless shirts, shorts, or slippers inside the computer laboratories.', getPhilippineTimeISO()]);
        console.log('Default announcements seeded.');
    }

    // 6. notifications table
    await run(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'normal',
            target_user_id INTEGER,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES admins(id),
            FOREIGN KEY (target_user_id) REFERENCES users(id)
        )
    `);

    // Add target_user_id column migration
    try {
        await run('ALTER TABLE notifications ADD COLUMN target_user_id INTEGER REFERENCES users(id)');
    } catch (e) {}

    // 7. notification_reads table
    await run(`
        CREATE TABLE IF NOT EXISTS notification_reads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            notification_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            read_at DATETIME,
            FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(notification_id, user_id)
        )
    `);

    // 8. sitin_records table
    await run(`
        CREATE TABLE IF NOT EXISTS sitin_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            purpose TEXT NOT NULL,
            lab TEXT NOT NULL,
            pc_number TEXT,
            sessions INTEGER NOT NULL,
            time_in DATETIME DEFAULT CURRENT_TIMESTAMP,
            time_out DATETIME
        )
    `);

    // Migration: Add pc_number column
    try {
        await run('ALTER TABLE sitin_records ADD COLUMN pc_number TEXT');
    } catch (e) {}

    // 9. reservations table
    await run(`
        CREATE TABLE IF NOT EXISTS reservations (
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
        )
    `);

    // Migration: Add pc_number column
    try {
        await run('ALTER TABLE reservations ADD COLUMN pc_number TEXT');
    } catch (e) {}

    // 10. feedback table
    await run(`
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            lab TEXT NOT NULL,
            feedback TEXT NOT NULL,
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 11. laboratory_software table
    await run(`
        CREATE TABLE IF NOT EXISTS laboratory_software (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lab TEXT NOT NULL,
            software_name TEXT NOT NULL,
            version TEXT,
            description TEXT,
            created_at DATETIME
        )
    `);

    // Seed software if empty
    const softCheck = await get('SELECT COUNT(*) as count FROM laboratory_software');
    if (!softCheck || softCheck.count === 0) {
        const defaultSoftware = [
            { lab: 'Lab 524', software_name: 'Visual Studio Code', version: '1.85.0', description: 'Advanced source code editor' },
            { lab: 'Lab 524', software_name: 'Node.js', version: '20.10.0', description: 'JavaScript runtime' },
            { lab: 'Lab 524', software_name: 'Python', version: '3.11.5', description: 'Programming language interpreter' },
            { lab: 'Lab 524', software_name: 'Git', version: '2.43.0', description: 'Distributed version control system' },
            { lab: 'Lab 526', software_name: 'Java Development Kit (JDK)', version: '17.0.9', description: 'Java programming environment' },
            { lab: 'Lab 526', software_name: 'Eclipse IDE', version: '2023-09', description: 'Java IDE' },
            { lab: 'Lab 526', software_name: 'MySQL Workbench', version: '8.0.34', description: 'Database management' },
            { lab: 'Lab 528', software_name: 'Android Studio', version: '2023.1.1', description: 'Android development environment' },
            { lab: 'Lab 528', software_name: 'Flutter SDK', version: '3.16.0', description: 'Cross-platform UI toolkit' },
            { lab: 'Lab 528', software_name: 'VS Code', version: '1.85.0', description: 'Source code editor' },
            { lab: 'Lab 530', software_name: 'Cisco Packet Tracer', version: '8.2.1', description: 'Network simulation tool' },
            { lab: 'Lab 530', software_name: 'Wireshark', version: '4.2.0', description: 'Network protocol analyzer' },
            { lab: 'Lab 542', software_name: 'Dev-C++', version: '6.3', description: 'C/C++ IDE' },
            { lab: 'Lab 542', software_name: 'Code::Blocks', version: '20.03', description: 'C/C++ IDE' },
            { lab: 'Lab 544', software_name: 'XAMPP', version: '8.2.4', description: 'Apache + MariaDB + PHP + Perl distribution' },
            { lab: 'Lab 544', software_name: 'Visual Studio Code', version: '1.85.0', description: 'Source code editor' },
            { lab: 'Lab 544', software_name: 'PostgreSQL', version: '16.1', description: 'Object-relational database' }
        ];

        const localTime = getPhilippineTimeISO();
        for (let s of defaultSoftware) {
            await run('INSERT INTO laboratory_software (lab, software_name, version, description, created_at) VALUES (?, ?, ?, ?, ?)',
                [s.lab, s.software_name, s.version, s.description, localTime]);
        }
        console.log('Seeded default laboratory software.');
    }
    console.log('Database initialized successfully.');
}

initDb().catch(err => {
    console.error('Error during database initialization:', err);
});

// --- Registration Route ---
app.post('/register', async (req, res) => {
    const {
        idnumber, lastname, firstname, middlename,
        courselevel, course, address, email, password
    } = req.body;

    const hashedPassword = bcrypt.hashSync(password, 10);
    const middleName = middlename || '';
    const userAddress = address || '';

    try {
        await run(
            `INSERT INTO users (idnumber, lastname, firstname, middlename, courselevel, course, address, email, password)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [idnumber, lastname, firstname, middleName, courselevel, course, userAddress, email, hashedPassword]
        );
        console.log('New user registered:', idnumber);
        res.json({ success: true });
    } catch (err) {
        console.error('Registration error:', err);
        const errorMessage = err.message || err.toString() || 'Unknown error';
        if (errorMessage.includes('UNIQUE constraint failed')) {
            res.status(400).json({ error: 'ID Number or Email already exists.' });
        } else {
            res.status(500).json({ error: 'Registration failed: ' + errorMessage });
        }
    }
});

// --- Login Route ---
app.post('/login', async (req, res) => {
    const { idnumber, password } = req.body;

    try {
        // First check if it's an admin login
        const admin = await get('SELECT * FROM admins WHERE username = ?', [idnumber]);
        
        if (admin) {
            const isMatch = bcrypt.compareSync(password, admin.password);
            if (isMatch) {
                const sessionId = crypto.randomBytes(32).toString('hex');
                sessions[sessionId] = { userId: admin.id, idnumber: admin.username, isAdmin: true };
                res.cookie('sessionId', sessionId, { httpOnly: false, maxAge: 30 * 60 * 1000, sameSite: 'lax' });
                return res.redirect('/admin.html');
            }
        }
        
        // If not admin, check regular users
        const user = await get('SELECT * FROM users WHERE idnumber = ?', [idnumber]);

        if (user) {
            const isMatch = bcrypt.compareSync(password, user.password);

            if (!isMatch) {
                return res.status(401).send('Login failed: Incorrect password.');
            }

            const sessionId = crypto.randomBytes(32).toString('hex');
            sessions[sessionId] = { userId: user.id, idnumber: user.idnumber };
            
            res.cookie('sessionId', sessionId, { httpOnly: true, maxAge: 30 * 60 * 1000 });
            res.redirect('/main.html');
        } else {
            res.status(401).send('Login failed: ID Number not found.');
        }
    } catch (err) {
        res.status(500).send('Login failed: ' + err.message);
    }
});

// Multer config for profile picture uploads
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        const uploadDir = path.join(__dirname, 'uploads', 'profiles');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function(req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- Student: Update Profile ---
app.put('/api/profile', upload.single('profilePicture'), async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    const { firstname, middlename, lastname, address, email } = req.body;
    const profilePicture = req.file ? `/uploads/profiles/${req.file.filename}` : null;
    
    try {
        let query = 'UPDATE users SET firstname = ?, middlename = ?, lastname = ?, address = ?, email = ?';
        let params = [firstname, middlename || '', lastname, address || '', email];
        
        if (profilePicture) {
            query += ', profile_picture = ?';
            params.push(profilePicture);
        }
        
        query += ' WHERE id = ?';
        params.push(userId);
        
        await run(query, params);
        console.log(`User ${userId} updated their profile`);
        const responseData = { success: true, message: 'Profile updated successfully' };
        if (profilePicture) {
            responseData.profile_picture = profilePicture;
        }
        res.json(responseData);
    } catch (err) {
        console.error('Error updating profile:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Get Current User API ---
app.get('/api/current-user', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    
    try {
        const user = await get('SELECT id, idnumber, lastname, firstname, middlename, courselevel, course, address, email, profile_picture FROM users WHERE id = ?', [userId]);
        
        if (user) {
            const result = await get('SELECT COALESCE(SUM(sessions), 0) as consumedSessions FROM user_sessions WHERE user_id = ?', [userId]);
            const consumedSessions = result?.consumedSessions || 0;
            const remainingSessions = Math.max(0, 30 - consumedSessions);
            
            const sitins = await all('SELECT time_in, COALESCE(time_out, CURRENT_TIMESTAMP) as time_out FROM sitin_records WHERE student_id = ?', [user.idnumber]);
            
            let totalDuration = 0;
            let sessionCount = 0;
            let longestSession = 0;
            
            sitins.forEach(record => {
                const timeIn = new Date(record.time_in).getTime();
                const timeOut = new Date(record.time_out).getTime();
                const duration = (timeOut - timeIn) / (1000 * 60);
                if (duration > 0) {
                    totalDuration += duration;
                    sessionCount++;
                    if (duration > longestSession) {
                        longestSession = duration;
                    }
                }
            });
            
            const totalAccumulatedHours = totalDuration / 60;
            const avgSessionHours = sessionCount > 0 ? (totalDuration / 60) / sessionCount : 0;
            
            user.totalSessions = remainingSessions;
            user.consumeSessions = consumedSessions;
            user.totalSitInHours = Math.round(totalAccumulatedHours * 10) / 10;
            user.avgSessionDuration = Math.round(avgSessionHours * 10) / 10;
            user.longestSession = Math.round(longestSession / 60 * 10) / 10;
            res.json(user);
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Logout API ---
app.post('/api/logout', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    let userId = null;
    
    if (sessionId && sessions[sessionId]) {
        userId = sessions[sessionId].userId;
        delete sessions[sessionId];
    }
    
    if (userId) {
        try {
            const result = await get('SELECT COALESCE(SUM(sessions), 0) as totalSessions FROM user_sessions WHERE user_id = ?', [userId]);
            const currentSessions = result ? (result.totalSessions || 0) : 0;
            const newSessions = Math.max(0, currentSessions - 30);
            
            const record = await get('SELECT id FROM user_sessions WHERE user_id = ?', [userId]);
            if (record) {
                await run('UPDATE user_sessions SET sessions = ? WHERE user_id = ?', [newSessions, userId]);
            } else {
                await run('INSERT INTO user_sessions (user_id, sessions) VALUES (?, ?)', [userId, newSessions]);
            }
            console.log(`User ${userId} logged out. Sessions remaining: ${newSessions}`);
        } catch (err) {
            console.error('Error updating sessions on logout:', err);
        }
    }
    
    res.clearCookie('sessionId');
    res.json({ success: true });
});

// --- Public: Get Announcements ---
app.get('/api/announcements', async (req, res) => {
    try {
        const results = await all('SELECT * FROM announcements ORDER BY date DESC LIMIT 50');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Create Announcement ---
app.post('/api/admin/announcements', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { title, content } = req.body;
    if (!title || !content) {
        return res.status(400).json({ error: 'Title and content are required' });
    }
    
    try {
        await run('INSERT INTO announcements (title, content, date) VALUES (?, ?, ?)', [title, content, getPhilippineTimeISO()]);
        res.json({ success: true, message: 'Announcement created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Delete Announcement ---
app.delete('/api/admin/announcements/:id', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { id } = req.params;
    
    try {
        await run('DELETE FROM announcements WHERE id = ?', [id]);
        res.json({ success: true, message: 'Announcement deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Search Student by ID ---
app.get('/api/admin/search-student', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { idnumber } = req.query;
    
    try {
        const student = await get('SELECT * FROM users WHERE idnumber = ?', [idnumber]);
        if (student) {
            res.json({ found: true, student: student });
        } else {
            res.json({ found: false, message: 'Student not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get All Students ---
app.get('/api/admin/students', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    try {
        const students = await all('SELECT id, idnumber, firstname, middlename, lastname, course, courselevel, email FROM users ORDER BY lastname');
        for (let student of students) {
            const sessResult = await get('SELECT COALESCE(SUM(sessions), 0) as consumed FROM user_sessions WHERE user_id = ?', [student.id]);
            student.remainingSessions = Math.max(0, 30 - (sessResult?.consumed || 0));
        }
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Get Own Sit-in History ---
app.get('/api/student/sitin-history', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;

    try {
        const user = await get('SELECT idnumber FROM users WHERE id = ?', [userId]);
        if (user) {
            const results = await all('SELECT * FROM sitin_records WHERE student_id = ? ORDER BY time_in DESC LIMIT 20', [user.idnumber]);
            res.json(results);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Submit Feedback ---
app.post('/api/student/feedback', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    const { lab, feedback } = req.body;

    try {
        const user = await get('SELECT idnumber, firstname, lastname FROM users WHERE id = ?', [userId]);
        if (user) {
            const studentName = `${user.firstname} ${user.lastname}`;
            await run('INSERT INTO feedback (student_id, student_name, lab, feedback, date) VALUES (?, ?, ?, ?, ?)',
                [user.idnumber, studentName, lab, feedback, getPhilippineTimeISO()]);
            res.json({ success: true, message: 'Feedback submitted successfully' });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Statistics ---
app.get('/api/admin/stats', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    try {
        const totalStudentsRes = await get('SELECT COUNT(*) as count FROM users');
        const totalSitinsRes = await get('SELECT COUNT(*) as count FROM sitin_records');
        const activeSessionsRes = await get('SELECT COUNT(*) as count FROM sitin_records WHERE time_out IS NULL');
        res.json({
            totalStudents: totalStudentsRes?.count || 0,
            totalSitins: totalSitinsRes?.count || 0,
            activeSessions: activeSessionsRes?.count || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Feedback Reports ---
app.get('/api/admin/feedback', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    try {
        const results = await all('SELECT * FROM feedback ORDER BY date DESC');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Sit-in History for a Specific Student ---
app.get('/api/admin/student-sitin-history/:studentId', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { studentId } = req.params;
    
    try {
        const results = await all('SELECT * FROM sitin_records WHERE student_id = ? ORDER BY time_in DESC LIMIT 1', [studentId]);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Student Remaining Sessions ---
app.get('/api/admin/student-sessions', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { idnumber } = req.query;
    
    try {
        const user = await get('SELECT id FROM users WHERE idnumber = ?', [idnumber]);
        if (user) {
            const result = await get('SELECT COALESCE(SUM(sessions), 0) as sessions FROM user_sessions WHERE user_id = ?', [user.id]);
            res.json({ sessions: Math.max(0, 30 - (result?.sessions || 0)) });
        } else {
            res.json({ sessions: 30 });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Reset Student Sessions ---
app.post('/api/admin/reset-sessions', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { idnumber } = req.body;
    if (!idnumber) {
        return res.status(400).json({ error: 'Student ID is required' });
    }
    
    try {
        const user = await get('SELECT id FROM users WHERE idnumber = ?', [idnumber]);
        if (user) {
            await run('DELETE FROM user_sessions WHERE user_id = ?', [user.id]);
            res.json({ success: true, message: 'Sessions reset successfully' });
        } else {
            res.status(404).json({ error: 'Student not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Reset All Student Sessions ---
app.post('/api/admin/reset-all-sessions', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    try {
        await run('DELETE FROM user_sessions');
        res.json({ success: true, message: 'All student sessions have been reset back to 30 successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Create Sit-in Record ---
app.post('/api/admin/sitin', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { studentId, studentName, purpose, lab, pc_number, sessions: sitinSessions } = req.body;
    
    try {
        await run(`INSERT INTO sitin_records (student_id, student_name, purpose, lab, pc_number, sessions, time_in) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [studentId, studentName, purpose, lab, pc_number || '', sitinSessions, getPhilippineTimeISO()]);
        res.json({ success: true, message: 'Sit-in record created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Sit-in Records ---
app.get('/api/admin/sitin-records', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    try {
        const results = await all('SELECT * FROM sitin_records ORDER BY time_in DESC');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Current Sit-in Records ---
app.get('/api/admin/current-sitin', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    try {
        const results = await all('SELECT * FROM sitin_records WHERE time_out IS NULL ORDER BY time_in DESC');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: End Sit-in ---
app.post('/api/admin/sitin/end', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { recordId } = req.body;

    try {
        const record = await get('SELECT student_id, sessions FROM sitin_records WHERE id = ?', [recordId]);

        if (record) {
            const user = await get('SELECT id FROM users WHERE idnumber = ?', [record.student_id]);

            if (user) {
                const sessRecord = await get('SELECT id, sessions FROM user_sessions WHERE user_id = ?', [user.id]);

                if (sessRecord) {
                    await run('UPDATE user_sessions SET sessions = ? WHERE user_id = ?', [sessRecord.sessions + 1, user.id]);
                } else {
                    await run('INSERT INTO user_sessions (user_id, sessions) VALUES (?, ?)', [user.id, 1]);
                }
            }

            const newSessions = Math.max(0, record.sessions - 1);
            await run(`UPDATE sitin_records SET time_out = ?, sessions = ? WHERE id = ?`, [getPhilippineTimeISO(), newSessions, recordId]);
        } else {
            await run(`UPDATE sitin_records SET time_out = ? WHERE id = ?`, [getPhilippineTimeISO(), recordId]);
        }

        res.json({ success: true, message: 'Sit-in ended successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Public: Get Reservation Global Status ---
app.get('/api/settings/reservations', async (req, res) => {
    try {
        const result = await get("SELECT value FROM settings WHERE key = 'reservations_enabled'");
        let enabled = result ? result.value : 'true';
        res.json({ enabled: enabled === 'true' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get Reservation Setting ---
app.get('/api/admin/settings/reservations', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    try {
        const result = await get("SELECT value FROM settings WHERE key = 'reservations_enabled'");
        let enabled = result ? result.value : 'true';
        res.json({ enabled: enabled === 'true' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Toggle Reservation Setting ---
app.post('/api/admin/settings/reservations', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }
    
    const { enabled } = req.body;
    if (enabled === undefined) {
        return res.status(400).json({ error: 'enabled state is required' });
    }
    
    try {
        await run("UPDATE settings SET value = ? WHERE key = 'reservations_enabled'", [enabled ? 'true' : 'false']);
        res.json({ success: true, message: `Reservation system has been ${enabled ? 'enabled' : 'disabled'} successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Create Reservation ---
app.post('/api/student/reservations', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    const { purpose, lab, preferred_date, preferred_time, pc_number } = req.body;

    try {
        const settingsVal = await get("SELECT value FROM settings WHERE key = 'reservations_enabled'");
        let reservationsEnabled = settingsVal ? settingsVal.value : 'true';
        
        if (reservationsEnabled !== 'true') {
            return res.status(403).json({ error: 'Workstation reservation is currently disabled by the administrator.' });
        }

        const user = await get('SELECT idnumber, firstname, lastname FROM users WHERE id = ?', [userId]);

        if (user) {
            const studentName = `${user.firstname} ${user.lastname}`;

            await run(`INSERT INTO reservations (student_id, student_name, purpose, lab, pc_number, preferred_date, preferred_time, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [user.idnumber, studentName, purpose, lab, pc_number || '', preferred_date, preferred_time || '', getPhilippineTimeISO()]);

            res.json({ success: true, message: 'Reservation created successfully' });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Cancel Reservation ---
app.delete('/api/student/reservations/:id/cancel', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    const { id } = req.params;

    try {
        const user = await get('SELECT idnumber FROM users WHERE id = ?', [userId]);

        if (user) {
            const reservation = await get('SELECT id, status FROM reservations WHERE id = ? AND student_id = ?', [id, user.idnumber]);
            
            if (reservation) {
                if (reservation.status !== 'pending') {
                    return res.status(400).json({ error: 'Only pending reservations can be cancelled' });
                }

                await run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [id]);
                res.json({ success: true, message: 'Reservation cancelled successfully' });
            } else {
                res.status(404).json({ error: 'Reservation not found or does not belong to you' });
            }
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Get Own Reservations ---
app.get('/api/student/reservations', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;

    try {
        const user = await get('SELECT idnumber FROM users WHERE id = ?', [userId]);

        if (user) {
            const results = await all('SELECT * FROM reservations WHERE student_id = ? ORDER BY created_at DESC', [user.idnumber]);
            res.json(results);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Get PC Occupancy for a Lab and Date ---
app.get('/api/student/pc-occupancy', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { lab, date } = req.query;
    if (!lab || !date) {
        return res.status(400).json({ error: 'Lab and Date are required' });
    }

    try {
        const reserved = [];
        const occupied = [];

        const resRows = await all(`
            SELECT pc_number FROM reservations 
            WHERE lab = ? AND preferred_date = ? AND status IN ('accepted', 'pending') AND pc_number != '' AND pc_number IS NOT NULL
        `, [lab, date]);
        resRows.forEach(row => reserved.push(row.pc_number));

        const options = { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' };
        const formatter = new Intl.DateTimeFormat('en-US', options);
        const parts = formatter.formatToParts(new Date());
        const year = parts.find(p => p.type === 'year').value;
        const month = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        const todayStr = `${year}-${month}-${day}`;

        if (date === todayStr) {
            const sitinRows = await all(`
                SELECT pc_number FROM sitin_records 
                WHERE lab = ? AND time_out IS NULL AND pc_number != '' AND pc_number IS NOT NULL
            `, [lab]);
            sitinRows.forEach(row => occupied.push(row.pc_number));
        }

        res.json({ reserved, occupied });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get All Reservations ---
app.get('/api/admin/reservations', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    try {
        const results = await all(`
            SELECT r.*, u.email as student_email
            FROM reservations r
            LEFT JOIN users u ON r.student_id = u.idnumber
            ORDER BY r.created_at DESC
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Accept Reservation ---
app.post('/api/admin/reservations/:id/accept', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { id } = req.params;
    const adminId = sessions[sessionId].userId;
    const { admin_notes } = req.body;

    try {
        const reservation = await get('SELECT student_id, purpose, lab, pc_number, preferred_date FROM reservations WHERE id = ?', [id]);
        if (!reservation) {
            return res.status(404).json({ error: 'Reservation not found' });
        }

        await run(`UPDATE reservations SET status = 'accepted', handled_by = ?, handled_at = ?, admin_notes = ? WHERE id = ?`,
            [adminId, getPhilippineTimeISO(), admin_notes || '', id]);

        const user = await get('SELECT id, firstname, lastname FROM users WHERE idnumber = ?', [reservation.student_id]);
        if (user) {
            const notifTitle = 'Reservation Accepted';
            const notifMessage = `Your reservation for ${reservation.lab} ${reservation.pc_number ? '(' + reservation.pc_number + ') ' : ''}on ${new Date(reservation.preferred_date).toLocaleDateString()} (${reservation.purpose}) has been accepted.${admin_notes ? ' Note: ' + admin_notes : ''}`;
            await run(`INSERT INTO notifications (title, message, priority, target_user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [notifTitle, notifMessage, 'high', user.id, adminId, getPhilippineTimeISO()]);
        }

        res.json({ success: true, message: 'Reservation accepted' });
    } catch (err) {
        console.error('Error accepting reservation:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Reject Reservation ---
app.post('/api/admin/reservations/:id/reject', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { id } = req.params;
    const adminId = sessions[sessionId].userId;
    const { admin_notes } = req.body;

    try {
        const reservation = await get('SELECT student_id, purpose, lab, preferred_date FROM reservations WHERE id = ?', [id]);
        if (!reservation) {
            return res.status(404).json({ error: 'Reservation not found' });
        }

        await run(`UPDATE reservations SET status = 'rejected', handled_by = ?, handled_at = ?, admin_notes = ? WHERE id = ?`,
            [adminId, getPhilippineTimeISO(), admin_notes || '', id]);

        const user = await get('SELECT id, firstname, lastname FROM users WHERE idnumber = ?', [reservation.student_id]);
        if (user) {
            const notifTitle = 'Reservation Rejected';
            const notifMessage = `Your reservation for ${reservation.lab} on ${new Date(reservation.preferred_date).toLocaleDateString()} (${reservation.purpose}) has been rejected.${admin_notes ? ' Reason: ' + admin_notes : ''}`;
            await run(`INSERT INTO notifications (title, message, priority, target_user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [notifTitle, notifMessage, 'high', user.id, adminId, getPhilippineTimeISO()]);
        }

        res.json({ success: true, message: 'Reservation rejected' });
    } catch (err) {
        console.error('Error rejecting reservation:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Delete Reservation ---
app.delete('/api/admin/reservations/:id', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { id } = req.params;

    try {
        await run('DELETE FROM reservations WHERE id = ?', [id]);
        res.json({ success: true, message: 'Reservation deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Get Notifications ---
app.get('/api/student/notifications', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;

    try {
        const rows = await all(`
            SELECT n.*,
                   CASE WHEN nr.read_at IS NULL THEN 0 ELSE 1 END as read
            FROM notifications n
            LEFT JOIN notification_reads nr ON n.id = nr.notification_id AND nr.user_id = ?
            WHERE n.target_user_id IS NULL OR n.target_user_id = ?
            ORDER BY n.created_at DESC
            LIMIT 50
        `, [userId, userId]);
        
        const results = rows.map(row => ({
            id: row.id,
            title: row.title,
            message: row.message,
            priority: row.priority,
            created_at: row.created_at,
            read: row.read === 1
        }));
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Mark Notification as Read ---
app.post('/api/student/notifications/:id/read', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    const { id } = req.params;

    try {
        const notif = await get('SELECT id FROM notifications WHERE id = ?', [id]);
        if (!notif) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        const check = await get('SELECT id FROM notification_reads WHERE notification_id = ? AND user_id = ?', [id, userId]);

        if (check) {
            await run('UPDATE notification_reads SET read_at = ? WHERE notification_id = ? AND user_id = ?',
                [getPhilippineTimeISO(), id, userId]);
        } else {
            await run('INSERT INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)',
                [id, userId, getPhilippineTimeISO()]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Mark All Notifications as Read ---
app.post('/api/student/notifications/read-all', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;

    try {
        const unreads = await all(`
            SELECT n.id FROM notifications n
            LEFT JOIN notification_reads nr ON n.id = nr.notification_id AND nr.user_id = ?
            WHERE nr.id IS NULL AND (n.target_user_id IS NULL OR n.target_user_id = ?)
        `, [userId, userId]);
        
        for (let unread of unreads) {
            await run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)',
                [unread.id, userId, getPhilippineTimeISO()]);
        }
        res.json({ success: true, marked: unreads.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Student: Delete Notification ---
app.delete('/api/student/notifications/:id', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = sessions[sessionId].userId;
    const { id } = req.params;

    try {
        await run('DELETE FROM notification_reads WHERE notification_id = ? AND user_id = ?', [id, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Create Notification ---
app.post('/api/admin/notifications', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const adminId = sessions[sessionId].userId;
    const { title, message, priority } = req.body;

    if (!title || !message) {
        return res.status(400).json({ error: 'Title and message are required' });
    }

    try {
        await run('INSERT INTO notifications (title, message, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
            [title, message, priority || 'normal', adminId, getPhilippineTimeISO()]);
        res.json({ success: true, message: 'Notification sent to all users' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Get All Notifications ---
app.get('/api/admin/notifications', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    try {
        const rows = await all(`
            SELECT n.*, a.name as admin_name
            FROM notifications n
            LEFT JOIN admins a ON n.created_by = a.id
            ORDER BY n.created_at DESC
            LIMIT 100
        `);
        
        const results = [];
        for (let row of rows) {
            const countRes = await get('SELECT COUNT(*) as cnt FROM notification_reads WHERE notification_id = ?', [row.id]);
            results.push({
                id: row.id,
                title: row.title,
                message: row.message,
                priority: row.priority,
                created_by: row.created_by,
                admin_name: row.admin_name,
                created_at: row.created_at,
                recipients: countRes?.cnt || 0
            });
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Delete Notification ---
app.delete('/api/admin/notifications/:id', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { id } = req.params;

    try {
        await run('DELETE FROM notifications WHERE id = ?', [id]);
        res.json({ success: true, message: 'Notification deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Community: Global Stats ---
app.get('/api/community-stats', async (req, res) => {
    try {
        const totalRes = await get("SELECT COUNT(*) as cnt FROM sitin_records");
        const totalSessions = totalRes?.cnt || 0;

        const activeRes = await get("SELECT COUNT(DISTINCT student_id) as cnt FROM sitin_records");
        const activeStudents = activeRes?.cnt || 0;

        let totalMinutes = 0;
        const hrsRes = await get("SELECT SUM((julianday(COALESCE(time_out, CURRENT_TIMESTAMP)) - julianday(time_in)) * 1440) as totalMin FROM sitin_records");
        if (hrsRes) { totalMinutes = hrsRes.totalMin || 0; }
        const totalHours = Math.round(totalMinutes / 60 * 10) / 10;

        const activeNowRes = await get("SELECT COUNT(*) as cnt FROM sitin_records WHERE time_out IS NULL");
        const activeNow = activeNowRes?.cnt || 0;
        const utilization = Math.round((activeNow / 180) * 100);

        res.json({ totalSessions, activeStudents, utilization, totalHours });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Community: Leaderboard ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        const rows = await all(`
            SELECT
                s.student_id,
                COALESCE(u.firstname || ' ' || u.lastname, s.student_name) AS student_name,
                u.course,
                u.profile_picture,
                COUNT(s.id)                                      AS sessions,
                COALESCE(SUM((julianday(COALESCE(s.time_out, CURRENT_TIMESTAMP)) - julianday(s.time_in)) * 1440), 0) AS totalMin
            FROM sitin_records s
            LEFT JOIN users u ON s.student_id = u.idnumber
            GROUP BY s.student_id
            ORDER BY totalMin DESC
            LIMIT 10
        `);
        
        const results = rows.map(row => ({
            name:     row.student_name,
            course:   row.course     || 'Not set',
            profile_picture: row.profile_picture || 'images/profile.webp',
            sessions: row.sessions    || 0,
            hours:    Math.round(row.totalMin / 60 * 10) / 10
        }));
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Laboratory Software: Get Installed Software ---
app.get('/api/software', async (req, res) => {
    const { lab } = req.query;
    try {
        let results;
        if (lab) {
            results = await all('SELECT * FROM laboratory_software WHERE lab = ? ORDER BY software_name ASC', [lab]);
        } else {
            results = await all('SELECT * FROM laboratory_software ORDER BY lab ASC, software_name ASC');
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Add Laboratory Software ---
app.post('/api/admin/software', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { lab, software_name, version, description } = req.body;
    if (!lab || !software_name) {
        return res.status(400).json({ error: 'Lab and Software Name are required' });
    }

    try {
        await run('INSERT INTO laboratory_software (lab, software_name, version, description, created_at) VALUES (?, ?, ?, ?, ?)',
            [lab, software_name, version || '', description || '', getPhilippineTimeISO()]);
        res.json({ success: true, message: 'Software added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Admin: Delete Laboratory Software ---
app.delete('/api/admin/software/:id', async (req, res) => {
    const sessionId = req.cookies?.sessionId;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
        return res.status(401).json({ error: 'Not authenticated as admin' });
    }

    const { id } = req.params;

    try {
        await run('DELETE FROM laboratory_software WHERE id = ?', [id]);
        res.json({ success: true, message: 'Software deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Start the Server ---
if (require.main === module || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
