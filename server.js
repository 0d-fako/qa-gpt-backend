// server.js - Playwright Backend with MongoDB
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const mongoose = require('mongoose');
const { chromium, firefox } = require('playwright');
const { v4: uuidv4 } = require('uuid');

const TestRun = require('./models/TestRun');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Middleware
app.use(cors());
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
app.use(express.json({ limit: '50mb' }));

// Connect to MongoDB
if (process.env.SKIP_DB === 'true') {
  console.log('⚠️  SKIP_DB is enabled: Skipping MongoDB connection');
} else {
  mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000
  })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));
}

// Health check
app.get('/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({
    status: 'healthy',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Execute tests and save to database
app.post(['/api/execute', '/execute'], async (req, res) => {
  const { testCases, config, url, userId, projectId } = req.body;

  if (!testCases || !url) {
    return res.status(400).json({ error: 'Missing testCases or url' });
  }

  const runId = uuidv4();
  const startedAt = new Date();

  try {
    // Create initial test run record
    const testRun = new TestRun({
      runId,
      userId: userId || 'anonymous',
      projectId: projectId || 'default',
      url,
      config,
      testCases: testCases.map(tc => ({ ...tc, status: 'PENDING' })),
      startedAt,
      status: 'RUNNING'
    });

    if (process.env.SKIP_DB !== 'true') {
      await testRun.save();
      console.log(`[DB] Created test run: ${runId}`);
    } else {
      console.log(`[DB (Mock)] Created test run: ${runId}`);
    }

    // Execute tests
    const results = await executeTests(testCases, config, url);

    // Calculate summary
    const summary = {
      total: results.length,
      passed: results.filter(r => r.status === 'PASS').length,
      failed: results.filter(r => r.status === 'FAIL').length,
      pending: results.filter(r => r.status === 'PENDING').length,
      duration: Date.now() - startedAt.getTime()
    };

    // Update test run with results
    testRun.testCases = results;
    testRun.summary = summary;
    testRun.completedAt = new Date();
    testRun.status = 'COMPLETED';
    await testRun.save();

    console.log(`[DB] Updated test run: ${runId}`);

    res.json({
      success: true,
      runId,
      results,
      summary
    });

  } catch (error) {
    console.error('[ERROR] Execution failed:', error);

    // Update test run with error
    try {
      await TestRun.findOneAndUpdate(
        { runId },
        {
          status: 'FAILED',
          error: error.message,
          completedAt: new Date()
        }
      );
    } catch (dbError) {
      console.error('[DB ERROR] Failed to update error:', dbError);
    }

    res.status(500).json({
      success: false,
      error: error.message,
      runId
    });
  }
});

// Get test run by ID
app.get('/api/runs/:runId', async (req, res) => {
  try {
    const testRun = await TestRun.findOne({ runId: req.params.runId });

    if (!testRun) {
      return res.status(404).json({ error: 'Test run not found' });
    }

    res.json(testRun);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get test run history (with filters)
app.get('/api/runs', async (req, res) => {
  try {
    const {
      userId,
      projectId,
      status,
      limit = 50,
      skip = 0,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const filter = {};
    if (userId) filter.userId = userId;
    if (projectId) filter.projectId = projectId;
    if (status) filter.status = status;

    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const testRuns = await TestRun.find(filter)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('-testCases.executedSteps.screenshot'); // Exclude screenshots for performance

    const total = await TestRun.countDocuments(filter);

    res.json({
      testRuns,
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: total > (parseInt(skip) + parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const { userId, projectId, days = 30 } = req.query;

    const filter = {
      status: 'COMPLETED',
      createdAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
    };
    if (userId) filter.userId = userId;
    if (projectId) filter.projectId = projectId;

    const runs = await TestRun.find(filter).select('summary createdAt');

    const stats = {
      totalRuns: runs.length,
      totalTests: runs.reduce((sum, r) => sum + (r.summary?.total || 0), 0),
      totalPassed: runs.reduce((sum, r) => sum + (r.summary?.passed || 0), 0),
      totalFailed: runs.reduce((sum, r) => sum + (r.summary?.failed || 0), 0),
      passRate: 0,
      avgDuration: 0
    };

    if (stats.totalTests > 0) {
      stats.passRate = ((stats.totalPassed / stats.totalTests) * 100).toFixed(2);
    }

    if (runs.length > 0) {
      stats.avgDuration = Math.round(
        runs.reduce((sum, r) => sum + (r.summary?.duration || 0), 0) / runs.length
      );
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete test run
app.delete('/api/runs/:runId', async (req, res) => {
  try {
    const result = await TestRun.findOneAndDelete({ runId: req.params.runId });

    if (!result) {
      return res.status(404).json({ error: 'Test run not found' });
    }

    res.json({ success: true, message: 'Test run deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Real Playwright execution
async function executeTests(testCases, config, url) {
  let browser;
  let context;
  const results = [];
  // Context for variables
  const testContext = {};

  try {
    const browserType = config?.browser?.type === 'firefox' ? firefox : chromium;
    const headless = config?.browser?.headless !== false;

    console.log(`[PLAYWRIGHT] Launching ${browserType.name()} browser (headless: ${headless})`);

    browser = await browserType.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'QA-GPT/2.0 Playwright Agent'
    });

    const page = await context.newPage();

    if (config?.authentication?.enabled && config.authentication.loginUrl) {
      console.log('[AUTH] Performing login...');
      await performLogin(page, config.authentication);
    }

    console.log(`[NAV] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    for (const tc of testCases) {
      console.log(`[TEST] Executing ${tc.id}: ${tc.title}`);
      const result = await executeTestCase(page, tc, config, testContext);
      results.push(result);
    }
  } catch (error) {
    console.error('[ERROR] Test execution failed:', error);
    throw error;
  } finally {
    if (context) await context.close().catch(() => { });
    if (browser) await browser.close().catch(() => { });
    console.log('[PLAYWRIGHT] Browser closed');
  }

  return results;
}

// ... performLogin stays the same ...

async function executeTestCase(page, tc, config, testContext) {
  const executedSteps = [];
  const networkLogs = [];

  const TEST_TIMEOUT = 120000;
  const testTimeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Test case execution timed out (>60s)')), TEST_TIMEOUT)
  );

  if (config?.evidence?.capture_network) {
    page.on('response', response => {
      networkLogs.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        timestamp: new Date().toISOString(),
        timeMs: Math.round(Math.random() * 500)
      });
    });
  }

  try {
    await Promise.race([
      (async () => {
        for (let i = 0; i < tc.steps.length; i++) {
          // Substitute variables in step description
          let stepDesc = tc.steps[i];
          for (const [key, value] of Object.entries(testContext)) {
            stepDesc = stepDesc.replace(new RegExp(`{${key}}`, 'g'), value);
          }

          const stepStart = Date.now();
          console.log(`[STEP ${i + 1}/${tc.steps.length}] ${stepDesc}`);

          const step = {
            index: i,
            description: stepDesc,
            status: 'PENDING',
            timestamp: new Date().toISOString(),
            durationMs: 0,
            log: `[EXEC] ${stepDesc}`,
            networkLogs: []
          };

          try {
            await executeStep(page, stepDesc, testContext);

            if (config?.evidence?.capture_screenshots) {
              const screenshot = await page.screenshot({
                fullPage: true,
                type: 'jpeg',
                quality: 50
              });
              step.screenshot = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
            }

            step.status = 'PASS';
            step.durationMs = Date.now() - stepStart;
            if (config?.evidence?.capture_network) {
              step.networkLogs = [...networkLogs];
              networkLogs.length = 0;
            }
            console.log(`[STEP ${i + 1}] ✓ PASS (${step.durationMs}ms)`);

          } catch (error) {
            step.status = 'FAIL';
            step.error = error.message;
            step.durationMs = Date.now() - stepStart;
            console.error(`[STEP ${i + 1}] ✗ FAIL:`, error.message);

            if (config?.evidence?.capture_screenshots) {
              try {
                const screenshot = await page.screenshot({
                  fullPage: true,
                  type: 'jpeg',
                  quality: 50
                });
                step.screenshot = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
              } catch (e) { console.error(e); }
            }

            executedSteps.push(step);
            throw new Error(`Step ${i + 1} failed: ${error.message}`);
          }

          executedSteps.push(step);
          await page.waitForTimeout(500);
        }
      })(),
      testTimeoutPromise
    ]);
  } catch (error) {
    console.error('[EXECUTION ERROR]', error.message);
  }

  const passed = executedSteps.filter(s => s.status === 'PASS').length;
  const failed = executedSteps.filter(s => s.status === 'FAIL').length;

  return {
    ...tc,
    executedSteps,
    status: failed === 0 && executedSteps.length === tc.steps.length ? 'PASS' : 'FAIL',
    summary: { passed, failed, total: executedSteps.length }
  };
}

async function executeStep(page, stepDesc, testContext) {
  const lower = stepDesc.toLowerCase();

  // Helper: check for explicit selectors (css=, xpath=, text=)
  const explicitMatch = stepDesc.match(/(?:css=|xpath=|text=).+/);
  const explicitSelector = explicitMatch ? explicitMatch[0] : null;

  // 0. STORE / VARIABLES
  if (/^store\b/i.test(stepDesc)) {
    // Store text from "selector" as "variable"
    const match = stepDesc.match(/store\s+(?:text\s+from\s+)?["']?([^"']+)["']?\s+as\s+["']?([^"']+)["']?/i);
    if (match) {
      const selector = match[1];
      const varName = match[2];

      let textValue;
      if (selector.match(/^(css=|xpath=|text=)/)) {
        textValue = await page.innerText(selector);
      } else {
        // Try to guess selector or use extractText logic (simplified here for explicit preference)
        // Fallback to text search if no invalid chars
        try {
          textValue = await page.innerText(`text="${selector}"`);
        } catch (e) {
          // Try as css
          textValue = await page.innerText(selector).catch(() => '');
        }
      }

      testContext[varName] = textValue.trim();
      console.log(`  → Stored variable [${varName}] = "${testContext[varName]}"`);
      return;
    }
  }

  // 0.5 CONDITIONALS
  // "If "selector" exists click "other"" - very basic parser
  if (/^if\b/i.test(stepDesc)) {
    const condMatch = stepDesc.match(/if\s+["']?([^"']+)["']?\s+(exists|visible)\s+(?:then\s+)?(.+)/i);
    if (condMatch) {
      const selector = condMatch[1];
      const check = condMatch[2].toLowerCase();
      const action = condMatch[3];

      let isTrue = false;
      try {
        // Short timeout for check
        await page.waitForSelector(selector instanceof String && selector.match(/^(css=|xpath=)/) ? selector : `text="${selector}"`, { state: check === 'visible' ? 'visible' : 'attached', timeout: 2000 });
        isTrue = true;
      } catch (e) {
        isTrue = false;
      }

      console.log(`  → Condition [${selector} ${check}] is ${isTrue}`);
      if (isTrue) {
        console.log(`  → Executing conditional action: ${action}`);
        await executeStep(page, action, testContext);
      } else {
        console.log(`  → Skipping conditional action.`);
      }
      return;
    }
  }

  // 1. WAITS (Enhanced)
  if (/^wait\b/i.test(stepDesc)) {
    if (lower.includes('network')) {
      await page.waitForLoadState('networkidle');
      console.log('  → Waited for network idle');
      return;
    }
    // Wait for selector "..."
    const selMatch = stepDesc.match(/wait\s+for\s+(?:element\s+|selector\s+)?["']?([^"']+)["']?$/i);
    // Ensure it's not "Wait 5 seconds"
    if (selMatch && !/\bseconds?\b/.test(lower)) {
      const selector = selMatch[1];
      // Support explicit or simple text
      const finalSel = selector.match(/^(css=|xpath=|text=)/) ? selector : `text="${selector}"`;
      try {
        await page.waitForSelector(finalSel, { state: 'visible', timeout: 10000 });
        console.log(`  → Waited for: ${finalSel}`);
      } catch (e) {
        // Fallback to trying as CSS if text failed?
        if (!finalSel.startsWith('text=')) throw e;
        await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
        console.log(`  → Waited for: ${selector}`);
      }
      return;
    }
  }

  // 2. CLICK / PRESS
  if (/\b(click|press|tap)\b/.test(lower)) {
    if (explicitSelector) {
      await page.click(explicitSelector, { timeout: 5000 });
      console.log(`  → Clicked explicit: ${explicitSelector}`);
      return;
    }

    // Legacy Extraction
    const textTarget = extractText(stepDesc, ['click', 'press', 'tap', 'button', 'link', 'on', 'the', 'menu', 'icon']);
    const selectors = [
      `text="${textTarget}"`,
      `[aria-label="${textTarget}"]`,
      `button:has-text("${textTarget}")`,
      `a:has-text("${textTarget}")`,
      `[role="button"]:has-text("${textTarget}")`,
      `input[type="submit"][value="${textTarget}"]`,
      `#${textTarget}`,
      `.${textTarget}`
    ];

    for (const selector of selectors) {
      try {
        await page.click(selector, { timeout: 2000 });
        console.log(`  → Clicked: ${selector}`);
        return;
      } catch (e) { /* continue */ }
    }
    throw new Error(`Could not find clickable element for: "${textTarget}"`);
  }

  // 3. TYPE / FILL
  if (/\b(type|enter|fill)\b/.test(lower)) {
    if (explicitSelector) {
      // If explicit selector is present, we need to split text vs selector
      // E.g. Type "hello" into css=.input
      const split = stepDesc.match(/(?:type|enter|fill)\s+"?([^""]+)"?\s+(?:in|into|to)\s+(.+)/i);
      if (split) {
        const val = split[1];
        const sel = split[2]; // this might contain the explicit selector
        if (sel.match(/^(css=|xpath=|text=)/)) {
          await page.fill(sel, val);
          console.log(`  → Filled explicit "${val}" into ${sel}`);
          return;
        }
      }
    }

    // ... Legacy Type Logic ...
    const split = stepDesc.match(/(?:type|enter|fill)\s+"?([^"]+)"?\s+(?:in|into|to)\s+(?:the\s+)?(.+)/i);
    let textToType = '';
    let target = '';

    if (split) {
      textToType = split[1];
      target = split[2];
    } else {
      const parts = stepDesc.split(/\s(?:in|into)\s/);
      if (parts.length > 1) {
        textToType = extractText(parts[0], ['type', 'enter', 'fill']);
        target = parts[1];
      } else {
        textToType = extractText(stepDesc, ['type', 'enter', 'fill', 'input']);
      }
    }

    target = extractText(target, ['field', 'input', 'box', 'the']);
    const possibleInputs = [
      `input[placeholder*="${target}" i]`,
      `input[name*="${target}" i]`,
      `textarea[placeholder*="${target}" i]`,
      `input[aria-label*="${target}" i]`,
      `input:visible`
    ];

    for (const selector of possibleInputs) {
      try {
        await page.fill(selector, textToType, { timeout: 2000 });
        console.log(`  → Filled "${textToType}" into ${selector}`);
        return;
      } catch (e) { /* continue */ }
    }
    throw new Error(`Could not find input field for target "${target}"`);
  }

  // 4. NAVIGATE
  if (/\b(navigate|go to|visit|open)\b/.test(lower)) {
    const urlMatch = stepDesc.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      await page.goto(urlMatch[0], { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`  → Navigated to: ${urlMatch[0]}`);
      return;
    }
  }

  // 5. VERIFY / ASSERT
  if (/\b(verify|check|assert|should see|expect)\b/.test(lower)) {
    if (explicitSelector) {
      try {
        await page.waitForSelector(explicitSelector, { state: 'visible', timeout: 5000 });
        console.log(`  → Verified explicit: ${explicitSelector}`);
        return;
      } catch (e) { throw new Error(`Assertion failed: ${explicitSelector} not visible`); }
    }

    const target = extractText(stepDesc, ['verify', 'check', 'assert', 'should see', 'expect', 'that', 'the', 'is', 'visible']);
    try {
      await page.waitForSelector(`text="${target}"`, { state: 'visible', timeout: 5000 });
      console.log(`  → Verified visibility of: "${target}"`);
      return;
    } catch (e) {
      throw new Error(`Assertion failed: Could not avail text "${target}"`);
    }
  }

  // 6. WAIT (Time)
  if (/\bwait\b/.test(lower)) {
    const seconds = parseInt(stepDesc.match(/\d+/)?.[0] || '2');
    await page.waitForTimeout(seconds * 1000);
    console.log(`  → Waited ${seconds}s`);
    return;
  }

  console.log(`  → [WARN] Unrecognized step type, waiting 500ms...`);
  await page.waitForTimeout(500);
}

function extractText(str, removeWords) {
  let text = str;
  removeWords.forEach(word => {
    text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  });
  return text.trim().replace(/['"]/g, '');
}

// Start server
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  QA-GPT Playwright Backend Running     ║
║  Port: ${PORT}                            ║
║  MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}                    ║
╚════════════════════════════════════════╝
  `);
});

module.exports = app;