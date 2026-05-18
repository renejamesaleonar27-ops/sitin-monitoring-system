const http = require('http');

console.log("Starting CCS Sit-in Monitoring System test server...");

// Set process env to test
process.env.PORT = 3001;

// Load the server app
const app = require('./server.js');

// Helper to make a request
function testRoute(method, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3001,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data.substring(0, 100) // first 100 chars
                });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.end();
    });
}

async function runTests() {
    // Give database initialization a moment to complete
    await new Promise(resolve => setTimeout(resolve, 1500));

    console.log("\n=============================================");
    console.log("           STARTING ENDPOINT TESTING          ");
    console.log("=============================================\n");

    const tests = [
        { method: 'GET', path: '/' },
        { method: 'GET', path: '/index.html' },
        { method: 'GET', path: '/api/announcements' },
        { method: 'GET', path: '/api/settings/reservations' },
        { method: 'GET', path: '/api/community-stats' },
        { method: 'GET', path: '/api/leaderboard' },
        { method: 'GET', path: '/api/software' },
        { method: 'GET', path: '/api/current-user' }, // Should return 401 (Not authenticated)
        { method: 'GET', path: '/api/student/sitin-history' }, // Should return 401
        { method: 'GET', path: '/api/admin/reservations' } // Should return 401
    ];

    let passed = 0;
    let failed = 0;

    for (let test of tests) {
        try {
            const res = await testRoute(test.method, test.path);
            let resultStatus = "PASSED";
            
            // Validate expectation
            if (test.path.includes('/api/current-user') || test.path.includes('/api/student/') || test.path.includes('/api/admin/')) {
                if (res.status !== 401) {
                    resultStatus = "FAILED (Expected 401 Auth Shield)";
                    failed++;
                } else {
                    passed++;
                }
            } else {
                if (res.status !== 200 && res.status !== 304) {
                    resultStatus = `FAILED (Status: ${res.status})`;
                    failed++;
                } else {
                    passed++;
                }
            }

            console.log(`[${resultStatus}] ${test.method} ${test.path} - Status: ${res.status}`);
        } catch (e) {
            console.log(`[FAILED] ${test.method} ${test.path} - Error: ${e.message}`);
            failed++;
        }
    }

    console.log("\n=============================================");
    console.log(`TEST RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log("=============================================\n");

    if (failed === 0) {
        console.log("✨ All major routing groups and security shields are fully verified and functioning! ✨");
        process.exit(0);
    } else {
        console.log("❌ Some endpoint checks failed. Please review the errors. ❌");
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
