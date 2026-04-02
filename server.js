const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

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
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
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
            res.redirect('/login.html');
        } catch (err) {
            console.error('Registration error:', err);
            const errorMessage = err.message || err.toString() || 'Unknown error';
            if (errorMessage.includes('UNIQUE constraint failed')) {
                res.status(400).send('Registration failed: ID Number or Email already exists.');
            } else {
                res.status(500).send('Registration failed: ' + errorMessage);
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
                    res.cookie('sessionId', sessionId, { httpOnly: true, maxAge: 30 * 60 * 1000 }); // 30 minutes session
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

    // --- Update User Profile API ---
    app.put('/api/profile', (req, res) => {
        const sessionId = req.cookies?.sessionId;
        
        if (!sessionId || !sessions[sessionId]) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = sessions[sessionId].userId;
        const { firstname, middlename, lastname, address, email } = req.body;
        
        try {
            db.run(`UPDATE users SET firstname = ?, middlename = ?, lastname = ?, address = ?, email = ? WHERE id = ?`,
                [firstname, middlename || '', lastname, address || '', email, userId]);
            saveDatabase();
            console.log(`User ${userId} updated their profile`);
            res.json({ success: true, message: 'Profile updated successfully' });
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
            const stmt = db.prepare('SELECT id, idnumber, lastname, firstname, middlename, courselevel, course, address, email FROM users WHERE id = ?');
            stmt.bind([userId]);
            
            if (stmt.step()) {
                const user = stmt.getAsObject();
                stmt.free();
                
                // Get remaining sessions (30 - consumed)
                const sessionStmt = db.prepare('SELECT COALESCE(SUM(sessions), 0) as consumedSessions FROM user_sessions WHERE user_id = ?');
                sessionStmt.bind([userId]);
                let remainingSessions = 30;
                if (sessionStmt.step()) {
                    const result = sessionStmt.getAsObject();
                    remainingSessions = Math.max(0, 30 - (result.consumedSessions || 0));
                }
                sessionStmt.free();
                
                user.totalSessions = remainingSessions;
                res.json(user);
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
        if (!sessionId || !sessions[sessionId] || !sessions[sessionId].isAdmin) {
            return res.status(401).json({ error: 'Not authenticated as admin' });
        }
        
        const { title, content } = req.body;
        
        try {
            db.run('INSERT INTO announcements (title, content) VALUES (?, ?)', [title, content]);
            saveDatabase();
            res.json({ success: true, message: 'Announcement created successfully' });
        } catch (err) {
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
            db.run(`INSERT INTO sitin_records (student_id, student_name, purpose, lab, sessions) VALUES (?, ?, ?, ?, ?)`,
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

    // --- Start the Server ---
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
