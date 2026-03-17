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
                    res.cookie('sessionId', sessionId, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
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
                
                res.cookie('sessionId', sessionId, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
                res.redirect('/main.html');
            } else {
                stmt.free();
                res.status(401).send('Login failed: ID Number not found.');
            }
        } catch (err) {
            res.status(500).send('Login failed: ' + err.message);
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
                
                // Get remaining sessions
                const sessionStmt = db.prepare('SELECT COALESCE(SUM(sessions), 0) as totalSessions FROM user_sessions WHERE user_id = ?');
                sessionStmt.bind([userId]);
                let totalSessions = 0;
                if (sessionStmt.step()) {
                    const result = sessionStmt.getAsObject();
                    totalSessions = result.totalSessions || 0;
                }
                sessionStmt.free();
                
                user.totalSessions = totalSessions;
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
        if (sessionId && sessions[sessionId]) {
            delete sessions[sessionId];
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

    // --- Start the Server ---
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
