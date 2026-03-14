const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// --- Middleware ---
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

    // --- Create the users table ---
    db.run(`DROP TABLE IF EXISTS users`);
    db.run(`
        CREATE TABLE users (
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

                // Login successful
                res.redirect('/main.html');
            } else {
                stmt.free();
                res.status(401).send('Login failed: ID Number not found.');
            }
        } catch (err) {
            res.status(500).send('Login failed: ' + err.message);
        }
    });

    // --- Start the Server ---
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer();
