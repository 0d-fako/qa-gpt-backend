const app = require('./server'); // This starts the server
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
process.env.SKIP_DB = 'true'; // Force skip DB for local testing confidence

// Wait for server to start
setTimeout(async () => {
    console.log('--- Starting Local Test ---');

    const payload = {
        url: 'https://vigimatch-frontend-dev.up.railway.app/auth',
        testCases: [
            {
                id: 'TC-ADVANCED-001',
                title: 'Verify Advanced Features (Selectors, Variables, Waits)',
                steps: [
                    'Wait for network idle',
                    'Store text from "h1" as "pageTitle"',
                    'Type "phemii_tester" into css=input[placeholder*="Username"]',
                    'Type "Hbon@1234" into css=input[type="password"]',
                    'Click xpath=//button[contains(text(), "Sign In")]',
                    'Wait for selector "text=Dashboard"',
                    'If "Dashboard" visible then Click "Logout"',
                    'Verify "Dashboard"'
                ]
            }
        ],
        config: {
            browser: { type: 'chromium', headless: true },
            authentication: { enabled: false },
            evidence: { capture_screenshots: true }
        }
    };

    try {
        console.log(`Sending POST request to http://localhost:${PORT}/execute...`);

        const response = await fetch(`http://localhost:${PORT}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        console.log('--- Response Status:', response.status);
        console.log('--- Response Body ---');
        console.log(JSON.stringify(data, null, 2));

        if (response.ok && data.success) {
            console.log('\n✅ TEST PASSED: Backend responded successfully.');
        } else {
            console.error('\n❌ TEST FAILED: Backend returned error or failure.');
        }

        if (data.results) {
            const screenshotsDir = path.join(__dirname, 'screenshots');
            if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir);
            }

            data.results.forEach(result => {
                result.executedSteps.forEach((step, index) => {
                    if (step.screenshot) {
                        let ext = 'png';
                        let data = step.screenshot;

                        // Detect and process different image types
                        if (step.screenshot.startsWith('data:image/jpeg')) {
                            ext = 'jpg';
                            data = step.screenshot.replace(/^data:image\/jpeg;base64,/, "");
                        } else {
                            data = step.screenshot.replace(/^data:image\/png;base64,/, "");
                        }

                        const filename = `${result.id}_step${index + 1}_${step.status}.${ext}`;
                        const filePath = path.join(screenshotsDir, filename);
                        fs.writeFileSync(filePath, data, 'base64');
                        console.log(`Saved screenshot: ${filename}`);
                    }
                });
            });
        }

    } catch (error) {
        console.error('\n❌ TEST FAILED: Network request failed:', error.message);
    } finally {
        console.log('--- Test Complete, Exiting ---');
        process.exit(0);
    }
}, 15000); // Wait 15 seconds for MongoDB connection and server start
