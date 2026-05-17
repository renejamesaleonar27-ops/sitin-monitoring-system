const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const app = express();
const PORT = 3000;
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// In-memory session store (for demo purposes)
const sessions = {};

// --- Middleware ---
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const DB_PATH = path.join(__dirname, 'sitin.db');

async function startServer() {
    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load existing database or create a new one
    let db;
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Helper function to save database to file
    function saveDatabase() {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }

    // --- Create the users table if not exists ---
    db.run(`
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
            profile_picture TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Migration: Add profile_picture column if it doesn't exist (for existing databases)
    try {
        db.run('ALTER TABLE users ADD COLUMN profile_picture TEXT');
    } catch (e) {
        // Column already exists, ignore
    }
    
    saveDatabase();
    console.log('Users table ready.');

    // --- Create the user_sessions table if not exists ---
    db.run(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            sessions INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    saveDatabase();
    console.log('User sessions table ready.');

    // --- Create the admins table if not exists ---
    db.run(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            name TEXT NOT NULL
        )
    `);
    
    // Check if admin exists, if not create default admin
    const adminCheck = db.exec('SELECT COUNT(*) as count FROM admins');
    if (adminCheck.length === 0 || adminCheck[0].values[0][0] === 0) {
        const hashedAdminPassword = bcrypt.hashSync('admin123', 10);
        db.run('INSERT INTO admins (username, password, name) VALUES (?, ?, ?)', 
            ['admin', hashedAdminPassword, 'Administrator']);
        saveDatabase();
        console.log('Default admin created (username: admin, password: admin123)');
    }

    // --- Create the announcements table if not exists ---
    db.run(`
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    saveDatabase();
    console.log('Announcements table ready.');

    // --- Create the notifications table if not exists ---
    db.run(`
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
    saveDatabase();
    console.log('Notifications table ready.');

    // Add target_user_id column if it doesn't exist (for older DBs)
    try {
        db.run('ALTER TABLE notifications ADD COLUMN target_user_id INTEGER REFERENCES users(id)');
        saveDatabase();
        console.log('Added target_user_id column to notifications.');
    } catch (e) {
        // Column likely already exists, ignore
    }

    // --- Create the notification_reads table if not exists ---
    db.run(`
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
    saveDatabase();
    console.log('Notification reads table ready.');

    // --- Create the sitin_records table if not exists ---
    db.run(`
        CREATE TABLE IF NOT EXISTS sitin_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            purpose TEXT NOT NULL,
            lab TEXT NOT NULL,
            sessions INTEGER NOT NULL,
            time_in DATETIME DEFAULT CURRENT_TIMESTAMP,
            time_out DATETIME
        )
    `);
    saveDatabase();
    console.log('Sit-in records table ready.');

    // --- Create the reservations table if not exists ---
    db.run(`
        CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            purpose TEXT NOT NULL,
            lab TEXT NOT NULL,
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
    saveDatabase();
    console.log('Reservations table ready.');

    // --- Create the feedback table if not exists ---
    // Check if old table exists with rating column
    const tableInfo = db.exec("PRAGMA table_info(feedback)");
    const hasRating = tableInfo.length > 0 && tableInfo[0].values.some(v => v[1] === 'rating');
    
    if (hasRating) {
        // Migrate: rename old table, create new one without rating, copy data
        db.run("ALTER TABLE feedback RENAME TO feedback_old");
        db.run(`
            CREATE TABLE feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL,
                student_name TEXT NOT NULL,
                lab TEXT NOT NULL,
                feedback TEXT NOT NULL,
                date DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.run("INSERT INTO feedback (id, student_id, student_name, lab, feedback, date) SELECT id, student_id, student_name, lab, feedback, date FROM feedback_old");
        db.run("DROP TABLE feedback_old");
    } else {
        db.run(`
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL,
                student_name TEXT NOT NULL,
                lab TEXT NOT NULL,
                feedback TEXT NOT NULL,
                date DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }
    
    saveDatabase();
    console.log('Feedback table ready.');

    // --- Registration Route ---
    app.post('/register', (req, res) => {
        const {
            idnumber, lastname, firstname, middlename,
            courselevel, course, address, email, password
        } = req.body;

        // Hash the password
        const hashedPassword = bcrypt.hashSync(password, 10);

        // Convert undefined/null to empty strings
        const middleName = middlename || '';
        const userAddress = address || '';

        try {
            db.run(
                `INSERT INTO users (idnumber, lastname, firstname, middlename, courselevel, course, address, email, password)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [idnumber, lastname, firstname, middleName, courselevel, course, userAddress, email, hashedPassword]
            );
            saveDatabase();
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
    app.post('/login', (req, res) => {
        const { idnumber, password } = req.body;

        try {
            // First check if it's an admin login
            const adminStmt = db.prepare('SELECT * FROM admins WHERE username = ?');
            adminStmt.bind([idnumber]);
            
            if (adminStmt.step()) {
                const admin = adminStmt.getAsObject();
                adminStmt.free();
                
                const isMatch = bcrypt.compareSync(password, admin.password);
                if (isMatch) {
                    const sessionId = crypto.randomBytes(32).toString('hex');
                    sessions[sessionId] = { userId: admin.id, idnumber: admin.username, isAdmin: true };
res.cookie('sessionId', sessionId, { httpOnly: false, maxAge: 30 * 60 * 1000, sameSite: 'lax' }); // 30 minutes session
                    return res.redirect('/admin.html');
                }
            }
            adminStmt.free();
            
            // If not admin, check regular users
            const stmt = db.prepare('SELECT * FROM users WHERE idnumber = ?');
            stmt.bind([idnumber]);

            if (stmt.step()) {
                const user = stmt.getAsObject();
                stmt.free();

                // Compare entered password with hashed password
                const isMatch = bcrypt.compareSync(password, user.password);

                if (!isMatch) {
                    return res.status(401).send('Login failed: Incorrect password.');
                }

                // Login successful - create session
                const sessionId = crypto.randomBytes(32).toString('hex');
                sessions[sessionId] = { userId: user.id, idnumber: user.idnumber };
                
                res.cookie('sessionId', sessionId, { httpOnly: true, maxAge: 30 * 60 * 1000 }); // 30 minutes session
                res.redirect('/main.html');
            } else {
                stmt.free();
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
    app.put('/api/profile', upload.single('profilePicture'), (req, res) => {
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
            
            db.run(query, params);
            saveDatabase();
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
    app.get('/api/current-user', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        
        try {
            const stmt = db.prepare('SELECT id, idnumber, lastname, firstname, middlename, courselevel, course, address, email, profile_picture FROM users WHERE id = ?');
            stmt.bind([userId]);
            
if (stmt.step()) {
                const user = stmt.getAsObject();
                stmt.free();
                
                // Get remaining sessions (30 - consumed)
                const sessionStmt = db.prepare('SELECT COALESCE(SUM(sessions), 0) as consumedSessions FROM user_sessions WHERE user_id = ?');
                sessionStmt.bind([userId]);
                let consumedSessions = 0;
                let remainingSessions = 30;
                if (sessionStmt.step()) {
                    const result = sessionStmt.getAsObject();
                    consumedSessions = result.consumedSessions || 0;
                    remainingSessions = Math.max(0, 30 - consumedSessions);
                }
                sessionStmt.free();
                
                // Get session duration statistics from actual sit-in records
                const userStmt = db.prepare('SELECT idnumber FROM users WHERE id = ?');
                userStmt.bind([userId]);
                if (userStmt.step()) {
                    const userInfo = userStmt.getAsObject();
                    userStmt.free();
                    
                    // Get completed sit-in records with both time_in and time_out
                    const sitinStmt = db.prepare('SELECT time_in, time_out FROM sitin_records WHERE student_id = ? AND time_out IS NOT NULL');
                    sitinStmt.bind([userInfo.idnumber]);
                    
                    let totalDuration = 0;
                    let sessionCount = 0;
                    let longestSession = 0;
                    
                    while (sitinStmt.step()) {
                        const record = sitinStmt.getAsObject();
                        const timeIn = new Date(record.time_in).getTime();
                        const timeOut = new Date(record.time_out).getTime();
                        const duration = (timeOut - timeIn) / (1000 * 60); // in minutes
                        if (duration > 0) {
                            totalDuration += duration;
                            sessionCount++;
                            if (duration > longestSession) {
                                longestSession = duration;
                            }
                        }
                    }
                    sitinStmt.free();
                    
                    // Total accumulated hours from all sit-ins
                    const totalAccumulatedHours = totalDuration / 60;
                    // Average session duration
                    const avgSessionHours = sessionCount > 0 ? (totalDuration / 60) / sessionCount : 0;
                    
                    user.totalSessions = remainingSessions;
                    user.consumeSessions = consumedSessions; // Total sit-in sessions count
                    user.totalSitInHours = Math.round(totalAccumulatedHours * 10) / 10; // Total accumulated hours
                    user.avgSessionDuration = Math.round(avgSessionHours * 10) / 10; // Avg per session in hours
                    user.longestSession = Math.round(longestSession / 60 * 10) / 10; // Longest in hours
                    res.json(user);
                } else {
                    userStmt.free();
                    user.totalSessions = remainingSessions;
                    user.consumeSessions = consumedSessions;
                    user.avgSessionDuration = 0;
                    user.longestSession = 0;
                    res.json(user);
                }
            } else {
                stmt.free();
                res.status(404).json({ error: 'User not found' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Logout API ---
    app.post('/api/logout', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        let userId = null;
        
        if (sessionId && sessions[sessionId]) {
            userId = sessions[sessionId].userId;
            delete sessions[sessionId];
        }
        
        // Subtract 30 sessions from user's remaining sessions on logout
        if (userId) {
            try {
                // Get current sessions
                const sessStmt = db.prepare('SELECT COALESCE(SUM(sessions), 0) as totalSessions FROM user_sessions WHERE user_id = ?');
                sessStmt.bind([userId]);
                let currentSessions = 0;
                if (sessStmt.step()) {
                    const result = sessStmt.getAsObject();
                    currentSessions = result.totalSessions || 0;
                }
                sessStmt.free();
                
                // Subtract 30 (but don't go below 0)
                const newSessions = Math.max(0, currentSessions - 30);
                
                // Update the sessions - insert or update the record
                const checkStmt = db.prepare('SELECT id FROM user_sessions WHERE user_id = ?');
                checkStmt.bind([userId]);
                if (checkStmt.step()) {
                    // Update existing record
                    const record = checkStmt.getAsObject();
                    db.run('UPDATE user_sessions SET sessions = ? WHERE user_id = ?', [newSessions, userId]);
                } else {
                    // Insert new record with the subtracted value
                    db.run('INSERT INTO user_sessions (user_id, sessions) VALUES (?, ?)', [userId, newSessions]);
                }
                checkStmt.free();
                saveDatabase();
                console.log(`User ${userId} logged out. Sessions remaining: ${newSessions}`);
            } catch (err) {
                console.error('Error updating sessions on logout:', err);
            }
        }
        
        res.clearCookie('sessionId');
        res.json({ success: true });
    });

    // --- Public: Get Announcements (for main.html) ---
    app.get('/api/announcements', (req, res) => {
        try {
            const stmt = db.prepare('SELECT * FROM announcements ORDER BY date DESC');
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Create Announcement ---
    app.post('/api/admin/announcements', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        console.log('Session ID:', sessionId);
        console.log('Sessions:', sessions);
        console.log('Body:', req.body);
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            console.log('Not authenticated as admin');
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { title, content } = req.body;
        
        try {
            db.run('INSERT INTO announcements (title, content) VALUES (?, ?)', [title, content]);
            saveDatabase();
            console.log('Announcement created:', title);
            res.json({ success: true, message: 'Announcement created successfully' });
        } catch (err) {
            console.error('Error creating announcement:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Delete Announcement ---
    app.delete('/api/admin/announcements/:id', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { id } = req.params;
        
        try {
            db.run('DELETE FROM announcements WHERE id = ?', [id]);
            saveDatabase();
            res.json({ success: true, message: 'Announcement deleted successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Search Student by ID ---
    app.get('/api/admin/search-student', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { idnumber } = req.query;
        
        try {
            const stmt = db.prepare('SELECT * FROM users WHERE idnumber = ?');
            stmt.bind([idnumber]);
            
            if (stmt.step()) {
                const student = stmt.getAsObject();
                stmt.free();
                res.json({ found: true, student: student });
            } else {
                stmt.free();
                res.json({ found: false, message: 'Student not found' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get All Students ---
    app.get('/api/admin/students', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        try {
            const stmt = db.prepare('SELECT id, idnumber, firstname, middlename, lastname, course, courselevel, email FROM users ORDER BY lastname');
            const results = [];
            while (stmt.step()) {
                const student = stmt.getAsObject();
                // Get remaining sessions for this student
                const sessStmt = db.prepare('SELECT COALESCE(SUM(sessions), 0) as consumed FROM user_sessions WHERE user_id = ?');
                sessStmt.bind([student.id]);
                let remainingSessions = 30;
                if (sessStmt.step()) {
                    const sessResult = sessStmt.getAsObject();
                    remainingSessions = Math.max(0, 30 - (sessResult.consumed || 0));
                }
                sessStmt.free();
                student.remainingSessions = remainingSessions;
                results.push(student);
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Get Own Sit-in History ---
    app.get('/api/student/sitin-history', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;

        try {
            const userStmt = db.prepare('SELECT idnumber FROM users WHERE id = ?');
            userStmt.bind([userId]);
            
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();
                
                const stmt = db.prepare('SELECT * FROM sitin_records WHERE student_id = ? ORDER BY time_in DESC LIMIT 5');
                stmt.bind([user.idnumber]);
                const results = [];
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                res.json(results);
            } else {
                userStmt.free();
                res.json([]);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Get Own Sit-in History ---
    app.get('/api/student/sitin-history', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;

        try {
            const userStmt = db.prepare('SELECT idnumber FROM users WHERE id = ?');
            userStmt.bind([userId]);
            
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();
                
                const stmt = db.prepare('SELECT * FROM sitin_records WHERE student_id = ? ORDER BY time_in DESC LIMIT 5');
                stmt.bind([user.idnumber]);
                const results = [];
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                res.json(results);
            } else {
                userStmt.free();
                res.json([]);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Get Own Sit-in History ---
    app.get('/api/student/sitin-history', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;

        try {
            const userStmt = db.prepare('SELECT idnumber FROM users WHERE id = ?');
            userStmt.bind([userId]);
            
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();
                
                const stmt = db.prepare('SELECT * FROM sitin_records WHERE student_id = ? ORDER BY time_in DESC LIMIT 20');
                stmt.bind([user.idnumber]);
                const results = [];
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                res.json(results);
            } else {
                userStmt.free();
                res.json([]);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Submit Feedback ---
    app.post('/api/student/feedback', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        const { lab, feedback } = req.body;

        try {
            const userStmt = db.prepare('SELECT idnumber, firstname, lastname FROM users WHERE id = ?');
            userStmt.bind([userId]);
            
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();
                
                const studentName = `${user.firstname} ${user.lastname}`;
                db.run('INSERT INTO feedback (student_id, student_name, lab, feedback) VALUES (?, ?, ?, ?)',
                    [user.idnumber, studentName, lab, feedback]);
                saveDatabase();
                res.json({ success: true, message: 'Feedback submitted successfully' });
            } else {
                userStmt.free();
                res.status(404).json({ error: 'User not found' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get Statistics ---
    app.get('/api/admin/stats', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        try {
            const totalStudents = db.exec('SELECT COUNT(*) FROM users');
            const totalSitins = db.exec('SELECT COUNT(*) FROM sitin_records');
            const activeSessions = db.exec('SELECT COUNT(*) FROM sitin_records WHERE time_out IS NULL');
            res.json({
                totalStudents: totalStudents[0]?.values[0]?.[0] || 0,
                totalSitins: totalSitins[0]?.values[0]?.[0] || 0,
                activeSessions: activeSessions[0]?.values[0]?.[0] || 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get Feedback Reports ---
    app.get('/api/admin/feedback', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        try {
            const stmt = db.prepare('SELECT * FROM feedback ORDER BY date DESC');
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get Sit-in History for a Specific Student ---
    app.get('/api/admin/student-sitin-history/:studentId', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { studentId } = req.params;
        
        try {
            const stmt = db.prepare('SELECT * FROM sitin_records WHERE student_id = ? ORDER BY time_in DESC LIMIT 1');
            stmt.bind([studentId]);
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get Student Remaining Sessions ---
    app.get('/api/admin/student-sessions', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { idnumber } = req.query;
        
        try {
            // First get user id from idnumber
            const userStmt = db.prepare('SELECT id FROM users WHERE idnumber = ?');
            userStmt.bind([idnumber]);
            
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();
                
                // Get sessions from user_sessions
                const sessStmt = db.prepare('SELECT COALESCE(SUM(sessions), 0) as sessions FROM user_sessions WHERE user_id = ?');
                sessStmt.bind([user.id]);
                let sessionsRemaining = 30; // default
                if (sessStmt.step()) {
                    const result = sessStmt.getAsObject();
                    sessionsRemaining = 30 - (result.sessions || 0);
                    if (sessionsRemaining < 0) sessionsRemaining = 0;
                }
                sessStmt.free();
                res.json({ sessions: sessionsRemaining });
            } else {
                userStmt.free();
                res.json({ sessions: 30 }); // default for unknown users
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Create Sit-in Record ---
    app.post('/api/admin/sitin', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { studentId, studentName, purpose, lab, sessions: sitinSessions } = req.body;
        
        try {
            db.run(`INSERT INTO sitin_records (student_id, student_name, purpose, lab, sessions, time_in) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [studentId, studentName, purpose, lab, sitinSessions]);
            saveDatabase();
            res.json({ success: true, message: 'Sit-in record created successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get Sit-in Records ---
    app.get('/api/admin/sitin-records', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        try {
            const stmt = db.prepare('SELECT * FROM sitin_records ORDER BY time_in DESC');
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get Current Sit-in Records ---
    app.get('/api/admin/current-sitin', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        try {
            const stmt = db.prepare('SELECT * FROM sitin_records WHERE time_out IS NULL ORDER BY time_in DESC');
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: End Sit-in ---
    app.post('/api/admin/sitin/end', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        const { recordId } = req.body;

        try {
            // Get the sit-in record to find the student
            const recordStmt = db.prepare('SELECT student_id, sessions FROM sitin_records WHERE id = ?');
            recordStmt.bind([recordId]);

            if (recordStmt.step()) {
                const record = recordStmt.getAsObject();
                recordStmt.free();

                // Get the user_id from the students table
                const userStmt = db.prepare('SELECT id FROM users WHERE idnumber = ?');
                userStmt.bind([record.student_id]);

                if (userStmt.step()) {
                    const user = userStmt.getAsObject();
                    userStmt.free();

                    // Get current consumed sessions
                    const sessStmt = db.prepare('SELECT id, sessions FROM user_sessions WHERE user_id = ?');
                    sessStmt.bind([user.id]);

                    if (sessStmt.step()) {
                        const sessRecord = sessStmt.getAsObject();
                        sessStmt.free();
                        // Add 1 to consumed sessions
                        db.run('UPDATE user_sessions SET sessions = ? WHERE user_id = ?', [sessRecord.sessions + 1, user.id]);
                    } else {
                        sessStmt.free();
                        // Create new record with 1 consumed session
                        db.run('INSERT INTO user_sessions (user_id, sessions) VALUES (?, ?)', [user.id, 1]);
                    }
                } else {
                    userStmt.free();
                }

                // Update the sit-in record: deduct 1 from sessions and set time_out
                const newSessions = Math.max(0, record.sessions - 1);
                db.run(`UPDATE sitin_records SET time_out = CURRENT_TIMESTAMP, sessions = ? WHERE id = ?`, [newSessions, recordId]);
            } else {
                recordStmt.free();
                db.run(`UPDATE sitin_records SET time_out = CURRENT_TIMESTAMP WHERE id = ?`, [recordId]);
            }

            saveDatabase();
            res.json({ success: true, message: 'Sit-in ended successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Create Reservation ---
    app.post('/api/student/reservations', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        const { purpose, lab, preferred_date, preferred_time } = req.body;

        try {
            // Get student info
            const userStmt = db.prepare('SELECT idnumber, firstname, lastname FROM users WHERE id = ?');
            userStmt.bind([userId]);

            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();

                const studentName = `${user.firstname} ${user.lastname}`;

                db.run(`INSERT INTO reservations (student_id, student_name, purpose, lab, preferred_date, preferred_time)
                        VALUES (?, ?, ?, ?, ?, ?)`,
                    [user.idnumber, studentName, purpose, lab, preferred_date, preferred_time || '']);
                saveDatabase();

                res.json({ success: true, message: 'Reservation created successfully' });
            } else {
                userStmt.free();
                res.status(404).json({ error: 'User not found' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Get Own Reservations ---
    app.get('/api/student/reservations', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;

        try {
            const userStmt = db.prepare('SELECT idnumber FROM users WHERE id = ?');
            userStmt.bind([userId]);

            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();

                const stmt = db.prepare('SELECT * FROM reservations WHERE student_id = ? ORDER BY created_at DESC');
                stmt.bind([user.idnumber]);
                const results = [];
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                res.json(results);
            } else {
                userStmt.free();
                res.json([]);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get All Reservations ---
    app.get('/api/admin/reservations', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        try {
            const stmt = db.prepare(`
                SELECT r.*, u.email as student_email
                FROM reservations r
                LEFT JOIN users u ON r.student_id = u.idnumber
                ORDER BY r.created_at DESC
            `);
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Accept Reservation ---
    app.post('/api/admin/reservations/:id/accept', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        const { id } = req.params;
        const adminId = sessions[sessionId].userId;
        const { admin_notes } = req.body;

        try {
            // Get reservation details
            const resStmt = db.prepare('SELECT student_id, purpose, lab, preferred_date FROM reservations WHERE id = ?');
            resStmt.bind([id]);
            if (!resStmt.step()) {
                resStmt.free();
                return res.status(404).json({ error: 'Reservation not found' });
            }
            const reservation = resStmt.getAsObject();
            resStmt.free();

            // Update reservation status
            db.run(`UPDATE reservations SET status = 'accepted', handled_by = ?, handled_at = CURRENT_TIMESTAMP, admin_notes = ? WHERE id = ?`,
                [adminId, admin_notes || '', id]);

            // Get user id from student_id (idnumber)
            const userStmt = db.prepare('SELECT id, firstname, lastname FROM users WHERE idnumber = ?');
            userStmt.bind([reservation.student_id]);
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();

                // Create notification for the student
                const notifTitle = 'Reservation Accepted';
                const notifMessage = `Your reservation for ${reservation.lab} on ${new Date(reservation.preferred_date).toLocaleDateString()} (${reservation.purpose}) has been accepted.${admin_notes ? ' Note: ' + admin_notes : ''}`;
                db.run(`INSERT INTO notifications (title, message, priority, target_user_id, created_by) VALUES (?, ?, ?, ?, ?)`,
                    [notifTitle, notifMessage, 'high', user.id, adminId]);
            } else {
                userStmt.free();
            }

            saveDatabase();
            res.json({ success: true, message: 'Reservation accepted' });
        } catch (err) {
            console.error('Error accepting reservation:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Reject Reservation ---
    app.post('/api/admin/reservations/:id/reject', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        const { id } = req.params;
        const adminId = sessions[sessionId].userId;
        const { admin_notes } = req.body;

        try {
            // Get reservation details
            const resStmt = db.prepare('SELECT student_id, purpose, lab, preferred_date FROM reservations WHERE id = ?');
            resStmt.bind([id]);
            if (!resStmt.step()) {
                resStmt.free();
                return res.status(404).json({ error: 'Reservation not found' });
            }
            const reservation = resStmt.getAsObject();
            resStmt.free();

            // Update reservation status
            db.run(`UPDATE reservations SET status = 'rejected', handled_by = ?, handled_at = CURRENT_TIMESTAMP, admin_notes = ? WHERE id = ?`,
                [adminId, admin_notes || '', id]);

            // Get user id from student_id
            const userStmt = db.prepare('SELECT id, firstname, lastname FROM users WHERE idnumber = ?');
            userStmt.bind([reservation.student_id]);
            if (userStmt.step()) {
                const user = userStmt.getAsObject();
                userStmt.free();

                // Create notification for the student
                const notifTitle = 'Reservation Rejected';
                const notifMessage = `Your reservation for ${reservation.lab} on ${new Date(reservation.preferred_date).toLocaleDateString()} (${reservation.purpose}) has been rejected.${admin_notes ? ' Reason: ' + admin_notes : ''}`;
                db.run(`INSERT INTO notifications (title, message, priority, target_user_id, created_by) VALUES (?, ?, ?, ?, ?)`,
                    [notifTitle, notifMessage, 'high', user.id, adminId]);
            } else {
                userStmt.free();
            }

            saveDatabase();
            res.json({ success: true, message: 'Reservation rejected' });
        } catch (err) {
            console.error('Error rejecting reservation:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Delete Reservation ---
    app.delete('/api/admin/reservations/:id', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        const { id } = req.params;

        try {
            db.run('DELETE FROM reservations WHERE id = ?', [id]);
            saveDatabase();
            res.json({ success: true, message: 'Reservation deleted' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Cancel Reservation ---
    app.delete('/api/student/reservations/:id/cancel', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        const { id } = req.params;

        try {
            // Verify the reservation belongs to this student
            const userStmt = db.prepare('SELECT idnumber FROM users WHERE id = ?');
            userStmt.bind([userId]);
            if (!userStmt.step()) {
                userStmt.free();
                return res.status(404).json({ error: 'User not found' });
            }
            const user = userStmt.getAsObject();
            userStmt.free();

            // Check reservation exists and belongs to student
            const resStmt = db.prepare('SELECT id, status FROM reservations WHERE id = ? AND student_id = ?');
            resStmt.bind([id, user.idnumber]);

            if (!resStmt.step()) {
                resStmt.free();
                return res.status(404).json({ error: 'Reservation not found or not authorized' });
            }
            const reservation = resStmt.getAsObject();
            resStmt.free();

            // Only allow cancellation of pending reservations
            if (reservation.status !== 'pending') {
                return res.status(400).json({ error: 'Cannot cancel a reservation that has been reviewed' });
            }

            db.run('DELETE FROM reservations WHERE id = ?', [id]);
            saveDatabase();
            res.json({ success: true, message: 'Reservation cancelled' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Get Notifications ---
    app.get('/api/student/notifications', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;

        try {
            // Get notifications with read status for this user
            // Include notifications that are either for all (target_user_id IS NULL) or specifically for this user
            const stmt = db.prepare(`
                SELECT n.*,
                       CASE WHEN nr.read_at IS NULL THEN 0 ELSE 1 END as read
                FROM notifications n
                LEFT JOIN notification_reads nr ON n.id = nr.notification_id AND nr.user_id = ?
                WHERE n.target_user_id IS NULL OR n.target_user_id = ?
                ORDER BY n.created_at DESC
                LIMIT 50
            `);
            stmt.bind([userId, userId]);
            const results = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                results.push({
                    id: row.id,
                    title: row.title,
                    message: row.message,
                    priority: row.priority,
                    created_at: row.created_at,
                    read: row.read === 1
                });
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Mark Notification as Read ---
    app.post('/api/student/notifications/:id/read', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        const { id } = req.params;

        try {
            // Check if notification exists
            const notifStmt = db.prepare('SELECT id FROM notifications WHERE id = ?');
            notifStmt.bind([id]);
            if (!notifStmt.step()) {
                notifStmt.free();
                return res.status(404).json({ error: 'Notification not found' });
            }
            notifStmt.free();

            // Insert or update read record
            const checkStmt = db.prepare('SELECT id FROM notification_reads WHERE notification_id = ? AND user_id = ?');
            checkStmt.bind([id, userId]);

            if (checkStmt.step()) {
                // Update existing
                checkStmt.free();
                db.run('UPDATE notification_reads SET read_at = CURRENT_TIMESTAMP WHERE notification_id = ? AND user_id = ?',
                    [id, userId]);
            } else {
                checkStmt.free();
                db.run('INSERT INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                    [id, userId]);
            }
            saveDatabase();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Mark All Notifications as Read ---
    app.post('/api/student/notifications/read-all', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;

        try {
            // Get all unread notification IDs for this user (including targeted or broadcast)
            const unreadStmt = db.prepare(`
                SELECT n.id FROM notifications n
                LEFT JOIN notification_reads nr ON n.id = nr.notification_id AND nr.user_id = ?
                WHERE nr.id IS NULL AND (n.target_user_id IS NULL OR n.target_user_id = ?)
            `);
            unreadStmt.bind([userId, userId]);
            const unreadIds = [];
            while (unreadStmt.step()) {
                unreadIds.push(unreadStmt.getAsObject().id);
            }
            unreadStmt.free();

            // Insert read records for all unread
            unreadIds.forEach(notifId => {
                db.run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                    [notifId, userId]);
            });
            saveDatabase();
            res.json({ success: true, marked: unreadIds.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Student: Delete Notification (from personal view) ---
    app.delete('/api/student/notifications/:id', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        const { id } = req.params;

        try {
            // Delete the read record (this removes it from user's view)
            db.run('DELETE FROM notification_reads WHERE notification_id = ? AND user_id = ?', [id, userId]);
            saveDatabase();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Create Notification ---
    app.post('/api/admin/notifications', (req, res) => {
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
            db.run('INSERT INTO notifications (title, message, priority, created_by) VALUES (?, ?, ?, ?)',
                [title, message, priority || 'normal', adminId]);
            saveDatabase();
            res.json({ success: true, message: 'Notification sent to all users' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Get All Notifications ---
    app.get('/api/admin/notifications', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        try {
            const stmt = db.prepare(`
                SELECT n.*, a.name as admin_name
                FROM notifications n
                LEFT JOIN admins a ON n.created_by = a.id
                ORDER BY n.created_at DESC
                LIMIT 100
            `);
            const results = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                // Get recipient count
                const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM notification_reads WHERE notification_id = ?');
                countStmt.bind([row.id]);
                let count = 0;
                if (countStmt.step()) {
                    count = countStmt.getAsObject().cnt;
                }
                countStmt.free();

                results.push({
                    id: row.id,
                    title: row.title,
                    message: row.message,
                    priority: row.priority,
                    created_by: row.created_by,
                    admin_name: row.admin_name,
                    created_at: row.created_at,
                    recipients: count
                });
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Admin: Delete Notification ---
    app.delete('/api/admin/notifications/:id', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }

        const { id } = req.params;

        try {
            // Delete notification (cascade will delete notification_reads)
            db.run('DELETE FROM notifications WHERE id = ?', [id]);
            saveDatabase();
            res.json({ success: true, message: 'Notification deleted' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Community: Global Stats ---
    app.get('/api/community-stats', (req, res) => {
        try {
            // Total completed sit-in sessions (records with time_out)
            const totalStmt = db.prepare("SELECT COUNT(*) as cnt FROM sitin_records WHERE time_out IS NOT NULL");
            let totalSessions = 0;
            if (totalStmt.step()) { totalSessions = totalStmt.getAsObject().cnt; }
            totalStmt.free();

            // Distinct students who have completed at least one session
            const activeStmt = db.prepare("SELECT COUNT(DISTINCT student_id) as cnt FROM sitin_records WHERE time_out IS NOT NULL");
            let activeStudents = 0;
            if (activeStmt.step()) { activeStudents = activeStmt.getAsObject().cnt; }
            activeStmt.free();

            // Total accumulated hours across all completed sessions
            let totalMinutes = 0;
            const hrsStmt = db.prepare("SELECT SUM((julianday(time_out) - julianday(time_in)) * 1440) as totalMin FROM sitin_records WHERE time_out IS NOT NULL");
            if (hrsStmt.step()) { totalMinutes = hrsStmt.getAsObject().totalMin || 0; }
            hrsStmt.free();
            const totalHours = Math.round(totalMinutes / 60 * 10) / 10;

            // Simple lab utilization: active sessions / 6 labs (max 30 PCs each, using 180 as baseline)
            const activeStmt2 = db.prepare("SELECT COUNT(*) as cnt FROM sitin_records WHERE time_out IS NULL");
            let activeNow = 0;
            if (activeStmt2.step()) { activeNow = activeStmt2.getAsObject().cnt; }
            activeStmt2.free();
            const utilization = Math.round((activeNow / 180) * 100);

            res.json({ totalSessions, activeStudents, utilization, totalHours });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Community: Leaderboard ---
    app.get('/api/leaderboard', (req, res) => {
        try {
            const stmt = db.prepare(`
                SELECT
                    s.student_id,
                    s.student_name,
                    u.course,
                    COUNT(s.id)                                      AS sessions,
                    COALESCE(SUM((julianday(s.time_out) - julianday(s.time_in)) * 1440), 0) AS totalMin
                FROM sitin_records s
                LEFT JOIN users u ON s.student_id = u.idnumber
                WHERE s.time_out IS NOT NULL
                GROUP BY s.student_id
                ORDER BY totalMin DESC
                LIMIT 10
            `);
            const results = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                results.push({
                    name:     row.student_name,
                    course:   row.course     || 'Not set',
                    sessions: row.sessions    || 0,
                    hours:    Math.round(row.totalMin / 60 * 10) / 10
                });
            }
            stmt.free();
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- Start the Server ---
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
