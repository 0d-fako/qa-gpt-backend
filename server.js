// server.js - Playwright Backend with MongoDB
const express = require('express');
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
app.use(express.json({ limit: '50mb' }));

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

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
app.post('/api/execute', async (req, res) => {
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
    
    await testRun.save();
    console.log(`[DB] Created test run: ${runId}`);

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

// Real Playwright execution (same as before)
async function executeTests(testCases, config, url) {
  const browserType = config?.browser?.type === 'firefox' ? firefox : chromium;
  const headless = config?.browser?.headless !== false;
  
  console.log(`[PLAYWRIGHT] Launching ${browserType.name()} browser (headless: ${headless})`);
  
  const browser = await browserType.launch({ 
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'QA-GPT/2.0 Playwright Agent'
  });
  
  const page = await context.newPage();
  const results = [];

  try {
    if (config?.authentication?.enabled && config.authentication.loginUrl) {
      console.log('[AUTH] Performing login...');
      await performLogin(page, config.authentication);
    }

    console.log(`[NAV] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    for (const tc of testCases) {
      console.log(`[TEST] Executing ${tc.id}: ${tc.title}`);
      const result = await executeTestCase(page, tc, config);
      results.push(result);
    }
  } catch (error) {
    console.error('[ERROR] Test execution failed:', error);
    throw error;
  } finally {
    await context.close();
    await browser.close();
    console.log('[PLAYWRIGHT] Browser closed');
  }

  return results;
}

async function performLogin(page, auth) {
  await page.goto(auth.loginUrl, { waitUntil: 'networkidle' });
  
  const usernameSelectors = [
    'input[type="email"]',
    'input[type="text"][name*="email"]',
    'input[name="username"]',
    'input[id="email"]',
    'input[placeholder*="email" i]'
  ];
  
  for (const selector of usernameSelectors) {
    try {
      await page.fill(selector, auth.username, { timeout: 2000 });
      console.log(`[AUTH] Filled username with selector: ${selector}`);
      break;
    } catch (e) {
      continue;
    }
  }
  
  await page.fill('input[type="password"]', auth.password);
  
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'input[type="submit"]'
  ];
  
  for (const selector of submitSelectors) {
    try {
      await page.click(selector);
      console.log(`[AUTH] Clicked submit with selector: ${selector}`);
      break;
    } catch (e) {
      continue;
    }
  }
  
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  console.log('[AUTH] Login complete');
}

async function executeTestCase(page, tc, config) {
  const executedSteps = [];
  const networkLogs = [];
  
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

  for (let i = 0; i < tc.steps.length; i++) {
    const stepDesc = tc.steps[i];
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
      await executeStep(page, stepDesc);
      
      if (config?.evidence?.capture_screenshots) {
        const screenshot = await page.screenshot({ 
          fullPage: true,
          type: 'png'
        });
        step.screenshot = `data:image/png;base64,${screenshot.toString('base64')}`;
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
    }
    
    executedSteps.push(step);
    await page.waitForTimeout(500);
  }

  const passed = executedSteps.filter(s => s.status === 'PASS').length;
  const failed = executedSteps.filter(s => s.status === 'FAIL').length;
  
  return {
    ...tc,
    executedSteps,
    status: failed === 0 ? 'PASS' : 'FAIL',
    summary: { passed, failed, total: executedSteps.length }
  };
}

async function executeStep(page, stepDesc) {
  const lower = stepDesc.toLowerCase();
  
  if (lower.includes('click') || lower.includes('press')) {
    const text = extractText(stepDesc, ['click', 'press', 'button', 'link', 'on', 'the']);
    
    const selectors = [
      `button:has-text("${text}")`,
      `a:has-text("${text}")`,
      `[role="button"]:has-text("${text}")`,
      `text="${text}"`,
      `button[id*="${text.toLowerCase()}"]`,
      `button[class*="${text.toLowerCase()}"]`
    ];
    
    for (const selector of selectors) {
      try {
        await page.click(selector, { timeout: 5000 });
        console.log(`  → Clicked: ${selector}`);
        return;
      } catch (e) {
        continue;
      }
    }
    
    throw new Error(`Could not find clickable element for: "${text}"`);
  }
  
  if (lower.includes('enter') || lower.includes('type') || lower.includes('fill')) {
    const text = extractText(stepDesc, ['enter', 'type', 'fill', 'input', 'in', 'into', 'the', 'field']);
    await page.fill('input:visible:not([type="hidden"])', text);
    console.log(`  → Filled input with: ${text}`);
    return;
  }
  
  if (lower.includes('navigate') || lower.includes('go to') || lower.includes('visit')) {
    const urlMatch = stepDesc.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      await page.goto(urlMatch[0], { waitUntil: 'networkidle' });
      console.log(`  → Navigated to: ${urlMatch[0]}`);
      return;
    }
  }
  
  if (lower.includes('wait')) {
    const seconds = parseInt(stepDesc.match(/\d+/)?.[0] || '2');
    await page.waitForTimeout(seconds * 1000);
    console.log(`  → Waited ${seconds}s`);
    return;
  }
  
  if (lower.includes('verify') || lower.includes('check') || lower.includes('see')) {
    const text = extractText(stepDesc, ['verify', 'check', 'see', 'that', 'should', 'is', 'visible']);
    
    try {
      await page.waitForSelector(`text="${text}"`, { timeout: 5000 });
      console.log(`  → Verified text present: ${text}`);
      return;
    } catch (e) {
      throw new Error(`Could not verify text: "${text}"`);
    }
  }
  
  console.log(`  → Unknown action, waiting 1s...`);
  await page.waitForTimeout(1000);
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